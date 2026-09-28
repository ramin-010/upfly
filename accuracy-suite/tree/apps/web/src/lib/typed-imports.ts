// Types only: TypeScript erases each of these, so no build loads the file it names.
import type { Chart } from '../assets/chart.png';
import type Logo from '../assets/inline-logo.jpg';
export type { Badge } from '../assets/badges/badge-1.png';

export type ChartAndLogo = [Chart, Logo];
