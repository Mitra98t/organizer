// Temi dell'interfaccia. Oltre a quelli di Organizer (automatico, chiaro, scuro) ci sono temi ispirati a
// schemi di colori famosi di Neovim e VS Code, e alcuni temi "funky" (funky: true). Per ognuno bastano i colori
// di base: le varianti tenui (sfondo dei codici, dei tag, dell'accento…) si ricavano mescolandoli con il colore
// dei pannelli. La scelta vale per il dispositivo (localStorage "org.theme"), come prima.

// bg: sfondo · panel/panel2: pannelli · text/muted: testo · line: bordi · accent/ink: colore principale e testo
// sopra di esso · blue: codici e mail · purple: tag e note · red/orange/yellow: errori, oggi, a breve.
// Facoltativi: grad (sfondo sfumato dietro ai pannelli) · glow (l'accento si illumina: pulsanti, menu, titoli) ·
// radius (angoli dei riquadri) · mono (tutto il testo in carattere monospaziato, da terminale).
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
  monokai: { name: 'Monokai Pro', dark: true, bg: '#19181a', panel: '#221f22', panel2: '#2d2a2e', text: '#fcfcfa', muted: '#939293', line: '#403e41', accent: '#ffd866', ink: '#2d2a2e', blue: '#78dce8', purple: '#ab9df2', red: '#ff6188', orange: '#fc9867', yellow: '#ffd866' },
  ayumirage: { name: 'Ayu Mirage', dark: true, bg: '#1f2430', panel: '#242936', panel2: '#2d3341', text: '#cccac2', muted: '#8a9199', line: '#343b4b', accent: '#ffcc66', ink: '#1f2430', blue: '#73d0ff', purple: '#d4bfff', red: '#f28779', orange: '#ffad66', yellow: '#ffd173' },
  nightowl: { name: 'Night Owl', dark: true, bg: '#010e1a', panel: '#011627', panel2: '#0b2942', text: '#d6deeb', muted: '#7e97b0', line: '#1d3b53', accent: '#82aaff', ink: '#011627', blue: '#7fdbca', purple: '#c792ea', red: '#ef5350', orange: '#f78c6c', yellow: '#ecc48d' },
  palenight: { name: 'Material Palenight', dark: true, bg: '#1b1e2b', panel: '#292d3e', panel2: '#32374d', text: '#bfc7d5', muted: '#8087a8', line: '#3a3f58', accent: '#89ddff', ink: '#1b1e2b', blue: '#82aaff', purple: '#c792ea', red: '#ff5370', orange: '#f78c6c', yellow: '#ffcb6b' },
  githubdark: { name: 'GitHub Dark', dark: true, bg: '#0d1117', panel: '#161b22', panel2: '#21262d', text: '#e6edf3', muted: '#8b949e', line: '#30363d', accent: '#3fb950', ink: '#0d1117', blue: '#58a6ff', purple: '#bc8cff', red: '#f85149', orange: '#db6d28', yellow: '#d29922' },
  solarizeddark: { name: 'Solarized Dark', dark: true, bg: '#002b36', panel: '#073642', panel2: '#0b4250', text: '#c3cfcf', muted: '#839496', line: '#0f4c5c', accent: '#2aa198', ink: '#002b36', blue: '#268bd2', purple: '#6c71c4', red: '#dc322f', orange: '#cb4b16', yellow: '#b58900' },
  rosepinedawn: { name: 'Rosé Pine Dawn', dark: false, bg: '#f2e9e1', panel: '#fffaf3', panel2: '#faf4ed', text: '#575279', muted: '#797593', line: '#dfdad9', accent: '#d7827e', ink: '#fffaf3', blue: '#286983', purple: '#907aa9', red: '#b4637a', orange: '#d7882a', yellow: '#b58a2e' },
  ayulight: { name: 'Ayu Light', dark: false, bg: '#f3f4f5', panel: '#fcfcfc', panel2: '#eef0f2', text: '#5c6166', muted: '#8a9199', line: '#e1e4e8', accent: '#fa8d3e', ink: '#ffffff', blue: '#399ee6', purple: '#a37acc', red: '#e65050', orange: '#e8742b', yellow: '#b98a1f' },
  latte: { name: 'Catppuccin Latte', dark: false, bg: '#e6e9ef', panel: '#eff1f5', panel2: '#dce0e8', text: '#4c4f69', muted: '#7c7f93', line: '#ccd0da', accent: '#8839ef', ink: '#ffffff', blue: '#1e66f5', purple: '#ea76cb', red: '#d20f39', orange: '#fe640b', yellow: '#df8e1d' },
  gruvboxlight: { name: 'Gruvbox Light', dark: false, bg: '#f2e5bc', panel: '#fbf1c7', panel2: '#ebdbb2', text: '#3c3836', muted: '#7c6f64', line: '#d5c4a1', accent: '#79740e', ink: '#fbf1c7', blue: '#076678', purple: '#8f3f71', red: '#9d0006', orange: '#af3a03', yellow: '#b57614' },
  solarizedlight: { name: 'Solarized Light', dark: false, bg: '#eee8d5', panel: '#fdf6e3', panel2: '#f3ecd7', text: '#3f5259', muted: '#839496', line: '#e0d9c3', accent: '#268bd2', ink: '#fdf6e3', blue: '#2aa198', purple: '#6c71c4', red: '#dc322f', orange: '#cb4b16', yellow: '#b58900' },
  githublight: { name: 'GitHub Light', dark: false, bg: '#f6f8fa', panel: '#ffffff', panel2: '#eff2f5', text: '#1f2328', muted: '#656d76', line: '#d0d7de', accent: '#1a7f37', ink: '#ffffff', blue: '#0969da', purple: '#8250df', red: '#cf222e', orange: '#bc4c00', yellow: '#9a6700' },

  // ---------- funky ----------
  synthwave: { name: "Synthwave '84", funky: true, dark: true, glow: true, bg: '#1a1626', panel: '#262335', panel2: '#34294f', text: '#fdfdfd', muted: '#a499c7', line: '#3d3260', accent: '#ff7edb', ink: '#1a1626', blue: '#36f9f6', purple: '#b893ce', red: '#fe4450', orange: '#ff8b39', yellow: '#fede5d',
    grad: 'linear-gradient(180deg, #2b1b47 0%, #1a1626 45%, #2a1430 100%)' },
  vaporwave: { name: 'Vaporwave', funky: true, dark: true, glow: true, radius: '14px', bg: '#1b1035', panel: '#241446', panel2: '#2f1a5c', text: '#fdf2ff', muted: '#b9a3e3', line: '#3b2470', accent: '#01cdfe', ink: '#12082a', blue: '#05ffa1', purple: '#ff71ce', red: '#ff5e8a', orange: '#ff9e5e', yellow: '#fffb96',
    grad: 'radial-gradient(circle at 15% 0%, #ff71ce55 0, transparent 45%), radial-gradient(circle at 90% 100%, #01cdfe44 0, transparent 50%)' },
  matrix: { name: 'Matrix', funky: true, dark: true, glow: true, mono: true, bg: '#000300', panel: '#020b03', panel2: '#071a09', text: '#b6ffb9', muted: '#4fae58', line: '#0e3a14', accent: '#00ff41', ink: '#001a05', blue: '#39ff88', purple: '#a5ff7a', red: '#ff4d4d', orange: '#ffb000', yellow: '#d8ff3e' },
  amber: { name: 'Terminale ambra', funky: true, dark: true, glow: true, mono: true, bg: '#120b02', panel: '#1a1004', panel2: '#241707', text: '#ffcf70', muted: '#b07f2c', line: '#3a2608', accent: '#ffb000', ink: '#120b02', blue: '#ffd27a', purple: '#ff9d3d', red: '#ff5a36', orange: '#ff8a00', yellow: '#ffe08a' },
  cobalt2: { name: 'Cobalt2', funky: true, dark: true, bg: '#15232d', panel: '#193549', panel2: '#1f4662', text: '#ffffff', muted: '#9fb6c6', line: '#234e6d', accent: '#ffc600', ink: '#193549', blue: '#9effff', purple: '#fb94ff', red: '#ff628c', orange: '#ff9d00', yellow: '#ffc600' },
  shadesofpurple: { name: 'Shades of Purple', funky: true, dark: true, bg: '#1e1e3f', panel: '#2d2b55', panel2: '#3a3772', text: '#ffffff', muted: '#a599e9', line: '#43418a', accent: '#fad000', ink: '#2d2b55', blue: '#9effff', purple: '#fb94ff', red: '#ec3a37', orange: '#ff9d00', yellow: '#fad000' },
  halloween: { name: 'Halloween', funky: true, dark: true, glow: true, bg: '#120c12', panel: '#1c131c', panel2: '#2a1b2a', text: '#f3e9dc', muted: '#a7929f', line: '#3b2a3b', accent: '#ff7518', ink: '#120c12', blue: '#a3ff76', purple: '#b267e6', red: '#ff3b3b', orange: '#ff7518', yellow: '#ffd23f',
    grad: 'radial-gradient(circle at 50% 120%, #ff751833 0, transparent 60%)' },
  bubblegum: { name: 'Bubblegum', funky: true, dark: false, radius: '16px', bg: '#ffe9f3', panel: '#fff6fb', panel2: '#ffe0ee', text: '#4a1d3a', muted: '#a0668a', line: '#fbc8df', accent: '#ff4fa3', ink: '#ffffff', blue: '#2f8cff', purple: '#a259ff', red: '#e0245e', orange: '#ff7a1a', yellow: '#c99700',
    grad: 'radial-gradient(circle at 10% 10%, #ffc2e2 0, transparent 40%), radial-gradient(circle at 90% 80%, #c9e4ff 0, transparent 45%)' },
  sorbetto: { name: 'Sorbetto', funky: true, dark: false, radius: '14px', bg: '#f4f1ff', panel: '#ffffff', panel2: '#eef0ff', text: '#2d2a4a', muted: '#7a7699', line: '#e1defa', accent: '#00b39b', ink: '#ffffff', blue: '#4f7cff', purple: '#c04de0', red: '#e5484d', orange: '#f07d18', yellow: '#b58400',
    grad: 'linear-gradient(135deg, #ffe6f2 0%, #e9f0ff 50%, #e6fff5 100%)' },
  limonata: { name: 'Limonata', funky: true, dark: false, bg: '#fbffe0', panel: '#fffff4', panel2: '#f3f9d2', text: '#2a3300', muted: '#6f7a3a', line: '#e3eeb1', accent: '#7ab800', ink: '#ffffff', blue: '#0077c8', purple: '#b03fb5', red: '#d6262e', orange: '#e86a00', yellow: '#a88a00',
    grad: 'radial-gradient(circle at 100% 0%, #fff27a66 0, transparent 50%)' },
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
    '--bg-image': t.grad || 'none',
    ...(t.radius ? { '--radius': t.radius } : {}),
    ...(t.mono ? { '--sans': 'var(--mono)' } : {}),
    'color-scheme': t.dark ? 'dark' : 'light',
  };
}

const KEYS = [...Object.keys(vars(THEMES.nord)), '--radius', '--sans'];

export function applyTheme(id) {
  const root = document.documentElement;
  for (const k of KEYS) root.style.removeProperty(k);
  const t = THEMES[id];
  // data-theme: chiaro o scuro di base (le regole del CSS che dipendono dal tema); i colori sono inline.
  root.dataset.theme = t ? (t.dark ? 'dark' : 'light') : id in BASE_THEMES ? id : 'auto';
  if (t) for (const [k, v] of Object.entries(vars(t))) root.style.setProperty(k, v);
  // Accento luminoso (temi funky): le regole stanno nel CSS, sotto [data-glow].
  root.toggleAttribute('data-glow', !!t?.glow);
  // Colore della barra del browser / dell'app installata.
  const bg = t ? t.bg : getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg));
}

export const currentTheme = () => localStorage.getItem('org.theme') || 'auto';

export function setTheme(id) {
  try { localStorage.setItem('org.theme', id); } catch { /* modalità privata: vale fino alla chiusura */ }
  applyTheme(id);
}
