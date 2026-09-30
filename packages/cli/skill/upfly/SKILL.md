---
name: upfly
description: Convert a project's images to WebP or AVIF and rewrite every reference to them without breaking the site; find where an image is used; tell whether an image is safe to delete; find broken image paths and identical copies. Use when a task touches the project's image files, such as optimizing or converting images, or finding unused, missing or duplicate images.
---

# Upfly

Upfly knows where a project's images are used. It converts them and rewrites the
references in one step that can be undone, reports every reference it cannot follow, and
never deletes an image. It makes no network calls.

Run it as `npx upfly <command>` in the project folder. The full guide is
`node_modules/upfly/AGENTS.md`.

## One image: where is it used, and can it go?

Run `npx upfly refs <image> --json`. It lists each reference (`file`, `line`, the path as
written) and gives a `verdict`.

- Any entry in `references` means the image is used.
- `possibly-unused`: its name appears in the places listed in `mentions`. Read them.
- `unused`: no reference Upfly can read names it. That is not proof: a path built at
  runtime, or a link from outside the repository, can still reach it.

Upfly never deletes an image; deleting is the user's decision.

## Converting images

1. `git status --porcelain` must print nothing. If it does, ask the user to commit or
   stash first; Upfly refuses to write over uncommitted changes.
2. `npx upfly optimize` writes nothing and prints the plan. Show it to the user.
3. Only with the user's yes: `npx upfly optimize --apply --commit`.
4. Run the project's own build, then `npx upfly check`.
5. If anything is wrong: `npx upfly undo` puts every file back.

Do not add `--allow-dirty` or `--replace` unless the user asks for it.

## When Upfly stops

Exit code 3 means Upfly refused to act, for safety. Read its `message`, which says what
to do; with `--json`, `reason` names the case. For `SERVING_ROOT_UNKNOWN`, ask the user
which folder the site is served from and pass it with `--public <dir>`.

## Other commands

- `npx upfly audit --json`: the whole project's report, which can be large.
- `npx upfly check`: exits 1 when a reference names an image that does not exist.
- `npx upfly dedupe`: plans pointing references to identical copies at one copy. Apply
  it only with the user's yes, as `npx upfly dedupe --apply --commit`; it deletes nothing.
- `npx upfly init`: writes `upfly.config.json` with the folders the site is served from.
  Show the user the file.
