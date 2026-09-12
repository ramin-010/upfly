/**
 * The guard that stands between a writing run and the pinned corpus.
 *
 * These are the only tests in this project whose failure would mean losing data rather
 * than shipping a bug, so they are written against the ways somebody would actually
 * arrive at the corpus by accident: the constant itself, a repository under it, a
 * relative path, a path walking back in through `..`, and a different capitalisation.
 */

import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALIDATION_ROOT, refuseValidationCorpus } from './repos.js';

describe('refuseValidationCorpus', () => {
  it('refuses the corpus root itself', () => {
    expect(() => refuseValidationCorpus(VALIDATION_ROOT)).toThrow(/pinned validation corpus/);
  });

  it('refuses a repository inside it', () => {
    expect(() => refuseValidationCorpus(join(VALIDATION_ROOT, 'shadcn-ui'))).toThrow(
      /pinned validation corpus/,
    );
  });

  it('refuses a path deep inside it', () => {
    expect(() =>
      refuseValidationCorpus(join(VALIDATION_ROOT, 'shadcn-ui', 'apps', 'v4', 'public')),
    ).toThrow(/pinned validation corpus/);
  });

  it('refuses a path that walks back in through ..', () => {
    // Compared as resolved absolute paths rather than as the strings given, which is
    // the whole reason a prefix test is safe here.
    const sideways = join(VALIDATION_ROOT, '..', 'upfly-validation', 'astro-docs');

    expect(() => refuseValidationCorpus(sideways)).toThrow(/pinned validation corpus/);
  });

  it('refuses a different capitalisation of the same directory', () => {
    // On Windows this is the same directory. A guard a different shift key walks past
    // is not a guard.
    expect(() => refuseValidationCorpus(VALIDATION_ROOT.toUpperCase())).toThrow(
      /pinned validation corpus/,
    );
    expect(() => refuseValidationCorpus(VALIDATION_ROOT.toLowerCase())).toThrow(
      /pinned validation corpus/,
    );
  });

  it('names the path it refused, so the message is actionable', () => {
    const target = join(VALIDATION_ROOT, 'eleventy-docs');

    expect(() => refuseValidationCorpus(target)).toThrow(resolve(target));
  });

  it('allows a sibling directory whose name merely starts the same way', () => {
    // `upfly-validation-copy` is not inside `upfly-validation`, and a prefix test
    // without the separator would have said it was.
    expect(() => refuseValidationCorpus(`${VALIDATION_ROOT}-copy`)).not.toThrow();
  });

  it('allows an ordinary scratch directory', () => {
    expect(() =>
      refuseValidationCorpus(resolve(VALIDATION_ROOT, '..', 'upfly-corpus-runs')),
    ).not.toThrow();
  });

  it('allows a path that contains the corpus name lower down', () => {
    expect(() =>
      refuseValidationCorpus(join('E:', sep, 'scratch', 'upfly-validation')),
    ).not.toThrow();
  });
});
