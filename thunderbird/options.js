// Options: server address (already filled in if the extension was downloaded from Organizer), API token and the
// Organizer workspace where each mail account's new conversations go. Texts: _locales (Thunderbird's language).
/* global browser */
const $ = id => document.getElementById(id);
const t = (key, ...subs) => browser.i18n.getMessage(key, subs.map(String)) || key;

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
document.documentElement.lang = browser.i18n.getUILanguage();

async function init() {
  const saved = await browser.storage.local.get(['server', 'token', 'inbox', 'status']);
  const preset = await fetch(browser.runtime.getURL('config.json')).then(r => r.json()).catch(() => ({}));
  $('server').value = saved.server || preset.server || '';
  $('token').value = saved.token || '';
  $('inbox').checked = saved.inbox !== false;
  showStatus(saved.status);
  showAccounts();
}

async function showAccounts() {
  const { server, token, wsByAccount = {} } = await browser.storage.local.get(['server', 'token', 'wsByAccount']);
  const box = $('accounts');
  if (!server || !token) return;
  let spaces;
  try {
    const r = await fetch(`${server}/api/mail/workspaces`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(t('errStatus', r.status));
    spaces = await r.json();
  } catch (e) {
    box.textContent = t('optWsNotRead', e.message);
    return;
  }
  const accounts = (await browser.accounts.list(false)).filter(a => a.type !== 'none');
  const def = spaces.find(w => w.default);
  box.className = '';
  box.replaceChildren(...accounts.map(a => {
    const sel = document.createElement('select');
    sel.append(new Option(`${t('optDefault')}${def ? ` (${def.name})` : ''}`, ''), ...spaces.map(w => new Option(w.name, String(w.id))));
    sel.value = String(wsByAccount[a.id] || '');
    sel.addEventListener('change', async () => {
      const cur = (await browser.storage.local.get('wsByAccount')).wsByAccount || {};
      if (sel.value) cur[a.id] = +sel.value; else delete cur[a.id];
      await browser.storage.local.set({ wsByAccount: cur });
    });
    const row = document.createElement('div');
    row.className = 'acc';
    const name = document.createElement('span');
    name.textContent = a.name;
    row.append(name, sel);
    return row;
  }));
}

function showStatus(s) {
  const el = $('status');
  el.className = s?.state || '';
  el.textContent = !s ? t('optNotConnected') : s.state === 'on' ? t('optConnectedTo', s.text) : s.text;
}

$('save').addEventListener('click', async () => {
  let server = $('server').value.trim().replace(/\/+$/, '');
  try {
    server = new URL(server).origin;
  } catch {
    return showStatus({ state: 'error', text: t('optBadAddress') });
  }
  // The permission to connect to the server: already granted if the extension comes from there, otherwise asked now.
  const origins = [`${server}/*`];
  if (!(await browser.permissions.contains({ origins })) && !(await browser.permissions.request({ origins }))) {
    return showStatus({ state: 'error', text: t('optNoPermission') });
  }
  $('server').value = server;
  await browser.storage.local.set({ server, token: $('token').value.trim(), inbox: $('inbox').checked });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) showStatus(changes.status.newValue);
  if (area === 'local' && changes.status?.newValue?.state === 'on') showAccounts();
});

init();
