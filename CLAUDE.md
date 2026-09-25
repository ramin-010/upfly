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
17. Tests are typechecked: `tsconfig.test.json` covers every test file and runs in `pnpm typecheck`.
18. Comments are written for a stranger. Comment the why, only where the code cannot say it, and
    document every public export with one plain sentence plus `@param`, `@returns`, `@throws` and
    `@example` where they help. Nothing a stranger cannot look up: no ruling numbers, plan sections,
    phases, chat names or `notes/` paths. Write the fact, and put where it came from in the commit
    message. Plain text: no bold, italics, emoji or em dashes. A comment over about ten lines is a
    design note for `ARCHITECTURE.md`. Output text (report reasons, messages, CLI output) never
    carries an internal reference. The standard, with examples: `../notes/15-comment-standard.md`.
    `pnpm comments:check` runs inside `pnpm check` and holds each file to
    `tools/comment-baseline.json`: a file may lose findings, never gain one. After cleaning a file,
    run `pnpm comments:baseline` to lower its entry.

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

✅ **There IS a pre-commit hook again, wired 2026-09-14 (R81).** A `PreToolUse(Bash)` hook runs
`pnpm check` — lint + typecheck + test — and **denies** a commit in this repo while it is red.
`[wip]` in the message is the sanctioned escape hatch. **Run `pnpm check` yourself anyway** (rule 3):
the hook is insurance against a lapse, not a substitute for knowing the state of your own tree.

🔴 **`pnpm test` IS NOT THE GATE.** `pnpm check` is, and CI runs `pnpm lint` first. Every chat had
been opening with `pnpm test` and calling the result a green baseline while lint was failing on all
six matrix cells — a baseline measured with a third of the gate is not a baseline.

**What this paragraph used to say, and why the correction matters more than the fix.** It promised a
hook, then — after that hook was found to have four bugs and to have **never once fired** — it
promised the opposite, that none existed. Both readings were acted on. It now has **six bugs on
record**, and the two found on the day it was rewired are the instructive ones:

- **Bug 5: it denied a commit in a DIFFERENT repository.** The fix for bug 4 anchored its `cd` match
  to the start of the command, so `export … && cd …/notes && git commit` fell through to a stale
  session cwd. Fixed with an invariant rather than by matching one more shape — **any `cd` at all
  means the session cwd is unusable** — because guessing at command shapes is what produced bugs 3,
  4 and 5.
- **Bug 5b: a backstop that could only ever fire falsely.** It read *“does upfly-v3 have staged
  changes”*, which is never evidence about where a commit lands: git resolves the repository from
  the working directory upward. Deleted, not narrowed.

🔴 **THE FAILURE MODE TO WATCH IS A FALSE DENY, NOT A MISSED ONE.** A gate that refuses a commit it
had no business refusing **trains the escape hatch**, and once `[wip]` becomes reflex the gate is
dead while the suite still *looks* protected. That is worse than never firing. **So if it denies you
unexpectedly, suspect the gate first** and run `.claude/hooks/precommit-check.test.sh` — 13 cases,
including the four `cd` shapes with a deliberately stale session cwd. A missed gate is caught by CI;
a false deny is caught by nobody, because the person just works around it.
