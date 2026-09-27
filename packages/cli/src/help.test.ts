import { describe, expect, it } from 'vitest';
import { helpText } from './help.js';

describe('the help text', () => {
  // Upfly reads the file types its adapters claim and names the files it could not read, so
  // a promise of every image and every reference is false for, say, a Vue or Svelte file.
  it.each([null, 'audit', 'optimize', 'undo'] as const)(
    'promises nothing about files Upfly cannot read (%s)',
    (command) => {
      const text = helpText(command);
      expect(text).not.toMatch(/every image in/);
      expect(text).not.toMatch(/every (place|reference)/);
    },
  );
});
