import mark from 'logo.png';
import gone from 'missing-mark.png';
import thumb from 'shared/assets/img/thumb.png';

/** Three images imported by bare name, the way a package is named, with no ./ in front. */
export function PackageMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? 'package-mark compact' : 'package-mark'}>
      <img src={mark} alt="Brand" width={96} height={72} />
      <img src={gone} alt="" />
      <img src={thumb} alt="Thumbnail" width={120} height={90} />
    </span>
  );
}
