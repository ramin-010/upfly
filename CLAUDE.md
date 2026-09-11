# Upfly v3

A **codebase-aware image engine**: build a graph of every image in a repo and every place it is
referenced, then optimize the images and rewrite the references transactionally, with confidence
tiers, never silently. Conversion is a commodity; **knowing where an asset is referenced is the
product.**

This is a **from-zero rewrite**. The `upfly/` and `upfly-vscode/` repos beside this one are v2 and
are read-only references — no code is carried over from them.

## Authoritative documents

| | |
|---|---|
| `../notes/STATE.md` | Where the project is *right now*. Read the **▶ HANDOFF** block — it is the live instruction; everything above it is history. |
| `../notes/05-build-plan.md` | The spec. §1.1 engine · §3.2 adapter contract + resolver ladder · §4 the rules below · §5.1 the Phase 1 exit gate. |
| `ARCHITECTURE.md` | The design, and it is kept true (rule 7). |

Work runs **one build-plan phase per chat**, coordinating through `../notes/STATE.md`. A parent chat
owns the roadmap and rules on design questions. Update STATE.md **continuously**, not at the end —
it is the only channel between chats and a chat can end at any moment.

## The rules — these are binding, not advisory

**Quality**
1. TypeScript `strict`, no `any` in public API. Exported types *are* the API and are documented.
2. ESM-only, Node ≥ 20.
3. Every module has tests. Every adapter has fixtures. **Every bug fix adds the test that would have
   failed.** Coverage gate: 90% on `core`, enforced in CI.
4. Biome for lint+format. Conventional commits carrying the *reasoning*. One concern per PR.
5. CI is ubuntu/windows/macos × Node 20/22. **Windows is a first-class target** — v2's worst bug was
   a platform bug that shipped broken for months.
6. Public JSON schemas (`report`, `manifest`, `config`) are versioned and snapshot-tested.
7. `ARCHITECTURE.md` is kept true. Bring it current *as* the design changes, not at phase end.

**Safety**
8. Dry-run by default. Nothing writes without `--apply`. **An `unsafe` reference is never rewritten.**
9. **A silent skip is a P0 bug.** Every declined item reaches the report with a reason.
10. No network calls in core or CLI. No telemetry. Ever.
11. Deterministic output: same inputs → **byte-identical** report. Sort on POSIX-relative paths, never
    on native absolute ones — `/` (0x2F) and `\` (0x5C) fall either side of alphanumerics.

**Process**
12. **From-zero.** No copy-paste from the v2 repos. Re-derive and re-test.
13. **Understanding rule.** Rinkal can explain every module's design without the AI. AI writes code;
    Rinkal owns it. A module that fails this gets a written design note before it merges.
14. **Time-box.** Slipping a phase moves scope to "Later", not the deadline.
15. No new features mid-phase unless they fall out of the graph for free.
16. Performance claims are only ever numbers produced by `bench/` in CI.

## Two things that decide whether this product is trusted

- **Zero false `broken` findings.** That is the Phase 1 exit criterion. The 867-install incumbent
  failed precisely by failing silently, so every ruling here widens the "we can't be sure" bucket
  rather than guessing.
- **Never regex JavaScript.** Real parsers: `@babel/parser` for JS/TS, `parse5` for HTML, `postcss`
  for CSS. Regex is only acceptable for Markdown, and even there the raw HTML goes to the HTML
  adapter.

**Raise, don't decide.** Eight requirements have surfaced from implementation rather than from the
plan. Anything touching `Reference`, the report schema, or the resolver ladder is public API — write
it up with options and a recommendation and ask the parent chat.

## Traps that have already cost time here

- **Never generate a test tree into an in-repo `public/`.** The v2 VS Code extension watches those
  and converts images in place, deleting the originals — it destroyed 19 fixture files this way.
  Write generated trees outside the workspace, or drop an `upfly.config.json` kill switch in the
  generated root (`fixtures/upfly.config.json` is the working example).
- **Coverage is only meaningful on Linux.** Four `discover` tests need POSIX permission bits and are
  skipped on Windows, so core reads ~88% there against ~99% on Linux. Not a regression; do not chase
  it. A Linux checkout lives in WSL at `~/upfly-v3` for this reason — see STATE.md's Gotchas for how
  to drive it.
- **A green `fixtures.test.ts` says nothing about whether fixture references resolve.** Adapters
  never touch disk by design, so a reference to a missing file looks identical to a good one at that
  layer. `fixture-integrity.test.ts` (§5.1h) is the assertion that can see it.
- **`biome` deliberately does not format `fixtures/`.** A tidied fixture stops standing in for what a
  person actually wrote.
- **Bash heredocs in this harness eat backslashes.** Use the Write tool for any file containing them.

## Git

Commit locally as you go. **Never push, never publish, never tag** — hand Rinkal the exact commands
and let him run them. `git push` and `gh` are denied at the permission layer.

⚠️ **There is no pre-commit hook. Run `pnpm check` yourself before every commit** (rule 3); it takes
~20s and is lint + typecheck + test.

This file used to promise a hook that ran it for you, with `[wip]` as the escape hatch. That hook was
**removed rather than fixed** after it was found to have four bugs and to have never once fired — the
clearest instance of the phase's most reliable lesson, that a construction which cannot carry the bug
beats the discipline of avoiding it. The removal was right; leaving the promise here was not, because
it told the next chat its commits were gated when nothing was checking them. **Open question for the
parent chat:** rebuild it so it *can* fail, or leave the check manual and keep this paragraph.
