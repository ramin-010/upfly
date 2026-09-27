import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type PipelineProgress, runPipeline, servingRootsFor } from './pipeline.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A small site outside the workspace. The images are never decoded here. */
function site(): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-pipeline-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': '{ "name": "site", "private": true }\n',
    'index.html': '<img src="/logo.png"><img src="legacy/old.png">\n',
    'public/logo.png': 'logo, never decoded',
    'legacy/old.png': 'an older picture, never decoded',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('runPipeline', () => {
  it('reports each stage as it finishes, with what it counted', async () => {
    const events: PipelineProgress[] = [];
    await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
      onProgress: (event) => events.push(event),
    });

    expect(events).toEqual([
      { stage: 'discovered', images: 2, files: 2 },
      { stage: 'scanned', references: 2 },
      { stage: 'resolved', linked: 2 },
      { stage: 'audited', findings: 0 },
    ]);
  });

  it('decides the serving roots itself unless they are declared', async () => {
    const root = site();
    const decided = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    const declared = await runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(decided.servingRoots).toEqual({ dirs: ['public'], declared: false });
    expect(declared.servingRoots).toEqual({ dirs: [''], declared: true });
  });

  it('leaves out what extraIgnores names, as .upflyignore would', async () => {
    const output = await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
      extraIgnores: ['legacy/'],
    });

    expect(output.discovery.assets.map((asset) => asset.relative)).toEqual(['public/logo.png']);
    expect(output.discovery.excludedRoots.map((excluded) => excluded.relative)).toEqual(['legacy']);
  });
});

describe('a construct Upfly could not read', () => {
  it('reaches the references whatever its text holds, so the report can say why', async () => {
    const root = site();
    // Each text shows something after its last dot that is no image extension, which a
    // test of a path would take as ruling the text out.
    writeFileSync(
      join(root, 'refused.html'),
      '<div style="background: url(/logo.png) no-repeat; color red"></div>\n' +
        '<div style="margin 0.5em"></div>\n' +
        '<div style="margin 0.5em; font-family: &quot;Inter&quot;"></div>\n' +
        '<style>{% if dark %}{% endif %}.a { margin: 0.5em }</style>\n',
    );
    writeFileSync(
      join(root, 'box.ts'),
      "import styled from 'styled-components';\nexport const Box = styled.div`margin: 0.5em; }`;\n",
    );

    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    const refused = output.references
      .filter((reference) => reference.resolution === 'dynamic')
      .map((reference) => reference.rawPath);
    expect(refused).toHaveLength(5);
    expect(refused).toEqual(
      expect.arrayContaining([
        'background: url(/logo.png) no-repeat; color red',
        'margin 0.5em',
        'margin 0.5em; font-family: &quot;Inter&quot;',
        '{% if dark %}{% endif %}.a { margin: 0.5em }',
        'margin: 0.5em; }',
      ]),
    );
  });
});

describe('the encode cap', () => {
  const partialPattern = fileURLToPath(
    new URL('../../../fixtures/partial-pattern', import.meta.url),
  );

  it.each([
    [2, ['public/banner.png', 'src/inline-logo.jpg']],
    [3, ['public/banner.png', 'public/theme-sepia.png', 'src/inline-logo.jpg']],
  ])(
    'measures the %i largest images, whether a pattern names them or not',
    async (cap, largest) => {
      const output = await runPipeline({
        root: partialPattern,
        servingRoots: servingRootsFor({ dirs: ['public'], declared: true }),
        publicDirs: (servingRoots) => servingRoots.dirs,
        probeOptions: { formats: ['webp'], maxEncodedAssets: cap },
      });

      const measured = (output.probes ?? [])
        .filter((probe) => probe.encoded.length > 0)
        .map((probe) => probe.relative);
      expect(measured).toEqual(largest);
    },
  );
});
