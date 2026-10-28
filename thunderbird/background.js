// Organizer per Thunderbird. Tiene una connessione con il server di Organizer (token API, vedi le opzioni):
//  - quando in Organizer si preme "Manda", apre la mail qui, già compilata e con gli allegati; se è una risposta,
//    la apre come risposta al messaggio originale, così la conversazione resta unita;
//  - quando la mail parte, lo dice a Organizer (diventa "mandata", in attesa di risposta);
//  - quando arriva una mail che risponde a una conversazione seguita da Organizer, gliela passa;
//  - con "tutta la posta in arrivo" (opzioni, attivo di base) passa anche le altre mail delle cartelle Posta in
//    arrivo, che in Organizer vede solo chi le riceve. Spento, le altre mail non escono da Thunderbird.
/* global browser */

let cfg = { server: '', token: '', inbox: true };
let watch = new Set(); // Message-ID delle conversazioni seguite
const composing = new Map(); // finestra di composizione → richiesta di Organizer
let stream = null; // AbortController della connessione aperta

const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = (state, text = '') => browser.storage.local.set({ status: { state, text, at: Date.now() } });

async function loadConfig() {
  const saved = await browser.storage.local.get(['server', 'token', 'inbox']);
  const preset = await fetch(browser.runtime.getURL('config.json')).then(r => r.json()).catch(() => ({}));
  cfg = { server: String(saved.server || preset.server || '').replace(/\/+$/, ''), token: String(saved.token || ''), inbox: saved.inbox !== false };
}

async function call(method, path, body) {
  const r = await fetch(`${cfg.server}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error((await r.json().catch(() => null))?.error || `errore ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

function notify(text) {
  browser.notifications.create({ type: 'basic', title: 'Organizer', message: text, iconUrl: 'icon.png' }).catch(() => {});
}

// ---------- connessione ----------
// Un flusso di eventi (Server-Sent Events) letto con fetch, perché serve l'header con il token.
async function connect() {
  stream?.abort();
  const ctrl = (stream = new AbortController());
  await loadConfig();
  if (!cfg.server || !cfg.token) return status('off', 'Inserisci indirizzo e token nelle opzioni');
  for (let wait = 2000; !ctrl.signal.aborted; wait = Math.min(wait * 2, 60000)) {
    try {
      const r = await fetch(`${cfg.server}/api/mail/stream`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: ctrl.signal });
      if (r.status === 401) return status('error', 'Token non valido o revocato: creane uno nuovo in Organizer');
      if (!r.ok) throw new Error(`errore ${r.status}`);
      status('on', cfg.server);
      wait = 2000;
      sendIdentities();
      refreshWatch().then(catchUp);
      openPending();
      saveAttachments();
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const ev = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: outbox$/m.test(ev)) openPending();
          if (/^event: watch$/m.test(ev)) refreshWatch();
          if (/^event: fetch$/m.test(ev)) saveAttachments();
        }
      }
      status('error', 'Connessione chiusa, riprovo…');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      status('error', `Server non raggiungibile (${e.message}), riprovo…`);
    }
    await sleep(wait);
  }
}

async function refreshWatch() {
  try {
    watch = new Set(await call('GET', '/mail/watch'));
  } catch (e) {
    console.warn('Organizer: conversazioni non lette', e);
  }
}

// I nostri indirizzi: servono a Organizer per "rispondi a tutti" senza rispondere a sé stessi.
async function sendIdentities() {
  try {
    const accounts = await browser.accounts.list(false);
    const addresses = accounts.flatMap(a => (a.identities || []).map(i => i.email)).filter(Boolean);
    await call('POST', '/mail/identities', { addresses });
  } catch (e) {
    console.warn('Organizer: indirizzi non mandati', e);
  }
}

