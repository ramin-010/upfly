# Architecture

This document explains how Upfly works internally. It is written for someone who wants to
change the code: read it before opening a PR. If you find it out of date, that is a bug;
please say so in an issue.

## The problem

Converting an image is trivial: `sharp('hero.png').webp().toFile('hero.webp')`. Dozens of
tools do it.

The hard part is that `hero.png` is *referenced*: from an `import` in a React component, a
`src` attribute in an HTML file, a `url()` in a stylesheet, a `srcset` on a `<picture>`, a
path in a JSON manifest. Convert the file and every one of those references breaks. That is
why most tools either refuse to touch existing files or quietly break builds.

Upfly's job is the second half: **know every place an asset is referenced, and rewrite those
references safely, or refuse, loudly.**

## The pipeline

Everything is a pure function over data except the modules that meet the disk: `discover`
walks it, the `ImageProbe` implementation reads and encodes images, the transaction's file
store writes, and `runPipeline` (`pipeline.ts`) hands the other stages their ports on the real
filesystem. Even `audit` is pure: it takes the graph and the probe's measurements and returns
findings. That is what lets the whole engine be tested without a disk.

`runPipeline` is the one wiring of these stages: `bench/`'s validation and its fixture builds
both call it, so their numbers describe one engine. The accuracy suite resolves its scan under
the same `decideServingRoots` for its unconfigured run. The write path has one wiring too:
`optimizeProject` (`optimize-project.ts`) runs the pipeline with every image measured and hands
its output to `optimize`, and both `upfly optimize` and the fixture builds call it, so what the
builds prove is what users run.

Two stages need one filesystem fact each without being filesystem modules, and both take it as
an **injected port**: `scan` takes `readFile`, and `resolve` takes `exists`. The probe stage takes
the `ImageProbe` port the same way. A port keeps each stage off the disk and unit-testable
against an in-memory map.

```
discover(fs) ──► assets[], sourceFiles[]      images, plus files claimed by an adapter
        │        excludedRoots[]              each pruned directory + the rule that pruned it
        │        skipped[]                    symlinks, unreadable entries, with reasons
        │        unscannedFiles[]             files no adapter claimed, kept with their paths
        ▼
scanSources(sourceFiles, adapters, readFile) ──► rawReferences[], unscanned[]
        │  syntax only: { file, start, end, rawPath, kind, ceiling, asserted }
        │  a file that will not parse becomes a reported entry, never an exception
        ▼
resolveReferences(rawReferences, assets, excludedRoots, exists) ──► references[]
        │  an eight-rung ladder producing one of seven outcomes
        │  final confidence = ceiling if it resolved, otherwise `unsafe`
        ▼
buildGraph(assets, references, unscannedFiles) ──► asset ↔ refs, via isLinked()
        │  byResolution[]         every reference bucketed, so none can be lost
        │  unscannedFiles[]       both sources merged: unclaimed extensions and parse failures
        ▼
probeAssets(assets, probe, formats) ──► dimensions, pages, measured encoded sizes
        │  header reads are free, encodes are not, hence `formats`
        │  outside the 3 s graph budget (see "Performance budget"), reported as its own number
        ▼
audit(graph, probes) ──► findings    dead | possibly-dead / broken / oversized / opportunities
        ▼
planOptimization(graph, …) ──► conversions, rewrites, declined     rewrites `certain` and `high` only
        ▼
optimize(plan) ──► manifest    stage (encode), prepare (check it all), commit (write, edit, remove)
        ▼
buildReport(graph, audit, discovery, sweep, probes) ──► Report
        │  versioned JSON (public API) · every path POSIX-relative · no timestamps
        ▼
renderReport(report) ──► text     numbers, then the SKIPPED list, then findings
```

## Confidence tiers

Every reference carries a confidence, and the planner rewrites only the top two:

| Tier | Means | Rewritten? |
|---|---|---|
| `certain` | Static `import`/`require`, resolved on disk | yes |
| `high` | String literal in a known attribute or function, resolved on disk | yes |
| `medium` | A path with a static prefix and unknown parts (a template literal, a `+` chain), glob-matched against the assets | never: its text is a pattern, not a path |
| `unsafe` | Dynamic concatenation, variable-only paths, unresolvable | **never** |

Both rewritable tiers say *"resolved on disk"*, and an adapter is forbidden from touching a
disk. So confidence is assigned in **two steps**, by two different modules:

1. The **adapter** emits a `ceiling` on a `RawReference`: the best confidence this *syntax*
   could ever justify. A static `import` has a ceiling of `certain`; a runtime-concatenated
   path has a ceiling of `unsafe`.
2. The **resolver** produces a `Reference`, assigning the final `confidence`: the ceiling if
   the path resolved to an asset, `unsafe` if it did not.

Two types rather than one type with mutable fields, because it makes the illegal state
unrepresentable: an adapter cannot hand back something that claims to be resolved.

### Asserted versus speculative

An adapter also marks whether the syntax **asserts** that this is an asset reference.

An `import`, an `<img src>`, a `url()`: the author said so. If one of those does not resolve,
that is a **broken reference** and a real finding; it is how the engine catches a path an agent
hallucinated. But a path-shaped string inside a JSON file is a *guess*: the JSON adapter cannot
know whether `"icons/logo.png"` is an asset path or a translation key, because deciding that
would require resolving it. Those are emitted as **speculative**.

Unresolved speculative references are dropped from the graph rather than reported as broken.
Without that split, auditing any real repository drowns in false findings from `package.json`,
lockfiles and i18n bundles. They are still *counted* in the report, and listable in verbose and
JSON output, because a silent skip is a bug: if the JSON adapter ever eats a real reference, the
user needs a way to find it.

### The resolver's seven outcomes

"Resolved or broken" is not enough, and every extra outcome below exists because some real
syntax would otherwise be reported as broken. Zero false `broken` findings is the engine's first
promise, so this is where most of the design pressure lands.

Five cases refuse to fit:

- `import logo from '@/assets/logo.png'` is asserted and will not resolve, because alias
  resolution (tsconfig `paths`, Vite `resolve.alias`) only resolves it when the project actually
  declares that alias and the declaration can be read **statically**. That import is everywhere
  in Next and Vite projects, and what is left over still must not be called broken.
- `url($hero)` never had a static path at all. A literal path pointing at nothing is a real,
  actionable finding; a path the preprocessor builds is simply not knowable, and nobody typed a
  wrong path.
- `` `./images/${name}.png` `` is a *pattern*. Resolved literally it fails; treated as a glob it
  may name a dozen assets, and all of them must be linked.
- `url(inter.woff2)` points at a real file the engine does not track at all.
- A reference into a directory the walk pruned (the common case being a user who put `legacy/`
  in `.upflyignore` while `legacy/` is still referenced) points at a file that really is there.

So the resolver runs a numbered ladder, and **the order is load-bearing**:

| # | Test | Outcome | Example |
|---|---|---|---|
| 1 | `ceiling === 'unsafe'` | `dynamic` | `url($hero)` |
| 2 | `ceiling === 'medium'` | `resolved-pattern` / `dynamic` | `` `./img/${name}.png` `` |
| 3 | not a tracked extension | *dropped, no report line* | `./inter.woff2` |
| 4 | resolves in the asset set | `resolved` | `./hero.png` |
| 4b | alias-shaped, and a declared alias matches | `resolved` | `~/assets/logo.png` |
| 5 | under an excluded root, or exists on disk | `out-of-scope` | `../legacy/old.png` |
| 6 | alias-shaped, nothing matched | `unresolved-alias` | `@/assets/logo.png` |
| 6b | a package specifier | `out-of-scope` | `@11ty/logo/img/logo.png` |
| 7 | asserted | `broken` | `./missing.png`, a real finding |
| 8 | otherwise | `discarded` | a path-shaped string in `package.json` |

The ceiling tests come first because if there is no static path, every later question is
meaningless. **Rung 3's position is the subtle one**, and it is wrong in both directions: moved
above the ceiling tests it silently swallows `url($hero)` and `` `/img/${file}` ``, real dynamic
references with no extension to test, and moved below the rungs that turn a miss into a finding
it reports every `url(inter.woff2)` as broken. There is a test for each failure mode, because the
placement is invisible otherwise.

Two outcomes deserve their own note.

**`resolved-pattern` links every match, not one.** A `medium` template becomes a glob, each
`${…}` becoming `[^/]*` so a hole cannot cross a directory boundary. One or more matches and it
resolves, carrying all of them; zero matches and it is `dynamic`, never `broken`. Linking only
the first would leave the rest looking unreferenced, which is a false `dead asset` finding
wearing a different costume. Such a reference is never rewritten, since its text is a pattern
rather than a path: the planner keeps every original it matches, and says so when only some of
them convert.

**Root-relative paths try every serving root that is an *ancestor* of the referencing file**,
nearest first, then the project root. A monorepo has one `public/` per app (shadcn-ui has twelve),
and a file under `apps/v4/` that writes `/images/hero.png` means `apps/v4/public/`. Resolving that
against a single serving root produced **93 false `broken` findings** on it.

