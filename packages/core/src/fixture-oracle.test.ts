/**
 * §5.1(i) — fixture assertions derived independently, not pasted from output.
 *
 * Every other fixture assertion in this repo lists expected references as a **literal
 * array**, and those arrays were produced by running the adapter and pasting the
 * result. That makes them a snapshot of current behaviour wearing the costume of a
 * specification: the fixture *files* were written first, with intent, and the
 * *assertions* second, from output. Where the two disagree, the assertion wins
 * silently. Five tests this phase blessed a defect instead of catching it, the clearest
 * being `Gallery.jsx:35` — `` const dynamic = `/generated/${slug}.png` ``, put there
 * deliberately to exercise templated paths, asserted as 14 references for a file with
 * 15. The adapter never saw it, so the pasted array never contained it, so the test
 * passed for two weeks.
 *
 * **This is §5.1(h)'s argument one step over.** A test suite that cannot see the
 * filesystem cannot vouch for the filesystem; build the gate at the layer that can.
 * Here: an assertion whose expected value came from the code cannot vouch for the code.
 *
 * So this file never reads an expected array. It harvests image-looking paths from the
 * raw bytes of each fixture with a scanner that is **not an adapter**, runs the real
 * pipeline over the same files, and requires every difference to be **written down with
 * a reason**.
 *
 * ⚠️ **`KNOWN_NOT_DETECTED` is the valuable half, not an escape hatch**, and it is
 * pinned from three sides so it cannot rot into one:
 *
 * 1. A harvested path that is neither detected nor listed **fails** — that is the
 *    Gallery.jsx class, and the reason this file exists.
 * 2. A listed path that is **no longer harvested** fails. A fixture edit that removes
 *    the text must remove the entry, or the list starts describing a file that has
 *    moved on.
 * 3. A listed path that the pipeline **now detects** fails. When an adapter improves,
 *    the entry claiming it is missed becomes a lie, and somebody has to delete it
 *    deliberately rather than leave a stale excuse behind.
 *
 * Without (2) and (3) the list would only ever grow, and "we know about that one"
 * would become indistinguishable from "we stopped looking".
 *
 * ⚠️ **This does NOT cover "a report branch no fixture reaches"** — the discarded line,
 * the encode-cap message, the counted-unsafe branch, the skipped-section renderer, the
 * size findings, and R22's own demotion. Those are about output paths, not references,
 * and this file is structurally blind to them. Their trigger is different and is stated
 * in §4/§6: when every fixture has the same value for the thing under test, the
 * fixtures cannot test it. They need hand-built cases, and have them elsewhere.
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
 * four `*.fixtures.test.ts` files. Between them they hold all 27 of the literal
 * assertion arrays this file exists to stop trusting.
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
 * ⚠️ **Deliberately a separate copy of the policy, and this is the R17 lesson applied
 * to an oracle.** Importing `IMAGE_EXTENSIONS` would make the harvest and the engine go
 * blind in the same instant: drop `.avif` from the engine's list and the adapters stop
 * detecting `.avif` *and* the oracle stops looking for it, so the suite stays green
 * while coverage disappears. A frozen copy keeps harvesting what the engine forgot, and
 * the mismatch then fails as an unaccounted path.
 *
 * The cost of a copy is drift in the other direction — a format added to the engine and
 * not here — and that is what `covers every extension the engine tracks` below is for.
 * So the duplication is load-bearing and the divergence is checked; neither half is
 * left to memory.
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
 * **Not an adapter, by construction**: no parser, no knowledge of `<img>` or `url()` or
 * an import specifier, and no idea what a comment is. That last part is the point — it
 * finds what a regex would find, which is a superset of what a correct adapter should,
 * and the difference is exactly the set this file makes somebody write down.
 *
 * The character class carries `/` so a whole path is captured rather than its last
 * segment, and `$`/`{`/`}`/`#`/`@`/`:` so a template hole or a URL scheme survives
 * intact — `/generated/${slug}.png` and `#{$image-dir}/hero.png` are each one token,
 * matching the `rawPath` an adapter emits for them. It stops at whitespace, quotes and
 * brackets, so `srcset="/a.jpg 1x, /b.jpg 2x"` yields two tokens the way the adapter
 * splits them.
 *
 * ⚠️ **`#` and `:` were added after reading the first run's exception list, and the
 * reason is worth keeping.** Without them the harvest produced `{$image-dir}/hero.png`
 * and `//cdn.example.com/banner.png`, and both would have needed an exception saying
 * *"the oracle clipped a character"* — an entry documenting this regex rather than the
 * engine. Six of the first 33 were that. **An exception list diluted by the oracle's own
 * artefacts is how the valuable half turns back into an escape hatch**, so the fix is to
 * make the harvest's token boundaries agree with the adapters' wherever a boundary is
 * not itself the thing in question. What remains is decisions.
 *
 * One boundary cannot be fixed this way and is excused honestly instead:
 * `{{ site.url }}/img/templated.png` contains spaces, so no whitespace-terminated token
 * can span it. Those entries say the reference *is* detected, under a longer spelling.
 *
 * A fresh `RegExp` per call: a `g`-flagged literal carries `lastIndex` between uses.
 */
function harvestPattern(): RegExp {
  return new RegExp(`[\\w@.\\-/\${}#:]*\\.(?:${ORACLE_EXTENSIONS.join('|')})\\b`, 'gi');
}

