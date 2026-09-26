import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_EXTENSIONS,
  VECTOR_EXTENSIONS,
  compareStrings,
  extensionOf,
  imageFilenameCandidates,
  isImageExtension,
  isVectorExtension,
  relativePath,
  toPosix,
} from './paths.js';

const onWindows = sep === '\\';

describe('toPosix', () => {
  it.skipIf(!onWindows)('converts native separators on Windows', () => {
    expect(toPosix('src\\assets\\hero.png')).toBe('src/assets/hero.png');
  });

  it.skipIf(onWindows)(
    'leaves a backslash alone on POSIX, where it is a legal filename character',
    () => {
      // Rewriting this would corrupt a real path: `a\b.png` is one file on Linux.
      expect(toPosix('src/a\\b.png')).toBe('src/a\\b.png');
    },
  );

  it('leaves an already-POSIX path unchanged', () => {
    expect(toPosix('src/assets/hero.png')).toBe('src/assets/hero.png');
  });
});

describe('relativePath', () => {
  it('reports POSIX separators regardless of platform', () => {
    const root = onWindows ? 'C:\\project' : '/project';
    const file = onWindows ? 'C:\\project\\src\\hero.png' : '/project/src/hero.png';
    expect(relativePath(root, file)).toBe('src/hero.png');
  });

  it('handles a file directly in the root', () => {
    const root = onWindows ? 'C:\\project' : '/project';
    const file = onWindows ? 'C:\\project\\hero.png' : '/project/hero.png';
    expect(relativePath(root, file)).toBe('hero.png');
  });
});

describe('extensionOf', () => {
  it.each([
    ['hero.png', '.png'],
    ['HERO.PNG', '.png'],
    ['photo.JPEG', '.jpeg'],
    ['archive.tar.gz', '.gz'],
    ['no-extension', ''],
    ['.gitignore', ''],
    ['weird.name.WebP', '.webp'],
  ])('%s -> %s', (input, expected) => {
    expect(extensionOf(input)).toBe(expected);
  });
});

describe('isImageExtension', () => {
  it('accepts every documented image extension', () => {
    for (const extension of IMAGE_EXTENSIONS) {
      expect(isImageExtension(extension)).toBe(true);
    }
  });

  it.each(['.ts', '.html', '.css', '.md', '.json', '', '.pngx', 'png'])(
    'rejects %s',
    (extension) => {
      expect(isImageExtension(extension)).toBe(false);
    },
  );
});

describe('isVectorExtension', () => {
  it('accepts every documented vector extension', () => {
    for (const extension of VECTOR_EXTENSIONS) {
      expect(isVectorExtension(extension)).toBe(true);
    }
  });

  it.each(['.png', '.jpg', '.webp', '.avif', '.gif', '.tif', '.tiff', '.jpeg'])(
    'rejects the raster format %s',
    (extension) => {
      expect(isVectorExtension(extension)).toBe(false);
    },
  );

  /**
   * A vector not tracked as an image is never discovered as an asset, so the report's
   * handling of unused vectors would silently apply to nothing. Adding a format to
   * `VECTOR_EXTENSIONS` and forgetting `IMAGE_EXTENSIONS` fails here.
   */
  it('only names formats the engine tracks as images', () => {
    for (const extension of VECTOR_EXTENSIONS) {
      expect(isImageExtension(extension)).toBe(true);
    }
  });

  it('does not claim every image is a vector', () => {
    expect(VECTOR_EXTENSIONS.length).toBeLessThan(IMAGE_EXTENSIONS.length);
  });
});

describe('compareStrings', () => {
  it('orders by code unit', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
  });

  it('sorts uppercase before lowercase, unlike a locale comparator', () => {
    // `['a', 'B'].sort(localeCompare)` depends on the locale, so the same repository
    // would produce differently ordered reports on two machines.
    expect(['b.png', 'A.png'].sort(compareStrings)).toEqual(['A.png', 'b.png']);
  });

  it('is a total order that produces the same result on repeated sorts', () => {
    const input = ['z.png', 'a/b.png', 'A.png', 'a/a.png', 'é.png', '0.png'];
    const once = [...input].sort(compareStrings);
    const twice = [...once].sort(compareStrings);
    expect(twice).toEqual(once);
  });
});

describe('imageFilenameCandidates', () => {
  /**
   * A token that stopped at a space would find only `Practice.webp` in
   * `Firing Practice.webp`, which never equals that asset's name. The sweep would record
   * no mention, and an asset whose name appears in the text would be reported `dead`.
   */
  function tokens(text: string): string[] {
    return [...imageFilenameCandidates(text)].map(([token]) => token);
  }

  it('finds a filename containing a space', () => {
    expect(tokens('src="/ncc/Firing Practice.webp"')).toContain('Firing Practice.webp');
  });

  it('finds a filename containing two spaces', () => {
    expect(tokens('"/img/Annual Sports Day.jpg"')).toContain('Annual Sports Day.jpg');
  });

  /**
   * With spaces allowed, the prose `Remove workspace.png` would be one token and no longer
   * match an asset named `workspace.png`. So every suffix that starts after a space is
   * yielded too, and a name found without spaces is still found.
   */
  it('also yields the suffixes, so nothing that matched before stops matching', () => {
    expect(tokens('aria-label="Remove workspace.png"')).toEqual(
      expect.arrayContaining(['Remove workspace.png', 'workspace.png']),
    );
  });

  it('yields every length of a multi-word token, shortest first', () => {
    // Shortest first because the pattern finds the tail and the generator walks leftwards
    // from it. Both callers key on the token, so the order does not matter; it is
    // asserted so that changing it is a decision rather than an accident.
    expect(tokens('"Annual Sports Day.jpg"')).toEqual([
      'Day.jpg',
      'Sports Day.jpg',
      'Annual Sports Day.jpg',
    ]);
  });

  it('reports an offset that points at the token it yielded', () => {
    // The offsets feed the citation a report prints, so a suffix must not carry its
    // parent's position.
    const text = 'x = "Remove workspace.png";';
    for (const [token, offset] of imageFilenameCandidates(text)) {
      expect(text.slice(offset, offset + token.length)).toBe(token);
    }
  });

  it('still finds a filename with no space, unchanged', () => {
    expect(tokens('url(/a/hero.png)')).toEqual(['hero.png']);
  });

  it('does not run away across a whole sentence', () => {
    // At most six words are added to the left of a match: a real file name has one to
    // four in all, and this runs over every byte of every unread file.
    const all = tokens('one two three four five six seven eight nine.png');
    expect(all[0]).toBe('nine.png');
    expect(all.at(-1)).toBe('three four five six seven eight nine.png');
    expect(all).toHaveLength(7);
  });
});
