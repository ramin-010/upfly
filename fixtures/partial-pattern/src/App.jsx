import { useState } from 'react';
// Imported rather than served: the bundler resolves this one, so a reference we
// failed to rewrite would break the build instead of showing a missing image.
import inlineLogo from './inline-logo.jpg';

/**
 * One reference standing for four files, which is the whole point of this tree.
 *
 * The theme is chosen at runtime, so `theme-${mode}.png` is one piece of text that
 * matches light, dark, sepia and a fourth file that is not an image and never converts.
 * A template is never rewritten, so its originals stay and it keeps resolving.
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

export function Screenshot() {
  // A UI screenshot: flat panels, hard edges, 1px rules. webp 80 makes it larger,
  // 1,912 bytes into 19,426, while lossless takes it to 220. Unlike `theme-dark.png`,
  // the saving clears `minSavingBytes`, so it becomes a `format-opportunity` and its
  // setting reaches `summary.savingQuality`.
  return <img src="/screenshot.png" alt="A screenshot of the interface" />;
}

export default function App() {
  const [mode, setMode] = useState('light');

  return (
    <main>
      <img src={inlineLogo} alt="Logo" />
      <Banner />
      <Screenshot />
      <ThemePreview mode={mode} />
      <button type="button" onClick={() => setMode('dark')}>
        Dark
      </button>
    </main>
  );
}
