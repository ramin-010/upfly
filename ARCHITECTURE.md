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

Everything is a pure function over data except three modules — `discover`, the `ImageProbe`
implementation, and `execute` — which are the only places that touch the filesystem. Even
`audit` is pure: it takes the graph and an injected probe and returns findings. That is what
lets the whole engine be tested without a disk.

```
discover(fs) ──► assets[], sourceFiles[]   images, plus files claimed by an adapter
        │                                  ignored paths pruned by directory name
        ▼
adapters.findReferences(file) ──► rawReferences[]
        │  syntax only: { file, start, end, rawPath, kind, ceiling, asserted }
        ▼
resolve(rawReferences, assets) ──► references[]
        │  final confidence = ceiling if it resolved, otherwise `unsafe`
        ▼
graph = link(assets, references)      asset → refs, ref → asset, unresolved buckets
        ▼
probe(assets) ──► dimensions, candidate encoded sizes     (read-only, injected)
        ▼
audit(graph, probe) ──► findings    dead / broken / oversized / opportunities
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

Notice that every tier above `unsafe` says *"resolved on disk"* — and an adapter is forbidden
from touching a disk. So confidence is assigned in **two steps**, by two different modules:

1. The **adapter** emits a `ceiling` on a `RawReference`: the best confidence this *syntax*
   could ever justify. A static `import` has a ceiling of `certain`; a runtime-concatenated
   path has a ceiling of `unsafe`.
2. The **resolver** produces a `Reference`, assigning the final `confidence`: the ceiling if
   the path resolved to an asset, `unsafe` if it did not.

Two types rather than one type with mutable fields, because it makes the illegal state
unrepresentable: an adapter cannot hand back something that claims to be resolved.

### Asserted versus speculative

An adapter also marks whether the syntax **asserts** that this is an asset reference.

An `import`, an `<img src>`, a `url()` — the author said so. If one of those does not resolve,
that is a **broken reference** and a real finding; it is how the engine catches a path an agent
hallucinated. But a path-shaped string inside a JSON file is a *guess*: the JSON adapter cannot
know whether `"icons/logo.png"` is an asset path or a translation key, because deciding that
would require resolving it. Those are emitted as **speculative**.

Unresolved speculative references are dropped from the graph rather than reported as broken.
Without that split, auditing any real repository drowns in false findings from `package.json`,
lockfiles and i18n bundles. They are still *counted* in the report, and listable in verbose and
JSON output, because a silent skip is a P0 bug — if the JSON adapter ever eats a real
reference, the user needs a way to find it.

### The fourth outcome: `unresolved-alias`

`import logo from '@/assets/logo.png'` is an asserted reference that will not resolve, because
alias resolution (tsconfig `paths`, Vite `resolve.alias`) does not land until Phase 2. Since
that import is everywhere in Next and Vite projects, treating it as broken would manufacture
exactly the false positives this design exists to avoid. Alias-shaped paths — `@/…`, `~/…`,
`#…`, bare specifiers — get their own bucket: reported, but not a finding.

So the resolver has four outcomes, not two: **resolved**, **broken** (unresolved and asserted),
**discarded** (unresolved and speculative), and **unresolved-alias**.

**A silent skip is a P0 bug.** If the engine declines to do something, the report says so.

## Adapters — the contribution surface

An adapter teaches Upfly to read one file format. This is where most contributions go, and
adding one should take about half an hour.

```ts
interface Adapter {
  readonly id: string;                    // 'jsx', 'html', 'css', 'vue', …
  readonly extensions: readonly string[]; // ['.html', '.htm']
  findReferences(input: { file: string; text: string }): RawReference[];
  rewrite(input: { text: string; edits: readonly Edit[] }): string;
}
```

Rules an adapter must follow:

1. **Never touch the filesystem.** It receives text and returns data.
2. **Never resolve paths.** Report `rawPath` exactly as written; the resolver decides what it
   points at. An adapter that resolves paths cannot be unit-tested without a disk. This is also
   why an adapter reports a `ceiling` rather than a confidence, and why "string values that
   resolve to an existing asset" is not something a JSON adapter can implement — it emits every
   path-shaped string as speculative and lets the resolver decide.