// ---------- mail da aprire ----------
let busy = null;
function openPending() {
  busy = (busy || Promise.resolve()).then(async () => {
    let list = [];
    try {
      list = await call('GET', '/mail/outbox');
    } catch (e) {
      return console.warn('Organizer: coda non letta', e);
    }
    for (const req of list) {
      try {
        await call('POST', `/mail/outbox/${req.ws}/${req.id}/claim`);
      } catch {
        continue; // presa da un altro Thunderbird
      }
      try {
        await openCompose(req);
      } catch (e) {
        console.error(e);
        notify(`Non riesco ad aprire la mail "${req.subject}": ${e.message}`);
      }
    }
  });
  return busy;
}

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const toHtml = text => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>\n');

async function openCompose(req) {
  const attachments = await Promise.all(req.files.map(async f => {
    const r = await fetch(`${cfg.server}/api/mail/outbox/${req.ws}/${req.id}/file/${f.n}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!r.ok) throw new Error(`allegato ${f.name} non scaricato (errore ${r.status})`);
    return { file: new File([await r.blob()], f.name, { type: f.mime }) };
  }));
  let tab = null;
  if (req.reply_to) {
    // Risposta: si apre dal messaggio originale (se è in Thunderbird), con la citazione sotto il testo.
    const found = await browser.messages.query({ headerMessageId: req.reply_to }).catch(() => null);
    const original = found?.messages?.[0];
    if (original) {
      tab = await browser.compose.beginReply(original.id, 'replyToSender', { attachments });
      const d = await browser.compose.getComposeDetails(tab.id);
      const details = { to: list(req.to), cc: list(req.cc) };
      if (d.isPlainText) details.plainTextBody = `${req.body}\n\n${d.plainTextBody || ''}`;
      else details.body = /<body[^>]*>/i.test(d.body || '') ? d.body.replace(/<body[^>]*>/i, m => `${m}${toHtml(req.body)}<br>`) : `${toHtml(req.body)}<br>${d.body || ''}`;
      await browser.compose.setComposeDetails(tab.id, details);
    }
  }
  if (!tab) {
    // Testo semplice o HTML come preferisce l'identità predefinita (Impostazioni account → Composizione).
    const identity = (await browser.accounts.getDefault().catch(() => null))?.identities?.[0];
    const plain = identity?.composeHtml === false;
    tab = await browser.compose.beginNew({
      to: list(req.to), cc: list(req.cc), subject: req.subject, attachments,
      isPlainText: plain, ...(plain ? { plainTextBody: req.body } : { body: toHtml(req.body) }),
    });
  }
  composing.set(tab.id, req);
}

browser.tabs.onRemoved.addListener(id => composing.delete(id));

browser.compose.onAfterSend.addListener(async (tab, info) => {
  const req = composing.get(tab.id);
  if (!req || info.error) return;
  composing.delete(tab.id);
  const m = info.messages?.[0];
  try {
    await call('POST', '/mail/sent', {
      ws: req.ws, outbox_id: req.id,
      message_id: m?.headerMessageId || info.headerMessageId || null,
      date: (m?.date ? new Date(m.date) : new Date()).toISOString(),
      from: m?.author || '', to: (m?.recipients || []).join(', '), cc: (m?.ccList || []).join(', '), subject: m?.subject || req.subject,
    });
  } catch (e) {
    notify(`Mail inviata, ma Organizer non l'ha saputo: ${e.message}`);
  }
});

// ---------- allegati → documenti del magazzino ----------
// Da Organizer si sceglie un allegato di una mail ricevuta e l'articolo: il file sta qui, lo carichiamo noi
// come documento dell'articolo (stessa API dei caricamenti, nel workspace da cui è partita la richiesta).
function saveAttachments() {
  busy = (busy || Promise.resolve()).then(async () => {
    let list = [];
    try {
      list = await call('GET', '/mail/fetches');
    } catch (e) {
      return console.warn('Organizer: richieste di allegati non lette', e);
    }
    for (const f of list) {
      try {
        await call('POST', `/mail/fetches/${f.id}/claim`);
      } catch {
        continue;
      }
      try {
        const found = await browser.messages.query({ headerMessageId: f.message_id });
        const msg = found?.messages?.[0];
        if (!msg) throw new Error('mail non trovata in Thunderbird');
        const file = await browser.messages.getAttachmentFile(msg.id, f.part);
        const r = await fetch(`${cfg.server}/api/items/${f.item_id}/docs?${new URLSearchParams({ name: f.name, kind: f.kind })}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.token}`, 'X-Workspace': String(f.ws), 'Content-Type': file.type || f.type || 'application/octet-stream' },
          body: file,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `errore ${r.status}`);
      } catch (e) {
        notify(`Allegato "${f.name}" non salvato in Organizer: ${e.message}`);
      } finally {
        call('POST', `/mail/fetches/${f.id}/done`).catch(() => {});
      }
    }
  });
  return busy;
}

// ---------- risposte in arrivo ----------
const ids = s => [...String(s || '').matchAll(/<([^>]+)>/g)].map(x => x[1]);

async function textOf(id, full) {
  try {
    const parts = await browser.messages.listInlineTextParts(id);
    const plain = parts.find(p => p.contentType === 'text/plain') || parts[0];
    if (plain) return plain.contentType === 'text/plain' ? plain.content : htmlToText(plain.content);
  } catch {
    // Thunderbird più vecchio: si cerca nelle parti del messaggio.
  }
  const walk = p => (p.contentType === 'text/plain' && p.body) || (p.parts || []).map(walk).find(Boolean) || '';
  return walk(full);
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const b of doc.querySelectorAll('p, div, li, tr')) b.append('\n');
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

async function check(header) {
  if (!cfg.token || header.junk) return;
  if (!cfg.inbox && !watch.size) return;
  const full = await browser.messages.getFull(header.id);
  const h = name => (full.headers?.[name] || []).join(' ');
  const refs = [...ids(h('in-reply-to')), ...ids(h('references'))];
  if (!cfg.inbox && !refs.some(r => watch.has(r))) return;
  const attachments = await browser.messages.listAttachments(header.id).catch(() => []);
  const r = await call('POST', '/mail/incoming', {
    message_id: header.headerMessageId, in_reply_to: ids(h('in-reply-to'))[0] || null, references: refs,
    from: header.author, to: (header.recipients || []).join(', '), cc: (header.ccList || []).join(', '),
    subject: header.subject, date: new Date(header.date).toISOString(),
    body: (await textOf(header.id, full)).slice(0, 100000), inbox: cfg.inbox,
    attachments: attachments.map(a => ({ name: a.name, part: a.partName, size: a.size, type: a.contentType })),
  });
  if (r?.matched) watch.add(header.headerMessageId);
}

async function checkAll(page) {
  for (let p = page; p; p = p.id ? await browser.messages.continueList(p.id) : null) {
    for (const m of p.messages) await check(m).catch(e => console.warn('Organizer: mail non passata', e));
  }
}

browser.messages.onNewMailReceived.addListener((folder, page) => {
  if (folder.specialUse?.includes('inbox') || folder.type === 'inbox') checkAll(page);
});

// Al collegamento: le mail arrivate nelle Posta in arrivo da quando l'estensione le ha guardate l'ultima volta
// (Thunderbird chiuso, server irraggiungibile…); la prima volta, gli ultimi 7 giorni. Il server scarta i doppioni.
let catching = false;
async function catchUp() {
  if (catching) return;
  catching = true;
  const started = Date.now();
  try {
    const { lastCheck } = await browser.storage.local.get('lastCheck');
    const fromDate = new Date(lastCheck ? lastCheck - 3600e3 : started - 7 * 864e5);
    for (const f of await browser.folders.query({ specialUse: ['inbox'] })) {
      await checkAll(await browser.messages.query({ folderId: f.id, fromDate }));
    }
    await browser.storage.local.set({ lastCheck: started });
  } catch (e) {
    console.warn('Organizer: recupero delle mail non riuscito', e);
  } finally {
    catching = false;
  }
}

// ---------- avvio ----------
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.server || changes.token || changes.inbox)) connect();
});
connect();
