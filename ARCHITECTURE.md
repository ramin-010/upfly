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

Two stages need one filesystem fact each without being filesystem modules, and both take it as
an **injected port**: `scan` takes `readFile`, and `resolve` takes `exists`. The probe stage takes
the `ImageProbe` port the same way. A port keeps the count at three and keeps each stage
unit-testable against an in-memory map.

```
discover(fs) ──► assets[], sourceFiles[]      images, plus files claimed by an adapter
        │        excludedRoots[]              each pruned directory + the rule that pruned it
        │        skipped[]                    symlinks, unreadable entries, with reasons
        │        unscannedFiles[]             files no adapter claimed — kept with their paths
        ▼
scan(sourceFiles, adapters, readFile) ──► rawReferences[], unscanned[]
        │  syntax only: { file, start, end, rawPath, kind, ceiling, asserted }
        │  a file that will not parse becomes a reported entry, never an exception
        ▼
resolve(rawReferences, assets, excludedRoots, exists) ──► references[]
        │  an eight-rung ladder producing one of seven outcomes
        │  final confidence = ceiling if it resolved, otherwise `unsafe`
        ▼
graph = buildGraph(assets, references, unscannedFiles) ──► asset ↔ refs, via isLinked()
        │  byResolution[]         every reference bucketed, so none can be lost
        │  unscannedFiles[]       both sources merged: unclaimed extensions and parse failures
        ▼
probeAssets(assets, probe, formats) ──► dimensions, pages, measured encoded sizes
        │  read-only port; header reads are free, encodes are not — hence `formats`
        │  EXCLUDED from the 3 s budget (§3.4) and reported as its own number
        ▼
audit(graph, probe) ──► findings    dead | possibly-dead / broken / oversized / opportunities
        ▼
plan(graph, config) ──► { assetPlans[], edits[] }     only confidence ≤ medium
        ▼
validate(plan)                     overlaps, writability, conflicting plans
        ▼
execute(plan) ──► manifest         encode → temp, then write, then edit, then manifest
        ▼
buildReport(graph, audit, discovery, sweep, probes) ──► Report
        │  versioned JSON (public API) · every path POSIX-relative · no timestamps
        ▼
renderReport(report) ──► text     numbers, then the SKIPPED list, then findings
```

## Confidence tiers — the core idea

Every reference carries a confidence, and the planner only rewrites the top three:

| Tier | Means | Rewritten? |
|---|---|---|
| `certain` | Static `import`/`require`, resolved on disk | yes |
| `high` | String literal in a known attribute or function, resolved on disk | yes |
| `medium` | Template literal with a static prefix, glob-matched against the assets | only if every match converts alike |
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

### The resolver's seven outcomes

"Resolved or broken" is not enough, and every extra outcome below exists because some real
syntax would otherwise be reported as broken. Zero false `broken` findings is the phase's exit
criterion, so this is where most of the design pressure lands.

Five cases refuse to fit:

- `import logo from '@/assets/logo.png'` is asserted and will not resolve, because alias
  resolution (tsconfig `paths`, Vite `resolve.alias`) only resolves it when the project actually
  declares that alias and the declaration can be read **statically**. That import is everywhere in
  Next and Vite projects, and what is left over still must not be called broken.
- `url($hero)` never had a static path at all. A literal path pointing at nothing is a real,
  actionable finding; a path the preprocessor builds is simply not knowable, and nobody typed a
  wrong path.
- `` `./images/${name}.png` `` is a *pattern*. Resolved literally it fails; treated as a glob it
  may name a dozen assets, and all of them must be linked.
- `url(inter.woff2)` points at a real file the engine does not track at all.
- A reference into a directory the walk pruned — the common case being a user who put `legacy/`
  in `.upflyignore` while `legacy/` is still referenced — points at a file that really is there.

So the resolver runs a numbered ladder, and **the order is load-bearing**:

