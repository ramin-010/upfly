# Using Upfly from a coding agent

Upfly finds every image in a project and every place the project refers to one, converts
images to WebP or AVIF, and rewrites the references so that nothing breaks. It never
deletes an image. It makes no network calls and sends nothing anywhere.

In a project that has Upfly installed, run it as `npx upfly <command>`. Every command
reads the folder given after it, or the current folder, and prints plain text; add
`--json` for output a program can read.

## Where to start

- One image: `npx upfly refs <image> --json`. It lists every reference to that image
  (file, line, the path as written, whether a run could rewrite it) and a verdict: what
  `upfly optimize` would do with it, or that it is unused. It is the small answer, and the
  right one for a question such as "is it safe to delete this image?".
- The whole project: `npx upfly audit --json`. It changes nothing. The report can run to
  megabytes on a large project; `--no-probe` skips measuring the images and is much
  faster when only the references matter.

## Converting images, safely

1. Check that the project folder has no uncommitted changes (`git status --porcelain`
   prints nothing). Upfly refuses to write otherwise, so that its changes are the only
   ones to review. If there are changes, ask the user to commit or stash them.
2. Run `npx upfly optimize`. It writes nothing and prints the plan: which images convert,
   how much smaller they get, which files change, and why anything is left alone. Show the
   user that plan, and the notes at its end.
3. Only when the user says yes: `npx upfly optimize --apply --commit`. The run's files go
   into one commit, which `git revert` undoes.
4. Check the result: run the project's own build if it has one, then `npx upfly check`,
   which fails if any reference names an image that does not exist.
5. To go back: `npx upfly undo` puts back every file the last run changed. After
   `--commit`, the commit stays in the history and the restored files show as uncommitted
   changes; `git revert <commit>` is the other way back.

Leave these to the user: `--allow-dirty` (writing over uncommitted changes), `--replace`
(removing each original once every reference to it has moved), and `--format avif`.
Never edit `.upfly/`: it is the record `upfly undo` follows.

## Is it safe to delete an image?

Run `npx upfly refs <image> --json` and read the verdict.

- Any entry in `references` means it is used: each names the file and line.
- `possibly-unused`: no reference Upfly can follow reaches it, but its name appears
  somewhere, listed in `mentions`. Read them before calling it unused.
- `unused`: no reference Upfly can read names it. That is not proof. A path built at
  runtime can still produce its name (the audit report lists those under
  `references.unsafe`), and an image in a folder the site is served from, such as
  `public`, may be linked from outside the repository, by an email or another site.

Upfly never deletes an image. The decision, and the deletion, are the user's.

## What the words mean

- `broken`: a path written as an image's that points at no file.
- `dead`, shown as unreferenced images: nothing references the image, and its name
  appears nowhere Upfly looked.
- `possibly-dead`, shown as possibly unreferenced: nothing Upfly can follow references
  the image, but its file name appears somewhere, such as a file no reader handles or a
  path Upfly could not resolve. The finding's `evidence` says where. Treat it as used
  until a person has looked.
- `dynamic`: a path built at runtime, such as `url($hero)` in a stylesheet. Upfly cannot
  know which file it names.
- `unsafe`: a reference Upfly never rewrites and always reports. The report lists each one
  under `references.unsafe` with its reason: `dynamic` paths, aliases no config Upfly
  reads maps (`unresolved-alias`), and paths into files Upfly leaves alone, such as those
  in `node_modules` (`out-of-scope`).

## Exit codes

| code | meaning |
|---|---|
| 0 | The command ran. What `audit` and `optimize` find does not change it. |
| 1 | `check` found something that fails it. |
| 2 | The command line or the config file is wrong. The message says what. |
| 3 | Upfly refused to act, for safety. The message says why and what to do. |
| 4 | Something failed that Upfly did not anticipate. |

With `--json`, a command that stops prints an error line with `exitCode`, `message`, and
often a `reason` to branch on:

- `UNCOMMITTED_CHANGES`: ask the user to commit or stash, then run again.
- `NO_REPOSITORY`: git does not track the folder. `--commit` needs it; ask the user.
- `SERVING_ROOT_UNKNOWN`: Upfly could not tell which folder the site is served from. Ask
  the user, then pass it with `--public <dir>`, or run `npx upfly init` and correct
  `publicDirs` in the file it writes.
- `TRANSACTION_INTERRUPTED`: an earlier run stopped part way. Run `npx upfly undo` first.
- `TRANSACTION_LOCKED`: another run is in progress. Wait for it.
- `TRANSACTION_FOREIGN_CHANGE`: a file changed after Upfly read it, so Upfly will not
  touch it. Tell the user; after a committed run, `git revert` is the other way back.
- `CONFIG_EXISTS`: `init` found a config file. Edit that file instead.
- `V2_EXTENSION_CONFIG`: `upfly.config.json` belongs to the Upfly VS Code extension (v2).
  Leave it alone; this CLI reads `upfly.config.ts` instead.

## The JSON

With `--json`, stdout carries one JSON object per line and nothing else: progress lines,
then the result, whose `type` is `result`, or an error line, whose `type` is `error`.
The package ships a JSON Schema for each, in `node_modules/upfly/schema/`: one per
command's result (`audit.json`, `optimize.json`, `undo.json`, `check.json`, `refs.json`,
`dedupe.json`, `init.json`), `report.json` for the report inside audit's and optimize's
result, `events.json` for every other line, and `config.json` for `upfly.config.json`.

## In continuous integration

`npx upfly check` exits 1 when a reference names an image that does not exist. On a pull
request, `npx upfly check --changed origin/main` keeps only what the change could have
caused (the checkout needs that branch's history). `check.maxImageBytes` in
`upfly.config.json` also fails it on an image in use that is larger. An unused image never
fails it.

## Identical copies

`npx upfly dedupe` finds sets of images with the same bytes and plans to point every
reference at one copy of each; `--keep <path>` chooses the copy. It deletes nothing: a
copy no reference names afterwards stays on disk, and `upfly audit` then lists it as
unused. Apply it the way `optimize` is applied: with the user's yes,
`npx upfly dedupe --apply --commit`.

## Config

`npx upfly init` writes `upfly.config.json` with the folders the site is served from, as
Upfly works them out, and says why it chose each. Show the user the file: a wrong folder
is the likeliest reason for a wrong result.


## The Agent Skill

The package also ships a short form of this file as an Agent Skill, which an agent loads
when a task involves the project's images. To install it, copy the folder
`node_modules/upfly/skill/upfly` into the project's `.claude/skills/` folder.
