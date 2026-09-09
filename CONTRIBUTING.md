# Contributing

Thanks for looking. This project is small and the maintainer reads everything — you will get
a first response within about three days.

## Before you write code

**Open an issue first** for anything beyond a typo or an obvious one-line bug. It is much
cheaper to disagree about an approach in an issue than in a 400-line diff, and it means your
time is not wasted on something that will not be merged.

Straightforward bug fixes with a failing test can go straight to a PR.

## Setup

Node ≥ 20 and pnpm.

```bash
pnpm install
pnpm check        # lint + typecheck + test — exactly what CI runs
pnpm test:watch   # while developing
```

Run `pnpm check` before you push. If it passes locally it will pass in CI, on all three
operating systems.

## The best first contribution: an adapter

An adapter teaches Upfly to read one file format — Vue SFCs, Svelte, Astro components, Rails
templates, Django templates, WordPress themes. The compatibility matrix in the README has
empty cells; each one is a good first issue and should take about half an hour.

1. Copy the closest existing adapter in `packages/core/src/adapters/`.
2. Add a fixture directory with a small but real project that uses the format.
3. Fill in the table-driven test: input text in, expected references out.
4. Run `pnpm check`.

Read [ARCHITECTURE.md](ARCHITECTURE.md) first — particularly the adapter rules. The important
ones: adapters never touch the filesystem, never resolve paths, and are pure functions.
`unsafe` is a valid and useful answer; guessing is not.

## Pull requests

- **One concern per PR.** A bug fix or a feature, not both. Aim for under 500 lines and under
  10 files — small PRs get reviewed quickly.
- **Every bug fix adds the test that would have failed.** No exceptions.
- Link the issue: `Fixes #123`.
- Use conventional commits (`fix:`, `feat:`, `docs:`, `refactor:`, `test:`).
- Run `pnpm changeset` if you changed anything a user would notice, and describe the change
  the way a user would experience it.

## Using AI

AI-assisted contributions are welcome — the maintainer uses AI too. Two conditions, and they
are not negotiable:

1. **Write your own words.** The PR description, the issue, and the code comments should be
   yours. A generated wall of text tells a reviewer nothing.
2. **Understand what you submit.** You should be able to discuss your diff — why this
   approach, what the edge cases are, what the test proves — without going back to the tool.

PRs that appear to be unreviewed generated output will be closed. This is not hostility to
the tooling; it is that reviewing code nobody understands costs more than writing it.

## Reporting bugs

The most useful bug report contains a **fixture**: the smallest file that reproduces the
wrong behaviour, plus what you expected. If Upfly missed a reference or rewrote one it should
not have, that fixture becomes a permanent regression test — which is the single most valuable
thing you can contribute.
