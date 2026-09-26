/**
 * The reference-shape vocabulary: which construct a reference was written in.
 *
 * A reference's resolution says what happened to it; its shape says what it is, so the
 * coverage matrix can count outcomes per construct. The coverage tree's answer key
 * (`coverage-tree/key/coverage-key.json`) defines the list, and this file holds a second copy.
 * Neither can import the other: the key's checker, `check-key.mjs`, imports only `node:`
 * modules and files beside it, so the key is never certified by the engine it measures, and
 * a shipped package must not depend on a test fixture. `shapes.reconcile.test.ts` fails when
 * the two copies differ in either direction.
 *
 * A shape names the narrowest thing whose breakage would take out that reference and no
 * others. See "Reference shapes" in ARCHITECTURE.md.
 */

/**
 * What the engine as a whole reports for a shape and, when it reports nothing, whether that
 * is a gap or the correct answer.
 *
 * The coverage matrix counts each class apart and never adds them together, so a zero reads
 * differently for a missing reader and for a decoy correctly ignored. Only `engine` rows form
 * the claimed population, where a miss is a bug. The class describes what reaches the report,
 * not what an adapter emits: an adapter emits a `decoy.typo` as a `js.string.literal`, and the
 * resolver discards it once it finds no such file. `ShapeDeclaration.adapterEmitsAs` records
 * where the two layers differ.
 */
export type ShapeEmission =
  /** The engine reports a reference here. A row counts found against expected. */
  | 'engine'
  /**
   * No adapter reads this yet, so a zero is expected and each key entry's `knownGap`
   * records the missing reader. References inside `.vue` files are an example.
   */
  | 'gap'
  /**
   * The text is not a live path to a file, so reporting nothing is correct: a decoy, a data
   * URI, a path inside a code fence, a `url(#grain)` naming an element. A count above zero is
   * the failure. An adapter may decline to emit it at all, or emit it under a broader shape
   * for the resolver to discard, which `adapterEmitsAs` records.
   */
  | 'declined'
  /**
   * A real, reachable file the engine chooses not to index: an absolute URL, an
   * `<iframe src>` naming a document, a stylesheet `<link>`. Reporting nothing is a scope
   * decision, not a defect. Text that is not a live path at all is `declined` instead.
   *
   * The class belongs to the shape, while each tree entry keeps its own expected outcome, so
   * a claimed shape can hold an unclaimed target: `html.video.src` is `engine`, and its
   * entries naming an `.mp4` are keyed `expect: out-of-scope`.
   */
  | 'unclaimed';

export interface ShapeDeclaration {
  readonly id: string;
  /** How the shape reads in prose, for a matrix row. */
  readonly label: string;
  /** Which coverage-tree spec section asked for it. */
  readonly spec: string;
  readonly emission: ShapeEmission;
  /**
   * What the construct is and why the engine emits, declines or leaves it, with any gap that
   * remains. `shapes.reconcile.test.ts` requires one on every `declined` or `unclaimed` row,
   * except a `declined` row in the `decoy.*` or `path.*` family.
   */
  readonly why?: string;
  /**
   * The broader shapes an adapter emits in place of this one, because telling them apart
   * needs a fact only the resolver has. Absent means an adapter always names this shape
   * itself. It can cover part of a shape: inside `import` or `require()` a bare specifier is
   * module syntax and the adapter names `path.bare-specifier`, while the same text in a plain
   * string is emitted as `js.string.literal`.
   *
   * When the engine's shape and the key's disagree, the coverage matrix reads this field to
   * tell a correct difference of layer from a defect, so the harness keeps no exemption list
   * of its own. `shapes.reconcile.test.ts` checks that each id names another real shape.
   */
  readonly adapterEmitsAs?: readonly string[];
  /**
   * The fact the adapter cannot see, in a few words, such as "whether the file exists".
   * Required alongside `adapterEmitsAs`, so each exemption names something a reader can
   * check against the code.
   */
  readonly needsToSee?: string;
}

