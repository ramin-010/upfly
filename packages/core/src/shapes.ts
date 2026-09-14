/**
 * The reference-shape vocabulary: what KIND of syntax a reference was written in.
 *
 * A reference already carries an *outcome* — did it resolve, is it broken, was it
 * discarded. This says what it IS, so the two can be crossed: *“`srcset` candidates
 * are 5 of 5”* means nothing until you also know *“and `srcset`-class references are
 * 94% of this repository's total”* (R76).
 *
 * 🔴 **THERE IS ONE LIST AND THIS IS NOT IT.** The list is DEFINED by the coverage
 * tree's `shape` field, in `coverage-tree/key/coverage-key.json`, and this file adopts
 * it. It is a second physical copy for one reason only: `check-key.mjs` fails its own
 * run if it imports anything outside `node:` and `./`, which is what stops the key
 * being certified by the engine it exists to measure (R72). It therefore *cannot*
 * import this file, and this file must not import the key — a shipping package would
 * be depending on a test fixture.
 *
 * ✅ **What makes two copies one list is `shapes.reconcile.test.ts`, which fails in
 * BOTH directions** — a shape here that the tree does not declare, and a shape the
 * tree declares that is missing here. Divergence is a red test rather than a
 * convention, which is the only answer to 6a-decies that has ever held.
 *
 * ## How a shape is chosen, and why it is not one axis
 *
 * The vocabulary mixes three things, and that is deliberate rather than sloppy:
 *
 * - **host** — the file or construct the reference sits in (`html.*`, `scss.*`, `md.*`)
 * - **construct** — the syntactic position (`img.src`, `url()`, `import`)
 * - **disposition** — what the path itself is (`path.absolute-url`, `decoy.comment`)
 *
 * 🔴 **The rule that picks between them: a shape names the NARROWEST THING WHOSE
 * BREAKAGE WOULD TAKE OUT THAT REFERENCE AND NOT OTHERS.** That is what makes a row
 * worth printing — it isolates one thing that can independently fail.
 *
 * So a `url()` inside a comment is `css.url.in-comment` **in every host**, because
 * comment handling is the CSS reader's job and breaks identically in `.css`, `.scss`,
 * `.less` and a `<style>` element. But a plain `url()` inside `<style>` is
 * `html.style.element`, because what would take it out is HTML's *extraction* of the
 * CSS, not the CSS parse. Both axes matter; which one wins is a judgement made per
 * shape and recorded in `why`.
 *
 * ⚠️ **This is why the vocabulary cannot be derived by a function**, and why the
 * adapters declare their shape at the point of emission instead of having one computed
 * for them. 430 of the tree's 432 entries already obeyed this rule when it was written
 * down; the two that did not were corrected to it (R82).
 */

/**
 * What the ENGINE AS A WHOLE reports for this shape — and if nothing, whether that is
 * a gap or the correct answer.
 *
 * 🔴 **The matrix must not print a zero the same way in all three cases**, which is the
 * whole reason this field exists. *“0 of 6, no reader”* is a gap worth acting on;
 * *“0 of 3”* for a decoy is the engine working exactly as intended, and printing it as
 * a failure would train a reader to ignore the column.
 *
 * 🔴 **THIS FIELD IS THE PIPELINE'S READING, NOT THE ADAPTER'S, and conflating the two
 * cost a day of measurement (R87).** `decoy.typo` is `declined` because nothing survives
 * to the report — but an adapter *does* emit all five of them, as `js.string.literal`,
 * and the resolver discards them once it can see that the file is absent. Read as an
 * adapter prediction the field is simply false there. **Which layer declines is recorded
 * separately, in `adapterEmitsAs`** — see its own note, because the distinction decides
 * whether a shape disagreement is a defect or arithmetic.
 */
export type ShapeEmission =
  /** The engine reports a reference here. A row counts found against expected. */
  | 'engine'
  /**
   * Nothing reads this today, so the row is zero and the key's `knownGap` names the
   * ruling that explains it. R75's `.vue 0 of 6 — no reader` is this.
   */
  | 'gap'
  /**
   * The engine deliberately reports nothing, and that is CORRECT. A decoy, a data URI,
   * a path inside a code fence. 🔴 **Here a NON-zero count is the failure**, so the
   * matrix reads this row in the opposite direction.
   *
   * ⚠️ It says nothing about *where* the refusal happens. An adapter may decline to
   * emit at all, or emit and have the resolver discard it; `adapterEmitsAs` is what
   * separates those.
   */
  | 'declined';

