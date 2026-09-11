/**
 * §5.1(d), the half a machine should do.
 *
 * The protocol says a person opens every `broken` finding and greps every dead
 * asset before believing it. The first worksheets this produced held **601
 * checkboxes with the grep command already written out** — and if the command is
 * written, the machine should run it. That is data entry, not review, and a person
 * doing it 601 times starts rubber-stamping around item forty, which is worse than
 * not checking at all.
 *
 * ⚠️ **The oracle here is deliberately NOT the engine.** No `resolve.ts`, no
 * `sweep.ts`, no adapters — a directory index built by its own walker and a grep
 * built from its own regex. An engine checking its own findings with its own logic
 * agrees with itself, which is the same rule `fixture-integrity.test.ts` follows and
 * for the same reason.
 *
 * It differs from the engine's own machinery on purpose, in three ways that are the
 * whole point:
 *
 * - it walks the directories `discover` prunes and whatever `.upflyignore` excluded,
 *   because an asset referenced from a pruned directory is still referenced — but **not**
 *   vendored dependencies or generated build output, which are derived rather than
 *   authored. See `ORACLE_SKIPS` for the measurement behind that;
 * - it matches an asset's **stem under a different extension** as well as its exact
 *   filename, which catches the case Phase 2 will create;
 * - it decides a path exists by looking it up in the **directory index**, not with
 *   `existsSync`, because `existsSync` is case-insensitive on Windows and would
 *   report a genuine cross-platform defect as a false finding.
 *
 * Every item comes back *confirmed-genuine*, *confirmed-false* or *ambiguous* with
 * the evidence attached. Only the ambiguous ones are a person's problem.
 */

import { appendFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { IMAGE_EXTENSIONS, type Report } from 'upfly-core';

export type Verdict = 'confirmed-genuine' | 'confirmed-false' | 'ambiguous';

export interface ItemVerdict {
  readonly kind: 'broken' | 'dead' | 'possibly-dead';
  /** What was checked, as the report names it. */
  readonly subject: string;
  readonly verdict: Verdict;
  /** What the oracle actually saw. A verdict without this is an opinion. */
  readonly evidence: readonly string[];
  /**
   * Items sharing this are the **same decision**, and the worksheet renders them
   * once. Twenty scaffolding fixtures all missing `/next.svg` is one judgement
   * call, and asking for it twenty times is how a worksheet goes back to being
   * 601 checkboxes nobody reads.
   */
  readonly group?: string;
}

export interface VerifyResult {
  readonly items: readonly ItemVerdict[];
  /** Files the oracle could not read, so its own coverage is not silent (rule 9). */
  readonly unreadable: readonly string[];
  readonly filesIndexed: number;
  readonly filesGrepped: number;
}

/** One mention of an asset filename found by the oracle's own grep. */
interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** True when the token matched the stem under a different extension. */
  readonly extensionSwapped: boolean;
}

/**
 * Everything the oracle knows about the repository, built once.
 *
 * `files` is every path as the filesystem actually spells it, so a lookup is
 * case-exact on every platform.
 */
interface RepoIndex {
  readonly files: ReadonlySet<string>;
  readonly hitsByToken: ReadonlyMap<string, readonly Hit[]>;
  readonly hitsByStem: ReadonlyMap<string, readonly Hit[]>;
  /**
   * Lowercased text of every grepped file, for the literal fallback below.
   *
   * Held in memory on purpose: it is the only way to answer "does this exact name appear"
   * for a basename the tokeniser cannot represent, and a bench tool can afford it.
   */
  readonly lowerTexts: ReadonlyMap<string, string>;
  readonly unreadable: readonly string[];
  readonly filesIndexed: number;
  readonly filesGrepped: number;
}

const MAX_GREP_BYTES = 8 * 1024 * 1024;

