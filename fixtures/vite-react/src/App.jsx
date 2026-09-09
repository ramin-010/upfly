import logo from './assets/logo.png';
import hero from './assets/hero.jpg';

const banner = new URL('./assets/banner.png', import.meta.url);

export default function App() {
  return (
    <main>
      <img src={logo} alt="Logo" width="64" height="64" />
      <img src={hero} alt="Hero" />
      <img src="/screenshot.png" alt="From the public directory" />
      <img
        src="/photos/wide.jpg"
        srcSet="/photos/wide.jpg 1x, /photos/wide@2x.jpg 2x"
        alt="Responsive"
      />
      <a href={banner}>banner</a>
    </main>
  );
}