3. **Be pure.** Same input, same output, no globals.
4. **Report offsets of the path text only** — not the surrounding quotes or attribute.
5. **Ship a fixture and a table-driven test.** The compatibility matrix in the README is
   generated from fixture results, so an adapter without fixtures is invisible.

Parsing strategy: use a real parser wherever one is cheap and correct — `@babel/parser` or
`oxc` for JS/TS, `parse5` for HTML, `postcss` for CSS. Regex is acceptable for Markdown and
JSON only. **Never regex JavaScript**; it will find references inside comments and strings and
produce exactly the silent corruption this design exists to prevent.

## Discovery

`discover` walks the project once and returns two lists: image assets, and the source files some
adapter has claimed by extension. It is the first of the three modules allowed to touch a disk.

It is a hand-written breadth-first walker rather than a glob library, for one reason:
**the performance budget is won by pruning, not by matching.** A repository's `node_modules`
usually holds more files than everything else combined, and the only way to stay under the
budget is to never descend into it at all. A glob has to consider each path in order to reject
it; a walker drops the entire subtree on a single directory-name lookup. Walking also lets us
take the one `stat` we need per image during the same pass instead of a second traversal.

Directories are read a level at a time, up to sixteen in parallel — the limit is there to avoid
exhausting file descriptors, not to match CPU count, since this work is entirely IO-bound. A
shared work queue would parallelise slightly better at the very top of the tree, but needs
active-worker bookkeeping to stop workers exiting while a peer is still producing work, and
this module is meant to stay readable.

What it declines to do, it records. Symlinks and Windows junctions are not followed (a junction
reports as a symlink to `lstat`, which is why the check comes first — following one can put the
walk into a cycle or outside the root). Unreadable directories, unstat-able files and anything
that is neither a file nor a directory each land in `skipped` with a reason. None of it is
silently dropped.

Two details that are easy to get wrong:

- **Reported paths are POSIX-separated and relative to the root**, normalised in exactly one
  place. Ordering uses a code-unit comparator, never `localeCompare` — that is locale-dependent,
  so the same repository would produce differently ordered reports on two machines and the
  byte-identical-report rule would quietly become false.
- **`.upflyignore` is matched with the `ignore` package, and a directory must be tested with a
  trailing slash.** Given a `build/` rule, `ignores('build')` is `false` and `ignores('build/')`
  is `true`. Get that wrong and the walker descends into every ignored directory without ever
  reporting an error.

`.gitignore` is deliberately *not* honoured: generated-but-referenced assets under `public/` are
routinely gitignored, and skipping them would produce false "dead asset" findings.

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
File reads are parallel and adapter work runs in a worker pool.

That budget covers **discovery, parsing, resolution and graph building only**. Probing and
encoding are explicitly excluded and reported as a separate number: both are dominated by
libvips, and optimising against a target that included them would mean tuning our code against
somebody else's decode time. Both are bounded by `--concurrency` (default `os.cpus() - 1`).

`bench/` is checked in and runs in CI against a fixed fixture, so a regression shows up as a
number rather than a feeling. Per the project rules, **any performance claim in the README must
come from a number `bench/` produced in CI** — the previous generation of this project shipped
unmeasured claims, and we are not repeating that.

## Package layout

| Package | Published as | Contains |
|---|---|---|
| `packages/core` | `upfly-core` | graph, adapters, planner, transaction, report. No CLI or editor concerns, no network. |
| `packages/cli` | `upfly` | argument parsing, human/JSON output, exit codes, git safety. |
| `packages/vscode` | `upfly-vscode` | the editor surface (arrives in Phase 4). |

`fixtures/` holds small but real projects per framework, each with a `build` script. CI runs
`optimize --apply` against them and then builds them: if a build breaks, the reference
detection was wrong. **That test is the product's central promise**, so it gates every PR.