export async function verifyFindings(
  root: string,
  report: Report,
  publicDirs: readonly string[],
): Promise<VerifyResult> {
  const index = await buildIndex(root);
  const items: ItemVerdict[] = [];

  for (const finding of report.findings) {
    if (finding.kind === 'broken') {
      items.push(verifyBroken(finding.file, finding.rawPath, index, publicDirs));
    } else if (finding.kind === 'dead') {
      items.push(verifyDead(finding.asset, index));
    } else if (finding.kind === 'possibly-dead') {
      items.push(verifyHedge(finding.asset, finding.evidence, index));
    }
  }

  // R22's demoted vectors, verified exactly as if they had stayed itemised.
  //
  // ⚠️ **Not optional, and the reason is a near miss.** These are no longer in
  // `report.findings`, so the first version of R22 dropped 145 assets out of this pass
  // without anything saying so -- astro-docs' verdict count fell from 150 to 24 while the
  // write-up was about to quote "0 confirmed-false" over the smaller number. A finding the
  // report declines to itemise is still a claim about somebody's repository, and the
  // independent oracle is the only thing that checks it. `assets` is `null` unless the run
  // asked for them, which is why `validate.ts` passes `includeUnusedVectors`.
  for (const vector of report.unusedVectors.assets ?? []) {
    items.push(
      vector.kind === 'dead'
        ? verifyDead(vector.asset, index)
        : verifyHedge(vector.asset, vector.evidence, index),
    );
  }

  return {
    items,
    unreadable: index.unreadable,
    filesIndexed: index.filesIndexed,
    filesGrepped: index.filesGrepped,
  };
}

/**
 * §5.1(d): every `broken` finding, opened.
 *
 * **One false `broken` fails the gate**, so this resolves the path the way a bundler
 * would — file-relative, then every serving root that is an ancestor of the
 * referencing file, then the project root — and answers from the directory index.
 */
function verifyBroken(
  file: string,
  rawPath: string,
  index: RepoIndex,
  publicDirs: readonly string[],
): ItemVerdict {
  const subject = `${file} → ${rawPath}`;
  const path = rawPath.split('?')[0]?.split('#')[0] ?? rawPath;
  const candidates = candidatePaths(file, path, publicDirs);

  const found = candidates.filter((candidate) => index.files.has(candidate));
  if (found.length > 0) {
    return {
      kind: 'broken',
      subject,
      verdict: 'confirmed-false',
      evidence: [`the path resolves to a file that exists: ${found.join(', ')}`],
    };
  }

  // A file of that name somewhere else in the tree is not a resolution, but it is
  // the shape of "somebody moved it" and a person should see it rather than have
  // the machine rule on it.
  const name = posix.basename(path).toLowerCase();
  const elsewhere = [...index.files].filter(
    (entry) => posix.basename(entry).toLowerCase() === name,
  );

  if (elsewhere.length > 0) {
    return {
      kind: 'broken',
      subject,
      verdict: 'ambiguous',
      group: path,
      evidence: [
        `nothing serves ${path} to this file: none of ${candidates.length} candidate paths exist.`,
        `The name does exist at ${elsewhere.slice(0, 4).join(', ')}${elsewhere.length > 4 ? ` (+${elsewhere.length - 4} more)` : ''},`,
        'but none of those directories serve this file, so they are not resolutions.',
        'The engine is right that nothing serves it here. What a person has to decide is',
        'whether a reference to a file the app never ships is a finding worth reporting.',
      ],
    };
  }

  return {
    kind: 'broken',
    subject,
    verdict: 'confirmed-genuine',
    evidence: [
      `none of ${candidates.length} candidate paths exist: ${candidates.slice(0, 4).join(', ')}`,
      `and no file named ${posix.basename(path)} exists anywhere in the repository`,
    ],
  };
}

/**
 * Every place a bundler could actually serve this path from.
 *
 * ⚠️ **Proximity filters; it does not merely order.** The first version of this
 * function tried every configured serving root and reported 19 of shadcn-ui's 20
 * `broken` findings as false, on evidence like *"`/next.svg` resolves to
 * `apps/v4/public/next.svg`"* — for a file under
 * `packages/shadcn/test/fixtures/frameworks/next-app/`, which `apps/v4` does not
 * serve. That is precisely the cross-app false link R13's correction was issued to
 * remove, reimplemented here and then used to "disprove" the engine that had already
 * fixed it.
 *
 * The lesson is worth more than the fix: an independent oracle has to be independent
 * in **implementation**, not in **correctness**. Modelling how static serving works
 * is not copying the engine — it is the ground truth both are trying to match.
 *
 * A serving root `apps/v4/public` serves the app rooted at `apps/v4`, so it applies
 * only to files underneath it. Ancestor `public/` directories are tried the same way,
 * which is what auto-detection would find.
 */