// 🔴 THERE WAS A FOURTH VALUE, `mixed`, AND IT IS DELIBERATELY GONE (R83).
//
// It existed for one shape — `html.link.href.other`, whose four entries split 1 emitted
// / 3 declined — and it meant *“nobody has ruled on this”* rather than naming a
// behaviour. The ruling split that shape three ways instead, so every row became
// homogeneous and the value had nothing left to describe.
//
// ⚠️ It is removed from the union rather than left unused, because a placeholder that
// outlives its question becomes furniture and the next ambiguous shape would reach for
// it instead of being ruled on. That is the same hazard `UNTESTED_SHAPE_IDS` is guarded
// against by the reconciliation going red when a debt is quietly paid.

export interface ShapeDeclaration {
  readonly id: string;
  /** How the shape reads in prose, for a matrix row. */
  readonly label: string;
  /** Which coverage-tree spec section asked for it. */
  readonly spec: string;
  readonly emission: ShapeEmission;
  /**
   * Why this emission class, and — where the choice was not obvious — which axis won
   * and what would have to break for this row to go red on its own.
   */
  readonly why?: string;
  /**
   * 🔴 **THE BROADER SHAPES AN ADAPTER EMITS WHERE IT CANNOT NARROW TO THIS ONE, because
   * the distinction needs a fact only the RESOLVER has.** Absent means an adapter always
   * names the shape itself.
   *
   * ⚠️ **“Where it cannot”, not “never can”** — and the wording is load-bearing. Most
   * shapes here are wholly out of an adapter's reach; `path.bare-specifier` is not. Inside
   * `import`/`require` a bare string is module-resolution syntax and the adapter decides
   * it; in an ordinary string literal the identical text decides nothing. One shape, one
   * construct-dependent boundary, so the field lists what is emitted on the far side of it
   * rather than claiming the whole shape is unreachable.
   *
   * **Why this field exists (R87).** `ShapeEmission` describes the engine's answer; this
   * describes which layer produces it. Without the split, a shape audit joining the key
   * against the adapters reports 22 of its 31 disagreements as defects when every one of
   * them is correct behaviour: a `decoy.typo` cannot be told from a real path until
   * something checks the disk, `js.import.alias.mapped` needs the `tsconfig` paths table,
   * `json.webmanifest.other` needs array context the flat scanner does not parse, and
   * `pattern.partial` needs to know which of the files a pattern names actually exist.
   *
   * ⚠️ **It is declared rather than listed at the call site on purpose.** The alternative
   * — the measuring harness carrying a hand-written roster of 22 exempt entries — rots the
   * first time a shape moves layer, and rots SILENTLY, because an exemption that is no
   * longer needed still suppresses. Declared here it is one fact per shape, reconciled
   * with the tree, and `shapes.reconcile.test.ts` fails when an id in here is not a real
   * shape. **The matrix reads this field; it does not keep its own list.**
   *
   * 🔴 **This is R83's flaw one layer along.** `mixed` meant *“two behaviours nobody
   * separated”* within a shape; this separates two LAYERS within a shape, and both
   * present the same way — a row that reads as a miss and is not one.
   */
  readonly adapterEmitsAs?: readonly string[];
  /**
   * The resolver fact the distinction needs, in a few words — *“whether the file
   * exists”*, *“the tsconfig paths table”*. Required alongside `adapterEmitsAs`: the
   * field is only believable if it names what the adapter cannot see, and *that* claim
   * is the one a reader has to be able to check against the code.
   */
  readonly needsToSee?: string;
}

/**
 * The vocabulary. Order follows the coverage tree's own, so a diff between the two
 * reads cleanly.
 *
 * ⚠️ `as const satisfies` rather than a type annotation: it keeps the literal id types,
 * which is what lets `ShapeId` below be derived instead of written out a second time.
 * An adapter can then only name a shape that exists here, checked at compile time —
 * and there is no third copy of the list to drift.
 */
