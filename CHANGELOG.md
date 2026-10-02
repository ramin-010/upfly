# Changelog

## 3.0.0

**3.0.0 is a different product from 2.x, under the same name.**

- **2.x** is an Express and Multer middleware: it converts images as a server receives them in an upload.
- **3.0.0** is a command-line tool, `upfly`, and the library under it, `upfly-core`. They work on a repository:
  they find the images and the references to them in the files they can read, convert the images to WebP or AVIF,
  and update every reference they can prove, naming each one they cannot. Nothing is written without `--apply`.

Nothing from 2.x carries over: no option, no API, no code. If you use the middleware, stay on 2.x:

```bash
npm i upfly@2
```

### What 3.0.0 holds

The commands:

- `upfly audit`: the images, the references to them, the references that point at nothing, the images nothing
  references, and how much smaller images would be as WebP or AVIF, measured by encoding them. It changes no file
  in the project.
- `upfly optimize`: the plan for converting images and updating their references, which `--apply` carries out.
  `--apply` refuses to write over uncommitted changes, so the run's changes are the only ones to review, and
  `--commit` makes them one commit. Originals stay beside the converted files unless `--replace` is given, and
  then each is removed only once every reference to it has moved.
- `upfly undo`: puts back every file the last applied run changed, after checking that none was edited since.
- `upfly check`: for continuous integration. It fails when a reference names an image that does not exist, or,
  with a limit in the config, an image in use is larger than it. `--changed [ref]` keeps only what a change
  could have caused.
- `upfly refs <image>`: every reference to one image, whether `optimize` could rewrite each, and what it would do
  with the image.
- `upfly dedupe`: for each set of identical images, keeps one copy and points the references to the others at it.
  It deletes no file.
- `upfly init`: writes `upfly.config.json` with the folders the site is served from, as Upfly works them out, and
  why.

`audit`, `optimize` and `dedupe` print a short summary and keep their full text in `.upfly/report.txt`, which git
is told to ignore; `--full` prints the full text instead. `optimize`'s file also lists each image and reference left
alone, and each original kept, with the reason for each.

For programs and coding agents:

- `--json` on every command: one JSON object per line, progress first and the result last. The package ships a
  JSON Schema for each command's result, for the report inside it, for every other line, and for the config file,
  in `schema/`.
- `AGENTS.md`, a guide for coding agents, and an Agent Skill in `skill/upfly`, which an agent loads when a task
  touches the project's images.

And:

- The accuracy suite, in `accuracy-suite/` in the repository: a project of image references and the decoys
  beside them, each with its expected answer written down before the engine ran. `pnpm accuracy:measure` runs it.
- No network calls and no telemetry, in the library and the command-line tool alike.
- Node.js 20 or later, as ES modules.