function candidatePaths(
  file: string,
  path: string,
  publicDirs: readonly string[],
): readonly string[] {
  const candidates: string[] = [];

  if (path.startsWith('/')) {
    const bare = path.slice(1);

    for (const dir of publicDirs) {
      const appRoot = dir === '' ? '.' : posix.dirname(dir);
      if (appRoot === '.' || file.startsWith(`${appRoot}/`)) {
        candidates.push(dir === '' ? bare : posix.join(dir, bare));
      }
    }

    let directory = posix.dirname(file);
    while (directory !== '.' && directory !== '/') {
      candidates.push(posix.join(directory, 'public', bare));
      directory = posix.dirname(directory);
    }

    // The project root, for a plain static site that serves from the top.
    candidates.push(posix.join('public', bare));
    candidates.push(bare);
  } else {
    candidates.push(posix.normalize(posix.join(posix.dirname(file), path)));
    // A `./`-spelled path meant relative to the project root — R15's case.
    candidates.push(posix.normalize(path));
  }

  return [...new Set(candidates)].filter((candidate) => !candidate.startsWith('..'));
}

/** Characters the oracle's tokeniser can represent: its class, plus the space it spans. */
const TOKENISABLE = /^[\w@.\- ]+$/;

/**
 * The fallback for a basename the tokeniser cannot represent at all.
 *
 * ⚠️ **A different search strategy on purpose, not a wider regex.** `WhatsApp Image
 * 2026-03-11 at 1.29.35 PM (1).webp` contains parentheses, which are not in the oracle's
 * character class — so no token is produced, the lookup finds nothing, and `verifyDead`
 * concludes *confirmed-genuine* having checked nothing. That verdict is not evidence, and
 * it is the shape that made §5.1(j) read 0.0% when **4 of those assets were referenced**.
 *
 * Widening the class was the wrong fix twice over: parentheses are delimiters in unquoted
 * CSS `url(…)` and bare Markdown `![](…)`, and every widening so far has cost more than it
 * bought. A literal case-insensitive substring search **cannot have a tokenisation hole**,
 * because it does no tokenising. It runs only for names the index provably cannot hold —
 * measured at 10 of 553 on `RBU-Website` — so its cost is bounded by that count rather
 * than by the corpus.
 *
 * ⚠️ **This is also the answer to "how would we know".** The index will always have some
 * character it cannot represent; what matters is that a name it cannot represent takes a
 * different road rather than falling through to a confident verdict.
 *
 * Returns `null` when the name *is* tokenisable, so the ordinary path runs unchanged.
 */
function literalHits(asset: string, index: RepoIndex): ItemVerdict | null {
  const name = posix.basename(asset);
  if (TOKENISABLE.test(name)) return null;

  const needle = name.toLowerCase();
  const found: string[] = [];
  for (const [file, text] of index.lowerTexts) {
    if (file === asset) continue;
    const at = text.indexOf(needle);
    if (at === -1) continue;
    const line = text.slice(0, at).split('\n').length;
    found.push(`  ${file}:${line}`);
    if (found.length >= 5) break;
  }

  if (found.length === 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'confirmed-genuine',
      evidence: [
        'the filename contains a character the token index cannot represent, so it was',
        'searched for literally across every grepped file, and appears in none of them.',
      ],
    };
  }

  return {
    kind: 'dead',
    subject: asset,
    verdict: 'confirmed-false',
    evidence: [
      `the exact filename appears in ${found.length} place(s), found by literal search`,
      'because the token index cannot represent it:',
      ...found,
    ],
  };
}

