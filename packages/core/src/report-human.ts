/**
 * Render a report for a person.
 *
 * Two rules shape this, and they pull against each other.
 *
 * **The numbers people screenshot come first, then the skipped list — before the
 * findings.** That ordering is deliberate and slightly uncomfortable: it puts what
 * the tool *could not do* above what it found. The previous generation of this
 * project failed by failing silently, and a limitation printed after eighty findings
 * is a limitation nobody reads. If the skipped list is long, that is information.
 *
 * **Deterministic** (rule 11). No timestamps, no durations, and no `toLocaleString`
 * anywhere — locale-dependent formatting would make the same repository render
 * differently on two machines, which is the same class of bug as sorting with
 * `localeCompare`. Every number here is formatted by hand.
 *
 * No colour codes either. Colour is the CLI's business, since it is the layer that
 * knows about TTYs and `NO_COLOR`.
 */

import { staticExtensionOf } from './adapters/reference-path.js';
import type { Finding, OversizeDimension } from './audit.js';
import { formatBytes as bytes } from './format.js';
import { compareStrings, isImageExtension } from './paths.js';
import type { Report, SkipStage, SkippedItem } from './report.js';
import type { MentionSource } from './sweep.js';

/** Render the report as plain text. */
export function renderReport(report: Report): string {
  const lines: string[] = [];

  lines.push(...headline(report));
  lines.push(...skippedSection(report));
  lines.push(...findingsSection(report));
  lines.push(...caveatSection(report));

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The first six lines, and the only ones that reliably get read.
 *
 * §5.1(d) asks whether the numbers are obvious within ten seconds, and this is the
 * text that gets the ten seconds. It failed that twice over (R21 #4, R25 #2):
 *
 * - `132 references across 2 681 source files — 13 linked` sat directly above
 *   `5 referenced, 150 not`, two overlapping counts with **no stated relationship**.
 *   Nothing on the page let a reader work out that the 13 resolving references point
 *   at 5 distinct images; they had to guess whether `13` and `5` were the same thing
 *   counted differently.
 * - `4.2 MB of measured savings available` — the one line anybody actually wants —
 *   was **fourth**, and it was a **floor** that did not say so. The encode cap left
 *   80 of shadcn-ui's 195 images unmeasured, and the only mention of that sat forty
 *   lines below in a caveat.
 *
 * So: **the first line is what a reader can act on, and everything under it is
 * provenance.** A number that is a floor says so in the same sentence — a footnote
 * elsewhere in the document is how "4.2 MB" gets quoted as if it were the total.
 */
function headline(report: Report): string[] {
  const { summary } = report;
  const unreferenced = summary.assets - summary.referencedAssets;
  const capped = report.caveats.find((caveat) => caveat.code === 'encode-capped')?.count ?? 0;

  return [
    'Upfly audit',
    '',
    `  ${savingsLine(summary, capped)}`,
    '',
    `  scanned ${count(summary.sourceFiles, 'source file')} and found ${count(summary.assets, 'image')}, ${bytes(summary.assetBytes)} in total`,
    // `resolved` and `pointing`, not `resolve` and `they point`: both are invariant,
    // so neither can disagree with a count of one. Latent rather than live — measured
    // scope today is zero, because no fixture has a single reference — but this is the
    // same construction as the line below, which WAS live, and the lesson this project
    // keeps relearning is to remove the possibility rather than to notice it later.
    `  ${summary.linkedReferences} of ${count(summary.references, 'reference')} resolved, pointing at ${summary.referencedAssets} of those images`,
    // ⚠️ No finite verb, and that is the whole point. This read `${…} have no
    // reference…`, which renders "the other 1 image have no reference" — the
    // subject–verb agreement bug for the seventh time in this renderer. It could not
    // fire until the Astro adapter landed, because every fixture had a plural count
    // here; the astro fixture's three hedged assets became ordinary links and left
    // exactly one unreferenced image behind. A noun phrase has no verb to disagree
    // with, so the fix is structural rather than another reminder to remember.
    `  ${count(unreferenced, 'image')} with no reference Upfly could follow`,
    ...vectorLine(report),
    '',
  ];
}

/**
 * R22's counted line, in the headline rather than only in the caveats.
 *
 * ⚠️ **This line exists because R22 would otherwise have recreated R21 #4.** The line
 * above says `150 images with no reference Upfly could follow`; the findings
 * list beneath it now holds 24, because 126 were demoted. Two overlapping counts with
 * no stated relationship is the precise defect R21 #4 was raised about, and burying
 * the explanation forty lines down in the caveats is what R21 #4's own lesson forbids:
 * a limitation printed after eighty findings is a limitation nobody reads.
 *
 * So the relationship is stated where the ten seconds are spent, and the caveat keeps
 * carrying it for the JSON. That is the same split `encode-capped` already uses — the
 * cap is in `savingsLine` *and* in a caveat — and it is the one place in this renderer
 * where saying it twice is right rather than a violation of R25 #3.
 *
 * `including` ties it to the preceding line on purpose: it is a subset of the
 * unreferenced count, not a fourth independent number.
 *
 * ⚠️ **`including` is also what makes the line agreement-proof, and the first version
 * was not.** It read `${n} of those are unreferenced vectors`, which renders
 * "1 of those are unreferenced vectors" — the verb-agreement bug for the sixth time in
 * this renderer, written by a chat that had read the warning about it twice and had
 * already hit it once the same hour. Only reading the rendered output caught it. There
 * is no finite verb here now: `including` takes a noun phrase, and
 * "Upfly will neither convert a vector nor delete an asset" has an invariant subject.
 */
function vectorLine(report: Report): string[] {
  const { count: vectors, bytes: vectorBytes } = report.unusedVectors;
  if (vectors === 0) return [];
  return [
    `  including ${count(vectors, 'unreferenced SVG')}, ${bytes(vectorBytes)} — counted, not listed: Upfly will neither convert an SVG nor delete an asset`,
  ];
}

/**
 * What a reader can act on, in one sentence including its own caveat.
 *
 * Four cases, and the third is the one that matters: a capped run has measured *some*
 * of the images, so its number is a lower bound and has to be readable as one. It
 * deliberately does not say "floor" or "lower bound" — it says how many were left
 * out, which is the fact underneath the jargon and the thing that tells a reader what
 * to do next.
 */
function savingsLine(summary: Report['summary'], capped: number): string {
  if (!summary.probed) {
    return 'savings not measured — images were not decoded (--no-probe)';
  }
  if (capped > 0) {
    return `${bytes(summary.potentialSavingBytes)} of savings found so far — ${capped} of ${count(summary.assets, 'image')} went unmeasured, so there may be more (--probe-all)`;
  }
  if (summary.potentialSavingBytes === 0) {
    return `no savings found, and every one of ${count(summary.assets, 'image')} was measured`;
  }
  return `${bytes(summary.potentialSavingBytes)} of savings, measured across all ${count(summary.assets, 'image')}`;
}

/**
 * What each stage's failures were, said as the thing that happened.
 *
 * ⚠️ The sweep's label used to read `could not be searched`, which under a heading
 * about what Upfly "could not handle" and beside conversion messages read as *"why
 * are we trying to convert fonts?"* (R21). They are fonts too large to grep for a
 * filename — nothing to do with conversion — so the label now says which search and
 * why, and the two kinds no longer look like one kind.
 */
const STAGE_LABEL: Record<SkipStage, string> = {
  discovery: 'could not be read',
  scan: 'could not be parsed',
  sweep: 'too large to search for asset filenames',
  citation: 'could not be re-read for a line number',
  measurement: 'could not be measured',
};

/**
 * What the engine declined to do — printed **before** the findings.
 *
 * The unsafe references live here too. They are not failures, but they are the same
 * kind of statement: paths the engine will not touch, and the number a user is
 * entitled to see before believing anything else in the report.
 */
function skippedSection(report: Report): string[] {
  const { skipped, references } = report;
  // The discarded count belongs to this guard too. Leaving it out made the line
  // below unreachable on exactly the common case — a clean repository with no
  // skips and no unsafe references, but a `package.json` full of path-shaped
  // strings. Every fixture tree has zero of those, so nothing caught it.
  if (skipped.length === 0 && references.unsafe.length === 0 && references.discardedCount === 0) {
    return ['Nothing was skipped.', ''];
  }

  const lines: string[] = [];

  if (skipped.length > 0) {
    // ⚠️ Neutral on purpose. "could not handle" was false for 134 of astro-docs'
    // 140 (R21) — determinations filed as failures — and the obvious replacement,
    // "could not do", is false in the same way for what remains: shadcn-ui's 80 are
    // a **deliberate cap** and the sweep's are a size limit. Upfly did not do them;
    // only some of them are things it could not do. Each row carries its own
    // reason, so the heading does not need to characterise them all.
    lines.push(`Skipped — ${count(skipped.length, 'thing')}, each with its reason`, '');
    for (const [stage, items] of groupByStage(skipped)) {
      lines.push(`  ${STAGE_LABEL[stage]}:`);
      lines.push(...collapseByReason(items));
      lines.push('');
    }
  }

  if (references.unsafe.length > 0) {
    // Listed only when the path could still name an image; counted otherwise (R21).
    //
    // The resolver drops what a static suffix rules out — `${name}.tsx` needs no
    // resolution — so what arrives here is either "shows an image extension" or
    // "shows no extension at all". The second kind is genuinely unknowable:
    // `/view/${style}/${name}` could be anything, and with no extension it can never
    // glob to an asset either. Printing fifty of those buries the eight a person
    // could act on, and one counted line satisfies rule 9 without the wall.
    const listed = references.unsafe.filter((entry) => showsAnImageFilename(entry.rawPath));
    const counted = references.unsafe.length - listed.length;

    // The two columns are `where it was found` and `what was found` (R21). Reading
    // `api-reference.mdx  script-src 'self' …` cold, the question it provoked was
    // whether the `.mdx` was being treated as an image — which nothing on the page
    // answered. One line of header costs less than the doubt did.
    lines.push(`${count(references.unsafe.length, 'reference')} could not be resolved safely`, '');
    // Only when there is a list to head. A column key above an empty list is its
    // own small piece of noise, and this section is often entirely counted.
    if (listed.length > 0) {
      lines.push('  (the file it was found in, then the path text as written)', '');
    }
    for (const entry of listed) {
      lines.push(`  ${entry.file}  ${entry.rawPath}`);
      lines.push(`    ${entry.resolution} — ${entry.reason}`);
    }
    if (counted > 0) {
      // Phrased to sidestep verb agreement rather than to get it right: this file
      // has shipped "1 file were not read" and "1 path-shaped string were not an
      // asset reference" already, and a noun phrase cannot have the bug. Reads the
      // same at 1 and at 52.
      lines.push(
        listed.length === 0
          ? '  none with a filename to check — each builds its path at runtime'
          : `  plus ${counted} with no filename to check — each builds its path at runtime`,
      );
    }
    lines.push('');
  }

  if (references.discardedCount > 0) {
    // Name the flag that actually produces the list. `--json` alone gives a bare
    // integer, and pointing someone at data that is not there costs more trust
    // than saying nothing would.
    // ⚠️ It says *did not resolve*, not "was not a reference" — which is what it
    // said, and which the data contradicts. On `astro-docs`, **117 of the 118**
    // discarded strings name a file that genuinely is an asset in that repository:
    // `src/data/logos.ts` holds `{ file: 'gitbook.svg' }` a hundred and seventeen
    // times, joined to a base directory at runtime. They are asset references. They
    // simply do not resolve as written.
    //
    // Worse, the old wording contradicted the same report a page later: those
    // identical strings are the R10 haystack's evidence, so the findings section
    // cites them as proof an asset is alive while this line called them not
    // references at all. Second time a confident sentence in this renderer was false
    // about the majority of what it described, and the same file caused both.
    // No singular/plural branch any more: "did not resolve" agrees either way,
    // where "was/were not an asset reference" needed one. The verb-agreement bug
    // this file has already had twice is now unreachable here rather than fixed.
    const hint = references.discarded === null ? ' (use --include-discarded to list them)' : '';
    lines.push(
      `${count(references.discardedCount, 'path-shaped string')} did not resolve to an asset${hint}`,
      '',
    );

    // Asked for explicitly, so shown — the flag would otherwise appear to do
    // nothing unless `--json` were passed alongside it.
    for (const entry of references.discarded ?? []) {
      lines.push(`  ${entry.file}  ${entry.rawPath}`);
    }
    if (references.discarded !== null) lines.push('');
  }

  return lines;
}

/**
 * Does this raw path show an image filename a person could go and check?
 *
 * Named for what it tests rather than for the decision it feeds. The first draft was
 * `couldBeAnImage`, whose doc claimed it was also true for a path showing no
 * extension — which is the opposite of what the code does, and a path with a hole
 * where the filename should be genuinely *could* be an image. Both the name and the
 * comment described a different function from the one underneath them.
 *
 * The real question is narrower and answerable: is there a filename here to look at?
 * A path that shows one gets listed; one that does not gets counted, because there is
 * nothing for a reader to do with it.
 */
function showsAnImageFilename(rawPath: string): boolean {
  const extension = staticExtensionOf(rawPath);
  return extension !== '' && isImageExtension(extension);
}

/**
 * R23, rendered first because it is the most actionable thing in the report.
 *
 * A broken reference to a file that does not exist is a broken image on the site, and
 * an unreferenced vector with the same stem is the likely explanation. Neither finding
 * says that alone.
 *
 * ⚠️ **Hedged on purpose.** `may have been` is the whole sentence's honesty: the
 * pairing is two facts and their proximity, and `hero.svg` next to a broken
 * `hero.png` could as easily be two unrelated files a designer named alike. R15
 * established that a weak resolution must not drive an action; a weak inference must
 * not drive a confident sentence either. Both facts are printed so the reader can
 * judge, and `may` is invariant, so the count has no verb to disagree with.
 */
function staleConversionSection(report: Report): string[] {
  if (report.staleConversions.length === 0) return [];

  const lines = [
    `  ${count(report.staleConversions.length, 'image')} may have been converted by hand without updating the reference`,
  ];
  for (const pair of report.staleConversions) {
    lines.push(`    ${pair.vector} is unreferenced, and ${pair.where} asks for ${pair.rawPath}`);
  }
  lines.push('');
  return lines;
}

function findingsSection(report: Report): string[] {
  // ⚠️ `No findings.` became a lie the moment R22 started demoting. A repository whose
  // only unreferenced assets are vectors produces an empty `findings` array and a
  // non-zero `unusedVectors.count`, and the old line would have reported "nothing to
  // see here" over 126 demoted items. None of the three validation repos reaches this
  // branch — all of them have other findings — which is exactly the condition that
  // makes fixtures unable to test it, so it has a hand-built case in report.test.ts.
  if (report.findings.length === 0) {
    if (report.unusedVectors.count === 0) return ['No findings.', ''];
    return [
      `No findings, apart from ${count(report.unusedVectors.count, 'unreferenced SVG')} counted above.`,
      '',
    ];
  }

  const lines = [`Findings — ${count(report.findings.length, 'item')}`, ''];
  lines.push(...staleConversionSection(report));
  let previous: Finding['kind'] | null = null;

  for (const finding of report.findings) {
    // Hedges are not a flat list: they are three different statements about why an
    // asset has no references, and they are rendered as such. See below.
    if (finding.kind === 'possibly-dead') {
      if (previous !== 'possibly-dead') {
        if (previous !== null) lines.push('');
        lines.push(...possiblyDeadSection(report));
        previous = 'possibly-dead';
      }
      continue;
    }

    // Both size findings are one statement about one file (R21). All five of
    // astro-docs' `oversized` assets were also in `format-opportunity`, in two
    // sections a page apart with nothing connecting them, so the same image was
    // reported twice and its total story was in neither place.
    if (finding.kind === 'oversized' || finding.kind === 'format-opportunity') {
      if (previous !== 'oversized') {
        if (previous !== null) lines.push('');
        lines.push(...sizeSection(report));
        previous = 'oversized';
      }
      continue;
    }

    if (finding.kind !== previous) {
      if (previous !== null) lines.push('');
      lines.push(`  ${headingFor(finding.kind, report)}`);
      previous = finding.kind;
    }
    lines.push(...describe(finding));
  }

  lines.push('');
  return lines;
}

type PossiblyDead = Extract<Finding, { kind: 'possibly-dead' }>;

/**
 * Most actionable first. A finding is filed under the best evidence it carries,
 * and still prints all of it.
 */
const MENTION_RANK: readonly MentionSource[] = [
  'unscanned-file',
  'scanned-file',
  'unresolved-reference',
];

/**
 * What each source means to the person reading, which is the only axis that
 * matters here: the three differ in what the user can *do*.
 */
const MENTION_HEADING: Record<MentionSource, string> = {
  'unscanned-file': 'in a file no adapter reads — an adapter or a config entry would resolve these',
  'scanned-file':
    'in text Upfly read but no adapter claimed — the weakest evidence; look if the asset matters',
  'unresolved-reference':
    'by a path Upfly read but could not resolve — nothing to fix; those files parse fine',
};

/**
 * The hedges, split by what the evidence actually is and grouped by the file that
 * named them.
 *
 * The single heading this replaced — *"named somewhere Upfly cannot read"* — was
 * **false for the majority of the findings it headed**: 119 of 140 on `astro-docs`,
 * 5 of 10 on `eleventy-docs`, 5 of 8 on `shadcn-ui` have no `unscanned-file`
 * evidence at all. `src/data/logos.ts` is ordinary TypeScript that parses perfectly;
 * `'gitbook.svg'` simply is not a resolvable path. A user who follows that citation
 * opens a readable file and concludes the tool is broken — so one wrong sentence
 * costs the credibility of a finding that was right.
 *
 * Grouping is by **citing file**, not by source. "120 assets are named in
 * `src/data/logos.ts`" is a fact somebody can act on; "120 unresolved-reference" is
 * our internal taxonomy, and one file explaining 86% of a repository's hedges is the
 * whole finding.
 */
function possiblyDeadSection(report: Report): string[] {
  const findings = report.findings.filter(
    (finding): finding is PossiblyDead => finding.kind === 'possibly-dead',
  );
  const lines = [
    `  possibly unreferenced (${findings.length}) — each is named somewhere, but not by a reference Upfly could follow`,
  ];

  for (const source of MENTION_RANK) {
    const group = findings.filter((finding) => bestSource(finding) === source);
    if (group.length === 0) continue;

    lines.push('', `    named ${MENTION_HEADING[source]} (${group.length})`);

    const byFile = new Map<string, PossiblyDead[]>();
    for (const finding of group) {
      const file = citingFile(finding, source);
      byFile.set(file, [...(byFile.get(file) ?? []), finding]);
    }

    // Biggest cause first, because that is the one worth acting on — with ties
    // broken on the path, so rule 11 survives two files naming the same number.
    const files = [...byFile].sort(
      (a, b) => b[1].length - a[1].length || compareStrings(a[0], b[0]),
    );

    for (const [file, assets] of files) {
      lines.push(`      ${file} — ${count(assets.length, 'asset')}`);
      for (const finding of assets) {
        lines.push(`        ${finding.asset}  ${bytes(finding.bytes)}`);
        // Every mention, not only the one that filed it: the citation is the whole
        // point of hedging per asset rather than globally.
        for (const mention of finding.evidence) {
          lines.push(`          named in ${mention.where}: ${mention.quote}`);
        }
      }
    }
  }

  return lines;
}

/** The most actionable source among a finding's evidence. */
function bestSource(finding: PossiblyDead): MentionSource {
  let best = finding.evidence[0].source;
  for (const mention of finding.evidence) {
    if (MENTION_RANK.indexOf(mention.source) < MENTION_RANK.indexOf(best)) best = mention.source;
  }
  return best;
}

/** The file that filed this finding, without the line number `where` carries. */
function citingFile(finding: PossiblyDead, source: MentionSource): string {
  const mention = finding.evidence.find((entry) => entry.source === source);
  const where = mention?.where ?? finding.evidence[0].where;
  return where.replace(/:\d+$/, '');
}

/** What exceeding each limit means, said as a comparison a reader can check. */
const OVERSIZE_LABEL: Record<OversizeDimension, string> = {
  bytes: 'larger than the size limit',
  width: 'wider than the width limit',
  height: 'taller than the height limit',
};

type Oversized = Extract<Finding, { kind: 'oversized' }>;
type Opportunity = Extract<Finding, { kind: 'format-opportunity' }>;

/**
 * Everything about an image's size, once per image.
 *
 * `oversized` and `format-opportunity` are two measurements of the same thing, and
 * printing them in separate sections meant `landing-page-book.png` appeared twice
 * with nothing linking the entries — 551 KB in one place, "340 KB as webp" in
 * another, and the sentence a reader actually wants ("551 KB, and 340 KB as webp")
 * in neither. On `astro-docs` **all five** oversized assets were also opportunities.
 *
 * Both counts stay in the heading, so nothing is hidden by the merge.
 */
function sizeSection(report: Report): string[] {
  const merged = new Map<string, { over: Oversized | null; opportunities: Opportunity[] }>();

  // First-encounter order, which is the report's own deterministic finding order —
  // rule 11 holds without a second sort.
  for (const finding of report.findings) {
    if (finding.kind !== 'oversized' && finding.kind !== 'format-opportunity') continue;
    const entry = merged.get(finding.asset) ?? { over: null, opportunities: [] };
    if (finding.kind === 'oversized') entry.over = finding;
    else entry.opportunities.push(finding);
    merged.set(finding.asset, entry);
  }

  const oversized = report.summary.findings.oversized;
  const opportunities = report.summary.findings['format-opportunity'];
  const lines = [
    `  size — ${count(merged.size, 'image')}: ${oversized} over the limit, ${opportunities} smaller as another format (measured, not estimated)`,
    '',
  ];

  for (const [asset, entry] of merged) {
    const first = entry.over ?? entry.opportunities[0];
    if (first === undefined) continue;

    const shape = entry.over === null ? '' : dimensions(entry.over.width, entry.over.height);
    lines.push(`    ${asset}  ${bytes(first.bytes)}${shape}`);

    if (entry.over !== null) {
      // One line each, not `over ${exceeded.join(' and ')}` — which rendered as
      // "over bytes and width", a phrase in no language. `exceeded` holds the
      // dimension *names*, and joining internal identifiers into a sentence is the
      // same shape of defect as the headings R21 was raised about. Separate lines
      // also sidestep "limit" vs "limits".
      for (const dimension of entry.over.exceeded) lines.push(`      ${OVERSIZE_LABEL[dimension]}`);
    }
    for (const opportunity of entry.opportunities) {
      lines.push(
        `      ${bytes(opportunity.wouldBe)} as ${opportunity.to} — saves ${bytes(opportunity.savedBytes)}, ${opportunity.savedPercent}%`,
      );
    }
  }

  return lines;
}

function headingFor(kind: Finding['kind'], report: Report): string {
  const total = report.summary.findings[kind];
  switch (kind) {
    case 'broken':
      return `broken references (${total}) — these point at nothing`;
    case 'dead':
      return `unreferenced images (${total})`;
    case 'possibly-dead':
      // Unreachable: `findingsSection` routes these through `possiblyDeadSection`,
      // which heads each of the three evidence kinds separately. Kept so the
      // exhaustive switch still compiles and an eighth finding still breaks it.
      return `possibly unreferenced (${total})`;
    case 'oversized':
      return `oversized images (${total})`;
    case 'format-opportunity':
      return `smaller as another format (${total}) — measured, not estimated`;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

function describe(finding: Finding): string[] {
  switch (finding.kind) {
    case 'broken':
      return [`    ${finding.where}  ${finding.rawPath}`];
    case 'dead':
      return [`    ${finding.asset}  ${bytes(finding.bytes)}`];
    case 'possibly-dead':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)}`,
        // The citation is the whole point of hedging per asset rather than
        // globally: it turns a warning into somewhere to look.
        ...finding.evidence.map((mention) => `      named in ${mention.where}: ${mention.quote}`),
      ];
    case 'oversized':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)}${dimensions(finding.width, finding.height)} — over ${finding.exceeded.join(' and ')}`,
      ];
    case 'format-opportunity':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)} → ${bytes(finding.wouldBe)} as ${finding.to}  (saves ${bytes(finding.savedBytes)}, ${finding.savedPercent}%)`,
      ];
    default: {
      const unhandled: never = finding;
      return unhandled;
    }
  }
}

function caveatSection(report: Report): string[] {
  if (report.caveats.length === 0) return [];

  const lines = ['Worth knowing', ''];
  for (const caveat of report.caveats) {
    // The message already carries its own count, so nothing here has to compose a
    // sentence out of a number and a fragment.
    lines.push(`  ${caveat.message}${caveat.detail.length > 0 ? ':' : ''}`);
    for (const detail of caveat.detail) lines.push(`    ${detail}`);
  }
  lines.push('');
  return lines;
}

/** Above this many items sharing one reason, the reason is lifted above them. */
const REPEAT_LIMIT = 3;

/**
 * Items sharing a reason, with the reason said once and every name kept.
 *
 * `--probe-all` appeared **81 times** in `shadcn-ui`'s report — once on each of 80
 * capped assets, plus the caveat — which is the wall the 126 repeated SVG lines
 * made.
 *
 * ⚠️ The first version of this fix dropped the names and printed only a count, and
 * that was wrong for the case right next to it: `eleventy-docs` has ten `.js` files
 * that are really Nunjucks templates, and *which ten* is the actionable part — a
 * reader renames those or configures them. The capped assets and the template files
 * differ in whether the individual identity matters, which is not something a count
 * threshold can tell.
 *
 * So the sentence moves up and the names stay under it. Eighty short lines instead
 * of eighty long identical ones, and nothing is lost from either the page or the
 * JSON.
 */
function collapseByReason(items: readonly SkippedItem[]): string[] {
  const byReason = new Map<string, SkippedItem[]>();
  for (const item of items) {
    byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item]);
  }

  const lines: string[] = [];
  for (const [reason, group] of byReason) {
    if (group.length > REPEAT_LIMIT) {
      lines.push(`    ${count(group.length, 'file')} — ${reason}`);
      for (const item of group) lines.push(`      ${item.what}`);
      continue;
    }
    for (const item of group) lines.push(`    ${item.what} — ${item.reason}`);
  }

  return lines;
}

function groupByStage(items: readonly SkippedItem[]): [SkipStage, SkippedItem[]][] {
  const groups = new Map<SkipStage, SkippedItem[]>();
  for (const item of items) {
    const list = groups.get(item.stage);
    if (list === undefined) groups.set(item.stage, [item]);
    else list.push(item);
  }
  // `skipped` arrives sorted by stage, so insertion order is already deterministic.
  return [...groups];
}

/** `1 image` / `2 images`. English pluralisation, which is the only language here. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * Bytes, formatted by hand.
 *
 * Deliberately not `Intl.NumberFormat` or `toLocaleString`: those are
 * locale-dependent, so the same repository would render `1.5 MB` on one machine and
 * `1,5 MB` on another and rule 11's byte-identical output would quietly be false.
 * Decimal units, because that is what file managers show.
 */

function dimensions(width: number | null, height: number | null): string {
  return width === null || height === null ? '' : `, ${width}×${height}`;
}
