/**
 * Every image-looking path in the fixtures, checked against what the pipeline detects.
 *
 * The adapter fixture tests list their expected references as literal arrays, and an array
 * copied from an adapter's output agrees with that adapter by construction: a reference the
 * adapter misses is missing from the array too. So this file reads no expected array. It
 * harvests paths from the raw text of every fixture with a scanner that is not an adapter,
 * runs the real pipeline over the same files, and requires every difference to be listed
 * in `KNOWN_NOT_DETECTED` with a reason.
 *
 * It covers references, not report output: a report branch no fixture reaches has
 * hand-built cases in other tests.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { discover } from './discover.js';
import { IMAGE_EXTENSIONS, toPosix } from './paths.js';
import { scanSources } from './scan.js';
import type { Adapter } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREES = join(HERE, '../../../fixtures');
const ADAPTER_FIXTURES = join(HERE, '../fixtures');

const ADAPTERS: readonly Adapter[] = defaultAdapters;

/**
 * Every fixture root, and both kinds matter.
 *
 * The five framework trees back `fixtures.test.ts`; `packages/core/fixtures` backs the
 * `*.fixtures.test.ts` files, whose literal expected arrays this file exists to check.
 */
const ROOTS: readonly { readonly label: string; readonly dir: string }[] = [
  { label: 'vite-react', dir: join(TREES, 'vite-react') },
  { label: 'next-app', dir: join(TREES, 'next-app') },
  { label: 'astro', dir: join(TREES, 'astro') },
  { label: 'plain-html', dir: join(TREES, 'plain-html') },
  { label: 'eleventy', dir: join(TREES, 'eleventy') },
  { label: 'adapter-fixtures', dir: ADAPTER_FIXTURES },
];

/**
 * The extensions the oracle looks for, written out rather than imported.
 *
 * Importing `IMAGE_EXTENSIONS` would blind the harvest and the engine together: drop
 * `.avif` from the engine's list and the oracle stops looking for it too, so the suite
 * stays green while coverage disappears. A separate copy keeps harvesting what the engine
 * forgot, and the mismatch fails as an unaccounted path. The copy can drift the other way,
 * a format added to the engine and not here, which `covers every extension the engine
 * tracks` below checks.
 */
const ORACLE_EXTENSIONS: readonly string[] = [
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
];

/**
 * Path-shaped tokens ending in an image extension, found in raw text.
 *
 * Not an adapter: no parser and no idea what a comment is, so it finds a superset of what a
 * correct adapter should. Its token boundaries agree with the adapters' wherever they can
 * (`/`, template holes such as `${slug}` and `#{$dir}`, and URL schemes stay inside a
 * token; whitespace, quotes and brackets end one), so the exception list
 * records decisions about the engine rather than quirks of this pattern. A template with
 * spaces, such as `{{ site.url }}/img/x.png`, cannot be one token: its entries are
 * `oracle-boundary`.
 *
 * A new `RegExp` per call, so no caller can inherit another's `lastIndex`.
 */
function harvestPattern(): RegExp {
  return new RegExp(`[\\w@.\\-/\${}#:]*\\.(?:${ORACLE_EXTENSIONS.join('|')})\\b`, 'gi');
}

/**
 * Dependencies and build output, which nobody here wrote. The fixtures install packages so
 * they can build, and an image path inside a third-party package is not the fixture's to
 * account for.
 */
const NOT_OURS: ReadonlySet<string> = new Set(['node_modules', 'dist', '_site', '.next', 'out']);

/**
 * Every fixture file under a directory, recursively. None of the engine's ignore rules
 * apply: the point is to harvest what a person wrote, including files no adapter claims.
 */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir)) {
    if (NOT_OURS.has(entry)) continue;
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) found.push(...(await filesUnder(full)));
    else found.push(full);
  }
  return found;
}

/**
 * Extensions whose bytes are not text, so there is nothing in them to harvest.
 *
 * A fixed list rather than a check for valid UTF-8: a `.png` that happens to decode would
 * otherwise be scanned, and compressed pixel data can hold a byte sequence that reads as
 * `hero.png`. Each such hit would need an entry in the exception list, and noise there is
 * what turns a written decision into an ignored one.
 */
const NOT_TEXT: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.ico',
]);

interface Harvested {
  /** `<root label>/<posix path within the root>`, the key `KNOWN_NOT_DETECTED` uses. */
  readonly key: string;
  readonly paths: ReadonlySet<string>;
}

