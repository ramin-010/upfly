import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { optimizeProject } from './optimize-project.js';
import type { EncodeFormat } from './probe/probe.js';

/**
 * An image the project's build loads, rather than a browser, converts only when that build is
 * one Upfly knows loads the new format by itself: a rewritten reference has to load in
 * whatever resolves it. Every tree here is a real project on disk, run through the same entry
 * point as `upfly optimize`, so the build is found the way it is found for a user.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const IMAGES = join(FIXTURES, 'plain-html/images');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A file's text, or the fixture image to copy there. */
type Entry = string | { readonly image: string };

/** A project outside the workspace holding exactly these files. */
async function tree(files: Readonly<Record<string, Entry>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-build-loaded-'));
  roots.push(root);
  for (const [path, entry] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    if (typeof entry === 'string') await writeFile(join(root, path), entry);
    else await cp(join(IMAGES, entry.image), join(root, path));
  }
  return root;
}

/** scratch-www's own rule: images load only as PNG, JPEG or GIF. */
const WEBPACK_CONFIG = `module.exports = {
  module: {
    rules: [{ test: /\\.(png|jpg|gif|eot|svg|ttf|woff)$/, loader: 'url-loader' }],
  },
};
`;

/** The four ways a build is handed an image, each naming its own image. */
const LOADED_BY_THE_BUILD: Readonly<Record<string, Entry>> = {
  'src/features.jsx': "const thumb = require('./thumb.png');\nexport default thumb;\n",
  'src/thumb.png': { image: 'logo.png' },
  'src/view.js': "import art from './art.png';\nexport default art;\n",
  'src/art.png': { image: 'texture.png' },
  'src/worker.js': "export const bg = new URL('./bg.jpg', import.meta.url);\n",
  'src/bg.jpg': { image: 'hero.jpg' },
  'src/style.css': '.paper {\n  background: url(./paper.png);\n}\n',
  'src/paper.png': { image: 'inline.png' },
};

const BUILT_IMAGES = ['src/art.png', 'src/bg.jpg', 'src/paper.png', 'src/thumb.png'];

/** The images the plan declined, each with its reason. */
function declinedOf(plan: { readonly declined: readonly { path: string; reason: string }[] }) {
  return new Map(plan.declined.map((entry) => [entry.path, entry.reason]));
}

async function planOf(root: string, format: EncodeFormat = 'webp', declared?: readonly string[]) {
  const { optimize } = await optimizeProject({
    root,
    ...(declared === undefined ? {} : { declared: { dirs: declared, declared: true } }),
    format,
    publicPolicy: 'keep-original',
    apply: false,
  });
  return optimize.plan;
}

describe('an image a webpack build loads, in a project with a served folder', () => {
  const WEBPACK_PROJECT: Readonly<Record<string, Entry>> = {
    'package.json': '{ "private": true, "scripts": { "build": "webpack --bail" } }\n',
    'webpack.config.js': WEBPACK_CONFIG,
    'static/index.html': '<img src="/img/photo.jpg" alt="A photo">\n',
    'static/img/photo.jpg': { image: 'hero@2x.jpg' },
    ...LOADED_BY_THE_BUILD,
  };

  it('keeps the format of an image a require loads, naming the build settings it found', async () => {
    const plan = await planOf(await tree(WEBPACK_PROJECT));

    expect(declinedOf(plan).get('src/thumb.png')).toBe(
      '`src/features.jsx` loads it through the build as `./thumb.png`, and that build is set up in `webpack.config.js`, which may have no rule for WebP files; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load WebP by themselves',
    );
    expect(plan.rewrites.map((rewrite) => rewrite.file)).not.toContain('src/features.jsx');
  });

  it('keeps the format of every image the build is handed: an import, a new URL and a stylesheet url()', async () => {
    const plan = await planOf(await tree(WEBPACK_PROJECT));
    const declined = declinedOf(plan);

    for (const image of BUILT_IMAGES) {
      expect(declined.get(image), image).toContain('that build is set up in `webpack.config.js`');
    }
    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'static/img/photo.jpg',
    ]);
  });

  it('still converts an image a page the site serves names, and rewrites the page', async () => {
    const plan = await planOf(await tree(WEBPACK_PROJECT));

    expect(plan.conversions.map((conversion) => conversion.asset)).toContain(
      'static/img/photo.jpg',
    );
    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['static/index.html']);
  });

  it('says AVIF when AVIF was asked for', async () => {
    const plan = await planOf(await tree(WEBPACK_PROJECT), 'avif');

    expect(declinedOf(plan).get('src/thumb.png')).toContain(
      'which may have no rule for AVIF files; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load AVIF by themselves',
    );
  });
});

