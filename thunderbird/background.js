// Organizer per Thunderbird. Tiene una connessione con il server di Organizer (token API, vedi le opzioni):
//  - quando in Organizer si preme "Manda", apre la mail qui, già compilata e con gli allegati; se è una risposta,
//    la apre come risposta al messaggio originale, così la conversazione resta unita;
//  - quando la mail parte, lo dice a Organizer (diventa "mandata", in attesa di risposta);
//  - quando arriva una mail che risponde a una conversazione seguita da Organizer, gliela passa;
//  - con "tutta la posta in arrivo" (opzioni, attivo di base) passa anche le altre mail delle cartelle Posta in
//    arrivo, che in Organizer vede solo chi le riceve. Spento, le altre mail non escono da Thunderbird;
//  - dal tasto destro su una mail (anche vecchia, in qualunque cartella), "Porta il thread in Organizer" passa
//    tutta la conversazione: i messaggi prima e tutte le risposte dopo, tra i thread attivi;
//  - al primo collegamento di una persona (lo dice il server) carica l'ultimo mese da tutte le cartelle, tranne
//    spam, cestino e bozze: in Organizer si vedono tutte le conversazioni recenti, da archiviare;
//  - le conversazioni nuove vanno nel workspace scelto per il loro account di posta (opzioni), se no nel predefinito;
//  - "Apri in Thunderbird" in Organizer apre qui il messaggio, in una scheda.
/* global browser */

let cfg = { server: '', token: '', inbox: true, wsByAccount: {} };
let watch = new Set(); // Message-ID delle conversazioni seguite
const composing = new Map(); // finestra di composizione → richiesta di Organizer
let stream = null; // AbortController della connessione aperta

const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = (state, text = '') => browser.storage.local.set({ status: { state, text, at: Date.now() } });

async function loadConfig() {
  const saved = await browser.storage.local.get(['server', 'token', 'inbox', 'wsByAccount']);
  const preset = await fetch(browser.runtime.getURL('config.json')).then(r => r.json()).catch(() => ({}));
  cfg = { server: String(saved.server || preset.server || '').replace(/\/+$/, ''), token: String(saved.token || ''), inbox: saved.inbox !== false,
    wsByAccount: saved.wsByAccount || {} };
}