async function harvest(root: { label: string; dir: string }): Promise<Harvested[]> {
  const out: Harvested[] = [];
  for (const file of await filesUnder(root.dir)) {
    const posix = toPosix(relative(root.dir, file));
    const extension = posix.slice(posix.lastIndexOf('.')).toLowerCase();
    if (NOT_TEXT.has(extension)) continue;

    const text = await readFile(file, 'utf8');
    const paths = new Set(text.match(harvestPattern()) ?? []);
    if (paths.size > 0) out.push({ key: `${root.label}/${posix}`, paths });
  }
  return out;
}

interface Detected {
  /** Raw paths the pipeline emitted, per file key. */
  readonly byFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** File keys some adapter claimed. A file missing from here was never read at all. */
  readonly claimed: ReadonlySet<string>;
}

/** What the real pipeline finds, keyed the same way. Every adapter, as `audit` runs them. */
async function detected(root: { label: string; dir: string }): Promise<Detected> {
  const discovered = await discover({ root: root.dir, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: ADAPTERS,
    readFile: (path) => readFile(path, 'utf8'),
  });

  const key = (path: string) => `${root.label}/${toPosix(relative(root.dir, path))}`;

  const byFile = new Map<string, Set<string>>();
  for (const reference of scanned.references) {
    byFile.set(
      key(reference.file),
      (byFile.get(key(reference.file)) ?? new Set()).add(reference.rawPath),
    );
  }
  return {
    byFile,
    claimed: new Set(discovered.sourceFiles.map((file) => key(file.path))),
  };
}

/**
 * Why a harvested path is not detected, and what the tests below check for each kind.
 *
 * - `no-adapter`: no adapter claims the file, so nothing in it was read. The file must be
 *   absent from `discover`'s `sourceFiles`. Not correct behaviour: a finished engine finds
 *   these, and until then an asset only they name is reported `possibly-dead`.
 * - `oracle-boundary`: detected under a longer spelling the harvest cuts short. Some
 *   detected path in the file must contain the harvested token.
 * - `ignored`: a correct engine ignores it (a comment, a code fence, prose, a remote URL, a
 *   JSON key, escaped markup). The file must be claimed and this exact path undetected;
 *   whether the path really is not a reference is judgement, which the reason records.
 */
type NotDetected =
  | { readonly why: 'ignored'; readonly because: string }
  | { readonly why: 'no-adapter'; readonly because: string }
  | { readonly why: 'oracle-boundary'; readonly because: string };

/**
 * Every image-looking path the pipeline does not detect, and why.
 *
 * Check each entry against the line it sits on, not the shape of the path, and say why a
 * correct engine behaves this way. A reason that is hard to write marks a defect rather
 * than a decision.
 */
