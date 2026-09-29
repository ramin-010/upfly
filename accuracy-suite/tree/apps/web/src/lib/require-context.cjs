// webpack's require.context, which bundles every file under a folder whose path from that
// folder, written from `./`, a regular expression matches.

/** The top-level art, one folder only: the badges a folder down are not bundled. */
const art = require.context('../assets', false, /\.(png|jpe?g)$/);

/** The folder alone: every file at any depth. */
const everything = require.context('../assets');

/** Only the badges, picked out by the path the expression is tested against. */
const badges = require.context('../assets', true, /^\.\/badges\//);

/** An expression read from the environment, which only the build can work out. */
const themed = require.context('../components', true, new RegExp(process.env.THEME_ICONS));

module.exports = { art, everything, badges, themed };
