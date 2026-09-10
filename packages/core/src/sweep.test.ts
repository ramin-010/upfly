import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from './graph.js';
import type { ReadFilePort } from './scan.js';
import { sweepForMentions } from './sweep.js';
import type { Asset, RawReference, Reference, UnscannedFile } from './types.js';

/**
 * The sweep decides `dead` against `possibly-dead`, so every test here is really
 * asking one question: would this asset be reported as confidently dead, and is
 * that true?
 */

const ROOT = '/repo';

function asset(relative: string): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes: 100,
  };
}

function unscanned(relative: string): UnscannedFile {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    reason: 'unclaimed-extension',
    detail: '',
  };
}

function raw(file: string, rawPath: string, start = 0): RawReference {
  return {
    file: `${ROOT}/${file}`,
    start,
    end: start + rawPath.length,
    rawPath,
    kind: 'attr',
    ceiling: 'unsafe',
    asserted: true,
  };
}

function unlinked(
  file: string,
  rawPath: string,
  resolution: 'dynamic' | 'broken' | 'discarded' | 'unresolved-alias',
  start = 0,
): Reference {
  return { ...raw(file, rawPath, start), resolution, confidence: 'unsafe', resolvedPath: null };
}

function outOfScope(file: string, rawPath: string): Reference {
  return {
    ...raw(file, rawPath),
    resolution: 'out-of-scope',
    confidence: 'unsafe',
    resolvedPath: `${ROOT}/legacy/hero.png`,
    exclusionReason: "the ignore rule 'legacy/'",
  };
}

function resolved(file: string, rawPath: string, target: string): Reference {
  return {
    ...raw(file, rawPath),
    ceiling: 'high',
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
  };
}

function files(contents: Record<string, string>): ReadFilePort {
  return async (path) => {
    const text = contents[path];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return text;
  };
}

function graphOf(input: {
  assets?: readonly Asset[];
  references?: readonly Reference[];
  unscannedFiles?: readonly UnscannedFile[];
}) {
  return buildGraph({
    root: ROOT,
    assets: input.assets ?? [],
    references: input.references ?? [],
    unscannedFiles: input.unscannedFiles ?? [],
  });
}

