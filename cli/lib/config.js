// Dove la CLI ricorda server, token e workspace: ~/.config/organizer/cli.json (leggibile solo da te).
// Le variabili ORGANIZER_URL, ORGANIZER_TOKEN e ORGANIZER_WS hanno la precedenza (utile negli script).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'organizer');
export const CONFIG_FILE = path.join(DIR, 'cli.json');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export const removeConfig = () => fs.rmSync(CONFIG_FILE, { force: true });

export function settings() {
  const c = loadConfig();
  const env = process.env;
  return {
    server: env.ORGANIZER_URL || c.server,
    token: env.ORGANIZER_TOKEN || c.token,
    workspace: env.ORGANIZER_WS || c.workspace,
  };
}
