/**
 * Which build bundles each file: one Upfly knows loads a converted image by itself, another
 * build, or none it can name.
 *
 * A file belongs to the package whose folder holds the nearest `package.json` at or above it.
 * A build tool runs in a package's folder and reads its settings there, so settings further
 * up belong to another package's build and cannot vouch for this one. In that folder the
 * build is named by its settings file, or, when there is none, by the command its `build`
 * script runs, as a Vite project with no `vite.config` builds with `vite build`.
 * See "Images a build loads" in ARCHITECTURE.md.
 */

import { compareStrings } from '../paths.js';

/** A build that loads WebP and AVIF by itself, from an import or a stylesheet's `url()`. */
export type KnownBuild = 'Vite' | 'Next.js' | 'Astro';

/** What Upfly found about the build of one package. */
export type Build =
  | { readonly kind: 'known'; readonly name: KnownBuild }
  /**
   * Another build, which may have no rule for a converted format. `file` is its settings
   * file, POSIX-relative to the project root, or the `package.json` whose build script runs
   * it, and then `command` is the part of the script that does.
   */
  | { readonly kind: 'other'; readonly file: string; readonly command?: string }
  /** No settings file and no build script naming a build. */
  | { readonly kind: 'none' };

/** The build of every package in a project. */
export interface ProjectBuilds {
  /** Each folder holding a `package.json`, POSIX-relative (`''` for the root), deepest first. */
  readonly packages: readonly { readonly folder: string; readonly build: Build }[];
}

/**
 * The settings files each known build reads, as its own source lists them: Vite's
 * `DEFAULT_CONFIG_FILES`, Next.js's `CONFIG_FILES` and Astro's `configPaths`.
 */
const KNOWN_SETTINGS: readonly (readonly [RegExp, KnownBuild])[] = [
  [/^vite\.config\.(js|mjs|ts|cjs|mts|cts)$/, 'Vite'],
  [/^next\.config\.(js|mjs|ts)$/, 'Next.js'],
  [/^astro\.config\.(mjs|js|ts|mts|cjs|cts)$/, 'Astro'],
];

/**
 * Settings files of builds Upfly cannot vouch for: webpack under any of its usual names
 * (`webpack.config.js`, `webpack.prod.js`), Rollup, Rspack, Rsbuild, esbuild scripts, Vue
 * CLI, CRACO and Gatsby, which configure webpack, Parcel and Angular.
 */
const OTHER_SETTINGS =
  /^(webpack(\.[\w-]+)*\.[cm]?[jt]s|(rollup|rspack|rsbuild|esbuild|vue|craco)\.config\.[cm]?[jt]s|gatsby-config\.[cm]?[jt]s|\.parcelrc|angular\.json)$/;

/** The command that runs each known build. */
const KNOWN_COMMANDS: readonly (readonly [string, KnownBuild])[] = [
  ['vite', 'Vite'],
  ['next', 'Next.js'],
  ['astro', 'Astro'],
];

/** Programs that bundle a project's images with rules Upfly cannot read. */
const OTHER_BUNDLERS: ReadonlySet<string> = new Set([
  'webpack',
  'webpack-cli',
  'rollup',
  'esbuild',
  'parcel',
  'rspack',
  'rsbuild',
  'react-scripts',
  'craco',
  'vue-cli-service',
  'ng',
  'gatsby',
  'tsup',
  'microbundle',
]);

/**
 * Words that run the program after them: an environment setting, or a launcher. `npm` is
 * not one: `npm run x` runs another script, which this does not follow.
 */
const LAUNCHER = /^([A-Za-z_][A-Za-z0-9_]*=.*|cross-env|npx|pnpm|yarn|bun|bunx|exec|dlx|--)$/;

/**
 * Find the build of every package in the walk, reading only each `package.json`.
 *
 * @param options every file the walk found, claimed or not, and how to read one
 * @returns each package's build, deepest folder first
 */
export async function detectBuilds(options: {
  readonly files: readonly { readonly path: string; readonly relative: string }[];
  readonly readFile: (path: string) => Promise<string>;
}): Promise<ProjectBuilds> {
  const namesIn = new Map<string, string[]>();
  for (const { relative } of options.files) {
    const slash = relative.lastIndexOf('/');
    const folder = slash === -1 ? '' : relative.slice(0, slash);
    const names = namesIn.get(folder) ?? [];
    names.push(relative.slice(slash + 1));
    namesIn.set(folder, names);
  }

  const packages: { folder: string; build: Build }[] = [];
  for (const file of options.files) {
    const slash = file.relative.lastIndexOf('/');
    if (file.relative.slice(slash + 1) !== 'package.json') continue;
    const folder = slash === -1 ? '' : file.relative.slice(0, slash);
    const script = buildScript(await options.readFile(file.path).catch(() => ''));
    packages.push({
      folder,
      build: buildIn(folder, [...(namesIn.get(folder) ?? [])].sort(compareStrings), script),
    });
  }
  packages.sort((a, b) => b.folder.length - a.folder.length || compareStrings(a.folder, b.folder));
  return { packages };
}

/**
 * The build of the package a file sits in.
 *
 * @param builds what `detectBuilds` found
 * @param file the file's POSIX path, relative to the project root
 */
export function buildOf(builds: ProjectBuilds, file: string): Build {
  const found = builds.packages.find(
    ({ folder }) => folder === '' || file === folder || file.startsWith(`${folder}/`),
  );
  return found?.build ?? { kind: 'none' };
}

/**
 * One package's build. A build Upfly cannot vouch for, named anywhere in the package,
 * outweighs a known one: which of the two loads a file cannot be told from the outside.
 */
function buildIn(folder: string, names: readonly string[], script: string | null): Build {
  const inFolder = (name: string) => (folder === '' ? name : `${folder}/${name}`);

  const otherSettings = names.find((name) => OTHER_SETTINGS.test(name));
  if (otherSettings !== undefined) return { kind: 'other', file: inFolder(otherSettings) };

  const commands = script === null ? [] : commandsOf(script);
  const otherCommand = commands.find(([program]) => OTHER_BUNDLERS.has(program ?? ''));
  if (otherCommand !== undefined) {
    return { kind: 'other', file: inFolder('package.json'), command: otherCommand.join(' ') };
  }

  for (const [pattern, name] of KNOWN_SETTINGS) {
    if (names.some((each) => pattern.test(each))) return { kind: 'known', name };
  }
  for (const [program, name] of KNOWN_COMMANDS) {
    if (commands.some(([first, second]) => first === program && second === 'build')) {
      return { kind: 'known', name };
    }
  }
  return { kind: 'none' };
}

/** The `build` script of a `package.json`'s text, or null when it has none it can read. */
function buildScript(text: string): string | null {
  try {
    const manifest: unknown = JSON.parse(text);
    if (typeof manifest !== 'object' || manifest === null || !('scripts' in manifest)) return null;
    const { scripts } = manifest;
    if (typeof scripts !== 'object' || scripts === null || !('build' in scripts)) return null;
    return typeof scripts.build === 'string' ? scripts.build : null;
  } catch {
    return null;
  }
}

/**
 * Each command a script runs, as its words from the program on: `NODE_OPTIONS=... webpack
 * --bail` gives `webpack --bail`, and `tsc && vite build` gives two commands.
 */
function commandsOf(script: string): string[][] {
  return script
    .split(/&&|\|\||[;|&()]/)
    .map((command) => {
      const words = command.trim().split(/\s+/).filter(Boolean);
      const start = words.findIndex((word) => !LAUNCHER.test(word));
      return start === -1 ? [] : words.slice(start);
    })
    .filter((words) => words.length > 0);
}
