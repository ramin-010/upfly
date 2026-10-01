import { describe, expect, it } from 'vitest';
import { columns, commandLine, renderSummary, shortenMiddle, wrap } from './layout.js';
import { PLAIN as plain } from './output.js';

describe('columns', () => {
  it('counts a wide character as two and a combining mark as none', () => {
    expect(columns('hero.png')).toBe(8);
    expect(columns('图片.png')).toBe(8);
    expect(columns('cafe\u0301')).toBe(4);
    expect(columns('→ …')).toBe(3);
  });
});

describe('shortenMiddle', () => {
  it('keeps the start and the file name, and leaves a path that fits alone', () => {
    expect(shortenMiddle('src/components/gallery/images/hero.png', 20)).toBe(
      'src/compon…/hero.png',
    );
    expect(columns(shortenMiddle('src/components/gallery/images/hero.png', 20))).toBe(20);
    expect(shortenMiddle('img/a.png', 20)).toBe('img/a.png');
  });

  it('counts wide characters by the columns they take', () => {
    const shortened = shortenMiddle('图片/图片/图片/图片/图片.png', 12);
    expect(columns(shortened)).toBeLessThanOrEqual(12);
    expect(shortened.endsWith('.png')).toBe(true);
  });
});

describe('wrap', () => {
  it('breaks at spaces and shortens a word wider than the line in the middle', () => {
    expect(wrap('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrap('see C:/a/very/long/path/to/a/project/folder now', 16)).toEqual([
      'see',
      'C:/a/ver…/folder',
      'now',
    ]);
  });
});

describe('commandLine', () => {
  it('quotes a word only when it needs it, and gives up on one no quoting serves everywhere', () => {
    expect(commandLine(['upfly', 'optimize', '--apply'])).toBe('upfly optimize --apply');
    expect(commandLine(['upfly', 'optimize', 'my site', '--only', '*.png'])).toBe(
      'upfly optimize "my site" --only "*.png"',
    );
    expect(commandLine(['upfly', 'optimize', 'C:\\work\\site'])).toBe(
      'upfly optimize "C:\\work\\site"',
    );
    expect(commandLine(['upfly', 'optimize', '$HOME/site'])).toBeNull();
    expect(commandLine(['upfly', 'optimize', 'site\\'])).toBeNull();
  });
});

describe('renderSummary', () => {
  it('puts labels and values in columns, counts in a column under the value, and wraps a long value', () => {
    const text = renderSummary(
      {
        command: 'optimize',
        mode: 'dry run',
        sections: [
          [
            {
              label: 'Leave',
              value: [{ bold: '12 images' }, ', 3 KB'],
              counts: [
                { count: 10, text: 'would save too little' },
                { count: 2, text: 'nothing links to it' },
              ],
            },
          ],
          [
            {
              label: 'Note',
              value: [
                'This folder is site/ in the git repository at C:/Users/someone/projects/website. --apply checks only the files under it.',
              ],
            },
          ],
        ],
        closing: 'Dry run: no project file was changed.',
      },
      plain,
    );

    expect(text).toBe(
      [
        'Upfly optimize · dry run',
        '',
        '  Leave        12 images, 3 KB',
        '                 10  would save too little',
        '                  2  nothing links to it',
        '',
        '  Note         This folder is site/ in the git repository at',
        '               C:/Users/someone/projects/website. --apply checks only the files',
        '               under it.',
        '',
        '  Dry run: no project file was changed.',
        '',
      ].join('\n'),
    );
  });
});
