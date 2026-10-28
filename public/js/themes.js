// Temi dell'interfaccia. Oltre a quelli di Organizer (automatico, chiaro, scuro) ci sono temi ispirati a
// schemi di colori famosi di Neovim e VS Code. Per ognuno bastano i colori di base: le varianti tenui
// (sfondo dei codici, dei tag, dell'accento…) si ricavano mescolandoli con il colore dei pannelli.
// La scelta vale per il dispositivo (localStorage "org.theme"), come prima.

// bg: sfondo · panel/panel2: pannelli · text/muted: testo · line: bordi · accent/ink: colore principale e testo
// sopra di esso · blue: codici e mail · purple: tag e note · red/orange/yellow: errori, oggi, a breve.
export const THEMES = {
  tokyonight: { name: 'Tokyo Night', dark: true, bg: '#16161e', panel: '#1f2335', panel2: '#292e42', text: '#c0caf5', muted: '#7a82a9', line: '#2f3549', accent: '#7aa2f7', ink: '#16161e', blue: '#7dcfff', purple: '#bb9af7', red: '#f7768e', orange: '#ff9e64', yellow: '#e0af68' },
  catppuccin: { name: 'Catppuccin Mocha', dark: true, bg: '#181825', panel: '#1e1e2e', panel2: '#313244', text: '#cdd6f4', muted: '#9399b2', line: '#383a4f', accent: '#cba6f7', ink: '#1e1e2e', blue: '#89b4fa', purple: '#f5c2e7', red: '#f38ba8', orange: '#fab387', yellow: '#f9e2af' },
  gruvbox: { name: 'Gruvbox Dark', dark: true, bg: '#1d2021', panel: '#282828', panel2: '#32302f', text: '#ebdbb2', muted: '#a89984', line: '#45403d', accent: '#b8bb26', ink: '#1d2021', blue: '#83a598', purple: '#d3869b', red: '#fb4934', orange: '#fe8019', yellow: '#fabd2f' },
  nord: { name: 'Nord', dark: true, bg: '#2e3440', panel: '#3b4252', panel2: '#434c5e', text: '#eceff4', muted: '#9aa5b8', line: '#4c566a', accent: '#88c0d0', ink: '#2e3440', blue: '#81a1c1', purple: '#b48ead', red: '#bf616a', orange: '#d08770', yellow: '#ebcb8b' },
  dracula: { name: 'Dracula', dark: true, bg: '#21222c', panel: '#282a36', panel2: '#343746', text: '#f8f8f2', muted: '#9aa3cf', line: '#44475a', accent: '#bd93f9', ink: '#282a36', blue: '#8be9fd', purple: '#ff79c6', red: '#ff5555', orange: '#ffb86c', yellow: '#f1fa8c' },
  onedark: { name: 'One Dark', dark: true, bg: '#21252b', panel: '#282c34', panel2: '#2f343e', text: '#abb2bf', muted: '#7f848e', line: '#3e4451', accent: '#98c379', ink: '#21252b', blue: '#61afef', purple: '#c678dd', red: '#e06c75', orange: '#d19a66', yellow: '#e5c07b' },
  rosepine: { name: 'Rosé Pine', dark: true, bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', text: '#e0def4', muted: '#908caa', line: '#403d52', accent: '#ebbcba', ink: '#191724', blue: '#9ccfd8', purple: '#c4a7e7', red: '#eb6f92', orange: '#f6c177', yellow: '#e9d17a' },
  kanagawa: { name: 'Kanagawa', dark: true, bg: '#16161d', panel: '#1f1f28', panel2: '#2a2a37', text: '#dcd7ba', muted: '#938aa9', line: '#363646', accent: '#7e9cd8', ink: '#1f1f28', blue: '#7fb4ca', purple: '#957fb8', red: '#e46876', orange: '#ffa066', yellow: '#e6c384' },
  everforest: { name: 'Everforest', dark: true, bg: '#232a2e', panel: '#2d353b', panel2: '#343f44', text: '#d3c6aa', muted: '#9da9a0', line: '#3d484d', accent: '#a7c080', ink: '#2d353b', blue: '#7fbbb3', purple: '#d699b6', red: '#e67e80', orange: '#e69875', yellow: '#dbbc7f' },
  githubdark: { name: 'GitHub Dark', dark: true, bg: '#0d1117', panel: '#161b22', panel2: '#21262d', text: '#e6edf3', muted: '#8b949e', line: '#30363d', accent: '#3fb950', ink: '#0d1117', blue: '#58a6ff', purple: '#bc8cff', red: '#f85149', orange: '#db6d28', yellow: '#d29922' },
  solarizeddark: { name: 'Solarized Dark', dark: true, bg: '#002b36', panel: '#073642', panel2: '#0b4250', text: '#c3cfcf', muted: '#839496', line: '#0f4c5c', accent: '#2aa198', ink: '#002b36', blue: '#268bd2', purple: '#6c71c4', red: '#dc322f', orange: '#cb4b16', yellow: '#b58900' },
  latte: { name: 'Catppuccin Latte', dark: false, bg: '#e6e9ef', panel: '#eff1f5', panel2: '#dce0e8', text: '#4c4f69', muted: '#7c7f93', line: '#ccd0da', accent: '#8839ef', ink: '#ffffff', blue: '#1e66f5', purple: '#ea76cb', red: '#d20f39', orange: '#fe640b', yellow: '#df8e1d' },
  gruvboxlight: { name: 'Gruvbox Light', dark: false, bg: '#f2e5bc', panel: '#fbf1c7', panel2: '#ebdbb2', text: '#3c3836', muted: '#7c6f64', line: '#d5c4a1', accent: '#79740e', ink: '#fbf1c7', blue: '#076678', purple: '#8f3f71', red: '#9d0006', orange: '#af3a03', yellow: '#b57614' },
  solarizedlight: { name: 'Solarized Light', dark: false, bg: '#eee8d5', panel: '#fdf6e3', panel2: '#f3ecd7', text: '#3f5259', muted: '#839496', line: '#e0d9c3', accent: '#268bd2', ink: '#fdf6e3', blue: '#2aa198', purple: '#6c71c4', red: '#dc322f', orange: '#cb4b16', yellow: '#b58900' },
  githublight: { name: 'GitHub Light', dark: false, bg: '#f6f8fa', panel: '#ffffff', panel2: '#eff2f5', text: '#1f2328', muted: '#656d76', line: '#d0d7de', accent: '#1a7f37', ink: '#ffffff', blue: '#0969da', purple: '#8250df', red: '#cf222e', orange: '#bc4c00', yellow: '#9a6700' },
};

// I temi di Organizer: colori nel CSS (auto segue il sistema, chiaro/scuro forzati).
export const BASE_THEMES = { auto: 'Organizer automatico', light: 'Organizer chiaro', dark: 'Organizer scuro' };

const mix = (c, pct, base) => `color-mix(in srgb, ${c} ${pct}%, ${base})`;

function vars(t) {
  return {
    '--bg': t.bg, '--panel': t.panel, '--panel-2': t.panel2, '--text': t.text, '--muted': t.muted, '--line': t.line,
    '--accent': t.accent, '--accent-ink': t.ink, '--accent-soft': mix(t.accent, 20, t.panel),
    '--danger': t.red, '--danger-soft': mix(t.red, 18, t.panel),
    '--today': t.orange, '--soon': t.yellow,
    '--code-bg': mix(t.blue, 16, t.panel), '--code-ink': t.blue,
    '--tag-bg': mix(t.purple, 16, t.panel), '--tag-ink': t.purple,
    '--mail': t.blue, '--note': t.purple,
    '--tag-l': t.dark ? '74%' : '38%',
    '--shadow': t.dark ? '0 1px 2px rgb(0 0 0 / 40%)' : '0 1px 2px rgb(0 0 0 / 6%), 0 4px 16px rgb(0 0 0 / 5%)',
    'color-scheme': t.dark ? 'dark' : 'light',
  };
}

const KEYS = Object.keys(vars(THEMES.nord));

export function applyTheme(id) {
  const root = document.documentElement;
  for (const k of KEYS) root.style.removeProperty(k);
  const t = THEMES[id];
  // data-theme: chiaro o scuro di base (le regole del CSS che dipendono dal tema); i colori sono inline.
  root.dataset.theme = t ? (t.dark ? 'dark' : 'light') : id in BASE_THEMES ? id : 'auto';
  if (t) for (const [k, v] of Object.entries(vars(t))) root.style.setProperty(k, v);
  // Colore della barra del browser / dell'app installata.
  const bg = t ? t.bg : getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg));
}

export const currentTheme = () => localStorage.getItem('org.theme') || 'auto';

export function setTheme(id) {
  try { localStorage.setItem('org.theme', id); } catch { /* modalità privata: vale fino alla chiusura */ }
  applyTheme(id);
}
