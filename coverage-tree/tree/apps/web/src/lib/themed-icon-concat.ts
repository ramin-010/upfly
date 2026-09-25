/** themedIcon from paths.ts, spelled with +: two unknown parts in one file name. */
export function themedIconConcat(theme: string, size: string): string {
  return '/icons/' + theme + '-' + size + '.png';
}