const KNOWN_NOT_DETECTED: Readonly<Record<string, Readonly<Record<string, NotDetected>>>> = {
  // The coverage gap: three references in two Nunjucks files, a format no adapter reads.
  'eleventy/src/index.njk': {
    '/img/logo.png': {
      why: 'no-adapter',
      because: 'an `<img src>` in Nunjucks; no adapter claims .njk',
    },
    '/img/hero.jpg': {
      why: 'no-adapter',
      because:
        'built by a `| url` filter in Nunjucks; no adapter claims .njk, and the filter would make it a pattern even if one did',
    },
  },
  'eleventy/src/_includes/base.njk': {
    '/img/favicon.png': {
      why: 'no-adapter',
      because: 'a `<link rel=icon>` in a Nunjucks layout; no adapter claims .njk',
    },
  },

  // Paths inside comments are the largest group: each is what a regex takes and a parser
  // skips, which is why adapters parse.
  'plain-html/index.html': {
    'images/removed.png': { why: 'ignored', because: 'inside an HTML comment' },
  },
  // The Astro adapter's own fixture: two deliberate non-references, which say something
  // about the engine, and two paths the harvest cuts short, which say something about
  // this oracle.
  'adapter-fixtures/astro/Page.astro': {
    './commented.png': {
      why: 'ignored',
      because: 'inside a `//` comment in the frontmatter fence, which Babel discards',
    },
    './ignored.png': {
      why: 'ignored',
      because: 'inside an HTML comment in the template body, which parse5 discards',
    },
    '/assets/houston.png': {
      why: 'oracle-boundary',
      because:
        'detected as `~/assets/houston.png`; the harvest tokenizes from the `/` and cannot see the alias prefix',
    },
    '}.png': {
      why: 'oracle-boundary',
      because:
        'the tail of `` `/gallery/${gallery[0]}.png` ``, detected whole as a templated path with an `unsafe` ceiling',
    },
  },
  'adapter-fixtures/html/page.html': {
    'deleted.png': { why: 'ignored', because: 'a CSS comment inside the `<style>` element' },
    '/images/old-banner.png': { why: 'ignored', because: 'inside an HTML comment' },
    'https://cdn.example.com/tracked.png': {
      why: 'ignored',
      because: 'a remote URL: not a file in this repository',
    },
    'escaped.png': {
      why: 'ignored',
      because:
        '`&lt;img src="escaped.png"&gt;` — entity-escaped text renders as prose, not as an element',
    },
  },
  'adapter-fixtures/css/site.css': {
    'deleted.png': { why: 'ignored', because: 'inside a CSS block comment' },
    'https://cdn.example.com/banner.png': {
      why: 'ignored',
      because: 'a remote URL: not a file in this repository',
    },
  },
  'adapter-fixtures/css/theme.scss': {
    'commented-out.png': { why: 'ignored', because: 'inside a SCSS `//` line comment' },
  },
  'adapter-fixtures/css/legacy.less': {
    'commented-out.png': { why: 'ignored', because: 'inside a Less `//` line comment' },
  },
  'adapter-fixtures/javascript/Gallery.jsx': {
    './assets/retired.png': {
      why: 'ignored',
      because:
        'a commented-out `import` — the case §5.1(i) names, and the reason this decision had to become written rather than invisible',
    },
    './assets/example.png': {
      why: 'ignored',
      because: 'an example `import` inside a JSDoc block comment',
    },
    '../images/never.png': {
      why: 'ignored',
      because: 'a `url()` inside a block comment in a styled-components template',
    },
    './assets/mentioned.png': {
      why: 'ignored',
      because:
        'named in a prose string; a string that is not in a reference position is not a reference',
    },
    'https://cdn.example.com/remote.png': {
      why: 'ignored',
      because: 'a remote URL: not a file in this repository',
    },
  },
  'adapter-fixtures/json/site.webmanifest.json': {
    'https://cdn.example.com/hosted.png': {
      why: 'ignored',
      because: 'a remote URL: not a file in this repository',
    },
    './icons/a-key-that-looks-like-a-path.png': {
      why: 'ignored',
      because: 'a JSON *key*, not a value — nothing points at it, so it names no reference',
    },
  },
  'adapter-fixtures/markdown/README.md': {
    './not-a-reference.png': { why: 'ignored', because: 'inside inline code backticks' },
    './docs/example-only.png': {
      why: 'ignored',
      because: 'inside a ```markdown fence: documentation showing markup, not using it',
    },
    './docs/also-example-only.png': {
      why: 'ignored',
      because: 'raw HTML inside a ```markdown fence',
    },
    './docs/code-example.png': { why: 'ignored', because: 'an `import` inside a ```js fence' },
    './docs/old-banner.png': { why: 'ignored', because: 'inside an HTML comment' },
    './docs/old-inline.png': { why: 'ignored', because: 'raw HTML inside an HTML comment' },
    'https://cdn.example.com/remote.png': {
      why: 'ignored',
      because: 'a remote URL: not a file in this repository',
    },

    // Detected, under a spelling the harvest cannot span.
    '}}/images/logo.png': {
      why: 'oracle-boundary',
      because:
        'detected as `{{ site.baseurl }}/images/logo.png`; the harvest token breaks at the space inside the template and the adapter does not',
    },
  },
  'eleventy/src/posts/first.md': {
    '}}/img/templated.png': {
      why: 'oracle-boundary',
      because:
        'detected as `{{ site.url }}/img/templated.png`; the harvest token breaks at the space inside the template and the adapter does not',
    },
  },
};

