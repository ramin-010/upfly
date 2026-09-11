/**
 * Static export, so the fixture emits a browsable tree rather than a bundler's
 * working directory. `images.unoptimized` is what static export requires of
 * `next/image`, since its optimizer is a server and an exported site has none.
 */
export default {
  output: 'export',
  images: { unoptimized: true },
};
