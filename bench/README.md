# bench

The tools that measure Upfly from outside the engine: its speed, its findings on real
repositories, and the fixture builds. Nothing here ships.

- `pnpm bench:gate` runs the speed gate CI runs.
- `pnpm bench` runs the whole benchmark.
- `pnpm validate` runs the engine over pinned public repositories, which live outside this
  repository and are never written to, and writes a report and a worksheet for each.
- `pnpm --filter upfly-bench run <script>` runs any other script in `bench/package.json`.

The sections below are the design notes these tools rest on.

## The gate is a regression ceiling, not the target

The 3-second budget in ARCHITECTURE.md's "Performance budget" is a design target. What fails a build in CI's `bench (gate)` cell is a
per-platform regression ceiling, 5,500 ms on Linux and 7,500 ms on Windows, which CI sets through
`UPFLY_BENCH_BUDGET_MS`. The two are kept apart because a ceiling that does not fail on noise has
to sit far above the target, and a reader who sees one number called the budget will take a
passing build for a met target. `bench` prints both on every run, and says whether the target is
met.

The ceiling's headroom is set by drift: on unchanged code, CI's headline moves by up to about 22%
from one run to the next. A ceiling inside that range flips its verdict between runs of the same
commit, so each one sits about 30% above the slowest run measured. The price is that the gate
catches a regression larger than about 30% and cannot see a 10% one. A smaller change needs an A/B
comparison run back to back in one session, which is what `bench/src/noise.ts` is for.

The headline is the median of three invocations, each a separate process that discards a warm-up
pass and takes the median of three runs. The first pass meets a cold filesystem cache, and
averaging it with warm passes measures neither state. Sampling inside one process controls that
cache and nothing else; separate processes also differ in module loading, JIT warm-up and libuv's
threadpool, which is the variation a CI runner has. The median rather than the mean, so one slow
run cannot move it.

How closely the invocations of one run agree is a machine-health check, not a promise that the
number will reproduce. In CI they differ by a few percent, so a run whose invocations differ by
more than 20% had something wrong with the machine: its headline is marked unusable and the build
fails, rather than passing or failing on that number. Drift between runs cannot be seen from inside
one run at all, so every run prints the measured drift beside its result, and the ceiling's
headroom is what absorbs it. The per-step breakdown printed after the headline carries the same
warning about its own spreads.


## The benchmark tree

The budget is measured on a repository that `bench/src/generate.ts` builds: 10,000 files, 2,000 of
them images, every choice drawn from a seeded generator so that two machines measure the same work.
It is written to the OS temp directory, outside any workspace, and reused until its shape changes.
The shape's version is part of its path, and a timing describes only the version it was measured
on: a new version can be slower because the tree became more realistic, which is not a regression
in the engine.

A tree with the right number of files and the wrong content times the wrong work, so what the files
hold is measured rather than chosen, on `astro-docs`, `eleventy-docs` and `shadcn-ui`:

- File sizes, per extension. Real repositories size files by kind, and `.tsx`, the most common
  kind, is one of the smallest, so a single curve for every kind gives `.tsx` several times its real
  bytes and overstates its share of parse time. Each extension draws from its own measured quantiles
  (p0, p10 up to p90, and p99), interpolating between them so that the tree does not hold exactly
  eleven sizes. Nothing is drawn beyond p99: the largest real files are single outliers, and
  reproducing them would let a handful of files swing the mean.
- The extension mix, blended across the three repositories by file count. On top of it sits a small
  floor of `.scss`, `.html`, `.vue` and `.yaml`, which the three barely contain: without them two
  adapters go unmeasured, and the sweep of unread files has nothing to search, so its cost would
  read as zero. Those kinds borrow a neighbouring kind's sizes rather than invent their own.
- Directory depth, five levels, because the walker recurses per level and `relativePath` runs per
  reported path, so a shallow tree understates both.