export const SHAPES = [
  // ---- HTML -------------------------------------------------------------------
  { id: 'html.img.src', label: 'img@src', spec: '4a', emission: 'engine' },
  {
    id: 'html.rawtext.swallowed',
    label: 'markup swallowed by an unclosed raw-text element',
    spec: '4a',
    emission: 'declined',
    why:
      '🔴 RENAMED AND REVERSED BY R90, and the old name was the whole defect: ' +
      '`html.img.src.after-rawtext-prose` ASSERTED these must be found, and the fixture below it ' +
      'reads "everything from here down must still be found". In an HTML file there is no prose — ' +
      'every character is markup, an unclosed <style> opens a raw-text element, and everything to ' +
      'the end of the document is its content. A BROWSER RENDERS NOTHING AFTER IT EITHER, so the ' +
      'engine agreeing is correct and a non-zero count here is the failure. ' +
      '⚠️ `maskInactiveRegions` lives in `markdown.ts` CORRECTLY: CommonMark says a raw-text block ' +
      'must BEGIN A LINE, so mid-sentence it is inline HTML and masking is right there and wrong ' +
      'here. The fixture ported a markdown lesson into HTML. ' +
      '✅ What was genuinely owed was the DIAGNOSIS — `invalid css syntax at line 1, column 2` is a ' +
      'symptom dressed as one — and `styleElementFailure` now names the tag, its line, and the ' +
      "reader's own browser. R51 one layer down.",
  },
  {
    id: 'html.img.srcset.single',
    label: 'img@srcset, one candidate',
    spec: '4a',
    emission: 'engine',
  },
  { id: 'html.img.srcset.x', label: 'img@srcset, x descriptors', spec: '4a', emission: 'engine' },
  { id: 'html.img.srcset.w', label: 'img@srcset, w descriptors', spec: '4a', emission: 'engine' },
  { id: 'html.source.srcset', label: 'source@srcset', spec: '4a', emission: 'engine' },
  { id: 'html.source.src', label: 'source@src', spec: '4a', emission: 'engine' },
  { id: 'html.video.src', label: 'video@src', spec: '4a', emission: 'engine' },
  { id: 'html.video.poster', label: 'video@poster', spec: '4a', emission: 'engine' },
  { id: 'html.audio.src', label: 'audio@src', spec: '4a', emission: 'engine' },
  { id: 'html.embed.src', label: 'embed@src', spec: '4a', emission: 'engine' },
  { id: 'html.input.src', label: 'input@src', spec: '4a', emission: 'engine' },
  { id: 'html.track.src', label: 'track@src', spec: '4a', emission: 'engine' },
  //
  // 🔴 THREE ROWS, NOT ONE, AND THE MEASUREMENT IS WHAT DECIDED IT (R83).
  // `linkPointsAtAnImage` is two independent branches with two separate returns:
  // delete the icon branch and preload still works, delete the preload branch and icon
  // still works. Under the ladder above they are two shapes — and what the predicate
  // REFUSES is a third. Folding preload into icon would have put two
  // independently-failing things in one row, one day after the rule against that was
  // written down.
  //
  // ⚠️ Named for what they ASSERT, not for their contents. The old label was
  // "stylesheet and manifest", which described three of its four entries — and a row
  // named for its contents rather than its assertion is how the two directions got
  // mixed in the first place.
  {
    id: 'html.link.href.icon',
    label: 'link@href asserted as an icon',
    spec: '4a',
    emission: 'engine',
  },
  {
    id: 'html.link.href.preload',
    label: 'link@href asserted as a preloaded image',
    spec: '4a',
    emission: 'engine',
    why:
      '⚠️ ONE tree instance, and deliberately NOT padded to three — manufacturing two more ' +
      'rel=preload links so the table looks right is R67 aimed at the tree instead of at a test. ' +
      "Carries a `singleReason` in the key and sits on §8.5's growth list beside " +
      '`new URL(..., import.meta.url)`: rel=preload as=image is how a modern page preloads its ' +
      'LCP hero, so reality will supply the instances. Not exotic, just untested.',
  },
  {
    id: 'html.link.href.other',
    label: 'link@href the predicate refuses',
    spec: '4a',
    emission: 'declined',
    why:
      'Every rel value linkPointsAtAnImage declines — a stylesheet, a webmanifest. Homogeneous ' +
      'once preload left, so a zero here is the correct reading and a NON-zero is the failure.',
  },
  { id: 'html.object.data', label: 'object@data', spec: '4a', emission: 'engine' },
  {
    id: 'html.iframe.src',
    label: 'iframe@src',
    spec: '4a',
    emission: 'declined',
    why: 'A path-shaped attribute that must never become a finding. Non-zero is the failure.',
  },
  { id: 'html.svg.image.href', label: 'SVG image@href', spec: '4a', emission: 'engine' },
  { id: 'html.svg.image.xlink', label: 'SVG image@xlink:href', spec: '4a', emission: 'engine' },
  { id: 'html.svg.feimage', label: 'SVG feImage', spec: '4a', emission: 'engine' },
  {
    id: 'html.style.element',
    label: '<style> element carrying CSS',
    spec: '4a',
    emission: 'engine',
    why:
      'Host wins over construct here: what would take these out is HTML failing to EXTRACT the ' +
      'CSS, not the CSS parse. A comment or an image-set inside the same element keeps its own ' +
      'css.* shape, because those break in every host alike.',
  },
  {
    id: 'html.style.attribute',
    label: 'style="" attribute carrying CSS',
    spec: '4a',
    emission: 'engine',
  },
  {
    id: 'html.percent-encoded',
    label: 'a percent-encoded path',
    spec: '4a,4h',
    emission: 'engine',
  },

  // ---- CSS and its dialects ----------------------------------------------------
  { id: 'css.url.bare', label: 'url() unquoted', spec: '4b', emission: 'engine' },
  { id: 'css.url.single', label: 'url() single-quoted', spec: '4b', emission: 'engine' },
  { id: 'css.url.double', label: 'url() double-quoted', spec: '4b', emission: 'engine' },
  { id: 'css.url.nested', label: 'url() inside another function', spec: '4b', emission: 'engine' },
  { id: 'css.image-set', label: 'image-set()', spec: '4b', emission: 'engine' },
  {
    id: 'css.image-set.webkit',
    label: '-webkit-image-set()',
    spec: '4b',
    emission: 'engine',
    why: 'Construct wins over host: it appears in .less too, and what breaks it is image-set parsing.',
  },
  {
    id: 'css.url.in-comment',
    label: 'url() inside a comment',
    spec: '4b',
    emission: 'declined',
    why:
      'Construct wins over host — it is keyed the same in .css, .scss, .less and <style>, because ' +
      "comment handling is the CSS reader's job everywhere. Non-zero is the failure.",
  },
  {
    id: 'css.url.in-selector',
    label: 'url() inside a selector',
    spec: '4b',
    emission: 'declined',
    why:
      'An attribute-selector value that happens to spell url() — `li[data-bg="url(/img/x.png)"]`. ' +
      'The CSS adapter walks DECLARATIONS, so a selector is never visited and nothing is emitted.',
  },
  { id: 'css.var', label: 'url() behind a custom property', spec: '4b', emission: 'engine' },
  { id: 'css.font-face', label: '@font-face src', spec: '4b', emission: 'engine' },
  {
    id: 'css.fragment',
    label: 'url(#fragment)',
    spec: '4b,4g',
    emission: 'declined',
    why: 'A same-document element reference, not a file. Dropped by isExternalUrl.',
  },
  { id: 'scss.url', label: 'url() in .scss', spec: '4b', emission: 'engine' },
  { id: 'scss.variable', label: 'url($variable)', spec: '4b,4c', emission: 'engine' },
  {
    id: 'scss.interpolation.trailing',
    label: 'url() with trailing #{} interpolation',
    spec: '4b',
    emission: 'engine',
  },
  {
    id: 'scss.interpolation.leading',
    label: 'url() with leading #{} interpolation',
    spec: '4b',
    emission: 'engine',
  },
  { id: 'less.url', label: 'url() in .less', spec: '4b', emission: 'engine' },
  { id: 'less.variable', label: 'url(@variable)', spec: '4b', emission: 'engine' },
  {
    id: 'less.interpolation',
    label: 'url() with @{} interpolation',
    spec: '4b',
    emission: 'engine',
  },

  // ---- JavaScript and TypeScript ----------------------------------------------
  {
    id: 'js.import.static',
    label: 'static ESM import of an image',
    spec: '4c',
    emission: 'engine',
  },
  {
    id: 'js.import.alias.mapped',
    label: 'import through a tsconfig paths alias',
    spec: '4c',
    emission: 'engine',
    adapterEmitsAs: ['js.import.static', 'astro.import.frontmatter', 'js.string.literal'],
    needsToSee: 'the tsconfig/vite paths table, which arrives long after the adapter has run',
    why:
      '⚠️ MAPPED and UNMAPPED are the same six characters of source. `~/img/hero.png` resolves or ' +
      'does not depending on a table the adapter cannot see, so an adapter that named either row ' +
      'would be asserting something it cannot know — the shape of every bug this project has paid ' +
      "for. Both rows are therefore the KEY's, and the adapter emits the construct instead.",
  },
  {
    id: 'js.import.alias.unmapped',
    label: 'import through an alias that maps nowhere',
    spec: '4c',
    emission: 'engine',
    adapterEmitsAs: ['js.import.static', 'astro.import.frontmatter', 'js.string.literal'],
    needsToSee: 'the tsconfig/vite paths table, which arrives long after the adapter has run',
  },
  { id: 'js.require', label: 'require() of an image', spec: '4c', emission: 'engine' },
  {
    id: 'js.template.pattern',
    label: 'template literal, one unknown segment',
    spec: '4c',
    emission: 'engine',
  },
  {
    id: 'js.template.dynamic',
    label: 'template literal, nothing static left',
    spec: '4c',
    emission: 'engine',
  },
  {
    id: 'js.concat.dynamic',
    label: 'path assembled by concatenation',
    spec: '4c',
    emission: 'engine',
  },
  {
    id: 'js.string.literal',
    label: 'a path-shaped string literal',
    spec: '4c',
    emission: 'engine',
  },
  {
    id: 'js.jsx.attribute',
    label: 'a literal path in a JSX attribute',
    spec: '4c',
    emission: 'engine',
  },
  { id: 'js.cssinjs', label: 'CSS-in-JS carrying a url()', spec: '4c', emission: 'engine' },

  // ---- Markdown ----------------------------------------------------------------
  { id: 'md.image', label: '![alt](path)', spec: '4d', emission: 'engine' },
  {
    id: 'md.image.reference-style',
    label: '![alt][label]',
    spec: '4d',
    emission: 'declined',
    why:
      'The use site carries no path — it names a label. The path lives in the definition and is ' +
      'keyed as md.reference-definition. Emitting here would double-count one reference.',
  },
  { id: 'md.reference-definition', label: '[label]: path', spec: '4d', emission: 'engine' },
  {
    id: 'md.raw-html',
    label: 'raw HTML inside markdown',
    spec: '4d',
    emission: 'engine',
    why: "Host wins: markdown hands its masked text to the HTML adapter, so this is markdown's row.",
  },
  {
    id: 'md.style-attribute',
    label: 'a style attribute inside markdown',
    spec: '4d',
    emission: 'engine',
  },
  {
    id: 'md.prose-mention',
    label: 'a path named in prose',
    spec: '4d',
    emission: 'declined',
    why:
      'A filename in a sentence is not a reference (R24). Markdown only claims link and image ' +
      'destinations, so bare prose is never collected.',
  },
  {
    id: 'md.code-fence',
    label: 'a path inside a fenced code block',
    spec: '4d',
    emission: 'declined',
    why: 'maskInactiveRegions blanks fenced blocks before anything reads them — code shown, not run.',
  },
  {
    id: 'md.indented-code',
    label: 'a path inside an indented code block',
    spec: '4d',
    emission: 'declined',
    why:
      '🔴 DECLINED IS THE IDEAL, AND TODAY THE ENGINE OVER-CLAIMS HERE — measured, 2 of 3 are ' +
      'emitted as raw HTML. `maskInactiveRegions` deliberately does NOT mask four-space blocks: ' +
      'telling one from a continuation line inside a list needs a real block parser, and guessing ' +
      'wrong would blank a REAL reference, which is the worse failure. So the row reads zero only ' +
      'for a correct engine, and the key carries a knownGap saying so. ⚠️ I first documented this ' +
      'as "masked with the fenced form", which was simply false; the shape audit caught the claim, ' +
      'no test did. ⚠️ It deliberately carries NO `adapterEmitsAs`: this is a GAP the engine could ' +
      'close by masking the block, not a distinction it is structurally unable to see. Declaring it ' +
      'there would excuse the over-claim instead of recording it.',
  },
  {
    id: 'md.inline-code',
    label: 'a path inside inline code',
    spec: '4d',
    emission: 'declined',
    why: 'Masked too. `![alt](x.png)` inside backticks is an example of markdown, not markdown.',
  },
  {
    id: 'md.frontmatter.scalar',
    label: 'an image path in YAML frontmatter',
    spec: '4d',
    emission: 'gap',
    why: "No frontmatter reader. The key's knownGap names the ruling.",
  },
  {
    id: 'md.frontmatter.nested',
    label: 'an image path nested inside frontmatter',
    spec: '4d',
    emission: 'gap',
  },
  { id: 'mdx.import', label: 'an ESM import in MDX', spec: '4d', emission: 'engine' },
  { id: 'mdx.jsx', label: 'a JSX attribute in MDX', spec: '4d', emission: 'engine' },

  // ---- JSON --------------------------------------------------------------------
  {
    id: 'json.webmanifest.icon',
    label: 'a webmanifest icon entry',
    spec: '4e',
    emission: 'engine',
  },
  {
    id: 'json.webmanifest.other',
    label: 'a webmanifest screenshot or shortcut icon',
    spec: '4e',
    emission: 'engine',
    adapterEmitsAs: ['json.webmanifest.icon'],
    needsToSee:
      'which top-level array the entry sits in — `screenshots` and `shortcuts` rather than `icons`',
    why:
      'The JSON adapter walks values and does not model the document, so a `{ src }` object is a ' +
      'webmanifest icon wherever it sits. Telling a screenshot from an icon needs the array it ' +
      'came from, which the flat scanner deliberately does not parse.',
  },
  {
    id: 'json.config.value',
    label: 'an image path in an ordinary JSON config',
    spec: '4e',
    emission: 'engine',
  },
  {
    id: 'json.config.glob',
    label: 'a glob in a JSON config',
    spec: '4e',
    emission: 'declined',
    why:
      'A glob names a SET, not a file. Resolving one would claim every asset it happens to match ' +
      "and report the rest of the repository referenced — R78 Q3's objection in a config file.",
  },

  // ---- Astro -------------------------------------------------------------------
  {
    id: 'astro.import.frontmatter',
    label: 'an ESM import in the frontmatter fence',
    spec: '4f',
    emission: 'engine',
  },
  {
    id: 'astro.template.literal',
    label: 'a literal path in the template body',
    spec: '4f',
    emission: 'engine',
  },
  {
    id: 'astro.template.expression',
    label: 'a path from an expression in the template body',
    spec: '4f',
    emission: 'declined',
    why:
      '`<img src={heroPath} />` carries no path; the path is the const in the fence, keyed as ' +
      'js.string.literal. Counting the use site too would double-count one reference.',
  },
  {
    id: 'astro.style.element',
    label: 'a <style> element in an .astro file',
    spec: '4f',
    emission: 'engine',
  },

  // ---- File types nothing reads (R72 / §4j) -------------------------------------
  { id: 'unread.vue', label: 'a reference inside .vue', spec: '4j', emission: 'gap' },
  { id: 'unread.svelte', label: 'a reference inside .svelte', spec: '4j', emission: 'gap' },
  { id: 'unread.njk', label: 'a reference inside .njk', spec: '4j', emission: 'gap' },
  { id: 'unread.liquid', label: 'a reference inside .liquid', spec: '4j', emission: 'gap' },
  { id: 'unread.erb', label: 'a reference inside .erb', spec: '4j', emission: 'gap' },
  { id: 'unread.php', label: 'a reference inside .php', spec: '4j', emission: 'gap' },

  // ---- Decoys: text that looks like a reference and is not (§4k.4) --------------
  //
  // 🔴 A DECOY ROW IS `declined` BECAUSE NOTHING REACHES THE REPORT, NOT BECAUSE THE
  // ADAPTERS REFUSE IT — and the two were assumed identical until R87 measured them.
  // Of the tree's 24 decoy entries an adapter emits ELEVEN, all as `js.string.literal`,
  // and the resolver discards them once it can see the file is absent. The other
  // thirteen never get that far, because the text fails the adapter's own path-shape
  // test. Both are correct; the row reads the same; `adapterEmitsAs` is the only place
  // the difference is written down.
  //
  // ⚠️ Two of these shapes are SPLIT down that seam, which is worth knowing before
  // reading their rows: `decoy.glob` emits `/gallery/*.png` and `src/**/*.jpg` and
  // declines `/img/hero.{jpg,png}` — brace expansion moves the extension off the end,
  // so the path test fails where a `*` sails through. `decoy.not-a-path` splits the same
  // way. The ROW is still homogeneous in what it asserts (all of them end up discarded),
  // which is why R83's split does not apply; only the layer differs.
  {
    id: 'decoy.comment',
    label: 'a filename inside a code comment',
    spec: '4k.4',
    emission: 'declined',
  },
  {
    id: 'decoy.log-message',
    label: 'a path inside a log message',
    spec: '4k.4',
    emission: 'declined',
  },
  {
    id: 'decoy.typo',
    label: 'a name one character from a real file',
    spec: '4k.4',
    emission: 'declined',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the file exists — adapters never touch the disk, by design',
    why:
      '🔴 ALL FIVE ARE EMITTED BY AN ADAPTER, and they must be: `/img/her.jpg` is indistinguishable ' +
      'from `/img/hero.jpg` as text. The resolver is the first layer that can tell them apart, and ' +
      'discarding there is the correct answer. An adapter that guessed would be guessing about ' +
      'the filesystem from a string.',
  },
  {
    id: 'decoy.not-a-path',
    label: 'extension-shaped text that is not a path',
    spec: '4k.4',
    emission: 'declined',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the file exists',
    why:
      "Split across the layers: `'.png'` and `'.jpg'` are refused by the adapter's path-shape " +
      'test, while `/img/hero.jpg.bak` passes it and is discarded at resolution. See the note ' +
      'above the family.',
  },
  {
    id: 'decoy.glob',
    label: 'a glob rather than a path',
    spec: '4k.4',
    emission: 'declined',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the file exists',
    why: 'Split across the layers — see the note above the family. `*` passes the path test; `{a,b}` does not.',
  },
  {
    id: 'decoy.windows-path',
    label: 'a backslash-separated path',
    spec: '4k.4',
    emission: 'declined',
  },
  {
    id: 'decoy.query-or-hash',
    label: 'a real file with a query string or fragment',
    spec: '4k.4,4g',
    emission: 'engine',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the file exists',
    why:
      'The only decoy row that SHOULD be found: the file is real and the suffix is preserved. ' +
      '🔴 And it is separated from `decoy.typo` by NOTHING BUT THE FILE EXISTING — the tree pairs ' +
      'it with `/img/missing-query.png?v=3`, identical in spelling and keyed as a typo. So this ' +
      'row is the sharpest illustration of R87: two shapes, one syntax, and the only instrument ' +
      'that can tell them apart is the one that reads the disk.',
  },
  {
    id: 'decoy.regex',
    label: 'an extension inside a regular expression',
    spec: '4k.4',
    emission: 'declined',
    why:
      '⚠️ This row measures nothing. A regex escapes the dot, so the bytes read `\\.(png` and the ' +
      "tree's text scan cannot key it. An engine that DID extract a path from a regex would not " +
      'be caught here.',
  },

  // ---- What the path itself is (§4g) -------------------------------------------
  //
  // 🔴 THE DISPOSITION TIER, AND ITS BOUNDARY IS *SPELLING* (R88). A shape belongs here
  // when what would take the reference out is a property of how the path is WRITTEN —
  // which is why it is keyed identically in every host and beats every host shape. An
  // absolute URL inside an `<img src>` is `path.absolute-url`, not `html.img.src`.
  //
  // ⚠️ Two shapes arrived here by rename rather than by design, and the lesson is in the
  // rename: `html.charref` and `js.import.package` were NAMED like host shapes and
  // BEHAVED like dispositions, so every argument about which of them beat a host shape
  // was unwinnable — the tier rule was already written down and the names hid which tier
  // the shape was in. **A name in the wrong namespace is not cosmetic.**
  {
    id: 'path.data-uri',
    label: 'a data: URI',
    spec: '4g',
    emission: 'declined',
    why: 'Disposition wins over host: it is keyed the same in .html and .css. Dropped by isExternalUrl.',
  },
  { id: 'path.absolute-url', label: 'an absolute URL', spec: '4g', emission: 'declined' },
  {
    id: 'path.protocol-relative',
    label: 'a protocol-relative URL',
    spec: '4g',
    emission: 'declined',
  },
  {
    id: 'path.charref',
    label: 'a path spelled with HTML character references',
    spec: '4a,4g',
    emission: 'engine',
    why:
      '⚠️ WAS `html.charref` until R88(a), and the rename is the ruling. A character reference is ' +
      'how the path is SPELLED, so it beats the construct the path sits in — identically to an ' +
      'absolute URL inside an <img src>. The tell that the old name was wrong: `/gallery/a&amp;b.png` ' +
      'in an feImage read as a contest between `html.svg.feimage` and `html.charref`, which the ' +
      '"narrowest thing that breaks alone" test CANNOT settle (both break other entries with them) ' +
      'because that test chooses WITHIN a tier and this is a choice BETWEEN tiers. ' +
      '🔴 The engine has always had the order right — html.ts compares the source text against ' +
      "parse5's decoded value and emits BEFORE any host shape is chosen; only the name disagreed.",
  },
  {
    id: 'path.bare-specifier',
    label: 'a bare package specifier',
    spec: '4c,4g',
    emission: 'engine',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the first path segment is an installed package — node_modules',
    why:
      '⚠️ WAS `js.import.package` until R88(b). R32 keeps it out of scope — the file exists inside ' +
      'a dependency and is not ours to rewrite — and that is true of the SPELLING, not of the ' +
      'construct: the tree holds one as an `import`, one inside `require()` and one as a plain ' +
      'string constant, and a row covering all three could not go on being called `import` ' +
      '(R83: name it for what it ASSERTS). ' +
      '🔴 BUT R88(b) ALSO ARGUED ALL THREE FAIL TOGETHER, AND MEASUREMENT SAYS TWO DO. Inside ' +
      '`import`/`require` a bare string IS module-resolution syntax, so the prefix test decides it. ' +
      'In an ordinary string it decides nothing: `some-ui-kit/dist/x.png` and `src/assets/x.png` are ' +
      'the same syntax, and asserting the disposition there labelled 351 corpus references as ' +
      "packages — `loading...`, `bs.button`, `v2.0.0`. So the plain-string third is the RESOLVER's " +
      "to draw and is declared above. ⚠️ Whether that makes it a separate row under R82's ladder " +
      'is a live question raised to the parent chat, not one settled here.',
  },

  // ---- What the RESOLVER found, which no adapter can see (R87) ------------------
  {
    id: 'pattern.partial',
    label: 'a pattern matching only some of the files it names',
    spec: '4c,4b',
    emission: 'engine',
    adapterEmitsAs: ['js.template.pattern', 'scss.interpolation.trailing'],
    needsToSee: 'which of the files the pattern names actually exist on disk',
    why:
      'R80(a), applied by R89. `tileImage(density: 1 | 2 | 3)` returns `/srcset/tile@${density}x.png` ' +
      'and `tile@1x.png` does not exist, so ONE reference stands for two files while its own type ' +
      'promises three. 🔴 Its own row because a partial match is R65 territory — one sibling ' +
      'failing withdraws the whole pattern and every conversion with it — so folding it into the ' +
      'complete-match row would hide the case that cost a P0. ' +
      '⚠️ It has no host prefix on purpose: the mechanism is the resolver glob and is identical in ' +
      'SCSS and JS. And it is NOT a `path.*` shape, because nothing about the spelling says the ' +
      'set is incomplete — the same template is complete in a tree where one more file exists. ' +
      'That is exactly what makes it `adapterEmitsAs`.',
  },

  // ---- Found in the engine, absent from the tree (§8.5 growth list) -------------
  //
  // 🔴 These are the measurement R76 promised, arriving before it ran: constructs an
  // adapter emits today that the tree has NO instance of, so nothing tests them. They
  // are declared here rather than left nameless — a shape with no name cannot be
  // reported as uncovered, it just vanishes, which is R76's whole objection.
  {
    id: 'js.import.dynamic',
    label: 'a dynamic import() of an image',
    spec: '§8.5',
    emission: 'engine',
    why: '🔴 NO TREE INSTANCE. Emitted by collectFromImportExpression; nothing measures it.',
  },
  {
    id: 'js.new-url',
    label: "new URL('./x.png', import.meta.url)",
    spec: '§8.5',
    emission: 'engine',
    why:
      '🔴 NO TREE INSTANCE, and this is the loudest of the four: it is the asset pattern VITE AND ' +
      "WEBPACK 5 BOTH DOCUMENT. Not an exotic shape — a whole build tool's default, untested.",
  },
  {
    id: 'js.jsx.srcset',
    label: 'a JSX srcSet candidate list',
    spec: '§8.5',
    emission: 'engine',
    why:
      '🔴 NO TREE INSTANCE. The tree tests html.img.srcset.* but that is a different adapter and a ' +
      'different code path — JSX srcSet is split by addJsxAttributeValue.',
  },
  {
    id: 'js.jsx.svg',
    label: 'a JSX inline-SVG <image href>',
    spec: '§8.5',
    emission: 'engine',
    why: '🔴 NO TREE INSTANCE. collectFromJsxSvgImage; the HTML twin is tested, this one is not.',
  },
] as const satisfies readonly ShapeDeclaration[];

/**
 * Every shape id, as a type.
 *
 * Derived from `SHAPES` rather than written out, so an adapter naming a shape that does
 * not exist is a compile error and the list has no second spelling to fall out of step
 * with. The coverage tree is the only other copy, and `shapes.reconcile.test.ts` holds
 * that one.
 */
export type ShapeId = (typeof SHAPES)[number]['id'];

/** Every shape id, for a membership test. */
export const SHAPE_IDS: ReadonlySet<string> = new Set(SHAPES.map((shape) => shape.id));

/**
 * Shapes that no tree entry instantiates, so nothing measures them.
 *
 * ⚠️ **An `absent` shape that never gains an instance becomes furniture.** The matrix
 * prints these as an explicit growth list rather than as rows, so they read as a debt
 * somebody owes rather than as a table that happens to have gaps in it.
 */
export const UNTESTED_SHAPE_IDS: readonly string[] = [
  'js.import.dynamic',
  'js.new-url',
  'js.jsx.srcset',
  'js.jsx.svg',
];

export function shapeById(id: string): ShapeDeclaration | undefined {
  return SHAPES.find((shape) => shape.id === id);
}
