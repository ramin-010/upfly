import brandUrl from './logo.png';
import chartUrl from '../assets/chart.png';
import inlineLogo from '../assets/inline-logo.jpg';
import sharedLogo from '~/assets/img/logo.png';
import aliasedArt from '@img/aliased.png';
import missingAlias from '@missing/emblem.png';
import iconUrl from '#internal/icon.png';
import reactLogo from 'some-ui-kit/dist/logo.png';
import styles from './Header.module.css';

export interface HeaderProps {
  readonly title: string;
  readonly compact?: boolean;
}

export function Header({ title, compact = false }: HeaderProps) {
  return (
    <header className={compact ? styles.compact : styles.full}>
      <img src={brandUrl} alt="Brand" width={96} height={72} />
      <img src={sharedLogo} alt="Shared brand" width={200} height={150} />
      <img src={aliasedArt} alt="Aliased artwork" width={240} height={180} />
      <img src={missingAlias} alt="An alias that maps nowhere" />
      <img src={iconUrl} alt="A second alias that maps nowhere" />
      <img src={reactLogo} alt="Shipped inside a package" />

      {/* A literal path in JSX, beside the imported ones. */}
      <img src="/brand.png" alt="Root-relative, straight from the serving root" />
      <img src="/gallery/hero image.png" alt="A name with a space" />
      <img src="../assets/chart.png" alt="Relative, unimported" />
      <img src="/img/missing-from-header.png" alt="Broken on purpose" />

      <figure>
        <img src={chartUrl} alt="Chart" width={400} height={300} />
        <img src={inlineLogo} alt="Inline logo" width={240} height={160} />
        <figcaption>{title}</figcaption>
      </figure>
    </header>
  );
}