async function call(method, path, body) {
  const r = await fetch(`${cfg.server}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'X-Organizer-Ext': browser.runtime.getManifest().version, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
      const r = await fetch(`${cfg.server}/api/mail/stream`, {
        headers: { Authorization: `Bearer ${cfg.token}`, 'X-Organizer-Ext': browser.runtime.getManifest().version }, signal: ctrl.signal,
      });
      if (r.status === 401) return status('error', 'Token non valido o revocato: creane uno nuovo in Organizer');
      if (!r.ok) throw new Error(`errore ${r.status}`);
      status('on', cfg.server);
      wait = 2000;
      sendIdentities();
      refreshWatch().then(catchUp).then(backfill);
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
          if (/^event: open$/m.test(ev)) openMessages();
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
let myAddresses = new Set(); // per capire se una mail vecchia l'abbiamo mandata noi
async function sendIdentities() {
  try {
    const accounts = await browser.accounts.list(false);
    const addresses = accounts.flatMap(a => (a.identities || []).map(i => i.email)).filter(Boolean);
    myAddresses = new Set(addresses.map(a => a.toLowerCase()));
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

// Una mail partita: se l'aveva preparata Organizer diventa "mandata"; in ogni caso (con "tutta la posta")
// entra nel suo thread, e se risponde a mail che Organizer non ha si recuperano anche quelle.
browser.compose.onAfterSend.addListener(async (tab, info) => {
  if (info.error) return;
  const req = composing.get(tab.id);
  composing.delete(tab.id);
  const m = info.messages?.[0];
  if (req) {
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
  }
  if (m && (req || cfg.inbox)) await pass(m, { direction: 'out' }).catch(e => console.warn('Organizer: mail mandata non passata', e));
});

// ---------- allegati → documenti del magazzino e anteprime ----------
// Da Organizer si sceglie un allegato di una mail ricevuta e l'articolo: il file sta qui, lo carichiamo noi
// come documento dell'articolo (stessa API dei caricamenti, nel workspace da cui è partita la richiesta).
// Per l'anteprima (preview) il file va solo al server, che lo mostra e lo tiene per poco.
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
        const url = f.preview ? `${cfg.server}/api/mail/fetches/${f.id}/file`
          : `${cfg.server}/api/items/${f.item_id}/docs?${new URLSearchParams({ name: f.name, kind: f.kind })}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.token}`, 'X-Workspace': String(f.ws), 'Content-Type': file.type || f.type || 'application/octet-stream' },
          body: file,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `errore ${r.status}`);
      } catch (e) {
        // L'anteprima che non arriva lo dice in Organizer, dove la si aspetta.
        if (f.preview) await call('POST', `/mail/fetches/${f.id}/done`, { error: e.message }).catch(() => {});
        else notify(`Allegato "${f.name}" non salvato in Organizer: ${e.message}`);
      } finally {
        if (!f.preview) call('POST', `/mail/fetches/${f.id}/done`).catch(() => {});
      }
    }
  });
  return busy;
}

// ---------- "Apri in Thunderbird" ----------
// Il messaggio scelto in Organizer si apre qui in una scheda, e la finestra viene davanti.
async function openMessages() {
  let list = [];
  try {
    list = await call('GET', '/mail/opens');
  } catch (e) {
    return console.warn('Organizer: mail da aprire non lette', e);
  }
  for (const mid of list) {
    try {
      const found = await browser.messages.query({ headerMessageId: mid });
      const msg = found?.messages?.[0];
      if (!msg) throw new Error('non è in nessuna cartella di Thunderbird');
      const tab = await browser.messageDisplay.open({ messageId: msg.id, location: 'tab' });
      if (tab?.windowId != null) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } catch (e) {
      notify(`Mail non aperta: ${e.message}`);
    }
  }
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

// Passa una mail di Thunderbird a Organizer. extra: direction ('in' arrivata, 'out' mandata), history (vecchia,
// chiesta per completare un thread), thread (quello che l'ha chiesta), import (scelta a mano: tra gli attivi).
async function pass(header, extra = {}, full = null) {
  full ||= await browser.messages.getFull(header.id);
  const h = name => (full.headers?.[name] || []).join(' ');
  const refs = [...ids(h('references')), ...ids(h('in-reply-to'))];
  if (!cfg.inbox && !extra.history && !extra.import && !extra.backfill && extra.direction !== 'out' && !refs.some(r => watch.has(r))) return null;
  const attachments = await browser.messages.listAttachments(header.id).catch(() => []);
  const r = await call('POST', '/mail/incoming', {
    message_id: header.headerMessageId, in_reply_to: ids(h('in-reply-to'))[0] || null, references: refs,
    from: header.author, to: (header.recipients || []).join(', '), cc: (header.ccList || []).join(', '),
    subject: header.subject, date: new Date(header.date).toISOString(),
    body: (await textOf(header.id, full)).slice(0, 100000), inbox: cfg.inbox, direction: 'in', ws: cfg.wsByAccount[header.folder?.accountId] || null, ...extra,
    attachments: attachments.map(a => ({ name: a.name, part: a.partName, size: a.size, type: a.contentType })),
  });
  if (r?.matched) watch.add(header.headerMessageId);
  if (r?.missing?.length) await history(r.missing, r.thread);
  return r;
}

// Le mail vecchie di un thread che Organizer non ha: si cercano in Thunderbird (in tutte le cartelle) e si
// mandano come storia. Al massimo 30 per volta, per non fermare tutto con conversazioni lunghissime.
async function history(missing, thread, budget = { n: 30 }) {
  for (const mid of missing) {
    if (budget.n-- <= 0) return;
    const found = await browser.messages.query({ headerMessageId: mid }).catch(() => null);
    const old = found?.messages?.[0];
    if (!old) continue;
    const mine = myAddresses.has(String(old.author || '').replace(/.*<([^>]+)>.*/, '$1').trim().toLowerCase());
    await pass(old, { history: true, thread, direction: mine ? 'out' : 'in' }).catch(e => console.warn('Organizer: mail vecchia non passata', e));
  }
}

// ---------- un thread scelto a mano ----------
// Dalla mail scelta si risale ai messaggi citati (References) e si scende alle risposte: quelle con lo stesso
// oggetto (senza Re:, R:, Fwd:…) in tutte le cartelle che citano un messaggio già raccolto, finché se ne trovano
// di nuove. Poi tutto a Organizer, dal più vecchio, nello stesso thread.
const cleanSubject = s => String(s || '').replace(/^\s*((re|r|fw|fwd|i|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
const isMine = m => myAddresses.has(String(m.author || '').replace(/.*<([^>]+)>.*/, '$1').trim().toLowerCase());
const IMPORT_MAX = 200;

async function allPages(page) {
  const out = [];
  for (let p = page; p; p = p.id ? await browser.messages.continueList(p.id) : null) out.push(...p.messages);
  return out;
}

async function conversation(start) {
  const got = new Map(); // Message-ID → { header, full, refs }
  const add = async m => {
    if (!m?.headerMessageId || got.has(m.headerMessageId) || got.size >= IMPORT_MAX) return null;
    const full = await browser.messages.getFull(m.id);
    const h = name => (full.headers?.[name] || []).join(' ');
    const x = { header: m, full, refs: [...ids(h('references')), ...ids(h('in-reply-to'))] };
    got.set(m.headerMessageId, x);
    return x;
  };
  const first = await add(start);
  // Prima: i messaggi citati che ci sono in Thunderbird.
  for (const mid of first.refs) {
    const found = await browser.messages.query({ headerMessageId: mid }).catch(() => null);
    if (found?.messages?.[0]) await add(found.messages[0]);
  }
  // Dopo: le risposte, cercate per oggetto.
  const subject = cleanSubject(start.subject);
  if (subject) {
    const candidates = (await allPages(await browser.messages.query({ subject })).catch(() => []))
      .filter(m => cleanSubject(m.subject) === subject && !m.junk);
    const pending = new Map(candidates.map(m => [m.headerMessageId, m]));
    for (let more = true; more && got.size < IMPORT_MAX;) {
      more = false;
      for (const [mid, m] of pending) {
        if (got.has(mid)) { pending.delete(mid); continue; }
        const full = await browser.messages.getFull(m.id);
        const h = name => (full.headers?.[name] || []).join(' ');
        const refs = [...ids(h('references')), ...ids(h('in-reply-to'))];
        if (refs.some(r => got.has(r))) {
          got.set(mid, { header: m, full, refs });
          pending.delete(mid);
          more = true;
        }
      }
    }
  }
  return [...got.values()].sort((a, b) => new Date(a.header.date) - new Date(b.header.date));
}

async function importThread(start, done) {
  if (!cfg.token) return notify('Collega prima Organizer (opzioni dell\'estensione)');
  try {
    const list = await conversation(start);
    for (const x of list) done.add(x.header.headerMessageId);
    let thread = null;
    for (const x of list) {
      const r = await pass(x.header, { import: true, thread, direction: isMine(x.header) ? 'out' : 'in' }, x.full);
      thread ||= r?.thread || null;
    }
    notify(`In Organizer: "${cleanSubject(start.subject) || 'senza oggetto'}", ${list.length} ${list.length === 1 ? 'messaggio' : 'messaggi'}${list.length >= IMPORT_MAX ? ' (i primi)' : ''}`);
  } catch (e) {
    console.error(e);
    notify(`Thread non portato in Organizer: ${e.message}`);
  }
}

browser.menus.create({ id: 'organizer-import', title: 'Porta il thread in Organizer', contexts: ['message_list'] });
browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'organizer-import') return;
  const picked = info.selectedMessages ? await allPages(info.selectedMessages)
    : [await browser.messageDisplay.getDisplayedMessage(tab.id).catch(() => null)].filter(Boolean);
  // Più mail scelte: un thread per ciascuna conversazione (quelle già raccolte non si ripetono).
  const done = new Set();
  for (const m of picked) if (!done.has(m.headerMessageId)) await importThread(m, done);
});

async function check(header) {
  if (!cfg.token || header.junk) return;
  if (!cfg.inbox && !watch.size) return;
  await pass(header);
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

// ---------- primo caricamento: l'ultimo mese ----------
const SKIP_FOLDERS = ['junk', 'trash', 'drafts', 'templates', 'outbox'];
let backfilling = false;
async function backfill() {
  if (backfilling) return;
  backfilling = true;
  try {
    const { since } = await call('GET', '/mail/backfill');
    if (!since) return;
    status('on', 'Carico in Organizer le mail dell\'ultimo mese…');
    const folders = (await browser.folders.query({})).filter(f => !f.isVirtual && !f.isUnified
      && !(f.specialUse || []).some(u => SKIP_FOLDERS.includes(u)) && !SKIP_FOLDERS.includes(f.type));
    const all = new Map();
    for (const f of folders) {
      const page = await browser.messages.query({ folderId: f.id, fromDate: new Date(since) }).catch(() => null);
      for (const m of page ? await allPages(page) : []) if (!m.junk && m.headerMessageId) all.set(m.headerMessageId, m);
    }
    // Dal più vecchio: i messaggi arrivano dopo quelli a cui rispondono e l'albero si forma da solo.
    const list = [...all.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    let n = 0;
    for (const m of list) {
      await pass(m, { backfill: true, direction: isMine(m) ? 'out' : 'in' }).catch(e => console.warn('Organizer: mail non caricata', e));
      if (++n % 25 === 0) status('on', `Carico in Organizer le mail dell'ultimo mese… ${n}/${list.length}`);
    }
    await call('POST', '/mail/backfill/done');
    status('on', cfg.server);
    notify(`Caricate in Organizer le mail dell'ultimo mese (${list.length})`);
  } catch (e) {
    console.warn('Organizer: caricamento dell\'ultimo mese non riuscito', e);
    status('error', `Caricamento dell'ultimo mese interrotto (${e.message}): riprovo al prossimo collegamento`);
  } finally {
    backfilling = false;
  }
}

// ---------- avvio ----------
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.wsByAccount) cfg.wsByAccount = changes.wsByAccount.newValue || {};
  if (area === 'local' && (changes.server || changes.token || changes.inbox)) connect();
});
connect();
