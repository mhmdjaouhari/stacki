// Studio's colour theme, light or dark. A host that frames Studio (emdash-stacki's Design
// page) tells it which one its own UI shows, so the editor follows the admin; Studio keeps
// the last one it was told, so a reload paints in that theme before the host speaks again.
// Without a host or a stored choice, it follows the operating system.

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'stacki.theme';
const MESSAGE_TYPE = 'stacki:theme';

/** Parse a host's theme message, `{ type: 'stacki:theme', theme: 'light' | 'dark' }`. */
export function parseThemeMessage(data: unknown): Theme | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const type: unknown = Reflect.get(data, 'type');
  const theme: unknown = Reflect.get(data, 'theme');
  if (type !== MESSAGE_TYPE) {
    return undefined;
  }
  return THEMES.find((known) => known === theme);
}

function storedTheme(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return THEMES.find((known) => known === value);
  } catch {
    // Storage can be blocked (a framed page in a strict browser); the OS preference stands in.
    return undefined;
  }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.style.colorScheme = theme;
}

/**
 * Apply the remembered (or system) theme now, then follow the host's messages. Call once,
 * before the first render, so the first paint is already in the right colours.
 */
export function startTheme(): void {
  apply(storedTheme() ?? systemTheme());
  window.addEventListener('message', (event) => {
    const theme = parseThemeMessage(event.data);
    if (theme === undefined) {
      return;
    }
    apply(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not remembered; the host sends the theme again on the next load.
    }
  });
}
