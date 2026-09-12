import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import type { AliasMap } from './aliases.js';
import { discover } from './discover.js';
import { buildGraph } from './graph.js';
import { type Move, planRelocation } from './relocate.js';
import { resolveReferences } from './resolve.js';
import { scanSources } from './scan.js';
import type { Asset, RawReference, Reference } from './types.js';

/**
 * `relocate` — moving an asset and repointing what names it.
 *
 * Two layers, deliberately. The **fixture** block runs the real pipeline over
 * `fixtures/partial-pattern`, because R70(c) is about a template binding several assets
 * and that is a partial-failure state the corpus cannot produce (R67). The **spelling**
 * block uses hand-built graphs, because a re-derived path has to be checked from many
 * directions and building twelve real trees to vary one directory would test the
 * fixtures rather than the arithmetic.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/partial-pattern');
const SERVING = { declared: true, dirs: ['public'] } as const;
const NO_ALIASES: AliasMap = { rules: [], skipped: [] };

async function fixtureGraph() {
  const discovered = await discover({ root: FIXTURE, adapters: defaultAdapters });
  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: defaultAdapters,
    readFile: (path) => readFile(path, 'utf8'),
  });
  const references = await resolveReferences(scanned.references, {
    root: discovered.root,
    assets: discovered.assets,
    servingRoots: SERVING,
    excludedRoots: discovered.excludedRoots,
    exists: (path) => existsSync(path),
  });
  return buildGraph({
    root: discovered.root,
    assets: discovered.assets,
    references,
    unscannedFiles: [...discovered.unscannedFiles, ...scanned.unscanned],
  });
}

async function relocateFixture(moves: Move[]) {
  return planRelocation({
    graph: await fixtureGraph(),
    moves,
    servingRoots: SERVING,
    publicDir: 'public',
    aliases: NO_ALIASES,
  });
}

describe('relocate, on the real tree', () => {
  it('moves a served asset within the served directory and repoints the URL', async () => {
    // The ordinary case, and the one the product claims: change where an image lives
    // and nothing breaks. A root-relative reference stays root-relative.
    const plan = await relocateFixture([
      { from: 'public/banner.png', to: 'public/img/banner.png' },
    ]);

    expect(plan.refused).toEqual([]);
    expect(plan.moves).toEqual([{ from: 'public/banner.png', to: 'public/img/banner.png' }]);
    expect(plan.rewrites).toEqual([
      { file: 'src/App.jsx', edits: [expect.objectContaining({ replacement: '/img/banner.png' })] },
    ]);
  });

  it('moves a bundled asset within the source tree and re-derives the relative path', async () => {
    // `./inline-logo.jpg` is expressed from the file that holds it, so moving the asset
    // one directory down makes it `./img/inline-logo.jpg` — and the `./` survives,
    // because a diff where `./` appears and disappears is a diff nobody can review.
    const plan = await relocateFixture([
      { from: 'src/inline-logo.jpg', to: 'src/img/inline-logo.jpg' },
    ]);

    expect(plan.refused).toEqual([]);
    expect(plan.rewrites[0]?.edits[0]?.replacement).toBe('./img/inline-logo.jpg');
  });

  describe('R70: a move that changes HOW the asset is referenced', () => {
    it.each([
      ['served to bundled', 'public/banner.png', 'src/banner.png'],
      ['bundled to served', 'src/inline-logo.jpg', 'public/inline-logo.jpg'],
    ])('refuses %s', async (_name, from, to) => {
      // 🔴 **The ruling's core, and the refusal a reader is most likely to think is
      // over-cautious.** It is not. After this move there is no path text that reaches
      // the file, whatever we write: a bundled asset is imported and emitted by the
      // build, a served one is fetched by URL. Turning one into the other is a code
      // change, and `relocate` rewrites paths.
      const plan = await relocateFixture([{ from, to }]);

      expect(plan.moves).toEqual([]);
      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['crosses-serving-boundary']);
      expect(plan.refused[0]?.reason).toContain('rewrites paths, not code');
    });

    it('makes no edits at all for a refused move', async () => {
      // ⚠️ Nothing partially applies. A caller that ignores `refused` writes *less*
      // than it asked for, never something wrong — which matters because the rewrites
      // would otherwise point at a file that never moved.
      const plan = await relocateFixture([{ from: 'public/banner.png', to: 'src/banner.png' }]);

      expect(plan.rewrites).toEqual([]);
      expect(plan.declined).toEqual([]);
    });

    it('refuses a pattern sibling and names every asset the pattern binds', async () => {
      // R70(c), inheriting R65. The user asked for one file; moving all three silently
      // is not the fix, and moving one breaks the single edit that stands for all of
      // them. ✅ This is the case `fixtures/partial-pattern` was built for.
      const plan = await relocateFixture([
        { from: 'public/theme-dark.png', to: 'public/img/theme-dark.png' },
      ]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['binds-a-pattern']);
      expect(plan.refused[0]?.reason).toContain('public/theme-light.png');
      expect(plan.refused[0]?.reason).toContain('public/theme-sepia.png');
      expect(plan.refused[0]?.reason).toContain('Move all 3, or none');
    });

    it('refuses a destination outside the project, which §1.2 already settled', async () => {
      const plan = await relocateFixture([{ from: 'public/banner.png', to: '../banner.png' }]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['outside-project']);
    });

    it('refuses a move onto a file that already exists', async () => {
      const plan = await relocateFixture([
        { from: 'public/banner.png', to: 'public/theme-dark.png' },
      ]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-occupied']);
    });

    it('refuses a path that is not an asset, rather than moving nothing quietly', async () => {
      const plan = await relocateFixture([{ from: 'public/not-here.png', to: 'public/x.png' }]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['not-an-asset']);
    });
  });
});

/** A hand-built graph, for the spelling cases that vary only by directory. */
function graphFor(input: {
  readonly assets: readonly string[];
  readonly references: readonly {
    file: string;
    rawPath: string;
    target: string;
    via?: 'file' | 'serving-root' | 'project-root' | 'speculative-root';
    confidence?: 'high' | 'unsafe';
  }[];
}) {
  const ROOT = '/repo';
  const assets: Asset[] = input.assets.map((relative) => ({
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes: 1_000,
  }));
  const raw: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
    kind: 'attr',
    ceiling: 'high',
    asserted: true,
  };
  const references = input.references.map(
    (entry) =>
      ({
        ...raw,
        file: `${ROOT}/${entry.file}`,
        rawPath: entry.rawPath,
        start: 10,
        end: 10 + entry.rawPath.length,
        resolution: 'resolved',
        confidence: entry.confidence ?? 'high',
        resolvedPath: `${ROOT}/${entry.target}`,
        resolvedVia: entry.via ?? 'file',
      }) as Reference,
  );

  return buildGraph({ root: ROOT, assets, references, unscannedFiles: [] });
}

