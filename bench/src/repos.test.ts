/**
 * The guard that stands between a writing run and the pinned corpus.
 *
 * These are the only tests in this project whose failure would mean losing data rather
 * than shipping a bug, so they are written against the ways somebody would actually
 * arrive at the corpus by accident: the constant itself, a repository under it, a
 * relative path, a path walking back in through `..`, and a different capitalisation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VALIDATION_ROOT,
  refuseValidationCorpus,
  validationOutFrom,
  validationRootFrom,
} from './repos.js';

describe('where the corpus and the reports are', () => {
  const repository = resolve('/work/upfly');
  const nothing = () => false;

  it('takes the corpus from UPFLY_VALIDATION_ROOT when it is set', () => {
    const env = { UPFLY_VALIDATION_ROOT: '/data/corpus' };
    expect(validationRootFrom(env, repository, nothing)).toBe(resolve('/data/corpus'));
  });

  it('otherwise looks beside the repository, then beside its parent folder', () => {
    expect(validationRootFrom({}, repository, nothing)).toBe(resolve('/work/upfly-validation'));
    const besideParent = resolve('/upfly-validation');
    const found = (path: string) => path === besideParent;
    expect(validationRootFrom({}, repository, found)).toBe(besideParent);
  });

  it('writes the reports to UPFLY_VALIDATION_OUT, or beside the corpus', () => {
    const root = resolve('/data/corpus');
    expect(validationOutFrom({ UPFLY_VALIDATION_OUT: '/data/out' }, root)).toBe(
      resolve('/data/out'),
    );
    expect(validationOutFrom({}, root)).toBe(resolve('/data/upfly-validation-reports'));
  });

  it('names no folder of one machine in the bench source', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(here).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join(here, file), 'utf8'), file).not.toMatch(/[A-Z]:\/PERSONAL_/);
    }
  });
});

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