/**
 * Every reference shape the engine knows, and what it reports for each.
 *
 * Rows follow the coverage key's order, except that `path.charref`, `path.bare-specifier`,
 * `pattern.partial` and `decoy.regex` sit with their families. `as const satisfies` keeps
 * the literal ids, so `ShapeId` is derived from this array and an adapter can only name a
 * shape that exists here.
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
      "Everything after an unclosed raw-text tag such as `<style>` is the element's content, " +
      'not markup, so a browser renders none of it and the engine reports no reference there. ' +
      'When that content fails to parse as CSS, `styleElementFailure` reports the unclosed tag ' +
      'and its line. Markdown blanks an unclosed tag instead (`maskInactiveRegions`), because ' +
      'there a raw-text block has to begin a line.',
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
  // Three `<link href>` rows. `linkImageClaim` in `html.ts` claims icons and preloaded
  // images in two independent branches, so each can break without the other, and what it
  // refuses is a third row. Each is named for what the link asserts, not for what its
  // entries hold.
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
      'A `<link rel="preload" as="image">`, the usual way a page preloads its hero image, ' +
      'claimed by the preload branch of `linkImageClaim` in `html.ts`. The coverage tree holds ' +
      'one instance rather than the usual three, because links written only to fill the row ' +
      'would add no new case.',
  },
  {
    id: 'html.link.href.other',
    label: 'link@href the predicate refuses',
    spec: '4a',
    emission: 'unclaimed',
    why:
      'A `<link href>` whose `rel` names neither an icon nor a preloaded image, such as a ' +
      'stylesheet or a web app manifest. `linkImageClaim` refuses it and nothing is emitted: ' +
      'the file is real, but it is read as a source file, not indexed as an image.',
  },
  { id: 'html.object.data', label: 'object@data', spec: '4a', emission: 'engine' },
  {
    id: 'html.iframe.src',
    label: 'iframe@src',
    spec: '4a',
    emission: 'unclaimed',
    why:
      'An `<iframe src>` names an HTML document: a real file, but never an image asset. The ' +
      'HTML adapter does not read the attribute, because reporting the document would be a ' +
      'false finding.',
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
      'A `url()` in CSS inside a `<style>` element. It is named for the host, because what ' +
      'would take it out is the HTML adapter failing to extract the CSS; an `image-set()` or a ' +
      'comment in the same element keeps its `css.*` shape, since those break the same way in ' +
      'every host.',
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
    why:
      'The vendor-prefixed `-webkit-image-set()`. It is named for the construct rather than ' +
      'the host, because what would break it is image-set parsing, which `.css`, `.less` and ' +
      'every other host share.',
  },
  {
    id: 'css.url.in-comment',
    label: 'url() inside a comment',
    spec: '4b',
    emission: 'declined',
    why:
      'A `url()` inside a CSS, SCSS or Less comment is not a reference, and the CSS adapter ' +
      'never reads comments. The shape is the same in every host, because comment handling is ' +
      "the CSS reader's job wherever the CSS sits.",
  },
  {
    id: 'css.url.in-selector',
    label: 'url() inside a selector',
    spec: '4b',
    emission: 'declined',
    why:
      'An attribute-selector value that happens to spell `url()`, as in ' +
      '`li[data-bg="url(/img/x.png)"]`. The CSS adapter reads declarations, never selectors, ' +
      'so nothing is emitted.',
  },
  { id: 'css.var', label: 'url() behind a custom property', spec: '4b', emission: 'engine' },
  { id: 'css.font-face', label: '@font-face src', spec: '4b', emission: 'engine' },
  {
    id: 'css.fragment',
    label: 'url(#fragment)',
    spec: '4b,4g',
    emission: 'declined',
    why:
      'A `url(#id)` naming an element in the same document, such as an SVG filter or clip ' +
      'path, not a file. `isExternalUrl` drops it before anything is emitted.',
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
    adapterEmitsAs: [
      'js.import.static',
      'astro.import.frontmatter',
      'mdx.import',
      'js.string.literal',
    ],
    needsToSee: 'the tsconfig/vite paths table, which arrives long after the adapter has run',
    why:
      'An import through an alias the project maps in its `tsconfig` or Vite config, such as ' +
      '`~/img/hero.png`. A mapped and an unmapped alias look the same in source, and only the ' +
      'paths table, which the adapter cannot see, tells them apart, so the adapter emits the ' +
      "construct's own shape and never names this row.",
  },
  {
    id: 'js.import.alias.unmapped',
    label: 'import through an alias that maps nowhere',
    spec: '4c',
    emission: 'engine',
    adapterEmitsAs: [
      'js.import.static',
      'astro.import.frontmatter',
      'mdx.import',
      'js.string.literal',
    ],
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
    id: 'js.concat.pattern',
    label: 'path assembled by concatenation, one unknown segment',
    spec: '4c',
    emission: 'engine',
    why:
      "A `+` chain such as `'/icons/icon-' + size + '.png'`: a fixed directory and one unknown " +
      'part of the file name, with no literal that is a complete path on its own. It is read ' +
      'as its template-literal twin is and resolved as a pattern. It has its own row because ' +
      '`collectFromChain` assembles chains apart from the template reader, so either can ' +
      'break without the other.',
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
      'A reference-style image, `![alt][label]`, names a label, not a path. The path sits in ' +
      "the label's definition, reported as `md.reference-definition`, so emitting the use " +
      'site too would count one reference twice.',
  },
  { id: 'md.reference-definition', label: '[label]: path', spec: '4d', emission: 'engine' },
  {
    id: 'md.raw-html',
    label: 'raw HTML inside markdown',
    spec: '4d',
    emission: 'engine',
    why:
      'An HTML element written inside a markdown file. The markdown adapter hands its masked ' +
      'text to the HTML adapter and relabels what comes back, because what would take these ' +
      "out is markdown's masking and hand-off, not HTML parsing.",
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
      'A path named in a sentence is not a reference, and rewriting it would edit prose. The ' +
      'markdown adapter reads only link and image destinations, link definitions and raw ' +
      'HTML, so a sentence is never collected.',
  },
  {
    id: 'md.code-fence',
    label: 'a path inside a fenced code block',
    spec: '4d',
    emission: 'declined',
    why:
      'A path inside a fenced code block is an example, not a reference. ' +
      '`maskInactiveRegions` blanks fenced blocks before any reader sees the text.',
  },
  {
    id: 'md.indented-code',
    label: 'a path inside an indented code block',
    spec: '4d',
    emission: 'declined',
    why:
      'A path inside an indented code block is an example, not a reference. ' +
      '`maskInactiveRegions` blanks such a block in `.md` and `.markdown` only where it is ' +
      'certainly code: never inside a list item, a paragraph that carries on, or a `<pre>`, ' +
      '`<script>`, `<style>` or `<textarea>` block, and never in `.mdx`, which has no indented ' +
      'code. The adapter sees this distinction itself, so any reference reported here is a ' +
      'defect.',
  },
  {
    id: 'md.inline-code',
    label: 'a path inside inline code',
    spec: '4d',
    emission: 'declined',
    why:
      'A path inside an inline code span, such as a markdown image written between ' +
      'backticks, is an example, not a reference. `maskInactiveRegions` blanks code spans ' +
      'before any reader sees the text.',
  },
  {
    id: 'md.frontmatter.scalar',
    label: 'an image path in YAML frontmatter',
    spec: '4d',
    emission: 'gap',
    why:
      'An image path in a YAML frontmatter key such as `image:` or `cover:`. No adapter reads ' +
      'frontmatter yet, so the engine does not report these references, and the key records ' +
      'each one as a known gap.',
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
      "A web app manifest's `screenshots` entry or shortcut icon. The JSON adapter scans " +
      "string values without parsing the document's structure, so every path in a manifest " +
      'is emitted as `json.webmanifest.icon`; telling a screenshot from an icon needs the ' +
      'array it sits in.',
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
      'A glob such as `**/*.png` in a JSON config names a set of files, not one file. The ' +
      'resolver does not expand it, since that would mark every matching asset as referenced; ' +
      'looked up as a literal name, it matches nothing and is discarded.',
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
      'An expression such as `<img src={heroPath} />` in an `.astro` template carries no ' +
      'path; the path is the constant declared in the frontmatter fence, reported as ' +
      '`js.string.literal`. Reporting the use site too would count one reference twice.',
  },
  {
    id: 'astro.style.element',
    label: 'a <style> element in an .astro file',
    spec: '4f',
    emission: 'engine',
  },

  // ---- File types nothing reads -----------------------------------------------
  { id: 'unread.vue', label: 'a reference inside .vue', spec: '4j', emission: 'gap' },
  { id: 'unread.svelte', label: 'a reference inside .svelte', spec: '4j', emission: 'gap' },
  { id: 'unread.njk', label: 'a reference inside .njk', spec: '4j', emission: 'gap' },
  { id: 'unread.liquid', label: 'a reference inside .liquid', spec: '4j', emission: 'gap' },
  { id: 'unread.erb', label: 'a reference inside .erb', spec: '4j', emission: 'gap' },
  { id: 'unread.php', label: 'a reference inside .php', spec: '4j', emission: 'gap' },

  // ---- Decoys: text that looks like a reference and is not --------------------
  //
  // Except for `decoy.query-or-hash`, whose files are real, a decoy row is `declined` because
  // nothing reaches the report, not because the adapters refuse it. Some decoys are never
  // emitted: they sit in a comment, or fail the adapter's path-shape test. Others are emitted
  // as `js.string.literal` and discarded by the resolver once it finds no such file.
  // `decoy.glob` and `decoy.not-a-path` hold both kinds, and each stays one row because all
  // its entries assert the same outcome.
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
      'A string one character away from a real file, such as `/img/her.jpg` beside ' +
      '`/img/hero.jpg`. As text it cannot be told from a real path, so the adapter emits it as ' +
      '`js.string.literal` and the resolver discards it once it finds no such file.',
  },
  {
    id: 'decoy.not-a-path',
    label: 'extension-shaped text that is not a path',
    spec: '4k.4',
    emission: 'declined',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the file exists',
    why:
      'Text carrying an image extension that names no image: a `.png` string that is only the ' +
      "tail of a `+` chain, or `/img/hero.jpg.bak`. The adapter's path-shape test refuses the " +
      'bare `.png`, while `/img/hero.jpg.bak` passes it, is emitted as `js.string.literal` and ' +
      'is dropped by the resolver, because `.bak` is not an image extension.',
  },
  {
    id: 'decoy.glob',
    label: 'a glob rather than a path',
    spec: '4k.4',
    emission: 'declined',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the file exists',
    why:
      'A glob such as `/gallery/*.png` matches files without naming one. A `*` glob passes ' +
      "the adapter's path-shape test, is emitted as `js.string.literal` and is discarded by " +
      'the resolver, which finds no file of that name; `/img/hero.{jpg,png}` holds a comma, ' +
      'which the test refuses.',
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
      'A real file with a query string or fragment, such as `/img/hero.jpg?v=3`, reported ' +
      'because the file exists and the suffix is kept out of the path. Only that existence ' +
      'separates it from `decoy.typo`: the tree also holds `/img/missing-query.png?v=3`, ' +
      'spelled the same way and naming nothing, so only the resolver, which checks the disk, ' +
      'can tell the two apart.',
  },
  {
    id: 'decoy.regex',
    label: 'an extension inside a regular expression',
    spec: '4k.4',
    emission: 'declined',
    why:
      'An image extension inside a regular expression, such as `/\\.(png|jpe?g|svg)$/i`, is ' +
      'code about images, not a reference. The row measures nothing: the regex escapes the ' +
      "dot, so the tree's text scan cannot find the extension to key it, and an engine that " +
      'did take a path from a regex would not be caught here.',
  },

  // ---- What the path itself is ------------------------------------------------
  //
  // A shape belongs here when what would take the reference out is how the path is spelled.
  // It is keyed the same in every host and takes precedence over the host's shape: an
  // absolute URL in an `<img src>` is `path.absolute-url`, not `html.img.src`.
  {
    id: 'path.data-uri',
    label: 'a data: URI',
    spec: '4g',
    emission: 'declined',
    why:
      'A `data:` URI carries the image itself, so there is no file to point at, and rewriting ' +
      'one would corrupt it. It is keyed the same in every host, and `isExternalUrl` drops it ' +
      'before anything is emitted.',
  },
  {
    id: 'path.absolute-url',
    label: 'an absolute URL',
    spec: '4g',
    emission: 'unclaimed',
    why:
      'An absolute URL such as `https://cdn.example.com/hero.png` names a real, reachable file ' +
      "on another host, which is not the project's to rewrite. `isExternalUrl` drops it, so " +
      'leaving it unreported is a scope decision, not a defect.',
  },
  {
    id: 'path.protocol-relative',
    label: 'a protocol-relative URL',
    spec: '4g',
    emission: 'unclaimed',
    why:
      'A protocol-relative URL such as `//cdn.example.com/hero.png` names a remote file over ' +
      "the page's own scheme: real, but not the project's. `isExternalUrl` drops it. It is " +
      '`unclaimed` rather than `declined` because its target is a real file, even though its ' +
      'text is not a local path.',
  },
  {
    id: 'path.charref',
    label: 'a path spelled with HTML character references',
    spec: '4a,4g',
    emission: 'engine',
    why:
      'A path spelled with HTML character references, such as `/gallery/a&amp;b.png`. ' +
      'Spelling takes precedence over the attribute the path sits in, so at each reference ' +
      "position `html.ts` compares the source text with parse5's decoded value and emits this " +
      'shape when they differ. The resolver tries the decoded spelling and a rewrite ' +
      're-encodes it; a path that does not fully decode stays `unsafe`.',
  },
  {
    id: 'path.bare-specifier',
    label: 'a bare package specifier',
    spec: '4c,4g',
    emission: 'engine',
    adapterEmitsAs: ['js.string.literal'],
    needsToSee: 'whether the first path segment is an installed package — node_modules',
    why:
      'A bare package specifier such as `some-ui-kit/dist/logo.png` names a file inside a ' +
      "dependency: real, but not the project's to rewrite, so it resolves `out-of-scope`. " +
      'Inside `import`, `import()` and `require()` the adapter recognises it by its spelling; ' +
      'in a plain string the same text could be a relative path written without `./`, so the ' +
      'adapter emits `js.string.literal` and the resolver treats it as an ordinary path.',
  },

  // ---- What only the resolver can see -----------------------------------------
  {
    id: 'pattern.partial',
    label: 'a pattern matching only some of the files it names',
    spec: '4c,4b',
    emission: 'engine',
    adapterEmitsAs: ['js.template.pattern', 'scss.interpolation.trailing'],
    needsToSee: 'which of the files the pattern names actually exist on disk',
    why:
      'A pattern that matches only some of the files its code can produce: ' +
      '`tileImage(density: 1 | 2 | 3)` returns `/srcset/tile@${density}x.png` and ' +
      '`tile@1x.png` does not exist, so the reference links two files while its type promises ' +
      'three. A row of complete matches alone would not notice a change in how partial ones ' +
      'are handled. Nothing in the spelling shows the set is incomplete, in SCSS or JavaScript, ' +
      'so adapters emit `js.template.pattern` or `scss.interpolation.trailing` and only the ' +
      'files on disk tell the two apart.',
  },

  // ---- Emitted by an adapter, absent from the coverage tree -------------------
  //
  // Nothing measures these yet. They are declared rather than left unnamed, because a shape
  // with no name cannot be reported as uncovered. `UNTESTED_SHAPE_IDS` lists them.
  {
    id: 'js.import.dynamic',
    label: 'a dynamic import() of an image',
    spec: '§8.5',
    emission: 'engine',
    why:
      'A dynamic `import()` of an image, emitted by `collectFromImportExpression`. The ' +
      'coverage tree has no instance of it, so nothing measures it.',
  },
  {
    id: 'js.new-url',
    label: "new URL('./x.png', import.meta.url)",
    spec: '§8.5',
    emission: 'engine',
    why:
      '`new URL(path, import.meta.url)`, the asset-reference pattern Vite and webpack 5 both ' +
      'document, emitted by the JavaScript adapter. The coverage tree has no instance of it, ' +
      'so nothing measures it.',
  },
  {
    id: 'js.jsx.srcset',
    label: 'a JSX srcSet candidate list',
    spec: '§8.5',
    emission: 'engine',
    why:
      'A `srcSet` candidate list in JSX, split with the same `parseSrcset` the HTML adapter ' +
      'uses. The coverage tree has no instance of it; its `html.img.srcset.*` rows reach that ' +
      'code only through the HTML adapter.',
  },
  {
    id: 'js.jsx.svg',
    label: 'a JSX inline-SVG <image href>',
    spec: '§8.5',
    emission: 'engine',
    why:
      'An `<image href>` or `<feImage href>` in inline SVG inside JSX, read by ' +
      '`collectFromJsxSvgImage`. The coverage tree tests the HTML version (`html.svg.*`) but ' +
      'has no JSX instance, so nothing measures this one.',
  },
] as const satisfies readonly ShapeDeclaration[];

/**
 * Every shape id, as a type. Derived from `SHAPES`, so an adapter naming a shape that does
 * not exist is a compile error.
 */
export type ShapeId = (typeof SHAPES)[number]['id'];

/** Every shape id, for a membership test. */
export const SHAPE_IDS: ReadonlySet<string> = new Set(SHAPES.map((shape) => shape.id));

/**
 * Shapes an adapter emits that no coverage-tree entry instantiates, so nothing measures them.
 *
 * `shapes.reconcile.test.ts` accepts these ids without a tree instance and fails once one
 * gains an instance, so the list cannot outlive the gap.
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