The restraint matters as much as the list. Trying *every* configured root looks free ("more roots
can only turn a false `broken` into a correct link") and is not: measured, it linked 23 references
to **another app's asset**, which a rewrite would then point at a file that app does not serve.
The guarantee holds only when every root serves the same URL space, and a monorepo's do not, so
proximity filters rather than merely orders. A false `broken` costs five minutes; a false link
costs a broken build.

**`out-of-scope` is not `resolved`.** It carries a `resolvedPath` (for a file inside a package,
the specifier itself), but it is never rewritten: the target was never converted, so pointing the
reference at a `.webp` would break something that works today. It also carries the
`exclusionReason`, naming the actual rule (`the ignore rule 'legacy/'`) rather than a generic
"excluded", because that is the difference between a report line that explains a missing asset
and one that just mentions it.

### The resolver is pure, and its one filesystem need is a port

Resolution happens against the **asset set** `discover` returned, not against a disk. That is
what keeps the two-step confidence rule honest (the adapter knows syntax, the resolver knows
what exists) without adding another module that touches a filesystem.

The exception is rung 5's fallback: a file excluded by a *file-level* ignore rule such as
`*.png` leaves no pruned directory to match against, so the only way to tell "excluded" from
"missing" is to look. That is an injected `exists` port, the same shape as the `ImageProbe`, and
it is consulted only for references that did not resolve, once per candidate path. It is a
required option rather than an optional one, because a default would let a call site keep the
false `broken` silently.

### Ask `isLinked`, never `resolution === 'resolved'`

Two of the seven outcomes are linked into the graph, so:

```ts
export function isLinked(ref: Reference): ref is Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>;
export function linkedPaths(ref: Reference): readonly string[];
```

This is not a convenience. `if (ref.resolution === 'resolved')` compiles, runs, and silently
ignores every pattern reference: a false negative the compiler cannot see, and precisely the
class the validation protocol exists to catch. The graph builder, the audit and the planner call
`isLinked`; nothing outside the resolver compares `resolution` by hand, and every `switch` over
it carries a `never`-typed default so an eighth outcome breaks the build instead of quietly
un-linking a whole category.

### A link says the asset is alive; `resolvedVia` says whether the text may be edited

Being linked and being rewritable are different questions, and conflating them is how a tool
breaks a build. Every linked reference records **how** it reached its target:

| `resolvedVia` | what happened | may the text be rewritten? |
|---|---|---|
| `file` | relative to the referencing file's directory | yes: the base is unambiguous |
| `serving-root` | root-relative, against a serving root, or through a declared alias | yes |
| `project-root` | root-relative, and no serving root held it | it depends on `RootLinkPolicy`, below |
| `speculative-root` | a speculative `./` path retried against the project root | no |

`speculative-root` is a guess at the base of a string that was already a guess: a path-shaped
literal in a data object may well be joined to some other directory at runtime, so the match is
evidence the asset is **alive** and nothing more. Rewriting it could point a working reference at
a file the code never loads.

`project-root` is kept apart from it because it is different evidence. The common case is
`<img src="/favicon.png">` in hand-written HTML on a site with no build step, where the project
root genuinely *is* the serving root. Treating that as the same evidence as a guess on a guess
would decline to rewrite most of such a repository, and repositories like it are the ones this
product is for. Measuring this class needs a repository with no configured serving root: once a
project declares its own root as a serving root (the validation harness does this for
`railsgirls-com` with `publicDirs: ['']`), the same references resolve as `serving-root`, and a
count of `project-root` reads zero for a reason that has nothing to do with how common it is.

`project-root` is also not unconditionally safe. If a serving root *is* configured and correct, a
root-relative path that misses it and happens to exist at the project root may be coincidence
rather than a link. The planner treats the two apart rather than guessing: it rewrites this class
when the project configures no serving root, and declines it when one is configured and the path
missed it. The policy is named (`RootLinkPolicy`) rather than implied, so overriding it is a
decision somebody makes on purpose.

The counts reach the JSON as `references.byResolvedVia`, so a consumer can tell a guess from an
ordinary resolution, and the planner has something to cite when it declines one: a silent decline
would be a skip nobody could see.

### Serving roots

A root-relative `/hero.png` means nothing until you know which directory the site serves. The
engine works that out from the directories `discover` walked, by name, and this section holds the
measurements behind `serving-roots.ts`.

**Why it exists at all.** The headline claim, zero false `broken`, was measured across 53,154
references, and every measurement used serving roots somebody had typed in by hand. Run the way a
first-time user runs it, a single-entry convention guess (`['public']`) finds one of shadcn-ui's
twelve public directories: 159 resolved references become 3, and the run reports 116 `broken` and
125 `dead` findings, 44 of whose paths exist on disk. No rung misbehaved. The ladder was never the
defect; the input was.

**Detection is by directory name, over the recorded walk.** `DiscoveryResult.directories` is
recorded during the walk rather than derived afterwards from the paths in `assets` and
`sourceFiles`, because a directory holding only files nothing tracks leaves no trace in either
list. Deriving finds 11 of shadcn-ui's 12; `templates/next-app/public` holds a single `.gitkeep`.
A recorded list cannot disagree with the walk, because it is the walk.

**Depth is not the discriminator.** Those twelve range from two path segments to six, so any
depth-limited search is wrong on the repository that matters. A `-maxdepth 3` search finds six.

**It does not require the directory to hold an image**, and that was measured rather than assumed.
Six of shadcn-ui's twelve public directories hold no image the engine tracks, only `favicon.ico`,
`.gitkeep`, `robots.txt` and `manifest.json`. So an asset-bearing rule finds six, the same count as
the depth search, reached by a different route and failing in the same way. A `public/` directory
is a serving root whether or not it currently holds an image, because that is what the bundler
thinks.

**It never reads a framework config.** A serving root in `next.config.js` or `astro.config.mjs` is
more often computed JavaScript than a literal, so reading one means either executing a user's code
or statically reading a value that usually is not static, and a plain static site has no config to
read. The directory name is observable and static; the config is neither. Checking that a project
file *exists*, below, is not reading one: existence is as observable and static as a name.

**And only where the directory holding it is a project.** A folder called `public` inside a
tutorial is not a website folder, and no rule on the text of its references can tell it from
Create React App's `public/index.html`: both name a root-relative file that nothing outside the
folder mentions. What differs is ownership: a website folder belongs to a project. So a `public`
or `static` directory is claimed only when a project file sits beside it, in its parent:
`package.json`; Hugo's `hugo.toml` or `config.toml` (and their YAML and JSON forms); a `Gemfile`;
`composer.json` or `artisan`; `angular.json`; or VitePress's `.vitepress/`, a config *directory*,
because VitePress keeps its `package.json` at the repository root. The list is `PROJECT_MARKERS`
and, like the names, an argument. Detection reads the whole walk for it, not only the files an
adapter claims: a `Gemfile` is an unscanned file. Measured on the five validation repositories, all
14 name-matched folders have a `package.json` beside them and all 14 are kept; the coverage tree's
`docs-examples/public` has none and is rejected. **Every marker except `package.json` is untested
on a real repository**, because the corpus holds only JavaScript projects. A folder whose project
file sits further up is rejected: Phoenix's `priv/static`, Spring Boot's
`src/main/resources/static`, VuePress's `.vuepress/public`, and a plain HTML site with no project
file at all. That is the cheap direction: a rejected root leaves a reference `broken`, never linked
to the wrong file, and declaring the folder fixes it.

**The name set is `public` and `static`, and it is an argument rather than a constant.** It is still
a hardcoded convention list and it will be wrong for some framework, so a caller can supply its own.

**Measured against the hand-tuned corpus** (`pnpm --filter upfly-bench run detect-roots`):
detection reproduces the configured list exactly on `astro-docs`, `shadcn-ui` (all twelve),
`railsgirls-com` and `scratch-www`, and `--delta` shows zero change in every resolution bucket on
those four. It finds nothing on `eleventy-docs`, which serves from `src` via `addPassthroughCopy`.

**Eleventy is not special; it is merely in the test set.** Hugo, Jekyll, Gatsby, Nuxt, SvelteKit,
Rails, Django and WordPress are equally unresolvable out of the box. Special-casing the one
framework that happens to be in the corpus is letting the corpus decide the product, and the first
per-framework parser is a door the second and third requests come through. What eleventy gets
instead is inference, below, which finds `src/` from what its references resolve against. A
project whose references do not settle it is told plainly that the serving root could not be
determined, so one line of configuration fixes it.

**A missed root is survivable and a wrong one is not.** Detection finding nothing degrades to the
`project-root` rung, which is correct for a hand-written static site and measured at identical
findings on `railsgirls-com`. A wrongly detected root resolves a reference to the *wrong file*, and
a rewrite would then act on that false link. That asymmetry is why detection matches directory
names exactly rather than case-insensitively, and why `src` was measured and then rejected: adding
it fixes eleventy and costs zero delta and zero relinks on the other four repos, but `src` is a
source directory rather than a serving root, it is free here only because roots are filtered to
ancestors of the referencing file and `public` happens to sort before `src` on a tie, and the
corpus contains no repository of the shape where it would fail: a project with `src/` but no
`public/`, serving from its root. A measurement that cannot see a failure is not evidence that
there is none.

**Detected roots carry `declared: false`, and the report says so.** Detection is an inference, not
the project stating anything. The planner's root-link policy already branches on that flag; the
report discloses it in `coverage.servingRoots` and in a line of the human headline, because a guess
nobody is told about is precisely the defect above.

### Inference: what the references resolve against

Detection asks what a directory is called. Some sites serve from a directory no naming rule can
reach: Eleventy copies `src/` to the site root, and `src` is a source directory everywhere else.
So a run nobody configured also asks which directories its references actually resolve against,
and adds those. `decideServingRoots` (`serving-root-decision.ts`) makes that decision for every
caller; `inferServingRoots` does the scoring.

- **It runs after the scan**, because it needs references. Detection needs only the walk.
- **It only adds.** A detected root is never removed: the case inference exists for is a root
  detection cannot see, not one detection got wrong.
- **It scores only root-relative references that could name an image.** A documentation site's
  page links (`/en/guides/deploy/`) are references too, and counting them dragged real serving
  roots under 3%. Every candidate fell alike, so the ranking survived while the rates became
  meaningless, which is the kind of wrong number that passes a glance.
- **Volume first, then rate.** A candidate needs at least three such references
  (`MIN_ROOT_REFERENCES`) and must resolve at least 40% of them (`MIN_ROOT_RESOLUTION_RATE`). A
  folder named `public` that serves nothing can resolve two references out of two, so a rate alone
  would take it. Measured over 201 directories in the five validation repositories and the
  coverage tree, true roots scored at least 45.8% once the volume floor applied, and wrong ones at
  most 0%.
- **A tie refuses.** A rejected root leaves every affected reference where it already was,
  `broken` or `discarded`, so a false reject costs nothing new. A false accept links a reference to
  the wrong file, and a rewrite would then act on that link.
- **The union is sorted for byte-identical output only.** The resolver orders roots by ancestor
  depth itself, so the order handed in cannot change what resolves.
- **The result is always `declared: false`.** Nobody stated these roots; the report says they were
  worked out.

### When the serving root cannot be found at all

Detection can come back with nothing, and for a hand-written static site that is the right
answer. For a framework whose convention the engine does not know, it is not: almost no
root-relative reference resolves, and the run fills with `broken` findings whose targets are
sitting on disk.

**In that state the finding is not "these references are broken". It is "we could not work out
where this project serves files from."** Reporting the first is stating a symptom as a diagnosis,
and it is the same class of mistake as calling a reference broken when it is not.

So two things happen below a floor:

1. **`planOptimization` refuses.** It returns a `PlanRefusal` rather than throwing: a throw leaves
   the caller holding nothing, while a returned refusal is a finding with a reason. The audit still
   reports; only the write path stops.
2. **`audit` replaces every root-relative `broken` finding with one `serving-root-unknown` finding**
   that names the real problem, says how many findings it replaced, and tells the user to declare a
   serving root. A broken relative path is not affected. The replaced references are counted in the
   report's `references.byResolution`, not listed one by one.

**The measure is deliberately narrow: root-relative references only, linked over linked-plus-broken.**
Only those depend on a serving root. A repository whose *relative* imports are genuinely broken
scores normally and keeps every one of its findings, which makes the diagnosis correct by
construction rather than merely the likeliest explanation. Dynamic, discarded, alias-shaped and
out-of-scope references are excluded too: a discarded path-shaped string out of a lockfile is no
evidence about a serving root, and counting it would make a large `package.json` look like a
misconfiguration.

**The floor is 25%, and it was measured rather than chosen.** Across the five validation
repositories, root-relative references only:

| repo | configured or correctly detected | no serving root found |
|---|---|---|
| `astro-docs` | 12/12, 100% | 0/11, **0.0%** |
| `eleventy-docs` | 23/23, 100% | 0/14, **0.0%** |
| `shadcn-ui` | 164/183, 89.6% | 0/115, **0.0%** |
| `scratch-www` | 682/704, 96.9% | 0/615, **0.0%** |
| `railsgirls-com` | 1325/1335, 99.3% | 1325/1335, 99.3% |

The two populations do not overlap and do not come close. `railsgirls-com` is unchanged in both
columns because it genuinely serves from its own project root, which is the control that shows the
measure is not simply detecting "no serving root configured".

**A partial failure is not caught by this, on purpose.** A monorepo where half the serving roots
are found scores around 50% and keeps its individual findings, because half of them are real and a
user can act on them. This fires only where the run has nothing to say.

**Below ten root-relative references the floor does not apply**, because a share taken over a
handful is not a measurement and a single genuinely broken path would otherwise suppress itself.
That minimum is judgement rather than measurement.

### Aliases are read, never executed

`@/assets/logo.png` resolves only if the project declares that alias somewhere the engine can read
**without running anything**. `loadAliases` parses `tsconfig`/`jsconfig` `paths` (following
`extends`, including by name into `node_modules`) and a `vite.config.*` `resolve.alias`, and hands
the resolver a map; the resolver stays pure.

**A config is read statically or not at all, and that is a hard line rather than a trade-off.**
Every `resolve.alias` in the validation corpus is `'@': path.resolve(__dirname, './src')`, a
JavaScript expression. Evaluating it would mean **executing a config file from a repository the
user did not write**, in a tool they ran to save bytes. No byte saving buys that. Where the static
read cannot see a value, the alias is reported as unreadable with its file and line, because a
limitation a user can see is worth more than a resolution they cannot trust. Today a Vite config is
read only when its whole text is an object literal, so one written as a module, as real ones are,
yields no alias.

Two details that are easy to get wrong:

- **`tsconfig.json` is JSONC.** Comments and trailing commas are legal and common, and `JSON.parse`
  throws on both. It is parsed with `@babel/parser` (a JSONC document *is* a JavaScript object
  literal) rather than by stripping comments with a regex, which would be "never regex JavaScript"
  wearing a different extension. Values are read off the AST, never reconstructed into an object.
- **A tsconfig key and a Vite key mean different things.** `"@/*"` is a pattern whose `*` says
  "prefix"; a Vite string key is *always* a prefix replacement, so `{'@': './src'}` turns
  `@/x.png` into `./src/x.png`. Treating the Vite form as an exact match resolves nothing at all.

Aliases are scoped to the directory of the config that declared them. `shadcn-ui` has roughly twenty
configs all defining `@/*`, and without scoping every one of them would offer a candidate for every
reference in the workspace.

**A package specifier is not an alias** (rung 6b). `@11ty/logo/img/logo.png` names a file inside
`node_modules`, which the walk prunes, so no alias configuration will ever resolve it; it is
`out-of-scope`. The two shapes differ by one character: `@/…` has an empty scope, which no registry
permits. `unresolved-alias` means an alias-shaped path that no declared alias maps. It is a final
outcome, not pending work.

### Non-asset extensions are the resolver's business

`url(inter.woff2)` in an `@font-face` is a perfectly asserted reference to a file the engine
does not track. Adapters deliberately do **not** filter by extension: the tracked-extension
policy lives in one place so it is not re-implemented across six adapters and forgotten by the
sixth contributor, and so that adding video later flows through automatically.

These are dropped without a report line. That is not a silent skip: a `.woff2` was never a
candidate asset, so declining it is not declining to do work, and counting fonts would be noise.

**A silent skip is a bug.** If the engine declines to do something, the report says so.

### Percent-encoded and entity-encoded paths

A reference can spell its path with encoded characters: `hero%20image.png` for a file called
`hero image.png`, or, in HTML, `a&amp;b.png` or `a&#38;b.png` for `a&b.png`. Four rules govern
these, and each prevents a different error.

The reference keeps the text as written. `rawPath` is always the source text, so
`source.slice(start, end) === rawPath` holds for every reference and a rewrite replaces exactly
what the author typed. Decoded forms are never stored. `spellingsOf` lists them and the resolver
tries each one: its extension filter passes a path if any spelling ends in a tracked extension,
and its lookup tries the spellings in order, recording on the resolved reference the spelling
that matched.

The literal spelling is tried first. `enc%20name.png` can be a real file whose name contains a
percent sign, while `hero%20image.png` reaches a file called `hero image.png`, and as text the two
cannot be told apart. An engine that never decodes gets the second wrong; one that always decodes
gets the first wrong. The coverage tree holds both files, so the order is tested rather than
assumed.

A path that cannot be fully decoded offers no decoded spelling at all. A partly decoded path is
neither what the author wrote nor the file's name, and looking it up would miss, which for an
asserted reference means a `broken` finding. The decoder knows numeric references (`&#38;`,
`&#x26;`) and the five predefined names `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&apos;`, and none
of the other HTML named references. So the HTML adapter reports a path such as `caf&eacute;.png`
as `unsafe`, a refusal with a reason, instead of giving it a ceiling that leads to a lookup.
Widening the bound would mean depending on a complete entity table. Percent-decoding uses
`decodeURIComponent`, and text it rejects, such as `100%`, is treated the same way.

A rewrite writes the new path back in the matched spelling. It starts from the path on disk, so
without this a file called `hero image.webp` would be written into a URL with a raw space. `spell`
percent-encodes each segment separately, leaving the slashes alone, and for an entity spelling
re-encodes only `&`, because inventing entities for other characters would change text the author
did not write. How the HTML adapter finds these spellings in attributes, `style` included, is
under "Character references in HTML attributes".

### `possibly-dead`, and why "zero references" is usually a lie

An asset referenced only from a `.vue`, `.svelte` or `.njk` file has zero references for a reason
that has nothing to do with the asset: no adapter reads that format yet. Calling it dead is a false
positive we manufactured ourselves. The `eleventy` fixture has two of them: `logo.png` and
`favicon.png` are referenced only from `.njk` templates, and both would otherwise be reported dead.
The hedge stands in for coverage the engine does not have yet, and the fix for a hedge is an
adapter, not a softer label.

The obvious rule, hedge globally whenever some extension went unread, degenerates. Measured on
this repository, the unread list is `.astro`, `.njk`, `.yaml`, `.yml`, three dotfiles and
`LICENSE`. It is never empty on a real project, so `dead` would never fire, and a label that
always fires carries no information. A curated allowlist of "extensions that can reference an
image" is the other wrong answer: it is a place to be wrong in the direction that ships a false
`dead`.

**So the hedge is per-asset.** `discover` records every file it did not read *with its path*, and
`scan` adds every file it could not parse. For each asset with zero references, the audit sweeps
that text for the asset's filename, in one pass building a set of names, not one pass per asset:

- **A hit → `possibly-dead`**, and the report names the file: *"`hero.png`, referenced in
  `config.yaml`, which Upfly cannot parse."* That is actionable; a global hedge is not.
- **No hit → `dead`**, confidently.

`unscannedExtensions` is still reported. It stops being the trigger and becomes what it should
always have been: a coverage statement, and how a user finds out they want an adapter.

The sweep reads three things: files **no adapter claimed**, the raw path of every reference we
**could not resolve**, and the asset filenames `scan` saw in the files it **did** read, collected
while each file's text was already in memory, so no source file is read twice. That last one
covers a name that parses fine and yields no reference, such as `{ file: 'My Logo.png' }`, a spaced
file name with no slash, which has the shape of a UI label (see "What counts as a path-shaped
string").

The unresolved paths it reads are those of references whose target is unknown: `dynamic`,
`unresolved-alias` and `discarded`. A reference whose target is known is no evidence of use.
`broken` points at nothing and is already its own finding, and `hero.png: dead` beside
`./wrong-dir/hero.png: broken` tells a reader more than a hedge would. `out-of-scope` is known not
to be an indexed asset.

**No basename sweep can rescue a filename assembled at runtime.** `` `background-${dir}.png` ``
never contains the string `background-ltr.png`, so there is a test pinning that limit, of *the
sweep*, so nobody "fixes" it for a case no sweep can reach. It is a limit of the sweep and not of
the engine: the same template literal carries a `medium` ceiling, the resolver globs it, and
`resolved-pattern` links every file it matches. When one mechanism cannot reach a case, check
whether another already does before calling the limit fundamental.

Two things belong in that swept text for reasons that are not obvious. **An SVG is both an asset
and a container**: `<image href>`, `<use href>` and a `<style>` block inside one are all real
references and no adapter reads them, so `.svg` is recorded as unread even though it is also an
asset. And **a reference we read but could not resolve names no asset**: eleventy's
`![Templated]({{ site.url }}/img/templated.png)` is `dynamic`, so `templated.png` links to nothing and
looks dead while being demonstrably alive, the same manufactured false positive arriving from the
other direction; its raw path is part of the swept text for that reason. Directories the user
*excluded* are deliberately not swept: an ignore rule is an instruction, not a gap in our coverage.

## Adapters: the contribution surface

An adapter teaches Upfly to read one file format. This is where most contributions go, and
adding one should take about half an hour.

```ts
interface Adapter {
  readonly id: string;                    // 'javascript', 'html', 'css', 'vue', …
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
   resolve to an existing asset" is not something a JSON adapter can implement: it emits every
   path-shaped string as speculative and lets the resolver decide.
3. **Be pure.** Same input, same output, no globals.
4. **Report offsets of the path text only**, not the surrounding quotes or attribute.
5. **Ship a fixture and a table-driven test.** The compatibility matrix in the README is
   generated from fixture results, so an adapter without fixtures is invisible.

Parsing strategy: use a real parser wherever one is cheap and correct: `@babel/parser` or
`oxc` for JS/TS, `parse5` for HTML, `postcss` for CSS. Regex is acceptable for Markdown and
JSON only. **Never regex JavaScript**; it will find references inside comments and strings and
produce exactly the silent corruption this design exists to prevent.

### The six that exist

| Adapter | Extensions | Reads | Parser |
|---|---|---|---|
| `astro` | `.astro` | the frontmatter fence as TypeScript **and** the template body as HTML | delegates to `javascript` + `html` |
| `css` | `.css .scss .less` | `url()`, `image-set()` | `postcss` + `postcss-value-parser` |
| `html` | `.html .htm` | `src`, `srcset`, `poster`, `<source>`, `<audio>`, `<track>`, `<embed>`, `<input>`, `<object data>`, inline SVG `<image>` and `<feImage>`, icon and preloaded-image `<link>`, `<style>`, `style=""` | `parse5` |
| `javascript` | `.js .jsx .mjs .cjs .ts .tsx .mts .cts` | `import`, `require()`, `import()`, `new URL(…, import.meta.url)`, JSX `src`/`srcSet`/`poster`, CSS-in-JS | `@babel/parser` |
| `markdown` | `.md .mdx .markdown` | `![]()`, `[]()`, link reference definitions, raw HTML, and in `.mdx` the top-level `import`/`export` blocks | regex over masked text; delegates raw HTML to `html` and MDX's ESM to `javascript` |
| `json` | `.json .webmanifest` | every path-shaped string **value**, as a speculative candidate | regex |

The JavaScript adapter also emits **path-shaped string literals as speculative**, the same standing
a string in a JSON file gets. The asymmetry was indefensible once stated: `{ "file": "x.png" }` in
`data.json` was a candidate and the identical string in `data.ts` was invisible, and that produced
a *confidently dead* asset on a real repository. A candidate that resolves becomes a real link,
which beats a hedge because the rewrite can act on it; one that does not is discarded, **counted in
the report, and listable with `--include-discarded`**, because a candidate the JSON adapter ate in
error is invisible unless the count says something is wrong and the list says what. It leaves
alone any value a construct examined and declined: `alt="/not.png"` is display text, and
overturning that decision would rewrite it.

Three things they share, and each was a bug before it was a rule:

- **CSS is read in one place.** An HTML `<style>` element, a `style=""` attribute and a
  `styled.div` template all go through the CSS adapter's scanner rather than a second, weaker
  implementation. Markdown hands its raw HTML to the HTML adapter for the same reason, and an
  MDX document's top-level `import`/`export` blocks to the JavaScript adapter, delimited by MDX's
  own rules, so a paragraph line that merely begins with the word `import` stays prose, and each
  line is read by exactly one of the three.
- **Mask before you match.** The Markdown adapter blanks fenced blocks, code spans and HTML
  comments with spaces *of identical length* before running any pattern, so a `![](old.png)` in a
  documentation example is invisible while every offset after it stays exact. The JavaScript
  adapter does the same to flatten a CSS-in-JS template, replacing each `${…}` with a CSS comment
  of matching length: a comment rather than a SCSS interpolation, because `styled.div` templates
  routinely open with `${baseStyles}` at statement level, where an interpolation fails to parse
  and would cost the real `url()` below it.
- **A `?query` or `#fragment` sits outside the reference range.** Rewriting swaps `hero.png` for
  `hero.webp` and leaves the author's `?v=2` alone. Including it would also make the path
  unresolvable and produce a false broken finding.

Two places where the same character means opposite things, both settled by `kind`:

- A leading `#` is a document fragment (`url(#gradient)`) everywhere except a module specifier,
  where `#internal/img.png` is a Node subpath import. `isExternalUrl` takes the reference `kind`
  as a **required** argument for exactly this: a default would let a call site keep the wrong
  reading silently, and dropping a subpath import made it vanish from every report under no
  reason at all.
- `#{` opens a SCSS interpolation, so it is never treated as a fragment.

### What counts as a path-shaped string

The JavaScript adapter emits path-shaped string literals as speculative candidates, and the CSS
adapter does the same for quoted strings in preprocessor variables. Each first requires a file
extension; `plausiblePathShape` then decides whether the string is shaped like a path at all.

A comma rules a string out, because `"/a.jpg 1x, /b.jpg 2x"` is an unsplit `srcSet` list rather
than a path. So do tabs and newlines, which no real path carries.

Spaces are allowed. Files uploaded through a CMS or dragged into a project carry them, and a rule
against whitespace makes `["/ncc/Firing Practice.webp"]` invisible, which reports an image on a
live site as dead. But a space is allowed only alongside a `/`. Without one, a spaced string cannot
be told from a sentence: shadcn-ui has 87 quoted strings that contain a space and end in an image
extension, all of them accessible labels such as `"Remove workspace.png"` and
`"Open desk-reference.jpg"`, and none contains a slash. Taking a label for a path is the expensive
mistake: a speculative string that resolves becomes a link, and a rewrite acts on it.

A slash is not enough on its own, because prose can hold both: `"see ./old.png for details"`,
`` `we removed ./old.png last week` ``, `"import logo from './old.png'"`. What separates these from
`/ncc/Firing Practice.webp` is that the prose continues after the extension. So a spaced string
must be nothing but a path. `SPACED_PATH` is anchored at both ends and must finish on an
extension, a dot followed only by letters or digits, which rejects `.png for details` and `.png'`.
The extension check the adapters make first cannot do this job: `extname('see ./old.png for
details')` is `'.png for details'`, which is not empty.

`*` is allowed because the JavaScript adapter joins a template literal's chunks with it, so
`` `/gallery/Firing Practice ${n}.webp` `` is tested as `/gallery/Firing Practice *.webp`.

Parentheses are allowed here and nowhere else. A phone screenshot downloaded twice,
`WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp`, is a common way an image enters a repository
kept by non-developers. Inside a string literal a parenthesis is an ordinary character. In an
unquoted CSS `url(…)` or a bare Markdown `![](…)` it closes the construct, so admitting it there
would break the parse, and both have quoted or angle-bracket forms that already carry such a name.
The end anchor keeps the widening to file names: `"url(hero one.png)"` ends on `)`, not on an
extension, and is rejected. A string with no space, such as `"url(hero.png)"`, never reaches
`SPACED_PATH`: it is emitted as a guess and discarded when nothing of that name exists.

One gap is accepted. A spaced file name with no slash, `{ file: 'My Logo.svg' }`, has the same
shape as the UI labels and stays invisible. A test in `javascript.test.ts` pins the gap, and
closing it is one clause in `plausiblePathShape`.

### Assembled paths in JavaScript

Besides the constructs that assert a reference, the JavaScript adapter guesses. A path-shaped
string literal outside any construct is one kind of guess. A template literal such as
`` `./_images/background-${dir}.png` `` in an object property is another, and so is a path
assembled with `+`, such as `'/srcset/' + 'card-' + String(width) + '.jpg'`. Guesses carry
`asserted: false`, so none of them is ever reported as `broken`: a string that names nothing is
discarded and counted, and a template or chain that matches nothing is `dynamic`, like any other
template.

The static text of a guessed template or chain must look like a path, and its extension must be
written in that static text. In `report.${type}` the hole is the extension. Guessing there admits
version strings (`v1.2.0-beta.${n}`), translation keys, IP address formats and source files such
as `layout.${ext}`; on the five validation repositories it admitted no image at all. A reference
in an asserting position, such as `` <img src={`hero.${ext}`}> ``, is not held to this bound,
because the author said it is an asset. The shape test is `plausiblePathShape`, the same predicate
the string rule uses, so the guessing rules cannot disagree about what a path looks like.

A template and a `+` chain that spell the same path are read the same way.
`` `/srcset/card-${width}.jpg` `` and the chain above get the same bound, the same globbing rule
(`assembledPathIsGlobbable`: a fixed directory before the first unknown segment, and at most one
unknown segment in the file name) and the same external-URL and not-a-file tests, all asked of the
assembled text. A pattern is never rewritten in either spelling, so a chain having no single range
a rewrite could replace costs nothing.

There is one difference, and it favours the chain. Where an operand is already a complete path,
as in `'/img/hero.jpg' + '?v=' + version`, that literal stays the reference and the chain is not
read at all. The literal resolves as an ordinary path, and a rewrite edits exactly that literal and
leaves the query alone, where the template twin would be a pattern that no rewrite touches. A chain
is a guess wherever it sits, a JSX `src` included, so it is held to the bound even where a template
would not be. A parenthesised `+` is a single operand, because the brackets may be adding numbers
rather than joining text.

Same-file constants are read through. `const ASSET_BASE = '/gallery'` above
`` `${ASSET_BASE}/${name}.png` `` is statically knowable, so the template is judged as
`/gallery/${name}.png`, a pattern, rather than as a path whose directory is unknown. This is sound
without scope analysis under one condition: the name has exactly one binding anywhere in the file,
and that binding is a top-level `const` initialised with a string. A top-level binding is visible
throughout the module, so with no other binding of the name, every use of it is that constant. A
parameter, a nested declaration, a catch clause or a second top-level name adds a binding, and the
name stays unknown. Counting too many bindings can only refuse a trace, so bindings in every scope
count. `let` and `var` are never read, because their first value says nothing about a later use.

When a constant was read through, or the path is a chain, the text in the file is not the path.
The range and `rawPath` stay on the source text, so `source.slice(start, end) === rawPath` still
holds, and the path the text proves travels as `assembledPath`, with each unknown segment written
`${}`. A question about what the path is (the glob, the static-extension test, the external-URL
test) reads `assembledPath`. A question about where the text is (the range, a citation, a sweep for
a file name) reads `rawPath`.

Interpolations in CSS-in-JS follow the same rule. The CSS adapter reads a flattened copy of a
`styled.div` template in which each `${…}` is a comment of the same length, so to it
`url(/theme-${mode}.png)` holds a comment and is dynamic. Only the JavaScript adapter knows which
comments are its own placeholders, so it puts the source text back as `rawPath` and asks
`assembledPathIsGlobbable`. `/theme-${mode}.png` is then a pattern in a CSS block, as it is in a
template literal anywhere else in the same file.

### Character references in HTML attributes

parse5 decodes character references in attribute values, so the value it reports can be shorter
than the source text it came from: `src="a&amp;b.png"` is eleven characters of source and seven of
value. A reference's range has to cover source text, and no range into the source spells the
decoded path. The HTML adapter therefore compares each attribute's source text with parse5's value
and carries the result as a flag, `entityEscaped`.

The flag is acted on only inside a reference position, once the attribute has been judged to hold a
reference. Acting on it earlier, for every attribute of every element, would turn escaped `alt`
text, other sites' links and `<meta content>` values into references the engine says it could not
handle. That is the mirror image of a silent skip: failures the engine invented, reported as
`unsafe`, which make it look worse than it is and bury the real ones.

At a reference position an escaped value goes through one helper, so every position answers the
same way:

- Another host's URL is dropped first, as an unescaped one is. An entity in a query string
  (`https://example.com/a.png?w=1&amp;h=2`) does not make the file this project's.
- A single-URL attribute whose whole path decodes is resolved. Its range and `rawPath` stay the
  encoded source text; the resolver also tries the decoded spelling (`spellingsOf`), and a rewrite
  writes the new path re-encoded (`spell`). `/gallery/a&amp;b.png` names `a&b.png` and can be
  rewritten.
- A path the decoder cannot finish stays `unsafe`, as "Percent-encoded and entity-encoded paths"
  explains.
- A `srcset` stays `unsafe`. It is a list, so its one range is not one path.

A `style` attribute is CSS and never meets the external-URL test: `width: 100%` begins with letters
and a colon, which reads as a URL scheme and would drop the whole attribute. Usually only its
delimiters are encoded, as in `style="background-image: url(&quot;/logo.png&quot;)"`, and the path
itself is plain in the source; read as source text, PostCSS would see the unquoted token
`&quot;/logo.png&quot;`. The adapter decodes the CSS with a map from each decoded character back to
its source offset (`decodeCharacterReferencesWithMap`), hands the decoded text to the CSS adapter,
and maps each reference found back to the source. It keeps the result only when three guards hold,
and otherwise reports the attribute as unread:

1. The decoder finishes. A named reference outside its five, such as `&nbsp;`, stops it.
2. Its decoded text equals parse5's. parse5 knows every named reference in the HTML
   specification, so where the two disagree the offsets would describe text the browser never
   saw. This comparison is what makes a bounded decoder safe to use.
3. Each mapped range starts within the attribute, runs forwards, and is no shorter than the path
   the CSS adapter found. `rawPath` is sliced from the source, so it always matches its range.

An unread `style` attribute, whether escaped beyond these guards or simply not valid CSS, is
reported with a note saying whether its CSS contains `url()` or `image-set()`. Without one there is
no reference to find, and the report counts the refusal as correct; with one, a reference may be
hidden, and it counts as a miss.

### Reference shapes

Every reference an adapter emits carries a shape: the construct it was written in, such as
`html.img.src`, `css.url.in-comment` or `path.absolute-url`. A reference's resolution says what
happened to it; its shape says what it is, so outcomes can be counted per construct. The coverage
matrix (`coverage-tree/tools/matrix.mjs`) prints one row per shape and no total, so no single
figure can be quoted out of context.

The coverage tree's answer key, `coverage-tree/key/coverage-key.json`, defines the vocabulary, and
`packages/core/src/shapes.ts` holds a second copy as `SHAPES`, which the engine exports. Neither can
import the other. The key's checker, `check-key.mjs`, imports only `node:` modules and files beside
it, so the key is never certified by the engine it measures, and a shipped package must not depend
on a test fixture. `shapes.reconcile.test.ts` fails when the copies differ in either direction, and
both directions matter: a shape only the engine declares is a construct nothing tests, and a shape
only the tree declares is a row the matrix can never fill. The one allowed difference is
`UNTESTED_SHAPE_IDS`, the shapes an adapter emits that the tree has no instance of yet. They are
declared rather than left unnamed, because a shape with no name cannot be reported as uncovered.
The test fails once one of them gains an instance, so the list cannot outlive the gap.

#### How a shape is chosen

The vocabulary mixes three kinds of name:

- a host, the file or construct the reference sits in (`html.*`, `scss.*`, `md.*`);
- a construct, the syntactic position (`img.src`, `url()`, `import`);
- a disposition, what the path itself is (`path.absolute-url`, `decoy.comment`).

One rule picks between them: a shape names the narrowest thing whose breakage would take out that
reference and no others. That is what makes a row worth printing, since it isolates one thing that
can fail on its own. A `url()` inside a comment is `css.url.in-comment` in every host, because
comment handling is the CSS reader's job and breaks the same way in `.css`, `.scss`, `.less` and a
`<style>` element. A plain `url()` inside `<style>` is `html.style.element`, because what would take
it out is the HTML adapter failing to extract the CSS, not the CSS parse.

That rule chooses within a kind. Between kinds, a disposition takes precedence: a path spelled with
character references, or an absolute URL, is keyed by its `path.*` shape whatever attribute holds
it, because its spelling is what would take it out. Every disposition carries a `path.*` id, so its
kind, and with it the precedence, is visible in the name.

Because the choice depends on which part of the engine could fail, no function can derive a shape
from the syntax. Each adapter names the shape where it emits a reference, and `ShapeId` is derived
from `SHAPES`, so naming a shape that does not exist is a compile error.

A row must be homogeneous. When a shape's entries turn out to fail in different ways, the shape is
split rather than given a mixed class: the three `html.link.href.*` rows exist because
`linkImageClaim` claims icons and preloaded images in two independent branches, and what it refuses
is a third case. A row is named for what its references assert, not for what its current entries
happen to contain.

#### What a zero means

Each shape declares an emission class, which is what the engine as a whole reports for it:

| class | meaning | how the matrix reads the row |
|---|---|---|
| `engine` | the engine reports a reference | found against expected; a miss is a bug |
| `gap` | no adapter reads the construct yet | zero is expected, and each entry's `knownGap` records the missing reader |
| `declined` | the text is not a live path to a file | zero is correct; a reference here is a false finding |
| `unclaimed` | a real, reachable file the engine chooses not to index | reporting nothing is a scope decision, not a defect |

The matrix counts each class as its own population and never adds them together. Only `engine`
rows form the claimed population, the one place a miss is a defect. The class belongs to the shape,
while each tree entry keeps its own expected outcome, so a claimed shape can hold an unclaimed
target: `html.video.src` is `engine`, and its entries naming an `.mp4` are keyed `out-of-scope`.

#### Which layer decides

The class describes what reaches the report, not what an adapter emits. For some shapes the two
differ, because the distinction needs a fact only the resolver has:

- `decoy.typo`: a name one character from a real file cannot be told from a real path without
  checking the disk.
- `js.import.alias.mapped` and `js.import.alias.unmapped`: only the `tsconfig` or Vite paths table
  says whether an alias maps anywhere.
- `json.webmanifest.other`: telling a screenshot from an icon needs the array the entry sits in,
  which the JSON adapter does not parse.
- `pattern.partial`: whether a pattern matches every file it names depends on which files exist.

For these, the adapter emits a broader shape, the shape declares it in `adapterEmitsAs`, and
`needsToSee` names the fact the adapter lacks. When the engine's shape and the key's disagree, the
matrix reads `adapterEmitsAs` to tell a correct difference of layer from a defect. The declaration
lives on the shape rather than in an exemption list inside the measuring harness, because such a
list goes stale silently: an entry that is no longer needed still suppresses. The reconcile test
checks that every id in `adapterEmitsAs` is another real shape and that `needsToSee` is given.

A declaration can cover part of a shape. Inside `import` or `require()`, a bare specifier such as
`some-ui-kit/dist/logo.png` is module syntax, and the adapter names `path.bare-specifier` itself. In
a plain string the same text could be a relative path written without `./`, so there the adapter
emits `js.string.literal` and the resolver reads it as an ordinary path.

## Discovery

`discover` walks the project once and returns three lists: image assets, the source files some
adapter has claimed by extension, and the files nobody claimed. It is one of the modules that touch
the disk.

It is a hand-written breadth-first walker rather than a glob library, for one reason:
**the performance budget is won by pruning, not by matching.** A repository's `node_modules`
usually holds more files than everything else combined, and the only way to stay under the
budget is to never descend into it at all. A glob has to consider each path in order to reject
it; a walker drops the entire subtree on a single directory-name lookup.

Directories are read a level at a time, up to sixteen in parallel, and the same bound applies to
the `stat` of each image afterwards. The limit is there to avoid exhausting file descriptors, not
to match CPU count, since this work is entirely IO-bound. A shared work queue would parallelise
slightly better at the very top of the tree, but needs active-worker bookkeeping to stop workers
exiting while a peer is still producing work, and this module is meant to stay readable.

What it declines to do, it records. Symlinks and Windows junctions are not followed (a junction
reports as a symlink to `lstat`, which is why the check comes first: following one can put the
walk into a cycle or outside the root). Unreadable directories, unstat-able files and anything
that is neither a file nor a directory each land in `skipped` with a reason. None of it is
silently dropped.

Two details that are easy to get wrong:

- **Reported paths are POSIX-separated and relative to the root**, normalised in exactly one
  place. Ordering uses a code-unit comparator, never `localeCompare`, which is locale-dependent,
  so the same repository would produce differently ordered reports on two machines and the
  byte-identical-report rule would quietly become false.
- **`.upflyignore` is matched with the `ignore` package, and a directory must be tested with a
  trailing slash.** Given a `build/` rule, `ignores('build')` is `false` and `ignores('build/')`
  is `true`. Get that wrong and the walker descends into every ignored directory without ever
  reporting an error.

`.gitignore` is deliberately *not* honoured: generated-but-referenced assets under `public/` are
routinely gitignored, and skipping them would produce false "dead asset" findings.

Discovery also records **what it excluded, and why**. Every pruned directory lands in
`excludedRoots` with the rule responsible: a built-in name prune, or the specific `.upflyignore`
pattern that matched. It keeps the raw pattern list to do that, because `ignore` reports *whether*
a path matches but not *which* pattern did, and "excluded by some rule you wrote" is a much worse
report line than "excluded by `legacy/`" when someone is working out where their asset went. The
resolver prefix-tests references against these to produce `out-of-scope` instead of a false
`broken`.

It records what it **did not read**, too. Every file no adapter claimed lands in `unscannedFiles`
with its path, which is what the audit sweeps to decide `dead` against `possibly-dead`. Ignored
and pruned entries are deliberately absent (an ignore rule is an instruction, not a gap in our
coverage), and so is the ignore file itself, which we obviously did read.

## Scanning: one place that owns adapter failure

`scan` reads each source file and hands the text to the adapter that claimed it. It exists
because nothing owned that loop, and because the adapters throw.

`css` and `javascript` raise `ADAPTER_PARSE_FAILED` when a file will not parse. That is right
(returning `[]` would report a file full of references as clean), but a throw nobody catches means
**one unparseable `.scss` in a five-thousand-file repository kills the whole audit**, and real
repositories contain one. So `scan` catches it into a reported entry carrying the file and the
parser's message, and that entry feeds the same per-asset sweep as a file no adapter claimed. The
two are the same condition: we did not learn what the file references.

It catches *every* throw, not only ours. Adapters are the contribution surface, and a bug in a
community adapter must not take down an audit of a repository that adapter barely touches, while
still being visible in the report rather than merely survived.

`readFile` is injected, so the module that owns error handling for every adapter is exercised
against an in-memory file map instead of a directory full of deliberately broken files. It
deliberately does not return the file texts: holding a whole repository's source in memory to save
a later re-read trades a bounded cost for an unbounded one.

### Skipping files that cannot hold a reference

Before handing an html, json or markdown file to its adapter, `scan` asks `couldHoldReference`
whether the text contains any token a reference is built from. If it contains none, no adapter
could produce a reference from it, certain or dynamic, and the parse is skipped. The check is a
lowercase substring search, far cheaper than a parse.

It is not used for css, javascript or astro. Those adapters wrap real parsers (postcss and Babel)
that reject invalid input whether or not it holds a reference, and that failure must still reach
the report as a file that could not be parsed. A stylesheet such as `a { color: ; ;; }} unclosed`
holds none of the tokens and is still reported.

One exception runs the other way. The Markdown adapter hands the top-level `import` and `export`
blocks of an `.mdx` file to the JavaScript adapter, and Babel can reject them, so a token-free
`.mdx` file whose `import` or `export` block does not parse is skipped instead of being reported as
a file that could not be parsed. That is accepted for three reasons. No reference is lost, since
without a token there is nothing to find. MDX itself refuses to compile such a file, so its author
already knows. And the alternative is expensive: in the five validation repositories, 1,637 of
2,905 `.mdx` files carry `import` or `export` blocks, nearly all of them component imports, and
taking `.mdx` out of the skip would parse every one of them to find nothing.

The token list is where the risk sits. A token missing from it drops a finding with no error,
which is the silent skip the engine treats as its worst bug. A token too many only costs a parse.
So the list errs wide (`style` matches the word "styling" in prose) and has four families:

1. Every tracked image extension.
2. Constructs that mark a reference position without an extension: `url(`, `image-set(`, the
   attributes `src`, `href` (which also matches `xlink:href`), `poster` and `style` (which also
   matches `styled`), and the CSS-in-JS tags `keyframes`, `createGlobalStyle` and `injectGlobal`.
   `url($icon-path)` in SCSS is reported as `dynamic` and holds no extension at all.
3. Encoded spellings. The resolver also tries a path's entity-decoded and percent-decoded forms, so
   `![alt](hero&#46;png)` resolves to `hero.png`. The named entities it decodes (`&amp;`, `&lt;`,
   `&gt;`, `&quot;`, `&apos;`) cannot spell an extension character, so every entity that hides one
   is numeric and contains `&#`. Percent-decoding applies to any character, and `hero.%70ng` is
   `hero.png`, so the token is `%` rather than `%2`.
4. Template markers. A templated destination such as `![logo]({{ site.logo }})` is reported as
   `dynamic` and has no static extension.

The skip decides per file: one token anywhere parses the whole document. A test of one spelling
therefore needs a file of its own, because a file holding several spellings is parsed if any one of
them is handled, and cannot show which. The coverage tree keeps `encoded-entity.md`,
`encoded-percent-dot.md` and `encoded-percent-letter.md` apart for this reason.

One gap is accepted. A CSS-in-JS block with the bare `css` tag, whose body does not parse, which
contains no `url(` or `image-set(`, in a file with no other token, is skipped along with its
`dynamic` finding. Since the JavaScript adapter reads the `import` and `export` blocks of `.mdx`
files, such a block can reach a skippable adapter inside an MDX `export`. `css` is not a token
because it is common in both prose and code (`import './x.css'`, `className`), and matching it
would cost most of what the skip saves.

## The graph

`buildGraph` is pure. It links each reference to the assets it resolved to, **through
`linkedPaths`, never by comparing `resolution`**, and returns an `AssetNode` per asset alongside
`byResolution`, every reference bucketed by outcome.

That bucketing is a correctness device, not a convenience. It is a `Record<Resolution, …>` literal,
so an eighth outcome fails to compile *here* rather than quietly vanishing from the report, the
same guarantee `linkedPaths` gets from its `never`-typed default. A reference cannot go missing
from the report without also going missing from a bucket, which makes "every skip is reported"
mechanical instead of remembered.

**Ordering is by POSIX-relative path, not by `Reference.file`.** `file` is an absolute native path,
and `/` (0x2F) and `\` (0x5C) fall on opposite sides of the alphanumerics: sorting it puts
`dir/a.html` before `dirZ.html` on Linux and *after* it on Windows. The promise that the same input
gives a byte-identical report would then be quietly false, and nobody would notice until two people
compared reports. The test for it only has teeth on Windows, because on POSIX the relative path is
a suffix of the absolute one and the two implementations cannot disagree.

A reference that links to a path outside the asset set throws `GRAPH_UNKNOWN_ASSET`. That cannot
happen in a single run (the resolver only ever returns paths it took from those very assets), but
it can the moment references are resolved against a cached asset set, which is exactly what the
editor integration will do. The quiet version of that bug is a phantom dead asset.

## The probe, and why it has two methods

Two of the four audit findings need pixels: `oversized` needs dimensions, and format opportunities
must be **measured**, not guessed. `ImageProbe` is the port that provides them, injected like the
resolver's `exists`; `createSharpProbe` is the implementation and one of the modules that touch the
disk. `encodeToFile` adds the write `optimize` needs to the same port, so a file is written by the
code that measured it.

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
caller asks for by name: `formats` is required and has no default, because the default belongs to
configuration: webp, with AVIF opt-in via `--format avif`. The audit measures the format it would
actually convert to; measuring one the tool would not produce is work nobody asked for.

### The cap is a count, not a threshold or a deadline

Even at WebP alone, two thousand images is twelve minutes, and `audit` is meant to be the fast
read-only command. So `maxEncodedAssets` bounds how many assets are encoded, and the two obvious
alternatives are both wrong:

- **A byte threshold bounds nothing.** Encode cost tracks pixel count, not file size, so a threshold
  does no work at all on a repository of three thousand large images, precisely the "large public
  directory" that the validation protocol requires us to test against.
- **A duration budget would break byte-identical output.** The same input must give the same
  report, so a slow machine must not measure fewer assets than a fast one.

Selection is largest source first, ties broken by path, so *which* assets are measured is a
deterministic function of the repository. Assets that could never be encoded (a vector, or one
already in every requested format) leave the running before the cap applies, so they cannot occupy
a slot they will not use. A byte or pixel floor can sit underneath as a secondary filter; the count
is what bounds.

What makes this safe is that it degrades exactly **one** of the four findings. `dead` and `broken`
need no probe at all, and `oversized` needs only the ~1 ms header read, which still happens for every
asset however low the cap goes. Everything past the cap is reported as unmeasured, with a count, a
reason and the flag that lifts it; silence would read as "no opportunity here". The default comes
from `bench/` rather than a guess, like the concurrency number.

### Animation is the trap

Encoding an animated GIF the obvious way keeps **one frame**. Sharp's own ten-frame, 370×285 fixture
encodes to 616 bytes that way, against 8 370 bytes for the real thing. Reported as a format
opportunity that is a ~92% saving achievable only by destroying the image: a headline finding in the
audit and a corrupted file when the rewrite acts on it.

The asymmetry is the thing to remember: **`encodedBytes` must pass `animated` and `metadata()` must
not**, and getting either backwards produces a confidently wrong number in opposite directions: a
phantom 92% saving, or an image reported ten times too tall.

So `encodedBytes` takes `animated`, and `probeAssets` passes `pages > 1` from the metadata it already
holds. And `metadata()` is deliberately a *plain* read: with `{ animated: true }` that same file
reports 370×**2850**, every frame stacked into one strip, which would make an "oversized by
dimensions" finding wrong by a factor of ten. The plain read gives one frame's dimensions and still
reports `pages`, answering both questions in one pass.

### Lossless WebP for PNG sources

For a PNG source, the probe measures two WebP encodes, one at the configured quality and one
lossless, and keeps whichever is smaller. A lossless encode is bit-exact, so when it is also smaller
it is better on both axes and there is nothing left to weigh. The choice needs no classifier for
text-heavy images and never consults a perceptual metric. That matters: PSNR rates text-heavy images
higher at every quality, so it would argue for lowering quality on exactly the images that lose most
from it. A byte comparison against an exact encode cannot be misled by a metric it does not use.

The trigger is the source container, not the picture. `bench/src/lossless-cohort.ts` encodes every
raster image in the five validation repositories, 5,857 of them: lossless beats webp 80 on 1,736, by
30.2% at the median, and 1,689 of those are PNG. A JPEG source wins 7 times in 1,693, because
encoding already-lossy pixels exactly preserves their artefacts at full price. Restricting the
second encode to PNG keeps 97.3% of the wins and skips 34% of the second encodes, which are not
free: a lossless encode costs about 1.3 times a lossy one.

One entry per format is recorded, and it carries its setting: `EncodedSize.quality` is a number or
`'lossless'`. `'lossless'` is not a quality of 100, since a lossy WebP at 100 is not bit-exact, and a
number standing in for it would misdescribe the encode to everything that formats it. The planner's
savings, the audit's format opportunities and the report's per-format grouping all assume one
measurement per format. Because the setting varies per image, a summary across assets (the report's
`savingQuality`) collects the settings rather than keeping one, and `PlannedConversion` carries the
setting to `encodeToFile`, so the file `optimize` writes is the one whose saving `audit` reported.

AVIF has no lossless option. On the text-heavy images lossless WebP is aimed at, `avif 75` already
saves 25.6% at the median with a worst SSIM of 0.9934, and lossless AVIF has not been measured. An
option nobody has measured is one nobody should be able to select.

### Nothing throws for a bad image

A zero-byte file, a truncated JPEG, a text file wearing a `.png` extension, a file that vanished
mid-run: every one becomes an `AssetProbe` carrying `metadata: null` and a recorded reason. Sharp
rejects for all of them and `failOn: 'none'` does not help, since it governs decode warnings rather
than header parsing. Measurements not taken are listed with reasons for the same reason skipped
references are: silence would read as "no opportunity here".

Sharp is imported **lazily**. It is a native module, and the previous generation of this project
shipped one built for a single platform and was broken everywhere else for months. A top-level
import would load the binary the moment anything in `upfly-core` is imported, so
`upfly audit --no-probe` would fail on a machine that needs no pixels at all.

### The recorded reason is ours, and the library's is not in the report

The same input must give a byte-identical report, and a failing decode is where that promise nearly
died. libvips does not word the same failure the same way twice: reading four corrupt SVGs 160 times
at probe concurrency gives the full message on most reads and a bare `Input file has corrupt header:`
with nothing after it on the rest. Because the report sorts its skipped list by reason, an unstable
sentence moved entries as well as changing them.

So the report carries one sentence per failure code, written by us, and the library's own text goes
to `ProbeOptions.onDiagnostic`. **There is deliberately no field for it on `ProbeSkip`.** A field
would sit inside the value the report is built from, and keeping it out of the output would then be
a rule someone has to remember; with no field there is nothing for a renderer to print or a sort to
key on. An absent sink drops the text rather than storing it, so a caller with nowhere to put it does
not quietly acquire an unstable string.

The general form is worth more than the instance: **a third-party library's error text does not
belong in an artefact we make a determinism promise about.** It is free to change between versions,
and it describes the library rather than describing what Upfly did.

Dropping the library's text loses nothing a reader needs, because the failure codes carry the
distinctions that matter. They are enumerated by what a reader can do about the failure, not by what
libvips said, and there are only three answers: supply a real image (`not-an-image`), fix the SVG
(`svg-unreadable`), or make the image smaller (`too-large-to-encode`). `encode-failed` remains for a
failure nothing classifies, so that it still reaches the report. The list is bounded, since it does
not grow when libvips adds a message, and each code is decided from our own data. A header failure
is split by extension: a `.svg` that will not read is an SVG to fix, and anything else is not an
image. An encode failure is `too-large-to-encode` when the measured width times height times frame
count exceeds `MAX_ENCODE_PIXELS`. That limit equals sharp's default `limitInputPixels` and is passed
to sharp explicitly, so our arithmetic and the limit in force cannot drift apart. In the five
validation repositories, 21 measurements fail: 8 files that are not images (HTML error pages saved
as `.png`, Git LFS pointers, zero-byte placeholders), 12 unreadable SVGs (no usable width and height,
malformed XML, or too large for the XML parser) and 1 image past the pixel limit.

### Two paths are the same file more often than they look

Windows and macOS fold case; Linux does not. `Reaktor.jpg` and `reaktor.png` convert to `Reaktor.webp`
and `reaktor.webp`, which are two files on one platform in the CI matrix and one file on the other
two. Every comparison here folds case when the question is *would these end up as the same file*: the
planner when it groups conversions by target, and the transaction when `prepare` claims a path.

Folded on **every** platform, not only where the filesystem demands it. Folding everywhere costs a
conversion on Linux that would have been safe there. Not folding means one repository gets a different
plan, a different report and a different set of files depending on where it runs, which no promise
about determinism survives.

## Offsets are UTF-16 code units

`start` and `end` are indices into the JavaScript string, the same units every JS parser and
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

`validateEdits` runs the same checks without applying anything. `applyEdits` and `invertEdits` call
it, and so does the transaction's `prepare`, which rejects a whole run before a single byte is
written.

## The transaction

Writing is two-phase, because a half-applied run is worse than a failed one.

**Prepare**: with every image already encoded into `.upfly/runs/<run-id>/`, back up the bytes of
anything that will be destroyed, compute every edit in memory, and check the whole plan. Any
failure here leaves the working tree completely untouched.

**Commit**, in this order, and the order is the design:

1. **write `.upfly/manifest.json` in `pending` state**, before a single file is touched
2. create new files: staged images into place, and the destination half of every move
3. apply the text edits
4. remove what is now superseded: deleted originals, and the source half of every move
5. rewrite the manifest in `committed` state

The manifest comes first because it is a statement of intent, not a receipt. A crash at any later
step leaves a `pending` manifest that `undo` can act on; a manifest written after the images and the
edits would leave a crash with a changed tree and no record, which is the one state `undo` cannot get
out of.

**The three write phases are separate functions, and each takes a witness value that only
the previous phase can produce.** That is not decoration. Step 4 is safe only because step 3
completed over *every* edit rather than running per asset: interleaved into a
create-edit-delete loop one asset at a time, asset B's delete runs before asset A's edits and
any file naming both is momentarily inconsistent. The crash matrix cannot see that, because it
injects failures by mutation count and an interleaved loop produces the same count in the same
order. The witnesses make the phases impossible to reorder; they do not make a per-asset loop
impossible, but they remove the innocent version of it, where three loops are merged into one
and nothing in the diff says an invariant died.

**Every prefix of that sequence leaves a tree that still builds** under the default
`keep-original` policy. Files appear before anything points at them, and originals are removed
only once nothing points at them any more. A move is committed as a copy in step 2 and a
removal in step 4 for exactly this reason: between the two, both paths exist.

**What `replace` converts, and which originals it removes, are the planner's decisions, and they
are two halves of one property.** An asset converts only when the plan moves at least one
reference to the new file, and its original is deleted only when the plan moves every reference
that links to it. So under `replace` an asset ends one of three ways:

| the asset | outcome |
|---|---|
| every reference to it moves | converted, original deleted |
| some move, and one the plan cannot move still needs the old file (a pattern, a refused literal, a path with no extension to change) | converted, original kept, and `keptOriginals` says which reference needs it |
| no reference would move: nothing links to it, or only references the plan cannot move | not converted, and `declined` names what holds it |

What `replace` never produces is a converted copy nothing asks for beside an original that has to
stay, which is the pair of files the policy exists to avoid. `keep-original` is untouched by the
first half, because two files are what its users asked for.

**Served means under any serving root the resolver used**, and `replace` removes originals only
there. The planner is handed the same `ServingRoots` value the resolver was, not a folder derived
beside it, so an image in a monorepo's second website folder is as served as one in its first.
Moving a file between two website folders is refused by `relocate`, because a URL that finds it in
one will not find it in the other. When the run found no serving root and the project declared
none, nothing counts as served: every original is kept, and the report says so and how to name the
folder. Guessing the project root instead would remove that protection from every project that
has no website folder at all.

The conversion half is decided per asset before collisions and before any reference is repointed,
so every sentence the plan writes afterwards is about assets that really convert. Asking that early
gives the finished plan's answer because whether a reference moves depends only on the reference
once its one asset converts; a pattern, the only reference that links several assets, never moves.
The deletion half runs last and does not rely on the first: it keeps the original of an asset
nothing links to on its own account, so loosening the conversion half can never delete a file.

The old-path text search (see "Moving an asset") then guards the references the graph never found,
for a path written down literally. **The bound that remains:** a path assembled at runtime that the
graph did not find, pointing at an asset some other reference links and this run moves. The text
search cannot see it, because it is not written down, and the planner cannot, because it is not a
reference it knows, so that original goes. It is the one way `replace` can still remove a file a
page asks for.

**Recovery is a pure function of the manifest and the current disk.** Every operation records
the content hash on both sides, so hashing a file says whether that operation ran. Nothing
depends on how far a counter got before the process died, and commit therefore keeps no journal
of its own progress. A file matching neither hash was changed by something other than the run:
the transaction refuses to touch it and names it in the error, because silently writing over
somebody's work is worse than leaving a run half applied.

**That check is made again at the moment of writing, not only in prepare.** A file an editor saves
after prepare leaves edit offsets that no longer describe the text, and applying them would both
corrupt the file and store an undo that does not fit it: damage `inspect` would report afterwards
rather than prevent.

**There is no separate "recover an interrupted run" path.** Undoing a finished run and cleaning
up an interrupted one are the same job (reverse whatever the disk says actually happened), so
there is no rarely-exercised branch left to be wrong.

A run that stopped part way leaves its manifest `pending`, and that manifest is the only record of
what it wrote and where its backups are. So `commit` refuses to start while the manifest is
`pending` for another run (`TRANSACTION_INTERRUPTED`): the interrupted run is reverted first. The
lock does not settle this by itself, because the process that held it is gone and its lock is
cleared as stale.

Upfly's folder hides itself from git: before an applied run's first write, `optimize` creates
`.upfly/.gitignore` holding `*` unless one is already there. Staged images and backups never show
in `git status`, `git add -A` never takes them, and the project's own `.gitignore` is never
touched.

**The manifest is self-contained**, and holds no absolute path, so it still means something
after the project is moved. For a text file it stores the *inverse* edits rather than a copy of
the file: the replaced text is a path string, so undo restores the file from bytes rather than
kilobytes. A delete is the one operation whose content nothing else can reconstruct, so its
bytes are backed up under the run directory and `prepare` refuses a delete whose backup is not
actually there. `revert` checks the same backups before its first write and refuses if one has
gone since, so an undo never stops part way through putting originals back. **The run directory
therefore survives commit**: deleting it would throw away the only copy of anything the `replace`
policy removed.

On top of all that, `upfly optimize --apply` refuses a project folder with uncommitted changes
unless forced, and `--commit` produces exactly one commit, making `git revert` the real undo
button and code review the trust mechanism. The rules are under "The CLI" below.

Windows specifics that are handled deliberately, not incidentally: every placement is a
`copyFile` rather than a rename, so a run directory on another volume cannot fail the way a
cross-volume rename would; long paths are supported; and `EBUSY` and `EPERM` are retried with
backoff, because on Windows an editor or a virus scanner holds a handle open for a few
milliseconds and failing the run for that would make the tool unusable on a first-class target.

### One writer at a time

The manifest has one fixed path, `.upfly/manifest.json`, and `undo` reverts the run it records.
That holds only while one run writes at a time. If two runs wrote at once, one would replace the
other's manifest, and the run whose record was replaced would leave its backups under
`.upfly/runs/<run-id>/` with nothing pointing at them: the originals it removed could not be put
back. The lock, `.upfly/lock`, makes one writer at a time a rule the code enforces. It protects the
record rather than the files: commit hashes each edit target again before writing it, so a file
another run changed after this run staged is refused anyway.

`commit` and `revert` each take the lock for their whole duration, so a caller that uses the
transaction directly is covered. `optimize` also takes it before `prepare` and holds it until
`commit` returns, so no other run can start and finish between this run's checks and its first
manifest write. The holds nest: a run may take the lock again while it holds it, and releasing a
nested hold does nothing, so an inner `commit` finishing does not unlock the run around it.
Re-entry needs both the same run id and the same process. A process id alone cannot tell apart two
runs in one process, as an editor extension would have; a run id alone would let an `undo` started
from a second terminal, which reads the run id from the manifest, walk into that run while it is
still writing.

The lock file is made with an exclusive create (`O_EXCL`), never by checking for it and then writing
it, since two runs could both see no lock and both write one. That is why `FileStore` has a
`createExclusive` method rather than the lock composing `hash` and `writeText`.

A run that finds the lock held by a live process is refused with `TRANSACTION_LOCKED`, never queued.
A queued run would stall silently behind a long one, and an editor would look frozen. The refusal
names the run holding the lock, its process and when it started, so the user can tell whether
anything is still running.

A lock whose process is gone is stale and is cleared, and so is a lock file that cannot be read,
since neither names a holder that could be alive. Staleness is decided by whether the holding
process is alive, not by the lock's age: to a clock, a long run looks the same as a stuck one.
Clearing is tried once. If another run takes the lock in between, this one is refused rather than
retrying in a loop. On the way out, a run removes the lock only if it still names that run and
process, so a run whose lock was cleared as stale cannot delete its successor's.

## Moving an asset

`planRelocation` (`relocate.ts`) moves assets and repoints every reference that names them.
Renaming and moving are one operation, so a single-file move is the simple case of a folder move.
It is pure, like the planner, and its moves ride the same transaction and manifest as `optimize`:
each is committed as a copy in step 2 and a removal in step 4, and `revert` undoes it.

A repointed reference keeps the form it was written in, as seen from the file that holds it. A
root-relative URL stays root-relative, a relative path is re-derived from the referencing file's
directory, an aliased import keeps its alias, a leading `./` stays when the original had one, and a
percent-encoded name stays encoded. A diff in which `./` comes and goes is one nobody can review, and
a raw space written into a URL breaks it.

### What a move refuses

A move acts on what the graph knows. A reference the graph missed becomes a broken reference the
move caused, not one it found. So `relocate` refuses whatever it cannot carry out by changing path
text, and reports each refusal with its reason. A refused move contributes no rewrites, so a caller
that ignores the refusals writes less than it asked for, never something wrong.

It rewrites paths, not code, and where a file lives decides how it is referenced:

| where it lives | how code refers to it | what resolves it |
|---|---|---|
| `src/assets/hero.png` | `import hero from '~/assets/hero.png'` | the bundler, which hashes and emits it |
| `public/img/hero.png` | `<img src="/img/hero.png">` | the web server, which serves the bytes as they are |

Moving a file from one row to the other would turn an import into a URL string or the reverse, which
is a code change, so it is refused as `crosses-serving-boundary`. The same code covers a move between
two serving roots, where a URL that finds the file today would not find it afterwards, and a move out
of reach of the alias an import uses: `~/* → src/*` cannot spell a path outside `src/`. A move wholly
inside one world proceeds.

A template reference such as `` `./theme-${mode}.png` `` is one piece of text standing for every file
it matches, so moving one of them breaks it for all of them. That move is refused as
`binds-a-pattern`, naming the other files. Taking them along is not the fix: the user asked for one
file. The remaining refusals guard the request itself: a source that is not an asset, a destination
outside the project or already holding an asset, a destination claimed by two moves (compared
case-insensitively, as `prepare` compares), and a source moved twice.

Some references to a moved asset cannot be repointed: a template, a reference a rewrite rule forbids
editing, or one whose new spelling cannot be worked out. They do not stop the move. Each is listed in
`declined`, because it will break.

### What "broken before versus after" can see

The obvious check after a move counts broken references before and after it. That count comes from
the same graph that decides which references exist, so it can only show that the move broke nothing
Upfly can read. A reference to a moved asset in a file type nothing scans, such as
`deploy/netlify.yml`, breaks while the count reads 0 before and 0 after. That is the shape of the
check rather than a defect in it, so `checkMoveRegression` (`move-check.ts`) states the limit beside
the number. The count and its limit are one value, and `lines` renders both whatever the verdict: a
regression of three says nothing about a fourth break the count could not see.

The limit names each class a reader would act on differently:

- Unread file types that could hold a path, with their file counts. Binary types such as fonts are
  left out, since no path text can hide in them. An unread type wants an adapter.
- Files of a type Upfly reads that could not be parsed, each named with the parser's complaint.
  Grouped by extension they would read as a missing adapter, when the cause is usually one invalid
  construct, such as bad CSS inside an inline `<style>`, which makes a whole HTML file unreadable.
  A parse failure is the likeliest place a break hides: if that file links a moved asset, the move
  breaks the reference and the count stays level, because the failure that hid the reference also
  hid the breakage.
- Directories excluded by an ignore rule. Their files are in neither the graph nor the unread count,
  so without this line a reader would take the unread count for the whole blind spot.
- Paths a program assembles at runtime, which neither side of the count can contain.

When the two sides left a different number of files unread, the report says the comparison is not
like-for-like. A move relocates assets rather than sources, so that should not happen.

Nothing in the types stops a caller printing `brokenAfter` alone. The module makes stating the limit
the shorter path, not the only one.

### The independent check

`findSurvivingPaths` (`old-path-search.ts`) searches the text of every file for each moved asset's
old path, and never reads a graph: a check built on the graph that missed a reference would miss it
again. It searches the path, not the basename, because a move keeps the file name and the basename
would match the asset at its new place. For the same reason `sweepForMentions`, which matches the
basenames of assets nothing references, is not reused.

A long needle misses the URL that markup uses, and a short one matches too much, so the old path is
searched in several spellings, and each finding names the one that matched: the path as stored, with
a leading slash for a project served from its own root, as a URL under each serving root
(`/img/hero.png` for `public/img/hero.png`), as its last directory and file name (`img/hero.png`,
which catches `../../img/hero.png`), and with Windows separators. A match that lies inside a
destination path is discounted, because for an asset at a serving root the old URL (`/og.png`) is
also the end of the new one (`/moved/og.png`).

A survivor is an occurrence the move did not rewrite. It is usually a reference that could not be
repointed, but it can be prose, a changelog entry or a coincidence, and a text search cannot tell
them apart, so each is reported with its line for a person to read. Reporting a coincidence costs a
glance; missing a break costs a missing image. The limits are printed with every result: a path
assembled at runtime, a path spelled some other way (URL-encoded, behind a CDN prefix, split across a
concatenation), and a file nobody handed the search, such as one in an excluded directory.

`optimize` runs the same search before it writes, treating each original that `replace` would delete
as a move to its converted file. At that point the old path still appears in the references the plan
is about to rewrite, so a match inside a planned edit's range is discounted by its offset. An asset
whose path survives elsewhere is not converted, its decline names where the mention is, and the
report adds one caveat for the run stating the search's bound. What that leaves uncovered is under
"The transaction".

## Performance budget

Building the graph on a 10k-file / 2k-image repository must stay **under 3 seconds** cold.

**That budget is missed, and the reason is measured.** CI's `bench (gate)` cell reads about 4.4 s on
Linux and 5.2 s on Windows, inside the regression ceilings and above the target, which was
deliberately not moved. Parsing is about 70% of `scan`, and the main thread is the bottleneck;
reading files never was.

**A pool of parse workers does not help.** Each worker pays V8's warm-up again, so the work grows as
it is spread: 8,763 ms of CPU at one worker became 27,074 ms at eight, for identical input. And its
two knobs oppose each other, because the setting that keeps the workers busy is the one that
inflates the work. The pool was removed before the public API was published; its last version is in
commit `c84a2f3`, for the day a long-lived process such as the editor extension, which would pay the
warm-up once, measures a win.

What does ship is narrower: a file whose text holds none of the tokens a reference needs is not
parsed at all, which is exact rather than fast and carries no performance claim. What remains
untried is a parse cache, a faster parser, and that long-lived process. **The budget number does not
move until a fix is measured.**

That budget covers **discovery, parsing, resolution and graph building only**. Probing and
encoding are explicitly excluded and reported as a separate number: both are dominated by
libvips, and optimising against a target that included them would mean tuning our code against
somebody else's decode time. **They are bounded separately, because their profiles are opposite:**
reads are IO-bound and default to **16 at a time** (`scan.ts`), encodes are CPU-bound with libvips
already multithreading internally and default to **4** (`probe.ts`), a measured default:
`os.cpus() - 1` was about 21% worse.

`bench/` is checked in and runs in CI against a fixed fixture, so a regression shows up as a
number rather than a feeling. **Any performance claim in the README must come from a number `bench/`
produced in CI**: the previous generation of this project shipped unmeasured claims, and this one
does not.

## The report

The JSON is public API and carries `version`. It is snapshot-tested over all five fixture trees, so a
schema change shows up as a diff somebody has to approve rather than as tests that still pass.

**No absolute path reaches it.** Half the data upstream carries an absolute `path` beside a POSIX
`relative` (`SkippedEntry`, `ExcludedRoot`, `UnscannedFile`, `Reference.file`), and the validation
protocol runs the same repository from two working directories and requires byte-identical output.
Projecting to the relative form is the report's job, and the guard is a test that serialises the
report and greps it for the root. It is one forgotten projection away from being false.

Everything declined, from every stage, lands in **one flat `skipped` list** rather than five
per-stage ones. Keeping every skip reported is easier when there is a single place to append to.

Two calls about references are worth knowing:

- The unsafe bucket (`dynamic`, `unresolved-alias`, `out-of-scope`) is **listed in full**. It is
  the "N references I couldn't safely rewrite" number, and it is the honesty that earns trust for
  everything else on the page.
- `discarded` is **counted, not listed**. A real repository produces thousands of them from lockfiles
  and i18n bundles, and listing them buries everything else. The count is still there, because it is
  what tells a user the JSON adapter has started eating something real.

### `findings` holds what there is something to do about

It is not every finding the audit produced. An unreferenced **vector** is moved to `unusedVectors`,
a count and a total size, because Upfly neither converts a vector nor deletes an asset, so itemising
one proposes the only two things it will not do. `--include-unused-svg` lists them;
`summary.findings` counts the itemised array, so the two can never disagree. On `astro-docs` this is
what takes the unreferenced-asset findings from 150 to 24, and the hedges from 140 to 18.

The argument is **"we offer no action", not "vectors are small"**. The second is false, and measured:
SVG is 96% of `shadcn-ui`'s hedged bytes and `eleventy-docs`' nine vectors are 210 KB. That is why the
counted line carries the size: Upfly never deletes an unused asset, so the decision stays with the
reader, and a total is what turns a count into one. SVGs stay in reference tracking throughout: a
broken `<img src="/logo.svg">` is a broken image like any other.

The set of vector extensions lives in `paths.ts`, not in the probe, because **two decisions depend on
it being the same set**: what the probe declines to encode, and what the report declines to itemise.

One exception keeps a vector itemised: if a broken reference asks for its raster twin (`hero.svg`
unreferenced beside a broken `hero.png`), the pair lands in `staleConversions` and the vector stays in
`findings`. There *is* an action, which is to fix the reference. It is phrased as two facts and an
inference the reader judges, never as a conclusion.

**An original kept beside its converted file leaves `findings` too.** After an `optimize` that keeps
originals, the references point at `logo.webp` and nothing links to `logo.png`, so the audit calls it
`dead`. That is true, and it is the user's own choice, not an unused image to clean up. So a `dead`
raster whose converted twin (the same path with `.webp` or `.avif`) exists and is linked moves to
`keptOriginals`: listed in full in the JSON, and counted with its size in the human headline. A twin
that nothing links to either proves nothing, and both stay findings.

### The human renderer prints the skipped list before the findings

That ordering is deliberate and slightly uncomfortable: it puts what the tool could *not* do above
what it found. A limitation printed after eighty findings is a limitation nobody reads, and the
previous generation of this project lost trust by failing quietly.

Nothing in it uses `toLocaleString` or `Intl`. Locale-dependent formatting would render `1,5 MB` on
some machines, which breaks the byte-identical rule exactly the way `localeCompare` would, so bytes
are formatted by hand. Colour is the CLI's business, since that is the layer that knows about TTYs
and `NO_COLOR`.

Caveats carry their own count and a `detail` list. "No adapter reads these file types" is a shrug;
`.astro — 1 file` is how someone finds out which adapter they want.

### Scoring references for accuracy

Every reference in the report carries a `classification`, which answers two questions: did the
reference have an answer (a file it really names), and did the engine give one?

| | the engine answered | the engine refused |
|---|---|---|
| there is an answer | `resolved-with-an-answer`: success | `missed-with-an-answer`: the ordinary failure |
| there is no answer | a wrong answer: the dangerous failure | `correctly-refused`: success |

A `broken` reference counts as answered. The engine worked out where it points and reported the
truth, that the file is not there, and the defect is the project's.

The fourth box is the one the engine cannot fill. A wrong answer, whether a false link, a false
`broken` or a false `dead`, is one the engine believes, so a count it reported itself would always
be zero. Refusal accuracy, correct refusals over correct refusals plus wrong answers, would then come
out at 100% for any engine. So the report carries no such count, and
`refusalAccuracyIsNotSelfAssessable: true` marks the absence as a decision. Wrong answers can only be
counted by a check that does not share the engine's assumptions, such as the verification in
`bench/src/verify.ts`; a check built on the same assumptions agrees with the same mistakes.
Resolution accuracy, answered over answered plus missed, can be computed from
`references.byClassification`.

The default is the unflattering one. Whether an answer exists is the engine's own judgement, so a
reference counts as `correctly-refused` only when a property from the closed list `REFUSAL_REASONS`
holds for it: a path assembled at render time, a target outside what Upfly acts on, or a style
attribute the adapter could not read that holds no url-taking function. Each is a fact about the
reference, never "the engine cannot handle it". Everything else is `missed-with-an-answer`, including
an alias that no config the engine can read declares, since a bundler config it did not read may
well resolve it. Adding a reason moves references from missed to correctly refused and raises the
accuracy figure, which is why it has to be a visible edit to one list rather than a condition
somewhere else.

Refusals are listed, not only counted. Each entry in `references.unsafe` carries its
`refusalReason`, so a reader can dispute a single refusal. A reason known to over-claim carries a
measured bound and a note of what it was measured against. For every such reason a run uses,
`references.classificationBounds` puts both beside the counts, and the human report prints them, so
an accuracy figure never travels without its known error, and a reader can tell when the measurement
has gone stale.

Path-shaped strings nobody asserted (the `discarded` references) are `not-a-claim` and stay out of
both figures: scoring the engine on them would measure it against work that was never its job.

The engine decides the class once, as a field. If the CLI, an editor or `bench/` derived it, each
would hold its own copy of the rule, and the copies would drift.

`coverage.notExercised` guards the same figures from another side. A check run under a configuration
that skips a mechanism passes without testing it: with serving roots declared, detection never runs,
so a known detection defect can look fixed. The report names each mechanism a run did not use, as a
fact about the run's input rather than a judgement about the engine.

## The CLI

`upfly` is a thin layer over the engine: it reads the command line and the configuration, runs
`runPipeline` (`audit`), `optimizeProject` (`optimize`) or the transaction's `revert` (`undo`),
and prints. It decides serving roots with the engine's own `servingRootsFor`, so a command cannot
decide them differently from the measurements behind it.

**The configuration file is `upfly.config.ts` (or `.js` and their module forms), or
`upfly.config.json`, in the directory the command runs on.** The code forms load through c12 with
everything a user did not ask for turned off: `extends` layers, which c12 would download from a
`github:` or `https:` source, rc files, `.env`, a `package.json` key and `NODE_ENV` sections. Upfly
makes no network calls, which is why the first is off, and the rest would each change a run without
the config file saying so. The JSON form is read as JSONC with syntax errors collected, so a
truncated file is an error rather than a partial config.

**The v2 VS Code extension reads a file with the same name,** holding `enabled`, `watchTargets` and
similar settings. A JSON config with any of those and nothing that only this CLI uses (`publicDirs`,
`publicPolicy`, `exclude`, or its `$schema`) is the extension's, and every command refuses it with
exit 3 and leaves it untouched. `format` is not evidence either way, because both products use the
name. A code config beside the extension's file is read and the file is left alone.

**Output.** With `--json`, stdout carries only JSON lines: progress events as each stage finishes,
the libraries' own messages as `diagnostic` lines, and one final `result` or `error` object. That
is why the libraries' wording can appear there and never in the report. Without it, the report goes
to stdout, and errors and progress go to stderr, progress only on a terminal. Colour appears only on
a terminal, and never under `--no-color` or a non-empty `NO_COLOR`.

**Exit codes** are a contract: 0 the command ran, 1 `check` found findings over its thresholds, 2 the
command line or configuration was wrong, 3 Upfly refused to act for safety, 4 something it did not
anticipate went wrong. A crash is its own code, because it is neither a finding nor a refusal. A
refusal's `error` line under `--json` also carries a `reason`, a stable name such as
`UNCOMMITTED_CHANGES` or the engine's `TRANSACTION_LOCKED`, so a script can tell refusals apart
without reading the sentence.

### `optimize` and git

The promise is that the run's changes are the only ones a reviewer has to look at, and that one
`git revert` takes them all back. Everything below follows from that.

- **Only the project folder is looked at.** A project can sit inside a larger repository, on
  purpose (a package in a monorepo) or by accident (a home folder that is itself a repository).
  `git status -- .` and `git ls-files -- .` run in the project folder, and git reports those paths
  relative to the repository's top, so they are cut back to the project. When the top is above the
  project, the dry run and the commit's output name the repository.
- **`--apply` refuses uncommitted changes in the project folder, untracked files included** (exit
  3). An untracked original that `--replace` removed could not be restored by git at all.
  `.upfly/` never counts. `--allow-dirty` writes anyway; `upfly undo` still puts the files back.
- **Where git cannot help, `--apply` refuses the same way**: no git, no repository, or a repository
  that tracks no file in the folder (an ignored folder looks clean to `git status`). `--allow-dirty`
  is the way through.
- **`--commit` needs a clean folder and cannot be combined with `--allow-dirty`**: a file holding
  both the user's edit and the run's would put the user's edit in Upfly's commit, and `git revert`
  would take it out again. It also needs a git identity, checked before anything is written.
- **The commit holds exactly the files the run wrote**, from the manifest: `git add` and then
  `git commit --only` on those paths, read literally (`GIT_LITERAL_PATHSPECS`), so a name holding
  `[` never matches a second file and work the user staged elsewhere stays staged and out of the
  commit. Paths travel on stdin, never through a shell.
- **A commit that could not hold the whole run stops the run before it writes.** Once the plan is
  final, `optimize` hands it to a `beforeWrite` check, and the CLI asks `git check-ignore` about
  every path the plan would write; if git would refuse any of them, nothing is written.
- **The commit message ends with `Upfly-Run: <run id>`**, the id the manifest records, which is how
  `upfly undo` finds the commit to say that it is still in the history. Undo follows the manifest
  alone and reads no configuration file.

## Package layout

| Package | Published as | Contains |
|---|---|---|
| `packages/core` | `upfly-core` | graph, adapters, planner, transaction, report. No CLI or editor concerns, no network. |
| `packages/cli` | `upfly` | argument parsing, human/JSON output, exit codes, git safety. |
| `packages/vscode` | `upfly-vscode` | the editor surface (not yet written). |

`fixtures/` holds small but real projects per framework, each with a `build` script. `bench`'s
`fixture-build` runs `optimize --apply` against copies of them and then builds them and checks
every link: if a build breaks, the reference detection was wrong. With `--cli` it does the same
through the built `upfly` binary, with git. **That test is the product's central promise.** It
runs locally: CI builds the packages but does not yet build the fixtures.