describe('the same images in a Vite project', () => {
  it('converts all four and rewrites every reference', async () => {
    const plan = await planOf(
      await tree({
        'package.json': '{ "private": true, "scripts": { "build": "vite build" } }\n',
        'vite.config.js': 'export default {};\n',
        'public/favicon.png': { image: 'favicon.png' },
        ...LOADED_BY_THE_BUILD,
      }),
    );

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(BUILT_IMAGES);
    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual([
      'src/features.jsx',
      'src/style.css',
      'src/view.js',
      'src/worker.js',
    ]);
  });

  it('knows Vite from the build script alone, as a project with no vite.config does', async () => {
    const plan = await planOf(
      await tree({
        'package.json': '{ "private": true, "scripts": { "build": "tsc && vite build" } }\n',
        'public/favicon.png': { image: 'favicon.png' },
        ...LOADED_BY_THE_BUILD,
      }),
    );

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(BUILT_IMAGES);
  });
});

describe('a project where no website folder was found', () => {
  // Served and bundled images cannot be told apart by folder here, so the reference's kind
  // decides: a module import is always the build's, and an HTML src never is.
  const NO_WEBSITE_FOLDER: Readonly<Record<string, Entry>> = {
    'package.json': '{ "private": true, "scripts": { "build": "webpack" } }\n',
    'webpack.config.js': WEBPACK_CONFIG,
    'index.html': '<img src="img/photo.jpg" alt="A photo">\n',
    'img/photo.jpg': { image: 'hero@2x.jpg' },
    'src/view.js': "import art from './art.png';\nexport default art;\n",
    'src/art.png': { image: 'texture.png' },
  };

  it('keeps the format of an image a module imports', async () => {
    const plan = await planOf(await tree(NO_WEBSITE_FOLDER));

    expect(declinedOf(plan).get('src/art.png')).toContain(
      '`src/view.js` loads it through the build as `./art.png`, and that build is set up in `webpack.config.js`',
    );
  });

  it('converts an image an HTML src names, whatever the build', async () => {
    const plan = await planOf(await tree(NO_WEBSITE_FOLDER));

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['img/photo.jpg']);
    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
  });

  it('keeps the format of an image a stylesheet names in a package a bundler builds', async () => {
    const plan = await planOf(
      await tree({
        ...NO_WEBSITE_FOLDER,
        'src/style.css': '.paper {\n  background: url(./paper.png);\n}\n',
        'src/paper.png': { image: 'inline.png' },
      }),
    );

    expect(declinedOf(plan).get('src/paper.png')).toContain(
      'that build is set up in `webpack.config.js`',
    );
  });

  it('converts an image a stylesheet names on a site with no build', async () => {
    const plan = await planOf(
      await tree({
        'index.html': '<link rel="stylesheet" href="css/site.css">\n',
        'css/site.css': '.paper {\n  background: url(../img/paper.png);\n}\n',
        'img/paper.png': { image: 'inline.png' },
      }),
    );

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['img/paper.png']);
  });
});

describe('fixtures/partial-pattern, which imports an image and names no build', () => {
  it('keeps the imported image in its format, saying no build settings were found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upfly-build-loaded-'));
    roots.push(root);
    await cp(join(FIXTURES, 'partial-pattern'), root, { recursive: true });

    const plan = await planOf(root, 'webp', ['public']);

    expect(declinedOf(plan).get('src/inline-logo.jpg')).toBe(
      '`src/App.jsx` loads it through the build as `./inline-logo.jpg`, and Upfly found no build settings naming that build; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load WebP by themselves',
    );
    expect(plan.conversions.map((conversion) => conversion.asset)).toContain('public/banner.png');
  });
});
