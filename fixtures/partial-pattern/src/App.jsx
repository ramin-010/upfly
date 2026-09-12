import { useState } from 'react';
// Imported rather than served: the bundler resolves this one, so a reference we
// failed to rewrite would break the build instead of showing a missing image.
import inlineLogo from './inline-logo.jpg';

/**
 * One reference standing for three images, which is the whole point of this tree.
 *
 * The theme is chosen at runtime, so `theme-${mode}.png` is a single piece of text
 * that has to keep resolving for light, dark and sepia alike. Nothing here can be
 * rewritten unless all three end up at the same extension.
 */
export function ThemePreview({ mode }) {
  const src = `/theme-${mode}.png`;

  return <img src={src} alt={`The ${mode} theme`} />;
}

export function Banner() {
  // An ordinary reference beside the pattern, so the tree has something that
  // converts and is rewritten normally.
  return <img src="/banner.png" alt="Banner" />;
}

export default function App() {
  const [mode, setMode] = useState('light');

  return (
    <main>
      <img src={inlineLogo} alt="Logo" />
      <Banner />
      <ThemePreview mode={mode} />
      <button type="button" onClick={() => setMode('dark')}>
        Dark
      </button>
    </main>
  );
}
