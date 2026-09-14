import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { checkMoveRegression } from './move-check.js';
import type { Asset, ExcludedRoot, RawReference, Reference, UnscannedFile } from './types.js';

/**
 * R72 part 1 — the disclosure that travels with a move's regression count.
 *
 * ⚠️ **What these tests are for, and what they are not for.** They pin the *shape* of
 * the disclosure: that it is present, that it survives the cases where it looks
 * unnecessary, and that it names what a reader can act on. They did not find the
 * defects in the wording — **three of those were found by rendering the output and
 * reading it**, after these assertions were already green: a truncated list that hid
 * the one extension R72 was discovered through, and two drafts of a sentence that said
 * *"1 directory … their files"*. That is the fourth, fifth and sixth time this phase
 * that reading the rendered output found what a passing suite could not.
 *
 * Graphs go through the **real** `buildGraph`, so `unscannedExtensions` is counted by
 * the code that counts it in production. A hand-written extension table would have let
 * the ordering test pass against data the real counter never produces.
 */

const ROOT = '/repo';

/** One unread file per entry, so the real extension counter does the counting. */
function unreadFiles(spec: readonly { ext: string; count: number }[]): UnscannedFile[] {
  const files: UnscannedFile[] = [];
  for (const { ext, count } of spec) {
    for (let index = 0; index < count; index++) {
      files.push({
        path: `${ROOT}/unread/f${index}${ext}`,
        relative: `unread/f${index}${ext}`,
        extension: ext,
        reason: 'unclaimed-extension',
        detail: '',
      });
    }
  }
  return files;
}

/** Files of a type we DO read that the scan could not parse. */
function parseFailures(spec: readonly { relative: string; detail: string }[]): UnscannedFile[] {
  return spec.map((entry) => ({
    path: `${ROOT}/${entry.relative}`,
    relative: entry.relative,
    extension: entry.relative.slice(entry.relative.lastIndexOf('.')),
    reason: 'parse-failed' as const,
    detail: entry.detail,
  }));
}

/** A graph with `broken` broken references and whatever went unread. */
function graphWith(input: {
  broken: number;
  unread?: readonly { ext: string; count: number }[];
  failed?: readonly { relative: string; detail: string }[];
}) {
  const assets: Asset[] = [
    { path: `${ROOT}/public/hero.png`, relative: 'public/hero.png', extension: '.png', bytes: 10 },
  ];
  const base: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
    kind: 'attr',
    shape: 'html.img.src',
    ceiling: 'high',
    asserted: true,
  };
  // ⚠️ `confidence: 'unsafe'` and `resolvedPath: null` are not decoration — the
  // `Reference` union *requires* them of anything not resolved, and the first draft of
  // this helper wrote `'high'` with a real path. **Rule 17's test typechecking caught a
  // reference in a state the engine cannot produce**, which would have made every
  // assertion below true of data no run can create. The fix is the data, not a cast
  // through `unknown`.
  const references: Reference[] = Array.from({ length: input.broken }, (_, index) => ({
    ...base,
    file: `${ROOT}/page${index}.html`,
    rawPath: '/gone.png',
    start: 10,
    end: 20,
    resolution: 'broken' as const,
    confidence: 'unsafe' as const,
    resolvedPath: null,
  }));

  return buildGraph({
    root: ROOT,
    assets,
    references,
    unscannedFiles: [...unreadFiles(input.unread ?? []), ...parseFailures(input.failed ?? [])],
  });
}

function excluded(names: readonly string[]): ExcludedRoot[] {
  return names.map((name) => ({
    path: `${ROOT}/${name}`,
    relative: name,
    reason: `a build or version-control directory named '${name}'`,
  }));
}

/** The whole disclosure as one string, which is how a reader meets it. */
function rendered(check: { lines: readonly string[] }): string {
  return check.lines.join('\n');
}

