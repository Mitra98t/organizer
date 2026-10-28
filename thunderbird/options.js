// Opzioni: indirizzo del server (già scritto se l'estensione è stata scaricata da Organizer) e token API.
/* global browser */
const $ = id => document.getElementById(id);

async function init() {
  const saved = await browser.storage.local.get(['server', 'token', 'inbox', 'status']);
  const preset = await fetch(browser.runtime.getURL('config.json')).then(r => r.json()).catch(() => ({}));
  $('server').value = saved.server || preset.server || '';
  $('token').value = saved.token || '';
  $('inbox').checked = saved.inbox !== false;
  showStatus(saved.status);
}

function showStatus(s) {
  const el = $('status');
  el.className = s?.state || '';
  el.textContent = !s ? 'Non ancora collegato.' : s.state === 'on' ? `Collegato a ${s.text}` : s.text;
}

$('save').addEventListener('click', async () => {
  let server = $('server').value.trim().replace(/\/+$/, '');
  try {
    server = new URL(server).origin;
  } catch {
    return showStatus({ state: 'error', text: 'Indirizzo non valido: scrivi per esempio https://organizer.esempio.it' });
  }
  // Il permesso di collegarsi al server: già concesso se l'estensione viene da lì, altrimenti si chiede ora.
  const origins = [`${server}/*`];
  if (!(await browser.permissions.contains({ origins })) && !(await browser.permissions.request({ origins }))) {
    return showStatus({ state: 'error', text: 'Senza il permesso di collegarsi a quell\'indirizzo l\'estensione non può funzionare.' });
  }
  $('server').value = server;
  await browser.storage.local.set({ server, token: $('token').value.trim(), inbox: $('inbox').checked });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) showStatus(changes.status.newValue);
});

init();
