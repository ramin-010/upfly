import Image from 'next/image';
import avatar from '../public/avatar.png';

export default function Page() {
  return (
    <main>
      <Image src={avatar} alt="Avatar" width={64} height={64} />
      <img src="/hero.png" alt="Hero" />
      <picture>
        <source srcSet="/hero.png 1x, /hero@2x.png 2x" />
        <img src="/hero.png" alt="Hero again" />
      </picture>
    </main>
  );
}
