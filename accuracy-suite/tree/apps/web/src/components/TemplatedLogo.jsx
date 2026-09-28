// A component kept in a project template, whose placeholders the generator fills in.
import banner from './img/{% if dark %}banner-dark{% else %}banner{% endif %}.png';

export const Logo = () => <img src="./img/{{ cookiecutter.logo }}.png" alt="" />;
export const Mark = () => <img src="./img/<%= name %>.png" alt="" />;
export const markUrl = new URL('./img/{{ mark }}.svg', import.meta.url);
export const Banner = () => <img src={banner} alt="" />;
