# Architecture

This document explains how Upfly works internally. It is written for someone who wants to
change the code — read it before opening a PR. If you find it out of date, that is a bug;
please say so in an issue.

## The problem

Converting an image is trivial: `sharp('hero.png').webp().toFile('hero.webp')`. Dozens of
tools do it.

The hard part is that `hero.png` is *referenced* — from an `import` in a React component, a
`src` attribute in an HTML file, a `url()` in a stylesheet, a `srcset` on a `<picture>`, a
path in a JSON manifest. Convert the file and every one of those references breaks. That is
why most tools either refuse to touch existing files or quietly break builds.

Upfly's job is the second half: **know every place an asset is referenced, and rewrite those
references safely — or refuse, loudly.**

## The pipeline

Everything is a pure function over data except two modules, `discover` and `execute`, which
are the only places that touch the filesystem. That is what lets the whole engine be tested
without a disk.

```
discover(fs) ──► assets[]        image files, minus ignored paths
discover(fs) ──► sourceFiles[]   files claimed by some adapter

adapters.findReferences(file) ──► references[]
        │  each: { file, start, end, rawPath, kind, confidence }
        ▼
resolve(references, assets) ──► links + unresolved[]
        ▼
graph = link(assets, references)      asset → refs, ref → asset
        ▼
audit(graph) ──► findings          dead / broken / oversized / opportunities
        ▼
plan(graph, config) ──► { assetPlans[], edits[] }     only confidence ≤ medium
        ▼
validate(plan)                     overlaps, writability, conflicting plans
        ▼
execute(plan) ──► manifest         encode → temp, then write, then edit, then manifest
        ▼
report(...) ──► human | json
```

## Confidence tiers — the core idea

Every reference carries a confidence, and the planner only rewrites the top three:

| Tier | Means | Rewritten? |
|---|---|---|
| `certain` | Static `import`/`require`, resolved on disk | yes |
| `high` | String literal in a known attribute or function, resolved on disk | yes |
| `medium` | Template literal with a static prefix resolving to exactly one asset | yes |
| `unsafe` | Dynamic concatenation, variable-only paths, unresolvable | **never** |

`unsafe` references are never touched and always appear in the report. A tool that rewrites
source files earns trust by being honest about what it could not do — the existing tools in
this space fail silently, and that is precisely why nobody uses them on a real repo.

**A silent skip is a P0 bug.** If the engine declines to do something, the report says so.

## Adapters — the contribution surface

An adapter teaches Upfly to read one file format. This is where most contributions go, and
adding one should take about half an hour.

```ts
interface Adapter {
  readonly id: string;                    // 'jsx', 'html', 'css', 'vue', …
  readonly extensions: readonly string[]; // ['.html', '.htm']
  findReferences(input: { file: string; text: string }): Reference[];
  rewrite(input: { text: string; edits: readonly Edit[] }): string;
}
```

Rules an adapter must follow:

1. **Never touch the filesystem.** It receives text and returns data.
2. **Never resolve paths.** Report `rawPath` exactly as written; the resolver decides what it
   points at. An adapter that resolves paths cannot be unit-tested without a disk.
3. **Be pure.** Same input, same output, no globals.
4. **Report offsets of the path text only** — not the surrounding quotes or attribute.
5. **Ship a fixture and a table-driven test.** The compatibility matrix in the README is
   generated from fixture results, so an adapter without fixtures is invisible.

Parsing strategy: use a real parser wherever one is cheap and correct — `@babel/parser` or
`oxc` for JS/TS, `parse5` for HTML, `postcss` for CSS. Regex is acceptable for Markdown and
JSON only. **Never regex JavaScript**; it will find references inside comments and strings and
produce exactly the silent corruption this design exists to prevent.

## Offsets are UTF-16 code units

`start` and `end` are indices into the JavaScript string — the same units every JS parser and
`String.prototype.slice` use. They are deliberately **not** byte offsets. A file containing an
emoji or a non-ASCII path would desynchronise the two, and every rewrite after that point
would land in the wrong place. There is a test for this in `edits.test.ts`.

## Edits and `applyEdits`

`applyEdits(source, edits)` is the primitive underneath every adapter's `rewrite`. It applies
range replacements from the end of the string backwards, so offsets earlier in the document
stay valid without any arithmetic.

It is deliberately strict, and throws rather than guessing when:

- a range is not a valid slice of the source (`INVALID_EDIT_RANGE`)
- two edits cover overlapping text (`OVERLAPPING_EDITS`)
- two edits start at the same offset, where the result would depend on order
  (`AMBIGUOUS_EDITS`)

`validateEdits` runs the same checks without applying anything, so the planner can reject a
whole run before a single byte is written.

## The transaction

Writing is two-phase, because a half-applied run is worse than a failed one.

**Prepare** — encode every image into `.upfly/tmp/<run-id>/`, compute every edit in memory,
validate the whole plan. Any failure here leaves the working tree completely untouched.

**Commit** — move images into place, write edited files, write `.upfly/manifest.json`, remove
the temp directory.

The manifest records every file touched with before/after hashes and every skipped reference
with its reason, so `upfly undo` can restore the tree even if the user never committed. On top
of that, `--apply` refuses to run on a dirty git tree unless forced, and `--commit` produces
exactly one commit — making `git revert` the real undo button and code review the trust
mechanism.

Windows specifics that are handled deliberately, not incidentally: cross-volume renames fall
back to copy + unlink, long paths are supported, and `EBUSY` is retried with backoff.

## Performance budget

Building the graph on a 10k-file / 2k-image repository must stay **under 3 seconds** cold.
File reads are parallel and adapter work runs in a worker pool. Encoding dominates wall-clock
time and is bounded by `--concurrency` (default `os.cpus() - 1`).

`bench/` is checked in and runs in CI against a fixed fixture, so a regression shows up as a
number rather than a feeling. Per the project rules, **any performance claim in the README must
come from a number `bench/` produced in CI** — the previous generation of this project shipped
unmeasured claims, and we are not repeating that.

## Package layout

| Package | Published as | Contains |
|---|---|---|
| `packages/core` | `@upfly/core` | graph, adapters, planner, transaction, report. No CLI or editor concerns, no network. |
| `packages/cli` | `upfly` | argument parsing, human/JSON output, exit codes, git safety. |
| `packages/vscode` | `upfly-vscode` | the editor surface (arrives in Phase 4). |

`fixtures/` holds small but real projects per framework, each with a `build` script. CI runs
`optimize --apply` against them and then builds them: if a build breaks, the reference
detection was wrong. **That test is the product's central promise**, so it gates every PR.