/**
 * §5.1(d): every `dead` asset, grepped across the whole repository.
 *
 * `dead` is the strong claim — *this filename appears nowhere in your codebase* — so
 * this is the claim most worth attacking. The oracle greps places the engine
 * deliberately does not: pruned directories, ignored ones, and the asset's stem
 * under a different extension.
 */
function verifyDead(asset: string, index: RepoIndex): ItemVerdict {
  const literal = literalHits(asset, index);
  if (literal !== null) return literal;

  const name = posix.basename(asset).toLowerCase();
  const stem = name.slice(0, name.lastIndexOf('.'));

  const exact = (index.hitsByToken.get(name) ?? []).filter((hit) => hit.file !== asset);
  if (exact.length > 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'confirmed-false',
      evidence: [
        `the filename appears in ${exact.length} place(s) the engine did not hedge on:`,
        ...exact.slice(0, 5).map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`),
      ],
    };
  }

  const swapped = (index.hitsByStem.get(stem) ?? []).filter(
    (hit) => hit.extensionSwapped && hit.file !== asset,
  );
  if (swapped.length > 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'ambiguous',
      evidence: [
        'the exact filename appears nowhere, but the same name under another image',
        'extension does — which is either an unrelated asset or a reference someone',
        'already converted by hand:',
        ...swapped.slice(0, 5).map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`),
      ],
    };
  }

  return {
    kind: 'dead',
    subject: asset,
    verdict: 'confirmed-genuine',
    evidence: [
      `grepped ${index.filesGrepped} files including pruned and ignored directories:`,
      `no mention of ${posix.basename(asset)} anywhere, under any image extension`,
    ],
  };
}

/**
 * §5.1(d): every hedge's citation, opened.
 *
 * `possibly-dead` is not exempt from review, and the thing to check is not whether
 * the asset is alive — the hedge does not claim to know — but whether the citation
 * is **real**. A hedge pointing at a line that does not contain the name is worse
 * than no hedge: it sends a user somewhere and wastes the trust the citation bought.
 */
function verifyHedge(
  asset: string,
  evidence: readonly { where: string; quote: string; source: string }[],
  index: RepoIndex,
): ItemVerdict {
  const checked: string[] = [];
  const wrong: string[] = [];

  for (const mention of evidence) {
    const match = /^(.*?):(\d+)$/.exec(mention.where);
    const file = match?.[1] ?? mention.where;
    const line = match?.[2] === undefined ? null : Number(match[2]);

    if (!index.files.has(file)) {
      wrong.push(`${mention.where} — that file is not in the repository`);
      continue;
    }

    const token = posix.basename(asset).toLowerCase();
    const hits = index.hitsByToken.get(token) ?? [];
    const inFile = hits.filter((hit) => hit.file === file);

    if (inFile.length === 0) {
      wrong.push(`${mention.where} — the file does not contain ${posix.basename(asset)}`);
    } else if (line !== null && !inFile.some((hit) => hit.line === line)) {
      wrong.push(
        `${mention.where} — the name is in that file but on line(s) ${inFile
          .map((hit) => hit.line)
          .slice(0, 4)
          .join(', ')}, not ${line}`,
      );
    } else {
      checked.push(`${mention.where} (${mention.source}) — the name is there`);
    }
  }

  if (wrong.length > 0) {
    return {
      kind: 'possibly-dead',
      subject: asset,
      verdict: 'confirmed-false',
      evidence: ['a citation does not hold up:', ...wrong.map((entry) => `  ${entry}`)],
    };
  }

  return {
    kind: 'possibly-dead',
    subject: asset,
    verdict: 'confirmed-genuine',
    evidence: checked.map((entry) => `  ${entry}`),
  };
}

