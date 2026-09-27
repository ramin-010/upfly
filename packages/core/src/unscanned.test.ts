import { describe, expect, it } from 'vitest';
import { groupUnscanned } from './unscanned.js';

describe('groupUnscanned', () => {
  it('files design and office formats as binary, never as text an adapter could read', () => {
    const extensions = [
      '.ai',
      '.doc',
      '.docx',
      '.eps',
      '.idml',
      '.indd',
      '.ppt',
      '.pptx',
      '.swf',
      '.xls',
      '.xlsx',
    ];
    const groups = groupUnscanned(extensions.map((ext) => ({ ext, fileCount: 1 })));

    expect(groups.binary.map((entry) => entry.ext).sort()).toEqual(extensions);
    expect(groups.adapterCould).toEqual([]);
  });

  it('still counts a text format as one an adapter could read', () => {
    const groups = groupUnscanned([{ ext: '.njk', fileCount: 2 }]);

    expect(groups.adapterCould.map((entry) => entry.ext)).toEqual(['.njk']);
    expect(groups.binary).toEqual([]);
  });
});