The content matches real code's density as well as its size. Real components get much of their size
from comments, prose inside JSX, long strings and blank lines, so filler made only of declarations
hands the parser about twice the syntax nodes per kilobyte that real code does, while filler made
only of comments costs almost nothing to parse. Each kind is padded with more of what it already is,
and the prose in it is what adds bytes without adding nodes.

Markdown carries HTML at two rates measured over the five validation repositories: 71.5% of
documents hold a tag, and 0.9% hold an image reference that only the markdown adapter's parse5 pass
finds. The rates are far apart because most markup in documentation sits inside fenced code blocks,
which the adapter masks before parse5 reads the text, and the filler reproduces that split between
fenced and live markup. The second class is the one that matters. Without documents where skipping
parse5 loses a reference, the tree could only ever confirm that the skip is safe.
`generate.test.ts` checks, through the adapter itself rather than a regex, that such documents
exist and that both rates sit near the measured ones.

Images are real encodes, because the probe decodes them, and they are filled with noise, because
flat colour encodes to almost nothing and would make every measured saving a fiction. Encoding two
thousand distinct images would take longer than the benchmark, so each size bucket is encoded once
and copied. The sizes are long-tailed, mostly icons and a few large heroes, because the encode cap
selects the largest first and a uniform tree would make the cap look idle.


## Verifying findings from outside the engine

`bench/src/verify.ts` checks a report's findings against the repository itself. It resolves each
`broken` finding's path again, searches the whole tree for each `dead` asset's name, and opens each
citation behind a `possibly-dead` finding, including, when the run lists them, the unused vectors
the report otherwise only counts. Every item comes back `confirmed-genuine`, `confirmed-false` or
`ambiguous`, with the evidence that decided it, so a person reads only the ambiguous ones. Items
that are one decision, such as twenty fixtures that all ask for a missing `/next.svg`, share a
`group`, and the validation worksheet asks about them once.

The check does not run the engine's resolver, sweep or adapters. It walks the repository with its
own walker and indexes it with its own filename pattern, and takes from the engine only the list of
image extensions and the functions that write a path in its encoded spellings (`spellingsOf`,
`spell`). A check built on the engine's code agrees with the engine's mistakes.

A separate implementation is not enough, because assumptions travel without code. A string
comparison does not decode, so a check written from scratch still misses that `hero%20image.png`
names `hero image.png`. A filename pattern written the usual way stops at a space, so it reads
`Firing Practice.webp` as `Practice.webp`. A search that skips image files never reads an SVG, and
editors write file names into SVGs. Each gap would make the check confirm a false finding as
genuine, or call a correct one false. So the check asks about every spelling of a path and of a
name, its tokeniser walks left over spaces from each match, and it reads SVG files as text. Before
any verdict, `assertOracleSeesSpaces` runs the real indexing path over a name that contains a space,
and throws if the index cannot find it.

Where the answer depends on how serving works, the check models that behaviour rather than accepting
anything plausible, because a check looser than the truth reports a correct engine as wrong. A
root-relative path is tried only against the serving roots of the app that holds the referencing
file, as the resolver does, and against any `public/` directory above the file. A relative path is
tried only from the referencing file: `./` in an `<img src>` means beside the file, and the engine's
project-root fallback applies only to speculative references, which never become `broken` findings.

The check differs from the engine on purpose in three ways:

- It reads the directories `.upflyignore` excludes, since an asset referenced from an ignored
  directory is still referenced.
- It matches an asset's name under another image extension as well as its own. That finds a
  reference someone already converted by hand, and also an unrelated file with the same stem, so
  such a match makes the item `ambiguous` rather than deciding it.
- It decides whether a path exists from its own index of the tree, which is case-exact, not with
  `existsSync`, which is case-insensitive on Windows and would call a `broken` finding false when
  the reference breaks on a case-sensitive filesystem.