/**
 * The oracle's own tokeniser, which must be able to see a filename containing a space.
 *
 * ⚠️ **It could not, and that is the R17 amendment landing for the third time.** This
 * index was built with `[\w@.\-]+\.(ext)` — no space — exactly like the engine's sweep.
 * So for an asset named `Firing Practice.webp` the oracle indexed only `practice.webp`,
 * the lookup for `firing practice.webp` found nothing, and it returned
 * **confirmed-genuine for a false `dead`.** *"Independent in implementation is not
 * independent in assumption"*: a different tree walk and a different regex, and the same
 * blind spot, because both were written by people who do not put spaces in filenames.
 *
 * This is the defect that would have made §5.1(j) worthless — the rate would have come
 * back near zero because the instrument could not see the class being measured. **R26's
 * 16% was found by a person grepping served paths by hand, not by this.**
 *
 * Deliberately a **separate copy** of the extend-leftwards trick rather than an import of
 * `imageFilenameCandidates`: the whole value of an oracle is that it agrees with the
 * engine by coincidence rather than by construction. `assertOracleSeesSpaces` below is
 * what stops the copy silently regressing.
 */
function* oracleTokens(text: string, pattern: RegExp): Generator<[token: string, index: number]> {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const end = match.index + match[0].length;
    yield [match[0], match.index];

    let start = match.index;
    for (let word = 0; word < 6; word += 1) {
      if (text[start - 1] !== ' ') break;
      let candidate = start - 1;
      while (candidate > 0 && /[\w@.\-]/.test(text[candidate - 1] ?? '')) candidate -= 1;
      if (candidate === start - 1) break;
      start = candidate;
      yield [text.slice(start, end), start];
    }
    match = pattern.exec(text);
  }
}

/**
 * Prove the oracle can see the class it is about to measure, before it measures it.
 *
 * A gate whose instrument is blind to the failure reports a clean result either way, and
 * that is the one outcome this project has learned to distrust. Cheap, runs once, and
 * throws rather than warning — a warning in a bench script is a line nobody reads.
 */
function assertOracleSeesSpaces(pattern: () => RegExp): void {
  const tokens = [...oracleTokens('src="/ncc/Firing Practice.webp"', pattern())].map(
    ([token]) => token,
  );
  if (!tokens.includes('Firing Practice.webp')) {
    throw new Error(
      'The oracle cannot see a filename containing a space, so any false-dead rate it reports is meaningless. See §5.1(j).',
    );
  }
}