| # | Test | Outcome | Example |
|---|---|---|---|
| 1 | `ceiling === 'unsafe'` | `dynamic` | `url($hero)` |
| 2 | `ceiling === 'medium'` | `resolved-pattern` / `dynamic` | `` `./img/${name}.png` `` |
| 3 | not a tracked extension | *dropped, no report line* | `./inter.woff2` |
| 4 | resolves in the asset set | `resolved` | `./hero.png` |
| 5 | under an excluded root, or exists on disk | `out-of-scope` | `../legacy/old.png` |
| 4b | alias-shaped, and a declared alias matches | `resolved` | `~/assets/logo.png` |
| 6 | alias-shaped, nothing matched | `unresolved-alias` | `@/assets/logo.png` |
| 6b | a package specifier | `out-of-scope` | `@11ty/logo/img/logo.png` |
| 7 | asserted | `broken` | `./missing.png` — a real finding |
| 8 | otherwise | `discarded` | a path-shaped string in `package.json` |

The ceiling tests come first because if there is no static path, every later question is
meaningless. **Rung 3's position is the subtle one**, and it is wrong in both directions: moved
above the ceiling tests it silently swallows `url($hero)` and `` `/img/${file}` `` — real dynamic
references with no extension to test — and moved below rung 4 it turns every `url(inter.woff2)`
into a broken finding. There is a test for each failure mode, because the placement is invisible
otherwise.

Two outcomes deserve their own note.

**`resolved-pattern` links every match, not one.** A `medium` template becomes a glob, each
`${…}` becoming `[^/]*` so a hole cannot cross a directory boundary. One or more matches and it
resolves, carrying all of them; zero matches and it is `dynamic`, never `broken`. Linking only
the first would leave the rest looking unreferenced, which is a false `dead asset` finding
wearing a different costume. Whether such a reference is *safe to rewrite* is Phase 2's question,
and the rule there is that every asset the pattern matches must convert to the same target
extension.

**Root-relative paths try every serving root that is an *ancestor* of the referencing file**,
nearest first, then the project root. A monorepo has one `public/` per app — shadcn-ui has twelve —
and a file under `apps/v4/` that writes `/images/hero.png` means `apps/v4/public/`. Resolving that
against a single serving root produced **93 false `broken` findings** on it.

