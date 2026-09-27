export function badgeFor(level: 1 | 2) {
  return import(`@/assets/badges/badge-${level}.png`);
}