/** The oracle's own walk and grep. Nothing here imports the engine's machinery. */
async function buildIndex(root: string): Promise<RepoIndex> {
  const files = new Set<string>();
  const hitsByToken = new Map<string, Hit[]>();
  const hitsByStem = new Map<string, Hit[]>();
  const lowerTexts = new Map<string, string>();
  const unreadable: string[] = [];
  let filesGrepped = 0;

  const extensions = IMAGE_EXTENSIONS.map((extension) => extension.slice(1)).join('|');
  const makePattern = () => new RegExp(`[\\w@.\\-]+\\.(?:${extensions})\\b`, 'gi');
  const pattern = makePattern();

  // Before measuring anything, prove the instrument can see the class being measured.
  assertOracleSeesSpaces(makePattern);

  let walked = 0;
  const startedAt = Date.now();
  for await (const absolute of walk(root)) {
    const rel = relative(root, absolute).replaceAll('\\', '/');
    files.add(rel);
    walked += 1;
    // Progress, synchronously to stderr: a slow index is otherwise indistinguishable from
    // a hang, and this is pointed at repositories nobody has profiled.
    if (walked % 2000 === 0) {
      appendFileSync(
        2,
        `      oracle: ${walked} walked, ${filesGrepped} grepped, ${((Date.now() - startedAt) / 1000).toFixed(0)}s\n`,
      );
    }

    const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(extension)) continue;

    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      unreadable.push(`${rel} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (text.length > MAX_GREP_BYTES) {
      unreadable.push(`${rel} — larger than ${MAX_GREP_BYTES} bytes, not grepped`);
      continue;
    }
    // Built with `String.fromCharCode` on purpose: a literal NUL in a source file
    // is exactly the character this harness mangles in transit, and it did.
    if (text.includes(String.fromCharCode(0))) {
      unreadable.push(`${rel} — contains a NUL byte, treated as binary and not grepped`);
      continue;
    }
    filesGrepped += 1;
    lowerTexts.set(rel, text.toLowerCase());

    const lineStarts = offsetsOfLines(text);
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const token = match[0].toLowerCase();
      const stem = token.slice(0, token.lastIndexOf('.'));
      const line = lineOf(lineStarts, match.index);
      const hit: Hit = {
        file: rel,
        line,
        text: lineText(text, match.index),
        extensionSwapped: false,
      };
      // ⚠️ **Push, never spread.** This was
      // `map.set(token, [...(map.get(token) ?? []), hit])`, which copies the whole array
      // per hit and is quadratic in the number of times one filename appears. On the three
      // pinned repos nothing repeats often enough to notice; on a real site with 1,873
      // images it turned a 23-second pipeline into a run that had not finished in ten
      // minutes, and adding the space-aware suffix tokens made it worse. A check nobody can
      // afford to run is a check nobody runs.
      pushHit(hitsByToken, token, hit);
      pushHit(hitsByStem, stem, { ...hit, extensionSwapped: true });
      match = pattern.exec(text);
    }
  }

  return {
    files,
    hitsByToken,
    hitsByStem,
    lowerTexts,
    unreadable,
    filesIndexed: files.size,
    filesGrepped,
  };
}

/**
 * Everything but `.git` and vendored dependencies.
 *
 * Deliberately not `discover`'s prune list: an asset referenced from `dist/` or from
 * a directory the user ignored is still referenced, and the point of an independent
 * oracle is to look where the engine agreed not to.
 *
 * ⚠️ **`node_modules` is the exception, and it is a validity fix rather than a speed one.**
 * That principle is about the *user's own* output — `dist/`, a `.gitignore`d build — and a
 * third-party package is not that. A user's asset filename appearing inside a dependency's
 * own files is a coincidence, not a reference to their asset, so counting it would produce
 * a **false confirmed-false** and bias §5.1(j)'s rate *upward*, making the engine look
 * worse than it is. The engine prunes `node_modules` too, so indexing it here would not be
 * independence — it would make the two corpora incomparable.
 *
 * None of the three pinned §5.1(c) repos has `node_modules` installed, so this changes
 * nothing there. It matters only on a real working repository, which is exactly what (j)
 * is pointed at. (It is also what took a run past ten minutes.)
 */
/** Append without copying. See the note at the call site. */
function pushHit(into: Map<string, Hit[]>, key: string, hit: Hit): void {
  const existing = into.get(key);
  if (existing === undefined) into.set(key, [hit]);
  else existing.push(hit);
}

/**
 * Directories the oracle does not index: vendored dependencies and generated output.
 *
 * ⚠️ **This reverses a decision written in this file, and the reversal is measured.** The
 * note above said an asset referenced from `dist/` is still referenced, so the oracle
 * should look there. Two problems showed up the first time it was pointed at a real
 * working repository rather than a pinned clone:
 *
 * - **Cost.** `.next/` holds 1,482 files of minified bundles, and the oracle's regex
 *   backtracks catastrophically over long runs of word characters. Measured on
 *   `D:/RBU/RBU-Website`: **over ten minutes** with `.next` indexed, **181 ms** without,
 *   across the same 1,314 other files. A check nobody can afford to run is a check nobody
 *   runs, and §5.1(j) is meant to be run on real repositories.
 * - **Validity, which matters more.** Generated output is *derived from* source. If the
 *   source still names an asset, the oracle finds it in the source; the only thing a build
 *   directory adds is the case where the source reference is **gone and the bundle is
 *   stale** — where the asset genuinely is dead and the oracle would wrongly call the
 *   finding false. Indexing it inflates the measured error rate with the engine's own
 *   correct answers.
 *
 * The same argument covers `node_modules`: a user's filename appearing inside a dependency
 * is a coincidence, not a reference to their asset.
 *
 * None of the three pinned §5.1(c) repos contains any of these directories, so this
 * changes nothing there — which is also why it was never noticed.
 *
 * ⚠️ **Raised rather than settled:** this changes §5.1(d)'s stated method, not the engine.
 * If the parent chat wants the other number, deleting an entry here is the whole change.
 */
const ORACLE_SKIPS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
]);

async function* walk(directory: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ORACLE_SKIPS.has(entry.name)) yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function offsetsOfLines(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Binary search rather than a scan per match: some of these files are large. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function lineText(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 140);
}
