import { describe, expect, it } from 'vitest';
import { helpText } from './help.js';

describe('the help text', () => {
  // Upfly reads the file types its adapters claim and names the files it could not read, so
  // a promise of every image and every reference is false for, say, a Vue or Svelte file.
  it.each([null, 'audit', 'optimize', 'undo', 'check', 'init', 'refs', 'dedupe'] as const)(
    'promises nothing about files Upfly cannot read (%s)',
    (command) => {
      const text = helpText(command);
      expect(text).not.toMatch(/every image in/);
      expect(text).not.toMatch(/every (place|reference)/);
    },
  );

  // Colour is the default and turns itself off where it cannot show, so a flag for it would
  // read as noise. `--no-color` still works for whoever knows it.
  it.each([null, 'audit', 'optimize', 'undo', 'check', 'init', 'refs', 'dedupe'] as const)(
    'does not offer --no-color (%s)',
    (command) => {
      expect(helpText(command)).not.toMatch(/no-color|NO_COLOR/);
    },
  );

  it('says the audit measures the largest images in the configured format', () => {
    // It encodes the configured format, AVIF included, and by default only the 100 largest.
    const text = helpText('audit');
    expect(text).not.toMatch(/each\s+image would be as WebP/);
    expect(text).toMatch(/the\s+largest images would be as WebP, or AVIF when the config names it/);
  });
});