describe('a move’s regression count, and what it cannot see', () => {
  it('never states the count without stating its limit', () => {
    // The sentence R72 is about is "no new broken references". The qualifier has to
    // travel with it, because a reader who reads one line reads that one.
    const check = checkMoveRegression({
      before: graphWith({ broken: 111 }),
      after: graphWith({ broken: 111 }),
      excludedRoots: [],
    });

    expect(check.regressed).toBe(false);
    expect(rendered(check)).toContain('no new broken references among those Upfly can parse');
    expect(rendered(check)).toContain('What that count cannot see');
    // The circularity itself is named, not just its consequence: this is the whole
    // content of R72 and a reader cannot weigh the number without it.
    expect(rendered(check)).toContain('same graph');
  });

  it('still states the limit when nothing went unread at all', () => {
    // 🔴 **The most important test in this file.** A tree where every file was read is
    // exactly where the count looks like a guarantee, and a caveat that disappears
    // there would turn the clean case into the false one. The class is absent from
    // *this tree*; it is not absent from the check.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0 }),
      excludedRoots: [],
    });

    expect(check.limit.typesThatCouldHide).toEqual([]);
    expect(check.limit.unreadFileCount).toBe(0);
    expect(rendered(check)).toContain('could have broken without');
    expect(rendered(check)).toContain('No unread file in this tree could hold a path');
    // Runtime-assembled paths are not a property of the tree, so this one has no
    // escape hatch in any tree.
    expect(rendered(check)).toContain('assembles at runtime');
  });

  it('states the limit on a regression too, not only on a clean run', () => {
    // A regression of 3 is just as silent about a fourth break it could not see.
    // Hiding the caveat exactly when the move has proven fallible is backwards.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      after: graphWith({ broken: 3, unread: [{ ext: '.yml', count: 1 }] }),
      excludedRoots: [],
    });

    expect(check.regressed).toBe(true);
    expect(rendered(check)).toContain('REGRESSION');
    expect(rendered(check)).toContain('3 references Upfly can parse broke in this move');

    // ⚠️ **Assert the bullets, never the heading.** The first version of this test
    // checked for `What that count cannot see`, which `render` pushes before the
    // conditional bullets — so suppressing every bullet on a regression left the
    // heading standing and this test green. The mutation that proved it is recorded in
    // the handoff; it is the same defect as B5's three, one layer further out.
    expect(rendered(check)).toContain('could have broken without');
    expect(rendered(check)).toContain('.yml — 1 file');
    expect(rendered(check)).toContain('assembles at runtime');
  });

  it('names parse failures separately, because they are fixable and the types are not', () => {
    // 🔴 **Measured on `railsgirls-com`, and the most consequential line this disclosure
    // has.** Three `.html` files failed on invalid CSS inside an inline `<style>`, so the
    // scan collected nothing from them — including their `<link rel="apple-touch-icon">`
    // pointing at the asset being moved. The move broke all three, and `broken before vs
    // after` stayed at 111, because the same scan failure hid both the reference and the
    // breakage. R72 part 2 found them by searching the text.
    //
    // ⚠️ Before this split, the disclosure grouped them by extension and printed
    // `.html — 22 files`, which reads as "Upfly cannot read HTML". It reads HTML fine.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({
        broken: 0,
        failed: [
          { relative: 'bratislava.html', detail: 'invalid css syntax at line 16, column 5' },
        ],
      }),
      excludedRoots: [],
    });

    expect(check.limit.parseFailed.map((entry) => entry.relative)).toEqual(['bratislava.html']);
    const text = rendered(check);
    expect(text).toContain('of a type Upfly DOES read could not be parsed');
    // Named individually with the parser's complaint: unlike an unread type, this is one
    // file a person can open.
    expect(text).toContain('bratislava.html — invalid css syntax at line 16, column 5');
    expect(text).toContain('usually fixable');
  });

  it('says nothing about parse failures when there were none', () => {
    // Here so the assertion above means something: a bullet that always prints proves
    // nothing about a tree that has them.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      excludedRoots: [],
    });

    expect(check.limit.parseFailed).toEqual([]);
    expect(rendered(check)).not.toContain('could not be parsed');
  });

  it('names an unread type that could hold a path, and not one that could not', () => {
    // The line `couldHideAReference` draws. A `.woff2` holds no path text, so naming it
    // would send a reader to look for a reference inside a font — confidently wrong,
    // which is the R21 failure. `.svg` is named because it genuinely carries
    // `<image href>` and nothing parses it.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({
        broken: 0,
        unread: [
          { ext: '.yml', count: 2 },
          { ext: '.woff2', count: 9 },
          { ext: '.svg', count: 1 },
        ],
      }),
      excludedRoots: [],
    });

    const named = check.limit.typesThatCouldHide.map((entry) => entry.ext);
    expect(named).toContain('.yml');
    expect(named).toContain('.svg');
    expect(named).not.toContain('.woff2');
    // And the count quoted to the reader excludes the font, or the sentence promises a
    // blind spot bigger than the one that exists.
    expect(check.limit.unreadFileCount).toBe(3);
  });

  it('names the types holding most files first, so truncation hides the smallest', () => {
    // 🔴 **Found by reading the rendered output, and the premise is what matters.**
    // On `railsgirls-com` the alphabetical order put `.yml` sixth of six, so the one
    // extension that demonstrated R72 sat behind "and 1 more".
    //
    // ⚠️ The data below is built so the two orderings **disagree** — alphabetically
    // `.aaa` leads, by volume it is last. B5 wrote a test whose `small-*`/`big-*` names
    // sorted the same way under both orders, so the mutation stayed green and the
    // premise was never exercised. That premise is asserted here rather than assumed.
    const unread = [
      { ext: '.aaa', count: 1 },
      { ext: '.bbb', count: 2 },
      { ext: '.ccc', count: 3 },
      { ext: '.ddd', count: 4 },
      { ext: '.eee', count: 5 },
      { ext: '.zzz', count: 900 },
    ];

    const alphabetical = [...unread].map((entry) => entry.ext).sort();
    const byVolume = [...unread].sort((a, b) => b.count - a.count).map((entry) => entry.ext);
    expect(alphabetical).not.toEqual(byVolume); // the premise, asserted

    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0, unread }),
      excludedRoots: [],
    });

    expect(check.limit.typesThatCouldHide.map((entry) => entry.ext)).toEqual(byVolume);
    // The biggest is named in the output; the smallest is the one summarised away.
    expect(rendered(check)).toContain('.zzz — 900 files');
    expect(rendered(check)).toContain('... and 1 more');
    expect(rendered(check)).not.toContain('.aaa —');
  });

  it('discloses directories nothing opened, and says they are outside the unread count', () => {
    // A reader told "2 files went unread" would otherwise take 2 for the whole blind
    // spot. An excluded directory's files were never seen, so they are absent from
    // that count as well as from the graph — R72's own defect one level down.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 2 }] }),
      after: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 2 }] }),
      excludedRoots: excluded(['node_modules', 'tmp']),
    });

    expect(check.limit.neverRead.map((entry) => entry.relative)).toEqual(['node_modules', 'tmp']);
    expect(rendered(check)).toContain('2 directories went unopened');
    expect(rendered(check)).toContain('nothing inside is counted above either');
    // The rule that closed each one, so a reader can decide whether to care.
    expect(rendered(check)).toContain("a build or version-control directory named 'tmp'");
  });

  it('says nothing about excluded directories when there are none', () => {
    // The inverse of the test above, and it is here because a bullet that always
    // prints would make the previous assertion meaningless.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0 }),
      after: graphWith({ broken: 0 }),
      excludedRoots: [],
    });

    expect(check.limit.neverRead).toEqual([]);
    expect(rendered(check)).not.toContain('went unopened');
  });

  it('warns when the two sides of the comparison did not read the same files', () => {
    // Then part of the difference between the counts may be coverage rather than the
    // move, and the comparison is not like-for-like. It should not happen — a move
    // relocates assets, not sources — so it is surfaced rather than assumed away.
    const check = checkMoveRegression({
      before: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 4 }] }),
      after: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 2 }] }),
      excludedRoots: [],
    });

    expect(check.limit.readDifferently).toBe(true);
    expect(check.limit.unreadBefore).toBe(4);
    expect(check.limit.unreadAfter).toBe(2);
    expect(rendered(check)).toContain('did not read the same number of files');
    expect(rendered(check)).toContain('not like-for-like');
  });

  it('does not warn when both sides read the same files', () => {
    const check = checkMoveRegression({
      before: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 4 }] }),
      after: graphWith({ broken: 2, unread: [{ ext: '.yml', count: 4 }] }),
      excludedRoots: [],
    });

    expect(check.limit.readDifferently).toBe(false);
    expect(rendered(check)).not.toContain('did not read the same number of files');
  });

  it('does not call a drop in broken references a success', () => {
    // A move repairs nothing, so fewer broken references than before means something
    // else changed. Reporting that as a clean run would be the reassuring version of
    // a result nobody has explained.
    const check = checkMoveRegression({
      before: graphWith({ broken: 5 }),
      after: graphWith({ broken: 4 }),
      excludedRoots: [],
    });

    expect(check.regressed).toBe(false);
    expect(rendered(check)).not.toContain('no new broken references');
    expect(rendered(check)).toContain('needs explaining');
  });

  it('reproduces R72: B5’s measurement does not read as a guarantee', () => {
    // 🔴 The exact shape B5 measured on `astro-docs`. A reference to a moved asset was
    // added to `deploy/netlify.yml`, nothing scans `.yml`, the move broke it, and the
    // check reported:
    //
    //     broken before: 0    broken after: 0    and the reference was broken
    //
    // Both numbers are still 0 — that is the check's shape and this does not change
    // it. What it changes is that the output now says the `.yml` was never read, so
    // the zero is no longer offered as proof.
    const check = checkMoveRegression({
      before: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      after: graphWith({ broken: 0, unread: [{ ext: '.yml', count: 1 }] }),
      excludedRoots: [],
    });

    expect(check.brokenBefore).toBe(0);
    expect(check.brokenAfter).toBe(0);
    expect(check.regressed).toBe(false);
    expect(rendered(check)).toContain('.yml — 1 file');
    expect(rendered(check)).toContain('could have broken without');
  });
});