describe('sweepForMentions', () => {
  describe('haystack (a) — files nobody read', () => {
    it('finds an asset named in an unscanned file, and cites the line', async () => {
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        unscannedFiles: [unscanned('config.yaml')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/config.yaml': 'site:\n  title: Home\n  image: /img/hero.png\n' }),
      });

      expect(result.mentions.get('img/hero.png')).toEqual([
        {
          asset: 'img/hero.png',
          source: 'unscanned-file',
          where: 'config.yaml:3',
          quote: 'hero.png',
        },
      ]);
    });

    it('leaves an asset nothing mentions out of the map entirely', async () => {
      // This is the case that gets a confident `dead` — the whole point of the
      // amendment. It has to stay reachable.
      const graph = graphOf({
        assets: [asset('img/orphan.png')],
        unscannedFiles: [unscanned('config.yaml')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/config.yaml': 'site:\n  title: Home\n' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('matches case-insensitively, because Windows does', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('page.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.vue': '<img src="Hero.PNG">' }),
      });

      expect(result.mentions.get('hero.png')).toHaveLength(1);
    });

    it('hedges both assets when two share a basename', async () => {
      // The evidence genuinely cannot tell them apart: a template says `logo.png`,
      // not where it lives. Hedging both is the safe direction to be wrong in.
      const graph = graphOf({
        assets: [asset('a/logo.png'), asset('b/logo.png')],
        unscannedFiles: [unscanned('page.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.vue': '<img src="/a/logo.png">' }),
      });

      expect([...result.mentions.keys()].sort()).toEqual(['a/logo.png', 'b/logo.png']);
    });

    it('does not stop a token at a slash boundary', async () => {
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        unscannedFiles: [unscanned('page.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.njk': "{{ '/img/hero.png' | url }}" }),
      });

      expect(result.mentions.get('img/hero.png')?.[0]?.quote).toBe('hero.png');
    });

    it('only sweeps assets that have no references at all', async () => {
      // A referenced asset is not a candidate, so its name in a `.vue` file is not
      // evidence of anything and costs nothing to ignore.
      const graph = graphOf({
        assets: [asset('used.png')],
        references: [resolved('index.html', './used.png', 'used.png')],
        unscannedFiles: [unscanned('page.vue')],
      });
      const readFile = vi.fn(files({ '/repo/page.vue': '<img src="used.png">' }));

      const result = await sweepForMentions({ graph, readFile });

      expect(result.mentions.size).toBe(0);
      // No candidates means no reason to touch a disk at all.
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('a filename inside an absolute URL', () => {
    it('hedges an asset under a serving root, which the URL could genuinely serve', async () => {
      // astro-docs cites its own published assets as
      // `https://docs.astro.build/assets/arc.webp`. Deleting `public/assets/arc.webp`
      // really would break that URL, so the mention is evidence.
      const graph = graphOf({
        assets: [asset('public/assets/arc.webp')],
        unscannedFiles: [unscanned('guide.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/guide.njk': 'See https://docs.astro.build/assets/arc.webp here' }),
        publicDirs: ['public'],
      });

      expect(result.mentions.has('public/assets/arc.webp')).toBe(true);
    });

    it('ignores it for an asset outside every serving root', async () => {
      // A URL cannot be serving `src/internal/arc.webp`, so the mention is noise —
      // and §5.1(b)'s triage already treats a URL as never a candidate reference.
      // Without this rule the sweep and the validation harness disagreed.
      const graph = graphOf({
        assets: [asset('src/internal/arc.webp')],
        unscannedFiles: [unscanned('guide.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/guide.njk': 'See https://docs.astro.build/assets/arc.webp here' }),
        publicDirs: ['public'],
      });

      expect(result.mentions.size).toBe(0);
    });

    it('still hedges a plain mention of an asset outside a serving root', async () => {
      const graph = graphOf({
        assets: [asset('src/internal/arc.webp')],
        unscannedFiles: [unscanned('guide.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/guide.njk': '<img src="/internal/arc.webp">' }),
        publicDirs: ['public'],
      });

      expect(result.mentions.has('src/internal/arc.webp')).toBe(true);
    });
  });

  describe('haystack (b) — paths we read but could not resolve', () => {
    it('rescues the eleventy case that R10 was raised for', async () => {
      // `templated.png` is named by a path in a file we parsed perfectly. The
      // reference is `dynamic`, so it links nothing and the asset looks dead while
      // being demonstrably alive.
      const source =
        '---\ntitle: First\n---\n\nSome prose.\n\n![Templated]({{ site.url }}/img/templated.png)\n';
      const graph = graphOf({
        assets: [asset('img/templated.png')],
        references: [
          unlinked(
            'posts/first.md',
            '{{ site.url }}/img/templated.png',
            'dynamic',
            source.indexOf('{{'),
          ),
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/posts/first.md': source }),
      });

      expect(result.mentions.get('img/templated.png')).toEqual([
        {
          asset: 'img/templated.png',
          source: 'unresolved-reference',
          // R10 makes file, line and raw path mandatory, not optional.
          where: 'posts/first.md:7',
          quote: '{{ site.url }}/img/templated.png',
        },
      ]);
    });

    it('sweeps an unresolved alias, which is every Next and Vite repo until Phase 2', async () => {
      const graph = graphOf({
        assets: [asset('src/assets/logo.png')],
        references: [unlinked('App.tsx', '@/assets/logo.png', 'unresolved-alias')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/App.tsx': "import logo from '@/assets/logo.png';\n" }),
      });

      expect(result.mentions.get('src/assets/logo.png')?.[0]?.source).toBe('unresolved-reference');
    });

    it('sweeps a discarded speculative path', async () => {
      const graph = graphOf({
        assets: [asset('icons/app.png')],
        references: [unlinked('manifest.json', 'icons/app.png', 'discarded')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/manifest.json': '{"icons":["icons/app.png"]}' }),
      });

      expect(result.mentions.has('icons/app.png')).toBe(true);
    });

    it('does NOT sweep a broken reference', async () => {
      // Its target is known: nothing. It is already its own finding, and
      // `hero.png: dead` beside `./wrong-dir/hero.png: broken` tells a reader more
      // than hedging `hero.png` would — hedging would hide the pair.
      const graph = graphOf({
        assets: [asset('hero.png')],
        references: [unlinked('index.html', './wrong-dir/hero.png', 'broken')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': '<img src="./wrong-dir/hero.png">' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('does NOT sweep an out-of-scope reference', async () => {
      // Target known, and known not to be an indexed asset.
      const graph = graphOf({
        assets: [asset('hero.png')],
        references: [outOfScope('index.html', '../legacy/hero.png')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': '<img src="../legacy/hero.png">' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('still cites the file when its source cannot be re-read for a line', async () => {
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        references: [unlinked('gone.md', '{{ x }}/img/hero.png', 'dynamic')],
      });

      const result = await sweepForMentions({ graph, readFile: files({}) });

      expect(result.mentions.get('img/hero.png')?.[0]?.where).toBe('gone.md');
      expect(result.skipped).toEqual([{ relative: 'gone.md', reason: 'ENOENT' }]);
    });
  });

  describe('haystack (c) — files we read but did not understand', () => {
    it('rescues an asset named only by a construct no adapter reads', async () => {
      // A template literal with no interpolation. It parses fine, no adapter reads
      // it, and it is not a `StringLiteral` so the speculative rule does not see it
      // either — so neither of the other haystacks covers it and the asset would be
      // reported *confidently* dead.
      const graph = graphOf({ assets: [asset('img/hero.png')] });
      const source = ['export const config = {', '  banner: `/img/hero.png`,', '};'].join('\n');

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/gen.ts': source }),
        scannedFiles: [{ path: '/repo/gen.ts', relative: 'gen.ts' }],
      });

      expect(result.mentions.get('img/hero.png')).toEqual([
        {
          asset: 'img/hero.png',
          source: 'scanned-file',
          where: 'gen.ts:2',
          quote: 'hero.png',
        },
      ]);
    });

    it('cannot rescue a filename that is assembled at runtime — the resolver must', async () => {
      // The honest limit of every basename sweep: `background-${dir}.png` never
      // contains the string `background-ltr.png`, so there is nothing to find.
      //
      // This asserts what the *sweep* cannot do, not that the finding is correct.
      // The right tool is the resolver: a template carries a `medium` ceiling, the
      // glob matches `background-*.png`, and `resolved-pattern` links every match.
      // The first version of this test read as though the dead finding were right,
      // which is how a limit of one mechanism gets mistaken for a limit of all of
      // them.
      const graph = graphOf({ assets: [asset('img/background-ltr.png')] });
      const source = ['export const x = {', '  path: `./img/background-${dir}.png`,', '};'].join(
        '\n',
      );

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/gen.ts': source }),
        scannedFiles: [{ path: '/repo/gen.ts', relative: 'gen.ts' }],
      });

      expect(result.mentions.size).toBe(0);
    });

    it('does not read scanned files when the cheaper haystacks explained everything', async () => {
      // It doubles the sweep's read volume, so it only earns that when something is
      // still unexplained. On a healthy repository it reads nothing at all.
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('page.vue')],
      });
      const readFile = vi.fn(files({ '/repo/page.vue': 'hero.png', '/repo/app.ts': 'hero.png' }));

      await sweepForMentions({
        graph,
        readFile,
        scannedFiles: [{ path: '/repo/app.ts', relative: 'app.ts' }],
      });

      expect(readFile).toHaveBeenCalledTimes(1);
      expect(readFile).toHaveBeenCalledWith('/repo/page.vue');
    });

    it('reads nothing at all when every asset is referenced', async () => {
      const graph = graphOf({
        assets: [asset('used.png')],
        references: [resolved('index.html', './used.png', 'used.png')],
      });
      const readFile = vi.fn(files({}));

      await sweepForMentions({
        graph,
        readFile,
        scannedFiles: [{ path: '/repo/app.ts', relative: 'app.ts' }],
      });

      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('what it declines to read', () => {
    it('records a file it could not read rather than silently not hedging', async () => {
      // A silent skip here turns a hedge back into a confident `dead`, which is the
      // exact false positive the rule exists to prevent.
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('locked.yaml')],
      });

      const result = await sweepForMentions({ graph, readFile: files({}) });

      expect(result.skipped).toEqual([{ relative: 'locked.yaml', reason: 'ENOENT' }]);
    });

    it('skips a file past the size limit, with a reason', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('promo.mp4')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/promo.mp4': `${'x'.repeat(500)}hero.png` }),
        maxBytes: 100,
      });

      expect(result.mentions.size).toBe(0);
      expect(result.skipped).toEqual([
        { relative: 'promo.mp4', reason: 'larger than the 100-byte sweep limit' },
      ]);
    });
  });

  describe('determinism and shape', () => {
    it('sorts mentions so two runs agree', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('b.vue'), unscanned('a.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/a.vue': 'hero.png', '/repo/b.vue': 'hero.png' }),
      });

      expect(result.mentions.get('hero.png')?.map((mention) => mention.where)).toEqual([
        'a.vue:1',
        'b.vue:1',
      ]);
    });

    it('records one mention per place, not per occurrence of the same place', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('a.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/a.vue': 'hero.png and again hero.png' }),
      });

      // Two occurrences on one line are one piece of evidence, not two.
      expect(result.mentions.get('hero.png')).toHaveLength(1);
    });

    it('sweeps nothing when there is nothing to sweep', async () => {
      const readFile = vi.fn(files({}));

      const result = await sweepForMentions({ graph: graphOf({}), readFile });

      expect(result).toEqual({ mentions: new Map(), skipped: [] });
      expect(readFile).not.toHaveBeenCalled();
    });

    it('ignores tokens whose extension we do not track', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('a.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/a.vue': 'import hero from "./hero.ts"; // not hero.png-ish' }),
      });

      // `hero.ts` is not a tracked extension, so it is not a filename token at all;
      // the comment does contain `hero.png` though, and evidence is evidence.
      expect(result.mentions.get('hero.png')?.[0]?.quote).toBe('hero.png');
    });
  });
});
