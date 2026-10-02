import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OTHER, countGroups, declineGroup, stayGroup, unmeasuredGroup } from './reasons.js';

/** The plan `optimize --json` printed for the plain HTML fixture, as the engine wrote it. */
const planned = JSON.parse(
  readFileSync(new URL('../test/golden/optimize-plain-html.jsonl', import.meta.url), 'utf8')
    .trimEnd()
    .split('\n')
    .at(-1) ?? '{}',
) as { plan: { declined: { path: string; reason: string }[] } };

describe('declineGroup', () => {
  it('names a group for every reason the planner gave on a real run', () => {
    const groups = planned.plan.declined.map((entry) => [entry.path, declineGroup(entry.reason)]);
    expect(groups).toEqual([
      ['images/badge.png', 'would save too little'],
      ['images/badge@2x.png', 'would save too little'],
      ['images/favicon.png', 'its references stay as written'],
      ['images/never-referenced.png', 'nothing links to it'],
      ['images/removed.png', 'nothing links to it'],
      ['images/team.jpg', 'would save too little'],
    ]);
  });

  it('groups both kinds of saving too small, as the engine words them', () => {
    const under = [
      'converting it would save 34 B, under the 1 KB a saving must reach to be reported or converted',
      'converting it would save 1.5 KB, 2% of the file, under the 10% of the file or 4 KB a saving must reach to be reported or converted',
    ];
    for (const reason of under) expect(declineGroup(reason)).toBe('would save too little');
  });

  it('groups the reasons that keep an original or a name, as the planner writes them', () => {
    const cases: [string, string][] = [
      [
        'measured as webp and came out no smaller, so converting it would cost bytes rather than save them',
        'no smaller when converted',
      ],
      [
        'nothing Upfly can see links to it, so a new file would be used by nobody. Upfly converts an image only when a reference moves to the new file',
        'nothing links to it',
      ],
      [
        'img/a.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
        'its new name is taken by another file',
      ],
      [
        'converting it would delete the original, and notes.txt:3 (and 1 more) still names its path in a form Upfly cannot rewrite',
        'named where Upfly cannot rewrite it',
      ],
      [
        'converting it would delete the original, and legacy/old.html:1 still names its path, in a file this run excluded',
        'named in a file this run leaves out',
      ],
      [
        'converting it would delete the original, and vendor/big.js could not be read to rule out a mention of it',
        'a file that may name it could not be read',
      ],
      [
        '`src/App.jsx` reaches it only through `./img/${name}.png`, a template assembled at run time. No reference would move to a new file, so it would be used by nobody. Upfly converts an image only when a reference moves to the new file',
        'its references stay as written',
      ],
    ];
    for (const [reason, group] of cases) expect(declineGroup(reason), reason).toBe(group);
  });

  it('counts a sentence it does not know under another reason, rather than dropping it', () => {
    expect(declineGroup('a reason added after this list was written')).toBe(OTHER);
  });
});

describe('unmeasuredGroup', () => {
  it('names the format an image already has, and every way a measurement can fail', () => {
    expect(unmeasuredGroup('vector', 'webp')).toBe('SVG, which Upfly does not convert');
    expect(unmeasuredGroup('already-target-format', 'avif')).toBe('already AVIF');
    expect(unmeasuredGroup('encode-failed', 'webp')).toBe('could not be measured');
    expect(unmeasuredGroup(null, 'webp')).toBe(OTHER);
  });
});

describe('stayGroup', () => {
  it('groups why a reference to a copy stays as written', () => {
    expect(
      stayGroup(
        'an import names a file for the bundler, and public/a.png is in a folder the site serves as it is, which bundlers such as Vite do not import from',
      ),
    ).toBe('an import cannot reach a folder the site serves');
    expect(stayGroup('the reference has no static path to replace')).toBe(
      'it cannot be rewritten safely',
    );
  });
});

describe('countGroups', () => {
  it('counts each group once, the largest first, ties by name', () => {
    expect(countGroups(['b', 'a', 'b', 'c', 'a', 'b'])).toEqual([
      { count: 3, text: 'b' },
      { count: 2, text: 'a' },
      { count: 1, text: 'c' },
    ]);
  });
});
