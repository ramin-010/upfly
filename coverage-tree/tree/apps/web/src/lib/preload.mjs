import banner from '../../public/img/banner.png';
import texture from '../../public/img/texture.png';

export const PRELOAD = [banner, texture, '/gallery/photo.png', '/srcset/card-800.jpg'];

export function preloadTag(href) {
  return `<link rel="preload" as="image" href="${href}">`;
}

export const FALLBACK = '/img/spacer.png';
export const FALLBACK_MISSING = '/img/spacer-2x.png';
