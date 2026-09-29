// webpack's import.meta.webpackContext, the ES module form of require.context: a folder, and
// options that say which files under it are bundled and how they load.

/** The top-level art, one folder only: the badges a folder down are not bundled. */
export const art = import.meta.webpackContext('../assets', {
  recursive: false,
  regExp: /\.(png|jpe?g)$/,
});

/** Options that change how the files load, not which: every file at any depth. */
export const everything = import.meta.webpackContext('../assets', {
  mode: 'lazy',
  chunkName: 'assets',
});

/** Only the badges, picked out by the path the expression is tested against. */
export const badges = import.meta.webpackContext(`../assets`, { regExp: /^\.\/badges\// });

/** An expression read from the environment, which only the build can work out. */
export const themed = import.meta.webpackContext('../components', {
  regExp: new RegExp(process.env.THEME_ICONS),
});