describe('fixture references, derived rather than pasted', () => {
  it('covers every extension the engine tracks', () => {
    const oracle = new Set(ORACLE_EXTENSIONS.map((extension) => `.${extension}`));
    for (const extension of IMAGE_EXTENSIONS) {
      expect(oracle).toContain(extension);
    }
  });

  it('harvests with something that is not an adapter', () => {
    // Proof the harvest sees what a parser does not: a path inside a comment. If this
    // ever fails, the harvest has started agreeing with the thing it checks.
    const text = '// see ./assets/retired.png\nconst a = 1;';
    expect(text.match(harvestPattern())).toEqual(['./assets/retired.png']);
  });

  describe.each(ROOTS.map((root) => [root.label, root] as const))('%s', (_label, root) => {
    /** This root's entries, so each check reads the same slice. */
    function entriesFor(): [key: string, path: string, entry: NotDetected][] {
      const out: [string, string, NotDetected][] = [];
      for (const [key, excused] of Object.entries(KNOWN_NOT_DETECTED)) {
        if (!key.startsWith(`${root.label}/`)) continue;
        for (const [path, entry] of Object.entries(excused)) out.push([key, path, entry]);
      }
      return out;
    }

    it('accounts for every image-looking path in every fixture file', async () => {
      const found = await detected(root);
      const unaccounted: string[] = [];

      for (const file of await harvest(root)) {
        const seen = found.byFile.get(file.key) ?? new Set<string>();
        const excused = KNOWN_NOT_DETECTED[file.key] ?? {};
        for (const path of file.paths) {
          if (seen.has(path)) continue;
          if (Object.hasOwn(excused, path)) continue;
          unaccounted.push(`${file.key}  ->  ${path}`);
        }
      }

      // Printed in full on failure: the fix is either an adapter change or a written
      // exception, and both need to know which path in which file.
      expect(unaccounted.sort()).toEqual([]);
    });

    it('has no exception for a path the fixture no longer contains', async () => {
      const harvested = new Map((await harvest(root)).map((file) => [file.key, file.paths]));
      const stale: string[] = [];

      for (const [key, path] of entriesFor()) {
        if (!harvested.get(key)?.has(path)) stale.push(`${key}  ->  ${path}`);
      }

      expect(stale.sort()).toEqual([]);
    });

    it('has no exception for a path the pipeline now detects', async () => {
      // Stops the list only ever growing: when an adapter improves, the entry saying its
      // path is missed becomes false, and this makes somebody delete it.
      const found = await detected(root);
      const fixed: string[] = [];

      for (const [key, path, entry] of entriesFor()) {
        if (entry.why === 'oracle-boundary') continue; // detected on purpose; checked below
        if ((found.byFile.get(key) ?? new Set<string>()).has(path))
          fixed.push(`${key}  ->  ${path}`);
      }

      expect(fixed.sort()).toEqual([]);
    });

    it('only claims no-adapter for a file no adapter claimed', async () => {
      // Stops `no-adapter` being used as a catch-all. A comment inside a `.css` file is
      // `ignored`; CSS has an adapter and the comment was read and correctly skipped.
      const found = await detected(root);
      const misfiled: string[] = [];

      for (const [key, path, entry] of entriesFor()) {
        if (entry.why !== 'no-adapter') continue;
        if (found.claimed.has(key)) misfiled.push(`${key}  ->  ${path}`);
      }

      expect(misfiled.sort()).toEqual([]);
    });

    it('only claims oracle-boundary when the reference really was detected', async () => {
      // The one category that says nothing about the engine, so the one most worth making
      // impossible to claim falsely: some detected path must actually contain the token.
      const found = await detected(root);
      const unproven: string[] = [];

      for (const [key, path, entry] of entriesFor()) {
        if (entry.why !== 'oracle-boundary') continue;
        const seen = [...(found.byFile.get(key) ?? new Set<string>())];
        if (!seen.some((detectedPath) => detectedPath.includes(path))) {
          unproven.push(`${key}  ->  ${path}`);
        }
      }

      expect(unproven.sort()).toEqual([]);
    });

    it('only claims ignored for a file an adapter read', async () => {
      // The other half of the `no-adapter` check, so neither category can absorb the
      // other. What survives in `ignored` is genuine judgement about reference positions.
      const found = await detected(root);
      const misfiled: string[] = [];

      for (const [key, path, entry] of entriesFor()) {
        if (entry.why !== 'ignored') continue;
        if (!found.claimed.has(key)) misfiled.push(`${key}  ->  ${path}`);
      }

      expect(misfiled.sort()).toEqual([]);
    });

    it('gives every exception a reason', () => {
      for (const [key, path, entry] of entriesFor()) {
        expect(entry.because.trim(), `${key} -> ${path}`).not.toBe('');
      }
    });
  });

  it('holds the coverage gap as a number somebody has to change on purpose', () => {
    // `no-adapter` entries are the coverage gap, the only entries that are not correct
    // behaviour. Counting them means a `.njk` adapter cannot land without this number
    // moving, and a wider gap fails here instead of passing quietly.
    const byKind = { ignored: 0, 'no-adapter': 0, 'oracle-boundary': 0 };
    for (const excused of Object.values(KNOWN_NOT_DETECTED)) {
      for (const entry of Object.values(excused)) byKind[entry.why] += 1;
    }

    expect(byKind).toEqual({ ignored: 25, 'no-adapter': 3, 'oracle-boundary': 4 });
  });
});