The restraint matters as much as the list. Trying *every* configured root looks free ("more roots can
only turn a false `broken` into a correct link") and is not: measured, it linked 23 references to
**another app's asset**, which Phase 2 would then rewrite to a file that app does not serve. The
guarantee holds only when every root serves the same URL space, and a monorepo's do not — so
proximity filters rather than merely orders. A false `broken` costs five minutes; a false link costs
a broken build.

**`out-of-scope` is not `resolved`.** It carries a `resolvedPath` — we know exactly where it
points — but Phase 2 must not rewrite it: the target was never converted, so pointing the
reference at a `.webp` would break something that works today. It also carries the
`exclusionReason`, naming the actual rule (`the ignore rule 'legacy/'`) rather than a generic
"excluded", because that is the difference between a report line that explains a missing asset
and one that just mentions it.

### The resolver is pure, and its one filesystem need is a port

Resolution happens against the **asset set** `discover` returned, not against a disk. That is
what keeps the two-step confidence rule honest — the adapter knows syntax, the resolver knows
what exists — without adding a fourth module that touches a filesystem.

The exception is rung 5's fallback: a file excluded by a *file-level* ignore rule such as
`*.png` leaves no pruned directory to match against, so the only way to tell "excluded" from
"missing" is to look. That is an injected `exists` port, the same shape as the `ImageProbe`, and
it is consulted **only** for a reference about to be called broken — a set that should number in
the tens. It is a required option rather than an optional one, because a default would let a call
site keep the false `broken` silently.

### Ask `isLinked`, never `resolution === 'resolved'`

Two of the seven outcomes are linked into the graph, so:

```ts
export function isLinked(ref: Reference): ref is Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>;
export function linkedPaths(ref: Reference): readonly string[];
```

This is not a convenience. `if (ref.resolution === 'resolved')` compiles, runs, and silently
ignores every pattern reference — a false negative the compiler cannot see, and precisely the
class the validation protocol exists to catch. The graph builder, the audit and the planner call
`isLinked`; nothing outside the resolver compares `resolution` by hand, and every `switch` over
it carries a `never`-typed default so an eighth outcome breaks the build instead of quietly
un-linking a whole category.

### A link says the asset is alive; `resolvedVia` says whether the text may be edited

Being linked and being rewritable are different questions, and conflating them is how a tool
breaks a build. Every linked reference records **how** it reached its target:

| `resolvedVia` | what happened | may the text be rewritten? |
|---|---|---|
| `file` | relative to the referencing file's directory | yes — the base is unambiguous |
| `serving-root` | root-relative, against a configured serving root | yes |
| `project-root` | root-relative, and no configured serving root held it | **open** — see below |
| `speculative-root` | a speculative `./` path retried against the project root | no (R15) |

`speculative-root` is a guess at the base of a string that was already a guess: a path-shaped
literal in a data object may well be joined to some other directory at runtime, so the match is
evidence the asset is **alive** and nothing more. Rewriting it could point a working reference at
a file the code never loads.

⚠️ **These were one value until R36, and the merge was costing real rewrites.** Measured across
the five validation repositories, `project-root` occurs **1,325** times with **1,267 asserted** —
almost all of them `<img src="/favicon.png">` in hand-written HTML on a site with no build step,
where the project root genuinely *is* the serving root — while `speculative-root` occurs **10
times and is never asserted**. Treating a static site's ordinary reference as the same evidence as
a guess-on-a-guess would decline to rewrite most of that repository, and repositories like it are
the ones this product is for.

⚠️ **`project-root` is still not unconditionally safe, and the unsafe sub-case is unmeasured.** If
a serving root *is* configured and correct, a root-relative path that misses it and happens to
exist at the project root is a false link. There are **zero** occurrences across all five repos —
wherever a serving root matched, its candidate won first — so the risk is real but unevidenced,
and whether the planner may rewrite this class is deliberately left open rather than assumed.

The counts reach the JSON as `references.byResolvedVia`. Before that they existed only inside the
resolver, which meant no consumer could tell a guess from an ordinary resolution and the planner
would have had nothing to cite when it declined one — and a silent decline is a rule 9 P0.

### Aliases are read, never executed

`@/assets/logo.png` resolves only if the project declares that alias somewhere the engine can read
**without running anything**. `loadAliases` parses `tsconfig`/`jsconfig` `paths` (following `extends`,
including by name into `node_modules`) and `vite.config.*` `resolve.alias`, and hands the resolver a
map; the resolver stays pure.

🔴 **A config is read statically or not at all, and that is a hard line rather than a trade-off.**
Every `resolve.alias` in the validation corpus is `'@': path.resolve(__dirname, './src')` — a
JavaScript expression. Evaluating it would mean **executing a config file from a repository the user
did not write**, in a tool they ran to save bytes. No byte saving buys that. Where the static read
cannot see a value, the alias is reported as unreadable **with its file and line**, because a
limitation a user can see is worth more than a resolution they cannot trust.

Two details that are easy to get wrong:

- **`tsconfig.json` is JSONC.** Comments and trailing commas are legal and common, and `JSON.parse`
  throws on both. It is parsed with `@babel/parser` — a JSONC document *is* a JavaScript object
  literal — rather than by stripping comments with a regex, which would be "never regex JavaScript"
  wearing a different extension. Values are read off the AST, never reconstructed into an object.
- **A tsconfig key and a Vite key mean different things.** `"@/*"` is a pattern whose `*` says
  "prefix"; a Vite string key is *always* a prefix replacement, so `{'@': './src'}` turns
  `@/x.png` into `./src/x.png`. Treating the Vite form as an exact match resolves nothing at all.

Aliases are scoped to the directory of the config that declared them. `shadcn-ui` has roughly twenty
configs all defining `@/*`, and without scoping every one of them would offer a candidate for every
reference in the workspace.

⚠️ **A package specifier is not an alias** (rung 6b). `@11ty/logo/img/logo.png` names a file inside
`node_modules`, which the walk prunes — so no alias configuration will ever resolve it, and leaving
it in `unresolved-alias` would promise a resolution that is never coming. `unresolved-alias` means
*"we expect to resolve this once aliases land"*: it is a promise, not a description. The two shapes
differ by one character — `@/…` has an empty scope, which no registry permits.

### Non-asset extensions are the resolver's business

`url(inter.woff2)` in an `@font-face` is a perfectly asserted reference to a file the engine
does not track. Adapters deliberately do **not** filter by extension: the tracked-extension
policy lives in one place so it is not re-implemented across six adapters and forgotten by the
sixth contributor, and so that adding SVG or video later flows through automatically.

These are dropped without a report line. That is not a silent skip — a `.woff2` was never a
candidate asset, so declining it is not declining to do work, and counting fonts would be noise.

**A silent skip is a P0 bug.** If the engine declines to do something, the report says so.

### `possibly-dead`, and why "zero references" is usually a lie

An asset referenced only from a `.vue`, `.svelte` or `.njk` file has zero references for a reason
that has nothing to do with the asset: no adapter reads that format yet. Calling it dead is a false
positive we manufactured ourselves. The `eleventy` fixture has two of them — `logo.png` and
`favicon.png` are referenced only from `.njk` templates, and both would otherwise be reported dead.

⚠️ **`.astro` used to be the example here, and it is the best evidence for why this rule exists.**
The `astro` fixture's `logo.png`, `favicon.png` and `banner.png` were all hedged; the Astro adapter
landed in B1 and all three became ordinary links, taking that tree's hedges from three to zero and
leaving its one genuinely unused asset still reported `dead`. **The hedge was doing exactly its job
— standing in for coverage we did not have yet — and the fix for a hedge is an adapter, not a
softer label.**

The obvious rule — hedge globally whenever some extension went unread — degenerates. Measured on
this repository, the unread list is `.astro`, `.njk`, `.yaml`, `.yml`, three dotfiles and
`LICENSE`. It is never empty on a real project, so `dead` would never fire, and a label that
always fires carries no information. A curated allowlist of "extensions that can reference an
image" is the other wrong answer: it is a place to be wrong in the direction that ships a false
`dead`.

**So the hedge is per-asset.** `discover` records every file it did not read *with its path*, and
`scan` adds every file it could not parse. For each asset with zero references, the audit sweeps
that text for the asset's filename — one pass building a set of names, not one pass per asset:

- **A hit → `possibly-dead`**, and the report names the file: *"`hero.png` — referenced in
  `config.yaml`, which Upfly cannot parse."* That is actionable; a global hedge is not.
- **No hit → `dead`**, confidently.

`unscannedExtensions` is still reported. It stops being the trigger and becomes what it should
always have been: a coverage statement, and how a user finds out they want an adapter.

The sweep reads three things, cheapest first: files **no adapter claimed**, the raw path of every
reference we **could not resolve**, and — only if something is still unexplained — the files we
**did** read. That last one earns its double read rarely: a template literal in an object property
parses fine and yields no reference, so nothing else covers it.

**No basename sweep can rescue a filename assembled at runtime.** `` `background-${dir}.png` `` never
contains the string `background-ltr.png`, so there is a test pinning that limit — of *the sweep*, so
nobody "fixes" it for a case no sweep can reach.

⚠️ **But a limit of one mechanism is not a limit of all of them, and this paragraph used to claim it
was.** It read "two astro-docs assets stay confidently dead for that reason, correctly." They are
not dead: a template literal carries a `medium` ceiling, the resolver globs it, and
`resolved-pattern` links every match. Both are live findings today. The lesson is worth more than
the correction — **when one mechanism cannot reach a case, check whether a different existing
mechanism already does before calling the limit fundamental.**

Two things belong in that swept text for reasons that are not obvious. **An SVG is both an asset
and a container** — `<image href>`, `<use href>` and a `<style>` block inside one are all real
references and no adapter reads them — so `.svg` is recorded as unread even though it is also an
asset. And **a reference we read but could not resolve names no asset**: eleventy's
`![](({{ site.url }}/img/templated.png)` is `dynamic`, so `templated.png` links to nothing and
looks dead while being demonstrably alive — the same manufactured false positive arriving from
the other direction. Whether those unresolved paths join the swept text is **raised and awaiting
a ruling** (R10 in `../notes/STATE.md`); the fixture suite already asserts what the
recommendation asks for. Directories the user *excluded* are deliberately not
swept: an ignore rule is an instruction, not a gap in our coverage, and the report carries one
global caveat line naming them instead.

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

### The six that exist

| Adapter | Extensions | Reads | Parser |
|---|---|---|---|
| `astro` | `.astro` | the frontmatter fence as TypeScript **and** the template body as HTML | delegates to `javascript` + `html` |
| `css` | `.css .scss .less` | `url()`, `image-set()` | `postcss` + `postcss-value-parser` |
| `html` | `.html .htm` | `src`, `srcset`, `poster`, `<source>`, icon and preloaded-image `<link>`, `<style>`, `style=""` | `parse5` |
| `javascript` | `.js .jsx .mjs .cjs .ts .tsx .mts .cts` | `import`, `require()`, `import()`, `new URL(…, import.meta.url)`, JSX `src`/`srcSet`/`poster`, CSS-in-JS | `@babel/parser` |
| `markdown` | `.md .mdx .markdown` | `![]()`, `[]()`, link reference definitions, raw HTML | regex over masked text |
| `json` | `.json` | every path-shaped string **value**, as a speculative candidate | regex |

The JavaScript adapter also emits **path-shaped string literals as speculative**, the same standing
a string in a JSON file gets. The asymmetry was indefensible once stated: `{ "file": "x.png" }` in
`data.json` was a candidate and the identical string in `data.ts` was invisible — and that produced a
*confidently dead* asset on a real repository. A candidate that resolves becomes a real link, which
beats a hedge because the rewrite can act on it; one that does not is discarded — **counted in the
report, and listable with `--include-discarded`**, because a candidate the JSON adapter ate in error
is invisible unless the count says something is wrong and the list says what. It leaves
alone any value a construct examined and declined: `alt="/not.png"` is display text, and overturning
that decision would rewrite it.

Three things they share, and each was a bug before it was a rule:

- **CSS is read in one place.** An HTML `<style>` element, a `style=""` attribute and a
  `styled.div` template all go through the CSS adapter's scanner rather than a second, weaker
  implementation. Markdown hands its raw HTML to the HTML adapter for the same reason.
- **Mask before you match.** The Markdown adapter blanks fenced blocks, code spans and HTML
  comments with spaces *of identical length* before running any pattern, so a `![](old.png)` in a
  documentation example is invisible while every offset after it stays exact. The JavaScript
  adapter does the same to flatten a CSS-in-JS template, replacing each `${…}` with a CSS comment
  of matching length — a comment rather than a SCSS interpolation, because `styled.div` templates
  routinely open with `${baseStyles}` at statement level, where an interpolation fails to parse
  and would cost the real `url()` below it.
- **A `?query` or `#fragment` sits outside the reference range.** Rewriting swaps `hero.png` for
  `hero.webp` and leaves the author's `?v=2` alone. Including it would also make the path
  unresolvable and produce a false broken finding.

Two places where the same character means opposite things, both settled by `kind`:

- A leading `#` is a document fragment (`url(#gradient)`) everywhere except a module specifier,
  where `#internal/img.png` is a Node subpath import. `isExternalUrl` takes the reference `kind`
  as a **required** argument for exactly this — a default would let a call site keep the wrong
  reading silently, and dropping a subpath import made it vanish from every report under no
  reason at all.
- `#{` opens a SCSS interpolation, so it is never treated as a fragment.

## Discovery

`discover` walks the project once and returns three lists: image assets, the source files some
adapter has claimed by extension, and the files nobody claimed. It is the first of the three
modules allowed to touch a disk.

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

Discovery also records **what it excluded, and why**. Every pruned directory lands in
`excludedRoots` with the rule responsible — a built-in name prune, or the specific `.upflyignore`
pattern that matched. It keeps the raw pattern list to do that, because `ignore` reports *whether*
a path matches but not *which* pattern did, and "excluded by some rule you wrote" is a much worse
report line than "excluded by `legacy/`" when someone is working out where their asset went. The
resolver prefix-tests references against these to produce `out-of-scope` instead of a false
`broken`.

It records what it **did not read**, too. Every file no adapter claimed lands in `unscannedFiles`
with its path, which is what the audit sweeps to decide `dead` against `possibly-dead`. Ignored
and pruned entries are deliberately absent — an ignore rule is an instruction, not a gap in our
coverage — and neither is the ignore file itself, which we obviously did read.

## Scanning — one place that owns adapter failure

`scan` reads each source file and hands the text to the adapter that claimed it. It exists
because nothing owned that loop, and because the adapters throw.

`css` and `javascript` raise `ADAPTER_PARSE_FAILED` when a file will not parse. That is right —
returning `[]` would report a file full of references as clean — but a throw nobody catches means
**one unparseable `.scss` in a five-thousand-file repository kills the whole audit**, and the
real-world validation repos will contain one. So `scan` catches it into a reported entry carrying
the file and the parser's message, and that entry feeds the same per-asset sweep as a file no
adapter claimed. The two are the same condition: we did not learn what the file references.

It catches *every* throw, not only ours. Adapters are the contribution surface, and a bug in a
community adapter must not take down an audit of a repository that adapter barely touches — while
still being visible in the report rather than merely survived.

`readFile` is injected. That keeps the count of filesystem-touching modules at three, and it means
the module that owns error handling for every adapter is exercised against an in-memory file map
instead of a directory full of deliberately broken files. It deliberately does not return the file
texts: holding a whole repository's source in memory to save a later re-read trades a bounded cost
for an unbounded one.

## The graph

`buildGraph` is pure. It links each reference to the assets it resolved to — **through
`linkedPaths`, never by comparing `resolution`** — and returns an `AssetNode` per asset alongside
`byResolution`, every reference bucketed by outcome.

That bucketing is a correctness device, not a convenience. It is a `Record<Resolution, …>` literal,
so an eighth outcome fails to compile *here* rather than quietly vanishing from the report — the
same guarantee `linkedPaths` gets from its `never`-typed default. A reference cannot go missing
from the report without also going missing from a bucket, which makes rule 9 mechanical instead of
remembered.

**Ordering is by POSIX-relative path, not by `Reference.file`.** `file` is an absolute native path,
and `/` (0x2F) and `\` (0x5C) fall on opposite sides of the alphanumerics: sorting it puts
`dir/a.html` before `dirZ.html` on Linux and *after* it on Windows. Rule 11 — same inputs,
byte-identical report — would then be quietly false, and nobody would notice until two people
compared reports. The test for it only has teeth on Windows, because on POSIX the relative path is
a suffix of the absolute one and the two implementations cannot disagree.

A reference that links to a path outside the asset set throws `GRAPH_UNKNOWN_ASSET`. That cannot
happen in a single run — the resolver only ever returns paths it took from those very assets — but
it can the moment references are resolved against a cached asset set, which is exactly what the
editor integration will do. The quiet version of that bug is a phantom dead asset.

## The probe — and why it has two methods

Two of the four audit findings need pixels: `oversized` needs dimensions, and format opportunities
must be **measured**, not guessed. `ImageProbe` is the port that provides them, injected like the
resolver's `exists`; `createSharpProbe` is the implementation and one of the three modules that
touches a disk. It is read-only and Phase 2's writing encoder extends it.

The port is split into `metadata()` and `encodedBytes()` because the two cost wildly different
amounts. Measured on sharp 0.35.4 / libvips 8.18.6 with noise-filled sources:

| source | `metadata()` | webp | avif |
|---|---|---|---|
| 400×300 | 2 ms | 56 ms | 317 ms |
| 1200×800 | 1 ms | 370 ms | 2 975 ms |
| 2400×1600 | 1 ms | 2 620 ms | 9 026 ms |

Reading a header is free and independent of pixel count; an encode is three orders of magnitude
dearer and AVIF is roughly eight times WebP. A single combined `probe()` would make every caller pay
for an encode to learn a width, so dimensions are always affordable and encoding is something a
caller asks for by name — `formats` is required and has no default, because the default belongs to
config, where locked decision 3 already put it: **webp**, with AVIF opt-in via `--format avif`. The
audit measures the format it would actually convert to; measuring one the tool would not produce is
work nobody asked for.

### The cap is a count, not a threshold or a deadline

Even at WebP alone, two thousand images is twelve minutes, and `audit` is meant to be the fast
read-only command. So `maxEncodedAssets` bounds how many assets are encoded — and the two obvious
alternatives are both wrong:

- **A byte threshold bounds nothing.** Encode cost tracks pixel count, not file size, so a threshold
  does no work at all on a repository of three thousand large images — precisely the "large public
  directory" that the validation protocol requires us to test against.
- **A duration budget would break rule 11.** Byte-identical output for the same inputs means a slow
  machine must not measure fewer assets than a fast one.

Selection is largest source first, ties broken by path, so *which* assets are measured is a
deterministic function of the repository. Assets that could never be encoded — a vector, or one
already in every requested format — leave the running before the cap applies, so they cannot occupy
a slot they will not use. A byte or pixel floor can sit underneath as a secondary filter; the count
is what bounds.

What makes this safe is that it degrades exactly **one** of the four findings. `dead` and `broken`
need no probe at all, and `oversized` needs only the ~1 ms header read, which still happens for every
asset however low the cap goes. Everything past the cap is reported as unmeasured, with a count, a
reason and the flag that lifts it — silence would read as "no opportunity here". The default comes
from `bench/` rather than a guess, like the concurrency number.

### Animation is the trap

Encoding an animated GIF the obvious way keeps **one frame**. Sharp's own ten-frame, 370×285 fixture
encodes to 616 bytes that way, against 8 370 bytes for the real thing. Reported as a format
opportunity that is a ~92% saving achievable only by destroying the image — a headline finding in the
audit and a corrupted file when the rewrite acts on it.

The asymmetry is the thing to remember: **`encodedBytes` must pass `animated` and `metadata()` must
not**, and getting either backwards produces a confidently wrong number in opposite directions — a
phantom 92% saving, or an image reported ten times too tall.

So `encodedBytes` takes `animated`, and `probeAssets` passes `pages > 1` from the metadata it already
holds. And `metadata()` is deliberately a *plain* read: with `{ animated: true }` that same file
reports 370×**2850**, every frame stacked into one strip, which would make an "oversized by
dimensions" finding wrong by a factor of ten. The plain read gives one frame's dimensions and still
reports `pages`, answering both questions in one pass.

### Nothing throws for a bad image

A zero-byte file, a truncated JPEG, a text file wearing a `.png` extension, a file that vanished
mid-run — every one becomes an `AssetProbe` carrying `metadata: null` and a recorded reason. Sharp
rejects for all of them and `failOn: 'none'` does not help, since it governs decode warnings rather
than header parsing. Measurements not taken are listed with reasons for the same reason skipped
references are: silence would read as "no opportunity here".

Sharp is imported **lazily**. It is a native module, and the previous generation of this project
shipped one built for a single platform and was broken everywhere else for months. A top-level import
would load the binary the moment anything in `upfly-core` is imported, so `upfly audit --no-probe`
would fail on a machine that needs no pixels at all.

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

🔴 **That budget is currently MISSED, and this section used to describe a design that does not
exist.** It read "file reads are parallel and adapter work runs in a worker pool." There is no worker
pool; nothing has ever run adapter work off-thread. It was written from a diagnosis that measurement
later inverted: parsing was believed to be about a sixth of the cost and is **77% of `scan`**, with
Babel over `.tsx` alone reaching 41% of the whole budget. The earlier number came from a benchmark
tree holding real code's file count and **a thirtieth of its bytes**.
Measured on a recalibrated tree: **12,518 ms**, stable at 3% across three separate invocations.
File reads *are* parallel. The fix — a worker pool, a faster parser, or both — is Phase 2 scope with
this section as its brief. **The budget number does not move until a fix is measured.**

That budget covers **discovery, parsing, resolution and graph building only**. Probing and
encoding are explicitly excluded and reported as a separate number: both are dominated by
libvips, and optimising against a target that included them would mean tuning our code against
somebody else's decode time. **They are bounded separately, because their profiles are opposite:**
reads are IO-bound and default to **16 at a time** (`scan.ts`), encodes are CPU-bound with libvips
already multithreading internally and default to **4** (`probe.ts`) — measured, where the
`os.cpus() - 1` this line used to claim was an assumption and about 21% worse.

`bench/` is checked in and runs in CI against a fixed fixture, so a regression shows up as a
number rather than a feeling. Per the project rules, **any performance claim in the README must
come from a number `bench/` produced in CI** — the previous generation of this project shipped
unmeasured claims, and we are not repeating that.

## The report

The JSON is public API and carries `version`. It is snapshot-tested over all five fixture trees, so a
schema change shows up as a diff somebody has to approve rather than as tests that still pass.

**No absolute path reaches it.** Half the data upstream carries an absolute `path` beside a POSIX
`relative` — `SkippedEntry`, `ExcludedRoot`, `UnscannedFile`, `Reference.file` — and the validation
protocol runs the same repository from two working directories and requires byte-identical output.
Projecting to the relative form is the report's job, and the guard is a test that serialises the
report and greps it for the root. It is one forgotten projection away from being false.

Everything declined, from every stage, lands in **one flat `skipped` list** rather than five
per-stage ones. Rule 9 is easier to keep when there is a single place to append to.

Two calls about references are worth knowing:

- The unsafe bucket — `dynamic`, `unresolved-alias`, `out-of-scope` — is **listed in full**. It is
  the "N references I couldn't safely rewrite" number, and it is the honesty that earns trust for
  everything else on the page.
- `discarded` is **counted, not listed**. A real repository produces thousands of them from lockfiles
  and i18n bundles, and listing them buries everything else. The count is still there, because it is
  what tells a user the JSON adapter has started eating something real.

### `findings` holds what there is something to do about (schema 2, R22)

⚠️ **It is not every finding the audit produced.** An unreferenced **vector** is moved to
`unusedVectors` — a count and a total size — because Upfly neither converts a vector nor deletes an
asset, so itemising one proposes the only two things it will not do. `--include-unused-svg` lists
them; `summary.findings` counts the itemised array, so the two can never disagree. On `astro-docs`
this is what takes the unreferenced-asset findings from 150 to 24, and the hedges from 140 to 18.

The argument is **"we offer no action", not "vectors are small"** — the second is false, and measured:
SVG is 96% of `shadcn-ui`'s hedged bytes and `eleventy-docs`' nine vectors are 210 KB. That is why the
counted line carries the size: §8 decision 7 leaves the reader holding the decision, and a total is
what turns a count into one. SVGs stay in reference tracking throughout — a broken
`<img src="/logo.svg">` is a broken image like any other.

The set of vector extensions lives in `paths.ts`, not in the probe, because **two decisions depend on
it being the same set**: what the probe declines to encode, and what the report declines to itemise.

One exception keeps a vector itemised: if a broken reference asks for its raster twin (`hero.svg`
unreferenced beside a broken `hero.png`), the pair lands in `staleConversions` and the vector stays in
`findings` — there *is* an action, which is to fix the reference. It is phrased as two facts and an
inference the reader judges, never as a conclusion.

### The human renderer prints the skipped list before the findings

That ordering is deliberate and slightly uncomfortable: it puts what the tool could *not* do above
what it found. A limitation printed after eighty findings is a limitation nobody reads, and the
previous generation of this project lost trust by failing quietly.

Nothing in it uses `toLocaleString` or `Intl`. Locale-dependent formatting would render `1,5 MB` on
some machines, which breaks the byte-identical rule exactly the way `localeCompare` would — so bytes
are formatted by hand. Colour is the CLI's business, since that is the layer that knows about TTYs
and `NO_COLOR`.

Caveats carry their own count and a `detail` list. "No adapter reads these file types" is a shrug;
`.astro — 1 file` is how someone finds out which adapter they want.

## Package layout

| Package | Published as | Contains |
|---|---|---|
| `packages/core` | `upfly-core` | graph, adapters, planner, transaction, report. No CLI or editor concerns, no network. |
| `packages/cli` | `upfly` | argument parsing, human/JSON output, exit codes, git safety. |
| `packages/vscode` | `upfly-vscode` | the editor surface (arrives in Phase 4). |

`fixtures/` holds small but real projects per framework, each with a `build` script. CI runs
`optimize --apply` against them and then builds them: if a build breaks, the reference
detection was wrong. **That test is the product's central promise**, so it gates every PR.
