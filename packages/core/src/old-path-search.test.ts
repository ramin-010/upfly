import { describe, expect, it } from 'vitest';
import { findSurvivingPaths, spellingsFor } from './old-path-search.js';

/**
 * R72 part 2 — searching for the old path without asking the graph.
 *
 * The tests that matter here are the ones about **what is searched for**, not about the
 * searching. A substring search is hard to get wrong; choosing the needle is where this
 * check lives or dies, and the ruling names the way it dies: **search the basename and
 * every move looks like a disaster**, because the asset still has that name at its new
 * home.
 */

const SERVING = ['public'];

/** A tiny in-memory tree. Nothing here touches a disk or a graph. */
function search(files: Record<string, string>, from: string, servingDirs = SERVING) {
  return findSurvivingPaths({
    moves: [{ from, to: 'public/moved/hero.png' }],
    files: Object.keys(files),
    readFile: async (relative) => {
      const text = files[relative];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    servingDirs,
  });
}

describe('the spellings an old path is searched for', () => {
  it('never searches the basename alone, because a move keeps the filename', () => {
    // 🔴 **The defect the ruling names.** After `public/img/hero.png` moves to
    // `public/moved/hero.png`, every reference to the NEW location still contains
    // `hero.png`. A basename search would report all of them as survivors, and a check
    // whose noise is indistinguishable from its signal is worse than no check.
    const spellings = spellingsFor('public/img/hero.png', SERVING);
    expect(spellings).not.toContain('hero.png');
    // Every spelling carries a directory separator — EITHER separator, since one of them
    // is the Windows variant. The first version of this assertion demanded `/` and failed
    // on `public\img\hero.png`, which is the spelling doing its job.
    for (const spelling of spellings) {
      expect(spelling.includes('/') || spelling.includes('\\')).toBe(true);
    }
  });

  it('derives the URL spelling, which is the one that appears in markup', () => {
    // `public/img/hero.png` is served at `/img/hero.png`, and that is what an `<img src>`
    // actually says. Searching only the project-relative path would miss every one.
    expect(spellingsFor('public/img/hero.png', SERVING)).toContain('/img/hero.png');
  });

  it('treats an empty serving directory as the project root being served', () => {
    // The `''` case, got backwards twice elsewhere in this codebase (R70).
    //
    // ⚠️ **This test caught nothing until the code changed.** It was written against an
    // explicit `if (dir === '')` branch, and a mutation that broke that branch left this
    // green — because the leading-slash spelling comes from the unconditional base set,
    // so the branch was adding a string that was already there. **The test could not see
    // its own premise**, and what it exposed was dead code rather than a weak assertion.
    // The branch is gone; the assertion is the same and now has one source of truth.
    expect(spellingsFor('img/hero.png', [''])).toContain('/img/hero.png');
    // And `''` must not be treated as a prefix that strips nothing and yields `/`.
    expect(spellingsFor('img/hero.png', [''])).not.toContain('/');
  });

  it('does not treat a serving directory as a bare string prefix', () => {
    // 🔴 Found by a mutation, not by design. `static` is a serving root and
    // `staticky/logo.png` is an asset that merely starts with those letters — stripping
    // the prefix without requiring a separator yields the URL `/ky/logo.png`, a spelling
    // that exists nowhere and that would then be searched for across the whole tree.
    const spellings = spellingsFor('staticky/logo.png', ['static']);
    expect(spellings).not.toContain('/ky/logo.png');
    expect(spellings).toContain('staticky/logo.png');
  });

  it('keeps a parent directory, so relative spellings are caught', () => {
    // `./img/hero.png` and `../../img/hero.png` both end in `img/hero.png`.
    expect(spellingsFor('public/img/hero.png', SERVING)).toContain('img/hero.png');
  });

  it('searches a backslash spelling too, for generated manifests', () => {
    expect(spellingsFor('public/img/hero.png', SERVING)).toContain('public\\img\\hero.png');
  });
});

describe('searching for what the move left behind', () => {
  it('finds a literal reference in a file type nothing parses — R72’s own case', async () => {
    // 🔴 B5's measurement, reproduced: a reference to a moved asset in `deploy/netlify.yml`.
    // Part 1 could only disclose that `.yml` went unread. This finds the line.
    const result = await search(
      { 'deploy/netlify.yml': 'from = "/img/hero.png"\nto = "/somewhere"\n' },
      'public/img/hero.png',
    );

    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.file).toBe('deploy/netlify.yml');
    expect(result.survivors[0]?.line).toBe(1);
    expect(result.survivors[0]?.text).toContain('/img/hero.png');
  });

  it('does NOT match a reference to the new location', async () => {
    // The premise of the whole design. `moved/hero.png` shares a basename with the old
    // path and must not match. ⚠️ If this ever goes green with a basename search, the
    // test data no longer satisfies its own premise — the old and new directories must
    // differ, and they do.
    const result = await search(
      { 'page.html': '<img src="/moved/hero.png">' },
      'public/img/hero.png',
    );
    expect(result.survivors).toEqual([]);
  });

  it('does not report the rewrite it just made as a survivor', async () => {
    // 🔴 **Found by running this on `astro-docs` and reading the output.** The asset was
    // served at `/default-og-image.png` and moved to `/upfly-moved/default-og-image.png`.
    // The old URL spelling is a SUFFIX of the new one, so the file the move had correctly
    // rewritten came back as a survivor — a correct rewrite reported as a failure, which
    // is the most misleading thing this check could say. An asset at the serving root has
    // a URL that is a filename with a slash in front of it, so the ruling's basename
    // warning applies to it in a costume.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/hero.png', to: 'public/upfly-moved/hero.png' }],
      files: ['routeData.ts'],
      readFile: async () => "const src = ogImageUrl ?? '/upfly-moved/hero.png';",
      servingDirs: SERVING,
    });

    expect(result.survivors).toEqual([]);
  });

  it('still reports a genuine survivor in a file that also holds the new path', async () => {
    // The inverse, and it is what stops the fix above from being a blanket exemption: a
    // file may hold both the rewritten reference AND one that was missed.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/hero.png', to: 'public/upfly-moved/hero.png' }],
      files: ['both.html'],
      readFile: async () => '<img src="/upfly-moved/hero.png">\n<meta content="/hero.png">\n',
      servingDirs: SERVING,
    });

    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.line).toBe(2);
  });

  it('reports one occurrence per line, not one per spelling that matched', async () => {
    // `/img/hero.png` contains the suffix `img/hero.png`, so a naive loop reports the same
    // line twice and the count says two occurrences where a reader can see one.
    const result = await search({ 'a.yml': 'src: /img/hero.png' }, 'public/img/hero.png');
    expect(result.survivors).toHaveLength(1);
  });

  it('finds several occurrences across files and orders them predictably', async () => {
    const result = await search(
      {
        'z.yml': 'a: /img/hero.png',
        'a.yml': 'b: /img/hero.png',
        'm.yml': 'nothing here',
      },
      'public/img/hero.png',
    );

    expect(result.survivors.map((s) => s.file)).toEqual(['a.yml', 'z.yml']);
    expect(result.filesSearched).toBe(3);
  });

  it('reports a file it could not read rather than counting it as clean', async () => {
    // 🔴 A hole in a search that reports "nothing found" is precisely R72's defect. An
    // unreadable file is named, not skipped.
    const result = await findSurvivingPaths({
      moves: [{ from: 'public/img/hero.png', to: 'public/moved/hero.png' }],
      files: ['gone.yml'],
      readFile: async () => {
        throw new Error('ENOENT');
      },
      servingDirs: SERVING,
    });

    expect(result.survivors).toEqual([]);
    expect(result.filesSearched).toBe(0);
    expect(result.unsearchable.map((entry) => entry.file)).toEqual(['gone.yml']);
    expect(result.lines.join('\n')).toContain('could not be read at all');
  });

  it('states its limits even when it finds nothing', async () => {
    // Same rule as part 1: a clean result is exactly where an unstated limit is read as a
    // guarantee, and this check has a large one.
    const result = await search({ 'a.yml': 'nothing' }, 'public/img/hero.png');

    expect(result.survivors).toEqual([]);
    const rendered = result.lines.join('\n');
    expect(rendered).toContain('What this search cannot see');
    expect(rendered).toContain('assembles at runtime');
    expect(rendered).toContain('excluded by an ignore rule');
    // The spellings are printed so the search can be repeated by hand.
    expect(rendered).toContain('/img/hero.png');
  });

  it('says a survivor is an occurrence to CHECK, not a reference we broke', async () => {
    // It reads text, so it cannot tell a broken reference from prose or a changelog. The
    // honest word is the whole point: reporting a coincidence costs a glance, and the
    // alternative wording would make a coincidence look like a defect.
    const result = await search(
      { 'CHANGELOG.md': 'moved /img/hero.png away' },
      'public/img/hero.png',
    );

    expect(result.survivors).toHaveLength(1);
    expect(result.lines.join('\n')).toContain('to check');
    expect(result.lines.join('\n')).toContain('coincidence');
  });
});
