> **Looking for the Express upload middleware?** That is Upfly 2: `npm i upfly@2`. Its code is on the
> [`v2` branch](https://github.com/ramin-010/upfly/tree/v2) and its documentation at
> [ramin-010.github.io/upfly](https://ramin-010.github.io/upfly/). Upfly 3, below, is a different product: a
> command-line tool that optimizes the images in a codebase.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/upfly-readme-header-dark.svg">
    <img src="assets/upfly-readme-header-light.svg" alt="upfly" height="96">
  </picture>
</p>

<h3 align="center">Optimize your repo's images without breaking a reference.</h3>

<p align="center">
Built for coding agents to use: a dry run by default, <code>--json</code> output, exit codes to branch on, one
commit per run with <code>--commit</code>, and <code>upfly undo</code>.
</p>

Build-time image tools leave your source alone. Conversion CLIs and the most-installed editor extensions write the
new file and leave the code that points at the old one for you to change.

Upfly finds the images in your repository and the places your code points at them, converts each image that comes
out smaller as WebP, and rewrites those references. With `--commit`, the whole change is one commit you can review.
Where it cannot prove what a path points at, it leaves the path alone, and `--include-declined` lists each such
path with the reason.

## Install

Node.js 22.18 or later; on Node.js 24, 24.11 or later.

```bash
npm install --save-dev upfly
```

Or run it once without installing: `npx upfly audit`.

## Quick start

```bash
npx upfly audit                       # the images, the references to them, what could be smaller; changes nothing
npx upfly optimize                    # the plan, as a dry run; changes nothing
npx upfly optimize --apply --commit   # carry out the plan as one commit
npx upfly undo                        # put back every file the last run changed
```

A real run, on a committed copy of [`fixtures/vite-react`](fixtures/vite-react) from this repository, at commit
`9716cb6`:

```
$ upfly optimize
Upfly optimize · dry run

  Convert      5 images to WebP, 124.2 KB → 48.8 KB
                 each original stays beside its new file
  Update       7 references in 2 files
  Leave        7 images, 2.7 KB
                 3  would save too little
                 2  SVG, which Upfly does not convert
                 1  its references stay as written
                 1  nothing links to it

  Full plan    .upfly/report.txt
  Next         upfly optimize --apply

  Dry run: no project file was changed.
```

The full plan is in `.upfly/report.txt`, which git is told to ignore, with each image and reference left alone and
the reason for each; `--full` prints the plan instead of the summary, and `--include-declined` adds those reasons to
it. Then:

```
$ upfly optimize --apply --commit
Upfly optimize · applied

  Converted    5 images to WebP, 124.2 KB → 48.8 KB
                 each original stays beside its new file
  Updated      7 references in 2 files
  Left alone   7 images, 2.7 KB
                 3  would save too little
                 2  SVG, which Upfly does not convert
                 1  its references stay as written
                 1  nothing links to it

  Run          20261002T052712-e901: 5 files created, 2 changed, 0 removed
  Commit       843863171199, exactly the files the run wrote
  Full plan    .upfly/report.txt
  Next         run the project's build, if it has one, then upfly check
                 upfly undo puts every file back
                 git revert 843863171199 undoes the commit
```

## Safety

- **Nothing is written without `--apply`.** `audit`, `check` and `refs` never write a project file, and `optimize`
  and `dedupe` only show their plan until you add `--apply`.
- **`--apply` refuses to run over uncommitted changes**, or in a folder git does not track, so the run's changes are
  the only ones to review. `--allow-dirty` writes anyway, and `upfly undo` still puts the files back.
- **`--commit` makes one commit** holding exactly the files the run wrote, which `git revert` undoes.
- **`upfly undo` puts back every file** the last `optimize --apply` or `dedupe --apply` changed. It checks each file
  first and changes nothing if any of them was edited since that run.
- **Upfly never deletes an image that nothing uses.** It lists each one with its size, and the decision is yours.
- **Originals stay beside their converted files.** With `--replace`, an original is removed only once no file Upfly
  reads still names it.
- **A path Upfly cannot prove is never rewritten**: one assembled at runtime, such as `` `/img/${name}.png` ``, or
  one that only happens to match a file. `--include-declined` lists each reference left as written, with the
  reason.

## The evidence

### The accuracy suite

> Upfly's reference accuracy suite is a purpose-built project of 451 keyed cases, image references and the decoys
> beside them, across 74 shapes in HTML, CSS (with SCSS and Less), JavaScript and TypeScript (with JSX), Astro,
> Markdown, MDX and JSON, each with its expected answer written down before the engine ran. With the suite's own
> settings, the engine meets all 451. With no configuration at all, it also meets all 451. It claims none of the 91
> cases that look like a path but are not one.

> What the suite does not show: it is ours, not a sample of real code, and a shape that is not in it is not
> measured. Files Upfly does not read yet (Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter) are listed
> as unread, not counted. A path assembled at runtime with no file extension written anywhere is not claimed,
> because its text cannot be told from a page route. Zero-configuration detection has been tested on JavaScript
> projects only; a Rails, Laravel, Hugo or plain-HTML site may need its website folder named in settings, as the
> plain-HTML site in the exit run had. Run it yourself: one command, `pnpm accuracy:measure`.

The suite is [`accuracy-suite/`](accuracy-suite/); its README says how each case is keyed.

### Three real projects, converted and built

Fresh clones of three public repositories, each at a pinned commit, run once under each policy: keep-original (the
default) and `--replace`.

| repository | policy | converted | references rewritten | originals deleted | build | image references (broken by the run) | second run |
|---|---|---|---|---|---|---|---|
| eleventy-docs | keep-original | 17 | 17 in 12 files | 0 | passes | 7,517 (0) | nothing to do |
| eleventy-docs | replace | 15 | 15 in 10 files | 15 | passes | 7,517 (0) | nothing to do |
| railsgirls-com | keep-original | 3,412 | 5,995 in 575 files | 0 | no build | 10,655, 119 already broken (0) | nothing to do |
| railsgirls-com | replace | 2,906 | 4,413 in 560 files | 2,900 (6 kept, with reasons) | no build | 10,655, 119 already broken (0) | nothing to do |
| scratch-www | keep-original | 183 | 214 in 56 files | 0 | passes, no file put back | 750, 52 already broken (0) | nothing to do |
| scratch-www | replace | 182 | 213 in 55 files | 182 | passes, no file put back | 750, 52 already broken (0) | nothing to do |

Every applied run made exactly one commit, no run broke a single image reference (18,922 checked across the three,
comments aside), and every second run found nothing to convert, rewrite or delete.

- **What was run:** `upfly optimize --apply --commit`, and `upfly optimize --apply --commit --replace` on a second
  fresh clone; then the project's own build, where it has one; then a second `upfly optimize` on the committed tree.
  The repositories and their pinned commits are in [`bench/src/repos.ts`](bench/src/repos.ts), and
  [`bench/README.md`](bench/README.md) says how to set them up. Measured with the CLI at commit `9b71d22`; the
  commits since change how one kind of reason is worded, what the terminal prints, and which folder of a built Hugo,
  Gatsby or Hexo site is read, and none of the three projects has such a folder.
- **The link check** reads every HTML, CSS and JavaScript file of the built site (or of the source, for a site with
  no build) and asks whether each image path names a file that exists, letter case included, as a Linux server
  would. It skips external URLs and anything inside an HTML or CSS comment, which no browser loads. "Broken by the
  run" is every reference broken after the run that was not broken before it. This check is a script outside this
  repository, not yet published.
- **railsgirls-com ran with its website folder named, `--public .`.** A plain HTML site has no project file, so
  Upfly finds no website folder by itself, and under `--replace` it then deletes nothing.
- **The builds ran on the Node.js version each project needs:** eleventy-docs on 22.23.3, scratch-www on 20.20.2.
  Upfly itself ran on Node.js 22.14.
- **Two of the five repositories Upfly is tested on were left out:** astro-docs cannot install at its pinned commit
  (its lockfile pins a preview build that is no longer served), and shadcn-ui's build rewrites tracked source files,
  so before and after would not compare like with like.
- **What this does not show:** three projects, at these commits, under these conditions; it does not certify a
  fourth. The link check does not read JSON or Markdown. A passing build is a weaker check than the link check, since
  most image paths are not resolved by a build; both are reported.

### Images Upfly might call unused when they are not

> Across five repositories, an independent search for every image file name found 3,485 mentions the graph did not
> link. 684 were adjudicated, all 384 in the four smaller repositories and a random 300 of railsgirls-com's 3,101,
> and none was an image Upfly would call unused.

Its blind spots, which go with it:

1. **It searches file names.** An image alive with no string naming it (a framework's file convention, a
   build-config glob, a path assembled at runtime) is invisible to it exactly as to the engine.
2. **0 of 300 is not 0 of 3,101.** A zero in a random 300 is consistent with up to 29 of railsgirls-com's 3,101 being
   misses, at 95% confidence (exact, for a sample drawn without replacement).
3. **It matches base names,** so it over-reports (a hit for each copy sharing a name) and cannot hide a miss.
4. **The verdict is about the image, not the line.** 456 of the 684 name an image the engine links from elsewhere, so
   a line naming a linked image is not a miss by this measure; whether each line still loads after a run is what
   the link check above measures. 278 of the 684 name SVGs, which Upfly neither converts nor deletes.

`pnpm validate` over the five pinned repositories produces the mentions; the 300 were drawn with seed `20261001`.
The two scripts that drew the sample and judged each mention are outside this repository, not yet published.

## Limits

- **File types Upfly does not read yet:** Vue, Svelte, PHP, ERB, Liquid, Nunjucks and YAML frontmatter. A reference
  only they hold is not seen. The audit names each file it could not read, and an image named in one is reported as
  possibly unused, never as unused.
- **Zero configuration is tested on JavaScript projects only.** Any site can name its website folder with
  `--public <dir>`, or in `upfly.config.json`.
- **An image the build loads converts only for Vite, Next.js and Astro**, which load WebP and AVIF by themselves.
  Under any other build (webpack, Rollup, esbuild, Parcel, or one Upfly cannot name), such an image keeps its format,
  and the plan says why: fewer conversions, never a broken build.
- **A stylesheet with a syntax error is not read.** A browser skips the one declaration it cannot read and reads the
  rest; Upfly reads none of that file, so an image only it names is reported as possibly unused, never as unused, and
  the report names the error and its line.
- **A site already built by a tool Upfly does not know may have its output read as source.** Upfly skips the folders
  only a tool writes (`dist`, `build`, `_site` and others) and `public/` beside Hugo's, Gatsby's or Hexo's own
  settings file. For anything else, run Upfly before building, or leave the output out with `--exclude <folder>/`.
- **A reference Upfly cannot read keeps working only while the original stays**: one in a file type it does not
  read, such as an email template, or outside the repository, such as an email already sent or another site. The
  default keeps every original; `--replace` would break those references.
- **`optimize` measures every image before converting it**, so the first run on a large site takes a while.

## No network, no telemetry

Upfly makes no network calls and sends nothing anywhere. A test runs every command with each way Node.js offers to
reach the network replaced by one that records the attempt, and fails on any
([`packages/cli/test/no-network.test.ts`](packages/cli/test/no-network.test.ts)). Upfly runs git for local work
only.

## Commands

| command | what it does |
|---|---|
| `upfly audit` | Reports the images, the references to them, the references that point at nothing, the images nothing references, and how much smaller each would be as WebP or AVIF, measured by encoding it. Changes no project file. |
| `upfly optimize` | Converts each image that measures smaller and updates the references it can rewrite safely. Shows the plan unless run with `--apply`. |
| `upfly undo` | Puts back every file the last `optimize --apply` or `dedupe --apply` changed. |
| `upfly check` | For continuous integration: fails when a reference names an image that does not exist, or, with a limit in the config, when an image in use is larger than it. `--changed [ref]` keeps only what a change could have caused. |
| `upfly refs <image>` | Lists where one image is referenced, whether Upfly could rewrite each reference, and what `optimize` would do with it. |
| `upfly dedupe` | Keeps one copy of each image stored more than once and points the references at it. Deletes nothing. |
| `upfly init` | Writes `upfly.config.json` with the folders the site is served from, as Upfly works them out, and why. |

`upfly <command> --help` gives each command's options and exit codes.

## Configuration

`upfly init` writes `upfly.config.json`: the folders the site is served from (`publicDirs`), what happens to an
original once it is converted (`publicPolicy`), the `format`, paths to `exclude`, and what `check` fails on. It
explains each value it wrote; correct what is wrong, and every command uses the file from then on. The file's JSON
Schema is [`packages/cli/schema/config.json`](packages/cli/schema/config.json), so an editor checks it as you type.
`upfly.config.ts` works too.

## For programs and coding agents

- **`--json`** on every command prints one JSON object per line: progress first, the result last. Each command's
  result, the report inside it, every other line and the config file have a published JSON Schema in
  [`packages/cli/schema/`](packages/cli/schema).
- **Exit codes:** 0 the command ran, including when there was nothing to do; 1 `check` failed; 2 a usage or
  configuration error; 3 Upfly refused to write, and the message says why and what to do; 4 a failure Upfly did not
  anticipate.
- **[`AGENTS.md`](packages/cli/AGENTS.md)** is a guide for coding agents, and
  **[`skill/upfly`](packages/cli/skill/upfly/SKILL.md)** is an Agent Skill an agent loads when a task touches a
  project's images. Both ship in the package.
- **[`upfly-core`](packages/core)** is the engine as a library, for building on it.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to set up, how a change is made (the test first), and how to add a reader
for a file type, the best first contribution. [ARCHITECTURE.md](ARCHITECTURE.md) describes the design.

```bash
pnpm install
pnpm check              # lint, the comment check, typecheck and the tests: the gate CI runs
pnpm accuracy:measure   # the accuracy suite, both runs
```

## How it was built

The code was written with AI coding assistants, working from written briefs one stage at a time; a separate session
re-ran each stage's claims before they were recorded, and every figure in this README comes from a run you can
repeat.

## License

MIT © [Rinkal Kumar](https://github.com/ramin-010)