/** Every file under a directory, recursively. Ignores nothing — that is the engine's job. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) found.push(...(await filesUnder(full)));
    else found.push(full);
  }
  return found;
}

/**
 * Extensions whose bytes are not text, so there is nothing in them to harvest.
 *
 * A frozen list rather than a check for valid UTF-8: a `.png` that happens to decode
 * without throwing would otherwise be scanned, and its compressed bytes can contain
 * anything at all — including a byte sequence that reads as `hero.png`. One spurious
 * hit from a raster's pixel data would have to be excused in the exception list, which
 * is precisely the noise that turns a written decision into an ignored one.
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
  /** `<root label>/<posix path within the root>` — the key `KNOWN_NOT_DETECTED` uses. */
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
 * Why a harvested path is not detected — and each kind is **checked, not just asserted**.
 *
 * ⚠️ **The categories exist so the exception list cannot be mis-filed to dodge
 * scrutiny.** A free-text reason is only as good as the care of whoever wrote it, and the
 * one thing this file must not become is a place where "we know about that one" and "we
 * stopped looking" are indistinguishable. So two of the three kinds carry a mechanical
 * cross-check, and the third is pinned by the absence of the other two:
 *
 * - `no-adapter` — the file's type has no adapter, so nothing in it was ever read.
 *   **Checked:** the file must be absent from `discover`'s `sourceFiles`. Marking a
 *   comment in a `.css` file as `no-adapter` fails, because CSS is claimed.
 *   ⚠️ These are **not** "correct to miss" — they are references a finished engine will
 *   find, and today R8's sweep hedges whatever they mention rather than reporting it
 *   dead. They are the coverage gap, counted.
 * - `oracle-boundary` — the reference **is** detected, under a longer spelling the
 *   harvest's whitespace-terminated token cannot reach (`{{ site.url }}/img/x.png`).
 *   **Checked:** some detected path for that file must contain the harvested token. This
 *   is the one kind that says nothing about the engine, so it is the one most worth
 *   making impossible to claim falsely.
 * - `ignored` — a correct engine ignores this: a comment, a code fence, prose, a remote
 *   URL, a JSON key, escaped markup. **Checked** from both sides: the file *is* claimed
 *   by an adapter, and no detected path contains the token. So this category cannot
 *   absorb either of the other two, and what is left in it is genuine judgement.
 */
type NotDetected =
  | { readonly why: 'ignored'; readonly because: string }
  | { readonly why: 'no-adapter'; readonly because: string }
  | { readonly why: 'oracle-boundary'; readonly because: string };

/**
 * Every image-looking path the pipeline does **not** detect, and why.
 *
 * ⚠️ **Read this as the specification it is.** Each entry was checked against the line it
 * sits on — not inferred from the shape of the path — and the reason states why a
 * *correct* engine behaves this way. If a reason is hard to write, that is the signal the
 * behaviour is a defect rather than a decision, which is how this list is meant to be
 * used. 32 entries: 25 `ignored`, 3 `no-adapter`, 4 `oracle-boundary` — the `.astro`
 * gap having closed in B1 and the adapter fixture having added four of its own.
 */
const KNOWN_NOT_DETECTED: Readonly<Record<string, Readonly<Record<string, NotDetected>>>> = {
  // ── The coverage gap, in full. Three references, one file, one file type. ──────────
  //
  // ⚠️ **This block used to be seven references across two file types, and the four
  // `.astro` ones are gone because B1's adapter reads them.** They were deleted because
  // the `no longer detected` check above insisted: it fails on an exception for a path
  // the pipeline now finds, which is exactly the mechanism that stops a stale excuse
  // outliving the gap it described. `.njk` is what remains.
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

  // ── Commented out. The single largest category, and the whole reason "never regex
  // JavaScript" is a rule: every one of these is what a regex would have taken. ───────
  'plain-html/index.html': {
    'images/removed.png': { why: 'ignored', because: 'inside an HTML comment' },
  },
  // ── The Astro adapter's own fixture, added in B1. ─────────────────────────────────
  //
  // Two deliberate non-references and two artefacts of the harvest's tokenizer, which
  // is the split the categories exist to keep visible: the first pair says something
  // about the engine, the second pair says something about this oracle.
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

    // ── Detected, under a spelling the harvest cannot span. ───────────────────────────
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

describe('§5.1(i) fixture references, derived rather than pasted', () => {
  it('covers every extension the engine tracks', () => {
    // The other direction of the deliberate copy above. A format added to
    // `IMAGE_EXTENSIONS` and not here would leave the oracle silently narrower than the
    // engine, which is the failure a frozen copy trades for.
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
      // The check that stops the list only ever growing. When an adapter improves, the
      // entry claiming its path is missed becomes a lie, and deleting it has to be a
      // deliberate act rather than something nobody notices.
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
    // ⚠️ Not decoration. `no-adapter` entries are the only ones that are **not** correct
    // behaviour — they are references a finished engine will find, and today R8's sweep
    // hedges whatever they mention instead of reporting it dead. Counting them means an
    // `.astro` or `.njk` adapter cannot land without this number moving, and an
    // accidental *widening* of the gap fails here rather than passing quietly.
    const byKind = { ignored: 0, 'no-adapter': 0, 'oracle-boundary': 0 };
    for (const excused of Object.values(KNOWN_NOT_DETECTED)) {
      for (const entry of Object.values(excused)) byKind[entry.why] += 1;
    }

    // ⚠️ `no-adapter` fell 7 -> 3 when the Astro adapter landed. That is the number
    // moving on purpose, which is what this assertion exists to force.
    expect(byKind).toEqual({ ignored: 25, 'no-adapter': 3, 'oracle-boundary': 4 });
  });
});
