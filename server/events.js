// Notifiche in tempo reale via Server-Sent Events: ad ogni modifica i client rileggono /api/sync.
// Ogni connessione appartiene a un workspace e riceve solo le modifiche di quel workspace.
let REV = Date.now();
const clients = new Set();

export const rev = () => REV;

// wsId null = modifica che riguarda tutti (es. account): avvisa ogni client.
export function bump(by, wsId = null) {
  REV++;
  const msg = `event: change\ndata: ${JSON.stringify({ rev: REV, by })}\n\n`;
  for (const c of clients) if ((wsId == null || c.wsId === wsId) && !c.res.writableEnded) c.res.write(msg);
}

export function openStream(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\nevent: change\ndata: ${JSON.stringify({ rev: REV })}\n\n`);
  const client = { res, userId: user.id, wsId: user.workspace_id };
  clients.add(client);
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

// Chiude le connessioni di una persona (in un workspace o in tutti): il client si riconnette e rilegge.
export function dropUser(userId, wsId = null) {
  // Fuori subito dall'elenco: chiusa, una connessione non si può più scrivere ('close' arriva dopo).
  for (const c of clients) {
    if (c.userId === userId && (wsId == null || c.wsId === wsId)) {
      clients.delete(c);
      c.res.end();
    }
  }
}

// Estensione di Thunderbird (server/thunderbird.js): ogni utente può averne più di una collegata (più computer).
// Finché ce n'è una, "Manda" passa da lei; quando si collega o si scollega l'app si aggiorna.
const mailExt = new Map(); // id utente → Set di risposte aperte

export const mailExtOn = userId => (mailExt.get(userId)?.size ?? 0) > 0;
// La versione dell'estensione collegata (la più recente, se ce n'è più d'una); '' = prima della 1.5.
export const mailExtVersion = userId => [...(mailExt.get(userId) || [])].map(r => r.extVersion || '')
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;

export function openMailExtStream(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\nevent: hello\ndata: {}\n\n');
  res.extVersion = String(req.headers['x-organizer-ext'] || '').slice(0, 20); // dalla 1.5
  let set = mailExt.get(user.id);
  if (!set) mailExt.set(user.id, (set = new Set()));
  set.add(res);
  if (set.size === 1) bump(user.id);
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (!set.size) bump(user.id);
  });
}

// event: 'outbox' (c'è una mail da aprire) o 'watch' (cambiate le conversazioni da seguire).
export function notifyMailExt(userId, event) {
  for (const res of mailExt.get(userId) || []) if (!res.writableEnded) res.write(`event: ${event}\ndata: {}\n\n`);
}
