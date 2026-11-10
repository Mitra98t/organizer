// Real-time notifications via Server-Sent Events: at every change the clients read /api/sync again.
// Each connection belongs to a workspace and only gets that workspace's changes.
let REV = Date.now();
const clients = new Set();

export const rev = () => REV;

// wsId null = a change that concerns everyone (e.g. accounts): tell every client.
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

// Closes a person's connections (in one workspace or in all): the client reconnects and reads again.
export function dropUser(userId, wsId = null) {
  // Out of the list at once: once closed, a connection cannot be written to ('close' arrives later).
  for (const c of clients) {
    if (c.userId === userId && (wsId == null || c.wsId === wsId)) {
      clients.delete(c);
      c.res.end();
    }
  }
}

// Thunderbird extension (server/thunderbird.js): each user may have more than one connected (several computers).
// While there is one, "Send" goes through it; when it connects or disconnects the app updates.
const mailExt = new Map(); // user id → Set of open responses

export const mailExtOn = userId => (mailExt.get(userId)?.size ?? 0) > 0;
// The version of the connected extension (the most recent, if there are several); '' = before 1.5.
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
  res.extVersion = String(req.headers['x-organizer-ext'] || '').slice(0, 20); // since 1.5
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

// event: 'outbox' (a mail to open), 'watch' (the conversations to follow changed), 'fetch' (an attachment to send), 'open' (a mail to show),
// 'read' (mails read or unread in Organizer).
export function notifyMailExt(userId, event) {
  for (const res of mailExt.get(userId) || []) if (!res.writableEnded) res.write(`event: ${event}\ndata: {}\n\n`);
}
