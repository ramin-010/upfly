// Seven directories down. `relocate` re-derives a relative path per holding file, so the
// arithmetic that breaks only shows up once the climb is long enough to get wrong.

import strip from './strip.png';
import chart from '../../../../assets/chart.png';
import sharedThumb from '../../../../../../../shared/assets/img/thumb.png';
import sharedHero from '../../../../../../../shared/assets/img/hero.jpg';

const CANDIDATES = [
  '../../../../../../../shared/assets/img/logo.png',
  '../../../../../../../shared/assets/img/aliased.png',
  '../../../../assets/inline-logo.jpg',
];

export function ThumbStrip() {
  return (
    <ul className="thumb-strip">
      <li>
        <img src={strip} alt="Strip" width={160} height={60} />
      </li>
      <li>
        <img src={chart} alt="Chart, four levels up" />
      </li>
      <li>
        <img src={sharedThumb} alt="Shared thumbnail, seven levels up" />
      </li>
      <li>
        <img src={sharedHero} alt="Shared hero, seven levels up" />
      </li>
      <li>
        <img src="../../../../../../../shared/assets/img/icon.svg" alt="Shared icon, literal" />
      </li>
      <li>
        <img src="../../../../../../../shared/assets/img/nowhere.png" alt="Seven levels up to nothing" />
      </li>
      {CANDIDATES.map((candidate) => (
        <li key={candidate}>
          <img src={candidate} alt="From a list of literals" />
        </li>
      ))}
    </ul>
  );
}