describe('relocate, and how a path is re-spelled', () => {
  function replacementFor(
    graph: ReturnType<typeof graphFor>,
    move: Move,
    over: { aliases?: AliasMap; servingRoots?: { declared: boolean; dirs: string[] } } = {},
  ) {
    const plan = planRelocation({
      graph,
      moves: [move],
      servingRoots: over.servingRoots ?? SERVING,
      publicDir: 'public',
      aliases: over.aliases ?? NO_ALIASES,
    });
    return { plan, text: plan.rewrites[0]?.edits[0]?.replacement };
  }

  it('climbs out of a directory when the asset moves above the referencing file', () => {
    const graph = graphFor({
      assets: ['src/deep/logo.png'],
      references: [
        { file: 'src/deep/App.jsx', rawPath: './logo.png', target: 'src/deep/logo.png' },
      ],
    });

    expect(replacementFor(graph, { from: 'src/deep/logo.png', to: 'src/logo.png' }).text).toBe(
      '../logo.png',
    );
  });

  it('does not invent a ./ the original did not have', () => {
    // The reference is expressed as the author wrote it. Adding `./` would be a change
    // to every line we touch that has nothing to do with the move.
    const graph = graphFor({
      assets: ['src/logo.png'],
      references: [{ file: 'src/App.jsx', rawPath: 'logo.png', target: 'src/logo.png' }],
    });

    expect(replacementFor(graph, { from: 'src/logo.png', to: 'src/img/logo.png' }).text).toBe(
      'img/logo.png',
    );
  });

  it('keeps a query or fragment, which is not part of the path', () => {
    // `?v=2` is a cache-buster the author put there on purpose. Dropping it on the way
    // past would be a silent change to behaviour in a tool that claims to move files.
    const graph = graphFor({
      assets: ['public/hero.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/hero.png?v=2',
          target: 'public/hero.png',
          via: 'serving-root',
        },
      ],
    });

    expect(replacementFor(graph, { from: 'public/hero.png', to: 'public/img/hero.png' }).text).toBe(
      '/img/hero.png?v=2',
    );
  });

  it('re-derives a root-relative path against the serving root, not the project root', () => {
    // The URL is what the browser asks for, so it is relative to what the server
    // serves. Writing `/public/img/hero.png` would be a path that exists on disk and
    // 404s in a browser — the most convincing kind of wrong.
    const graph = graphFor({
      assets: ['public/hero.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/hero.png',
          target: 'public/hero.png',
          via: 'serving-root',
        },
      ],
    });

    expect(replacementFor(graph, { from: 'public/hero.png', to: 'public/img/hero.png' }).text).toBe(
      '/img/hero.png',
    );
  });

  it('re-spells an aliased import through the same alias', () => {
    // `astro-docs` imports `~/assets/houston.png`. Moving it within the alias's root
    // keeps the alias: the import statement is untouched apart from the path.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: ['/repo/src'],
          wildcard: true,
          scope: '/repo',
          source: 'tsconfig.json',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/assets/houston.png'],
      references: [
        {
          file: 'src/App.astro',
          rawPath: '~/assets/houston.png',
          target: 'src/assets/houston.png',
        },
      ],
    });

    expect(
      replacementFor(
        graph,
        { from: 'src/assets/houston.png', to: 'src/img/houston.png' },
        { aliases },
      ).text,
    ).toBe('~/img/houston.png');
  });

  it('does not re-spell through an alias whose scope does not cover the file', () => {
    // ⚠️ An alias rule only applies to references from inside the directory its config
    // governs, which is what `expandAlias` enforces. A matcher here that looked only at
    // the `~/` prefix would re-spell a reference through a rule the resolver never
    // used, producing text that looks right and reaches nothing.
    //
    // `packages/site` is outside the rule's scope, so the reference is treated as the
    // ordinary relative one it resolved as.
    const aliases: AliasMap = {
      rules: [
        { prefix: '~/', targets: ['/repo/src'], wildcard: true, scope: '/repo/src', source: 'x' },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['packages/site/~/logo.png'],
      references: [
        {
          file: 'packages/site/App.jsx',
          rawPath: '~/logo.png',
          target: 'packages/site/~/logo.png',
        },
      ],
    });

    const { text } = replacementFor(
      graph,
      { from: 'packages/site/~/logo.png', to: 'packages/site/img/logo.png' },
      { aliases },
    );

    expect(text).toBe('img/logo.png');
  });

  it('refuses when the alias cannot express the destination', () => {
    // 🔴 R70(a) in its narrow form, and the case that made it a ruling. `~/* → src/*`
    // cannot name anything outside `src/`, so after the move no alias path reaches the
    // file. The import would have to become a URL string, which is a code change.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: ['/repo/src'],
          wildcard: true,
          scope: '/repo',
          source: 'tsconfig.json',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/assets/houston.png'],
      references: [
        {
          file: 'src/App.astro',
          rawPath: '~/assets/houston.png',
          target: 'src/assets/houston.png',
        },
      ],
    });

    const { plan } = replacementFor(
      graph,
      { from: 'src/assets/houston.png', to: 'public/img/houston.png' },
      { aliases },
    );

    expect(plan.moves).toEqual([]);
    expect(plan.refused[0]?.code).toBe('crosses-serving-boundary');
  });

  it('declines a reference it may not edit, rather than moving in silence', () => {
    // 🔴 **R39.** The move happens and this reference will break. Saying so is the
    // whole difference between a dangling reference we found and one we caused.
    const graph = graphFor({
      assets: ['src/logo.png'],
      references: [
        {
          file: 'src/App.jsx',
          rawPath: './logo.png',
          target: 'src/logo.png',
          confidence: 'unsafe',
        },
      ],
    });

    const { plan, text } = replacementFor(graph, { from: 'src/logo.png', to: 'src/img/logo.png' });

    expect(text).toBeUndefined();
    expect(plan.moves).toHaveLength(1);
    expect(plan.declined[0]?.reason).toContain('no static path to replace');
  });

  it('refuses two moves that both claim one destination', () => {
    const graph = graphFor({ assets: ['src/a.png', 'src/b.png'], references: [] });
    const plan = planRelocation({
      graph,
      moves: [
        { from: 'src/a.png', to: 'src/img/x.png' },
        { from: 'src/b.png', to: 'src/img/x.png' },
      ],
      servingRoots: SERVING,
      publicDir: 'public',
      aliases: NO_ALIASES,
    });

    // One survives and one is refused, rather than both proceeding and the result
    // depending on which ran first — the same fold `prepare` applies, for the same
    // reason: two paths differing only in case are one file on Windows and macOS.
    expect(plan.moves).toHaveLength(1);
    expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-claimed-twice']);
  });

  it('treats a project that serves from its own root as all one world', () => {
    // R63's `''`: a hand-written static site with no build step serves the repository
    // it uploads, so nothing can cross a boundary — there is only one side. Getting
    // this backwards would refuse every move on the simplest kind of site there is.
    const graph = graphFor({
      assets: ['images/logo.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/images/logo.png',
          target: 'images/logo.png',
          via: 'serving-root',
        },
      ],
    });
    const plan = planRelocation({
      graph,
      moves: [{ from: 'images/logo.png', to: 'assets/logo.png' }],
      servingRoots: { declared: true, dirs: [''] },
      publicDir: '',
      aliases: NO_ALIASES,
    });

    expect(plan.refused).toEqual([]);
    expect(plan.rewrites[0]?.edits[0]?.replacement).toBe('/assets/logo.png');
  });
});
