// Each path is resolved against this module's own URL, so a bare one is a file below it,
// as a relative one is. The dark variant and the light icon were never added.
export const logoUrl = new URL('logo.png', import.meta.url).href;
export const darkLogoUrl = new URL('logo-dark.png', import.meta.url).href;
export const chartUrl = new URL('../assets/chart.png', import.meta.url).href;
export const stripUrl = new URL('deep/gallery/thumbs/strip.png', import.meta.url).href;
export const lightIconUrl = new URL('icons/logo-light.png', import.meta.url).href;