It does not index version control, dependencies, generated output or Upfly's own records
(`ORACLE_SKIPS`): every directory the engine prunes by default, which a test holds it to, in a list
of its own rather than the engine's. Generated output is derived from source: while the source names an asset the check finds it there, and a stale
bundle adds only a mention of an asset the source no longer uses, which would call a correct `dead`
false. A user's filename inside a dependency is a coincidence rather than a reference. And minified
bundles are the filename pattern's slowest input, because it is quadratic over a long run of word
characters.

Some names the tokeniser cannot represent. `photo (1).webp` holds parentheses, which are outside its
character class, and a name of more than seven space-separated words is longer than its leftward
walk. For the spellings the index cannot hold, and only those, the check searches the text of every
file literally. Widening the character class is not the answer, because parentheses delimit unquoted
CSS `url(…)` and Markdown `![](…)`. A substring search has no tokenisation gaps, and since it runs
only for those names, its cost follows their number rather than the size of the repository.
`tokeniserCanRepresent` decides which names they are by running the tokeniser over the name, not by
testing its characters.

The engine decodes these spellings too, so real repositories no longer produce findings that
exercise the check's own decoding. `verify.test.ts` supplies those inputs, alongside controls that an
oracle giving the same answer to everything would fail.

No text search can see an asset that is alive for a reason that is not a string, such as a
framework's file convention, a glob in a build config or a name assembled at runtime. The validation
run prints that limit beside the verdicts.


## The fixture build

`bench/src/fixture-build.ts` runs `optimize --apply` on a copy of each fixture, then builds the copy
with the fixture's own `build` script and checks the local paths in the built site against the files
that exist. A reference the engine rewrote wrongly shows up as a failed build or a dangling path.

A check that has never been seen to fail cannot be told apart from one that passes, so the harness
first shows that its instruments can fail. Each fixture is checked untouched, which is the baseline,
and then once per reference class with one reference of that class pointed at a file that does not
exist, which are the negative controls. An instrument that reports a broken tree as intact is
recorded as blind to that class, and the run names every fixture and class that no instrument can
see. A baseline that does not check out fails the run, since an instrument that reports every tree
broken would look as if it saw every class. Each string a control breaks was chosen by reading the
fixture rather than by asking the engine, and must occur exactly once, so a stale one throws instead
of recording a blind spot that is not there.

Neither instrument shares code with the engine. A framework build is a useful judge because it is
someone else's idea of what a reference is; a check built on the engine would miss whatever the
engine misses. The build alone is not enough: in these fixtures it fails only on a bundled import it
cannot resolve, and passes with a stylesheet `url()`, a root-relative path or a `srcset` candidate
that names nothing. Across the sixteen negative controls, the build catches the three broken imports
and the link check the other thirteen. The link check reads the emitted site rather than the source,
because only there does `/x` mean the site root, and it reads JavaScript bundles as well as HTML and
CSS, because a reference written in a component ends up in a bundle. It scans text rather than
parsing, and errs toward false alarms, which cost a reading, over missed references, which are the
failure under test.

The optimized run uses the same instruments on trees made the same way, so it is no gentler than the
checks that showed the instruments can fail. It has three verdicts. A tree that broke fails, and so
does a run that converted nothing, which cannot show that converting is safe. Under `replace`, each
delete the manifest records is checked gone from disk, and a fixture that deleted nothing is reported
as not exercised rather than passed: every tree may be intact only because nothing was removed from
it. `--optimize` runs this after each fixture's baseline and leaves out the negative controls, which
are slow and do not change between runs.

With `--cli`, the same test runs through the built `upfly` binary in a git repository. The dry run
must write nothing; `--apply --commit` must make one commit holding exactly the files the run wrote;
a second run must find nothing to do and make no commit; the build and the link check must pass; and
`git revert` must give back every byte. Each fixture is also tested as a folder inside a larger
repository, whose own staged and untracked work must stay out of Upfly's commit, and once more with
`upfly undo` in place of `git revert`.
