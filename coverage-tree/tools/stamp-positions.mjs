/**
 * Fills the derived half of the answer key: byte offset, line and column for every
 * reference, byte size and hash for every asset. It never invents a reference or touches
 * an `expect`; it does the arithmetic a person cannot do reliably by hand.
 *
 * It can turn a red self-check green without anyone re-reading what changed in the tree,
 * so it prints every change it makes, and writes nothing if a `raw` cannot be found. Read
 * the diff: a `raw` that moved by more than whitespace needs a person to check its entry.
 * It imports only `node:` modules.
 *
 * Usage: node tools/stamp-positions.mjs [--root DIR] [--key PATH] [--check]
 * `--check` writes nothing and exits non-zero if anything would change.
 */

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Byte offset of the nth (1-based) literal occurrence of `raw` in `buf`. */
export function nthOccurrence(buf, raw, n) {
  const needle = Buffer.from(raw, 'utf8');
  let from = 0;
  for (let i = 0; i < n; i += 1) {
    const at = buf.indexOf(needle, from);
    if (at === -1) return { offset: -1, found: i };
    if (i === n - 1) return { offset: at, found: n };
    from = at + 1;
  }
  return { offset: -1, found: 0 };
}

/** 1-based line, and 1-based column counted in bytes. */
export function positionOf(buf, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (buf[i] === 0x0a) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Fill in each asset's byte size and hash, recording every change and every miss. */
function stampAssets(key, root, changes, errors) {
  for (const asset of key.assets ?? []) {
    const full = join(root, asset.path);
    let bytes;
    let sha;
    try {
      const buf = readFileSync(full);
      bytes = buf.length;
      sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    } catch {
      errors.push(`asset missing on disk: ${asset.path}`);
      continue;
    }
    if (asset.bytes !== bytes) {
      changes.push(`asset ${asset.path}: bytes ${asset.bytes ?? '-'} -> ${bytes}`);
      asset.bytes = bytes;
    }
    if (asset.sha256 !== sha) {
      changes.push(`asset ${asset.path}: sha256 ${asset.sha256 ?? '-'} -> ${sha}`);
      asset.sha256 = sha;
    }
  }
}

/** Fill in each reference's byte offset, line and column. Never invents an entry. */
function stampReferences(key, root, changes, errors) {
  for (const group of key.files ?? []) {
    let buf;
    try {
      buf = readFileSync(join(root, group.path));
    } catch {
      errors.push(`file missing on disk: ${group.path}`);
      continue;
    }
    for (const entry of group.entries ?? []) {
      const n = entry.occurrence ?? 1;
      const { offset, found } = nthOccurrence(buf, entry.raw, n);
      if (offset === -1) {
        errors.push(
          `${group.path}: raw ${JSON.stringify(entry.raw)} occurrence ${n} not found ` +
            `(only ${found} occurrence(s) present)`,
        );
        continue;
      }
      const { line, column } = positionOf(buf, offset);
      for (const [field, value] of [
        ['offset', offset],
        ['line', line],
        ['column', column],
      ]) {
        if (entry[field] !== value) {
          changes.push(
            `${group.path} ${JSON.stringify(entry.raw)}#${n}: ${field} ${entry[field] ?? '-'} -> ${value}`,
          );
          entry[field] = value;
        }
      }
    }
  }
}

function main() {
  const here = resolve(process.argv[1], '..', '..');
  const root = resolve(arg('--root', join(here, 'tree')));
  const keyPath = resolve(arg('--key', join(here, 'key', 'coverage-key.json')));
  const dryRun = process.argv.includes('--check');

  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const changes = [];
  const errors = [];

  stampAssets(key, root, changes, errors);
  stampReferences(key, root, changes, errors);

  for (const line of changes) process.stdout.write(`  ~ ${line}\n`);
  for (const line of errors) process.stdout.write(`  ! ${line}\n`);

  if (errors.length > 0) {
    process.stdout.write(`\n${errors.length} error(s); nothing written.\n`);
    process.exitCode = 1;
    return;
  }
  if (changes.length === 0) {
    process.stdout.write('positions already current; nothing to write.\n');
    return;
  }
  if (dryRun) {
    process.stdout.write(`\n${changes.length} change(s) pending. --check, so nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  // Encode to bytes, write a temp file, then rename. Writing in place truncates before
  // the write can fail, and would leave the key destroyed by an error halfway through.
  const out = `${JSON.stringify(key, null, 2)}\n`;
  const tmp = `${keyPath}.tmp`;
  writeFileSync(tmp, Buffer.from(out, 'utf8'));
  renameSync(tmp, keyPath);
  process.stdout.write(`\n${changes.length} change(s) written to ${keyPath}\n`);
  process.stdout.write(
    '🔴 Read the diff. A raw that moved by more than whitespace needed a person.\n',
  );
}

main();
