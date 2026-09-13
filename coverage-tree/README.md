# The coverage tree

A small repository where **the exact answer is known in advance** — every image, every
reference to it, and **what outcome the engine should produce for each reference**.

Built to [`notes/10-coverage-tree-spec.md`](../../notes/10-coverage-tree-spec.md), ruled as
**R75** in `notes/05-build-plan.md` §5.

```
node tools/check-key.mjs              # does the key still describe the tree?
node tools/check-key.mjs --strict     # ...and are there no unanswered questions?
node tools/prove-can-fail.mjs         # is that check capable of failing at all?
node tools/scan-occurrences.mjs       # authoring aid: every asset-shaped token, with positions
node tools/stamp-positions.mjs        # refill derived offsets — READ THE DIFF, see below
```

## 🔴 Its output is a coverage matrix. It is never a score.

Per reference shape, never per repository and never in total:

```
img@srcset, w descriptors        8 of  9   ✗
url() double-quoted             11 of 11   ✓
a reference inside .vue          0 of  8   ✗  no reader
```

**There is no total, no percentage and no overall row**, and it must stay impossible to build
one. That is not a stylistic preference — it is the property that stops a figure from this
tree escaping into a README. A shape row names *where to add an adapter next* and catches a
regression that drops `srcset` from 9 to 5; a single number does neither and invites misuse.

## 🔴 It does not replace the real repositories

| instrument | the question it answers |
|---|---|
| **this tree** | *how well do we handle the shapes we KNOW about?* — exactly |
| **real repositories** | *what shapes exist that nobody imagined?* — the only source of new ones |

Every serious defect in this project came from the second: R26's spaced filenames, R49's
twelve public directories, R72's reference in an unread file type. **A tree we build can only
contain what somebody thought of.** Every shape in here is traceable to something that has
already gone wrong, which is the most it can be.

## Layout

```
coverage-tree/
  key/coverage-key.json      THE ANSWER KEY — shapes, assets, and 404 references
  tools/check-key.mjs        the self-check. Plain text and path arithmetic, nothing else
  tools/prove-can-fail.mjs   18 deliberate mutations, each asserted to turn the check red
  tools/stamp-positions.mjs  fills derived offsets; never touches an `expect`
  tools/scan-occurrences.mjs authoring aid
  tree/                      ← the repository under test. ONLY this is ever scanned
```

**The key and the tools live OUTSIDE `tree/` on purpose.** The key contains every path string
in the tree; if it sat inside, the engine would scan it and the answer key would become part
of the answer.

### Inside `tree/`

```
apps/web/       serving root #1 — apps/web/public
apps/docs/      serving root #2 — apps/docs/public
sites/root-served/   serving root #3 — the site's OWN directory (R63)
legacy/         serving root #4 — legacy/public, with all its source in unread file types
docs-examples/  🔴 a public/ that is NOT a serving root
shared/         the alias target for ~/* and @img/*
```

371 files, of which **270 are ordinary and reference-free** — so referenced files are a
minority the way they are in real code (§4k.5). The filler averages ~2 KB per file rather
than being stubs, because R19's warning is about **bytes**, not file count: `bench/`'s
generator once had real code's file count with a thirtieth of its bytes and inverted two
measured conclusions.

## `expect` is the IDEAL outcome, not today's behaviour

The seven outcomes are the engine's own. `expect` records **what a correct engine should
produce**, independently of what this one does — so a `.vue` reference expects to be *found*,
which is the only way the matrix can say **"0 of 8, no reader"** out loud instead of silently
reporting nothing. Where today's engine is known to differ, `knownGap` says so and names the
ruling (50 entries carry one).

`discarded` means **"must not be treated as a live reference."** The spec used one word for
two engine behaviours — a `url()` inside a comment is probably never collected at all, rather
than collected and marked `discarded` — and the measuring harness accepts either. It must not
accept resolved, broken, or rewritten. This is written down in the key's `expectSemantics`.

**14 entries are `UNDECIDED`**, each with at least two candidate outcomes and a note. They do
not fail the integrity check; they fail `--strict`, which is what the measuring suite runs.
A wrong `expect` is worse than a missing one: it makes a correct engine look broken, or a
broken one look correct.

## 🔴 The tree is read-only ground truth

Any test that writes works on a **copy**. An `optimize --apply` run against the tree would
change the files and silently invalidate the key — the hazard R52 guards for the pinned
validation corpus. `prove-can-fail.mjs` already does this correctly: every mutation is applied
to a copy in the system temp directory, and the real tree is never written to.

`.gitattributes` sets `* -text` for this whole directory. The key records **byte offsets**,
and a line-ending conversion on checkout would shift every one of them — the self-check would
then blame the tree for something git did on the way out of the object store.

## The weakest seam, named rather than hidden

**`stamp-positions.mjs` can turn a red check green without anybody re-reading what changed.**

Somebody edits the tree, the self-check goes red, they re-run the stamper, and it goes green —
and the key now describes a tree nobody re-examined. That is a drifted key wearing a passing
check, which is precisely what R75 says a key does if you let it.

Three things hold against it, and none of them is a guarantee:

1. The stamper **prints every change it makes** and says so loudly. Read the diff.
2. It **only ever moves positions**. It cannot invent a reference, change an `expect`, or add
   a shape — those fields are hand-written and stay hand-written.
3. A *new or deleted* reference does not stamp away. It fails as an unaccounted occurrence or
   a missing raw, and the stamper refuses to write at all.

**What survives all three:** an existing reference whose `raw` was edited into a different but
still-present string. The stamper will happily re-point it. If a `raw` moved by more than
whitespace, the key needed a person.

## How the key is maintained

The JSON **is** the artifact and is edited by hand. It was bootstrapped from a one-shot
authoring script, which was not kept: a second source of truth beside the key is a second
thing to drift.

Adding a reference: add the entry with `file`, `raw`, `occurrence`, `shape`, `expect`,
`target`, `why` — then `stamp-positions.mjs`, then `check-key.mjs`.

`occurrence` is the **nth literal occurrence of that exact `raw` string in that file**, and it
need not start at 1. When a raw is a substring of a longer path earlier in the file —
`/img/avatar.png` inside `../../public/img/avatar.png`, `logo.png` inside four longer paths —
the first standalone occurrence is legitimately number 3 or 5. Getting this one too low
stamps a reference *inside* another one, where every other check still passes; the overlap
rule exists for exactly that and caught it twice while this was being built.

## What the self-check does not check

Stated plainly, because a check whose limits are unstated is read as a guarantee:

- **Only asset extensions are scanned.** A reference to a `.css` or `.ts` file added without
  a key entry would not be caught. Two such references *are* keyed by hand.
- **A token whose path is split by syntax is found short.** `/gallery/hero image.png` matches
  as `image.png`, and `` `/theme-${mode}.png` `` as `.png`. Both are accounted for by
  containment within the listed reference's span, which is correct but is a weaker statement
  than an exact match.
- **A path with no asset extension is invisible to it** — a directory reference, or an
  extensionless URL.
- **It says nothing about whether an `expect` is right.** It proves the key describes the
  tree. Whether the tree's answers are the correct ones is a human judgement, and 14 of them
  are openly marked as not yet made.
