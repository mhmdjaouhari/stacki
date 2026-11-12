import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startTheme } from './theme';
// Studio's UI faces, bundled from npm so the editor never asks a font CDN (studio.css applies them).
import '@fontsource-variable/inter/wght.css';
import '@fontsource/iosevka/400.css';
import '@fontsource/iosevka/500.css';
import '@fontsource/iosevka/600.css';
import '@fontsource/iosevka/700.css';
import '../../vendor/stacki/src/app/styles.css';
import './studio.css';
import './fork.css';
import './theme-light.css';
startTheme();
const root = document.getElementById('root');
if (!root) {
  throw new Error('Studio root is missing');
}
createRoot(root).render(<App />);
