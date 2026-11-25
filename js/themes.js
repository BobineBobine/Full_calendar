// Styles de couleurs. Chaque style a une variante claire et une sombre.
// Clés : bg (fond), surface (cartes), surface2 (survol), fg (texte), muted (texte secondaire),
//        border (bordures), accent (couleur principale). La couleur du texte sur l'accent est calculée.

export const PALETTES = {
  rose: {
    name: 'Rose (défaut)',
    light: { bg: '#ffffff', surface: '#f5f6f8', surface2: '#eceef2', fg: '#16181d', muted: '#6b7280', border: '#e6e8ec', accent: '#c0505f' },
    dark: { bg: '#121316', surface: '#1c1e22', surface2: '#26292e', fg: '#eceef1', muted: '#9aa1ab', border: '#2c2f35', accent: '#e27a88' },
  },
  obsidian: {
    name: 'Obsidian',
    light: { bg: '#ffffff', surface: '#f6f6f6', surface2: '#ebebeb', fg: '#222222', muted: '#5c5c5c', border: '#e0e0e0', accent: '#8a5cf5' },
    dark: { bg: '#1e1e1e', surface: '#262626', surface2: '#303030', fg: '#dadada', muted: '#999999', border: '#363636', accent: '#a882ff' },
  },
  atom: {
    name: 'Atom',
    light: { bg: '#fafafa', surface: '#eaeaeb', surface2: '#dfdfe0', fg: '#383a42', muted: '#696c77', border: '#dbdbdc', accent: '#526fff' },
    dark: { bg: '#282c34', surface: '#21252b', surface2: '#2c313a', fg: '#abb2bf', muted: '#7f848e', border: '#3a3f4b', accent: '#61afef' },
  },
  minimal: {
    name: 'Minimal',
    light: { bg: '#ffffff', surface: '#f7f7f7', surface2: '#eeeeee', fg: '#1a1a1a', muted: '#737373', border: '#ebebeb', accent: '#5e8aa3' },
    dark: { bg: '#262626', surface: '#1e1e1e', surface2: '#333333', fg: '#dadada', muted: '#999999', border: '#363636', accent: '#7aa2b8' },
  },
  things: {
    name: 'Things',
    light: { bg: '#ffffff', surface: '#f5f6f8', surface2: '#eceef1', fg: '#1d1d1f', muted: '#8a8f98', border: '#e7e8ec', accent: '#1b74e8' },
    dark: { bg: '#1c1d20', surface: '#25262a', surface2: '#2e3035', fg: '#e9eaec', muted: '#8f949c', border: '#34363b', accent: '#4a9eff' },
  },
  nord: {
    name: 'Nord',
    light: { bg: '#eceff4', surface: '#e5e9f0', surface2: '#d8dee9', fg: '#2e3440', muted: '#4c566a', border: '#d8dee9', accent: '#5e81ac' },
    dark: { bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', fg: '#eceff4', muted: '#a3abb9', border: '#434c5e', accent: '#88c0d0' },
  },
  catppuccin: {
    name: 'Catppuccin',
    light: { bg: '#eff1f5', surface: '#e6e9ef', surface2: '#dce0e8', fg: '#4c4f69', muted: '#6c6f85', border: '#ccd0da', accent: '#8839ef' },
    dark: { bg: '#1e1e2e', surface: '#181825', surface2: '#313244', fg: '#cdd6f4', muted: '#a6adc8', border: '#313244', accent: '#cba6f7' },
  },
  dracula: {
    name: 'Dracula',
    light: { bg: '#f8f8f2', surface: '#ececdf', surface2: '#e0e0d4', fg: '#282a36', muted: '#6272a4', border: '#deded0', accent: '#9a5bd6' },
    dark: { bg: '#282a36', surface: '#21222c', surface2: '#343746', fg: '#f8f8f2', muted: '#a0a8cd', border: '#44475a', accent: '#bd93f9' },
  },
  gruvbox: {
    name: 'Gruvbox',
    light: { bg: '#fbf1c7', surface: '#f2e5bc', surface2: '#ebdbb2', fg: '#3c3836', muted: '#7c6f64', border: '#d5c4a1', accent: '#af3a03' },
    dark: { bg: '#282828', surface: '#32302f', surface2: '#3c3836', fg: '#ebdbb2', muted: '#a89984', border: '#504945', accent: '#fe8019' },
  },
  solarized: {
    name: 'Solarized',
    light: { bg: '#fdf6e3', surface: '#eee8d5', surface2: '#e4ddc8', fg: '#073642', muted: '#657b83', border: '#e0dac7', accent: '#268bd2' },
    dark: { bg: '#002b36', surface: '#073642', surface2: '#0d4250', fg: '#eee8d5', muted: '#93a1a1', border: '#0f4554', accent: '#2aa198' },
  },
  rosepine: {
    name: 'Rosé Pine',
    light: { bg: '#faf4ed', surface: '#fffaf3', surface2: '#f2e9e1', fg: '#575279', muted: '#797593', border: '#dfdad9', accent: '#d7827e' },
    dark: { bg: '#191724', surface: '#1f1d2e', surface2: '#26233a', fg: '#e0def4', muted: '#908caa', border: '#2a2740', accent: '#ebbcba' },
  },
  tokyo: {
    name: 'Tokyo Night',
    light: { bg: '#e1e2e7', surface: '#d5d6db', surface2: '#c4c8da', fg: '#3760bf', muted: '#6172b0', border: '#c4c8da', accent: '#2e7de9' },
    dark: { bg: '#1a1b26', surface: '#16161e', surface2: '#24283b', fg: '#c0caf5', muted: '#787c99', border: '#292e42', accent: '#7aa2f7' },
  },
  everforest: {
    name: 'Everforest',
    light: { bg: '#fdf6e3', surface: '#f4f0d9', surface2: '#efebd4', fg: '#5c6a72', muted: '#829181', border: '#e0dcc7', accent: '#8da101' },
    dark: { bg: '#2d353b', surface: '#343f44', surface2: '#3d484d', fg: '#d3c6aa', muted: '#9da9a0', border: '#475258', accent: '#a7c080' },
  },
};

const KEYS = ['bg', 'surface', 'surface2', 'fg', 'muted', 'border', 'accent'];

// ---------- Couleurs ----------
function rgb(css) {
  const el = document.createElement('span');
  el.style.color = css;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  const m = c.match(/[\d.]+/g) || [0, 0, 0];
  return m.slice(0, 3).map(Number);
}
const lum = c => { const [r, g, b] = rgb(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

/** Applique une palette (variante déjà choisie) à la page. */
export function applyPalette(p, dark) {
  const root = document.documentElement.style;
  for (const k of KEYS) {
    const prop = k === 'surface2' ? '--surface2' : `--${k}`;
    root.setProperty(prop, p[k]);
  }
  root.setProperty('--accent-fg', lum(p.accent) > 0.6 ? '#16181d' : '#ffffff');
  root.setProperty('--accent-soft', `color-mix(in srgb, ${p.accent} 15%, transparent)`);
  root.setProperty('--today', `color-mix(in srgb, ${p.accent} 8%, transparent)`);
  root.setProperty('--danger', dark ? '#ef7a6c' : '#c0392b');
  root.setProperty('color-scheme', dark ? 'dark' : 'light');
  for (const m of document.querySelectorAll('meta[name=theme-color]')) m.content = p.bg;
}

// ---------- Thèmes Obsidian ----------
// Valeurs par défaut d'Obsidian 1.x, pour les thèmes qui ne redéfinissent qu'une partie des variables.
const OBS_DEFAULTS = `
body:where(.theme-light){--color-base-00:#fff;--color-base-05:#fcfcfc;--color-base-10:#fafafa;--color-base-20:#f6f6f6;--color-base-25:#e3e3e3;--color-base-30:#e0e0e0;--color-base-35:#d4d4d4;--color-base-40:#bdbdbd;--color-base-50:#ababab;--color-base-60:#707070;--color-base-70:#5c5c5c;--color-base-100:#222;--mono-rgb-0:255,255,255;--mono-rgb-100:0,0,0;--accent-h:254;--accent-s:80%;--accent-l:68%;--text-on-accent:#fff}
body:where(.theme-dark){--color-base-00:#1e1e1e;--color-base-05:#212121;--color-base-10:#242424;--color-base-20:#262626;--color-base-25:#2a2a2a;--color-base-30:#363636;--color-base-35:#3f3f3f;--color-base-40:#555;--color-base-50:#666;--color-base-60:#999;--color-base-70:#b3b3b3;--color-base-100:#dadada;--mono-rgb-0:0,0,0;--mono-rgb-100:255,255,255;--accent-h:254;--accent-s:80%;--accent-l:68%;--text-on-accent:#fff}
body:where(.theme-light,.theme-dark){--color-accent:hsl(var(--accent-h),var(--accent-s),var(--accent-l));--background-primary:var(--color-base-00);--background-primary-alt:var(--color-base-10);--background-secondary:var(--color-base-20);--background-secondary-alt:var(--color-base-05);--background-modifier-border:var(--color-base-30);--background-modifier-hover:rgba(var(--mono-rgb-100),.067);--text-normal:var(--color-base-100);--text-muted:var(--color-base-70);--interactive-accent:var(--color-accent)}
`;

const validColor = v => v && v !== 'transparent' && CSS.supports('color', v);

/**
 * Calcule les couleurs (clair + sombre) d'un thème Obsidian à partir de son theme.css.
 * La feuille n'est injectée que le temps du calcul : le reste du thème n'influence pas l'appli.
 */
export function paletteFromObsidianCss(css) {
  const style = document.createElement('style');
  style.textContent = OBS_DEFAULTS + '\n' + css;
  document.head.appendChild(style);
  const body = document.body, saved = body.className;
  const out = {};
  try {
    for (const mode of ['light', 'dark']) {
      body.className = `theme-${mode}`;
      const cs = getComputedStyle(body);
      const g = (...names) => { for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (validColor(v)) return v; } return null; };
      const base = PALETTES.obsidian[mode];
      const p = {
        bg: g('--background-primary') || base.bg,
        surface: g('--background-secondary', '--background-primary-alt') || base.surface,
        fg: g('--text-normal') || base.fg,
        muted: g('--text-muted', '--text-faint') || base.muted,
        border: g('--background-modifier-border') || base.border,
        accent: g('--interactive-accent', '--color-accent', '--text-accent') || base.accent,
      };
      // Survol : légèrement plus contrasté que la surface
      p.surface2 = `color-mix(in srgb, ${p.surface} 85%, ${p.fg})`;
      // Fige les couleurs en rgb() pour ne plus dépendre des variables du thème
      for (const k of Object.keys(p)) {
        if (k === 'surface2') continue;
        const [r, gg, b] = rgb(p[k]);
        p[k] = `rgb(${r}, ${gg}, ${b})`;
      }
      p.surface2 = `color-mix(in srgb, ${p.surface} 85%, ${p.fg})`;
      out[mode] = p;
    }
  } finally {
    body.className = saved;
    style.remove();
  }
  return out;
}

/** Variables Obsidian → couleurs de l'appli, pour les extraits CSS (snippets) importés du coffre. */
export const SNIPPET_BRIDGE = `
body{--background-primary:var(--bg);--background-primary-alt:var(--surface);--background-secondary:var(--surface);--background-secondary-alt:var(--surface);
--background-modifier-border:var(--border);--background-modifier-hover:var(--surface2);--text-normal:var(--fg);--text-muted:var(--muted);--text-faint:var(--muted);
--interactive-accent:var(--accent);--interactive-accent-hover:var(--accent);--color-accent:var(--accent);--text-accent:var(--accent);--text-on-accent:var(--accent-fg)}
`;
