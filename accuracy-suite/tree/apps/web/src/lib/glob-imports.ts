// Glob imports, which Vite expands into one import for each file a pattern matches.

/** Every badge, loaded with the module. */
export const badges = import.meta.glob('../assets/badges/*.png', { eager: true });

/** Every picture the components hold, at any depth, as URLs. */
export const componentArt = import.meta.glob('../components/**/*.png', {
  query: '?url',
  import: 'default',
});

/** The top-level assets in either format, through the app's alias. */
export const artwork = import.meta.glob<{ default: string }>('@/assets/*.{png,jpg}');

/** The assets at any depth, the second badge left out. */
export const allButOne = import.meta.glob(['../assets/**/*.png', '!**/badge-2.png']);
