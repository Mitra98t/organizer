// Notifiche in tempo reale via Server-Sent Events: ad ogni modifica i client rileggono /api/sync.
let REV = Date.now();
const clients = new Set();

export const rev = () => REV;

export function bump(by) {
  REV++;
  const msg = `event: change\ndata: ${JSON.stringify({ rev: REV, by })}\n\n`;
  for (const c of clients) c.res.write(msg);
}

export function openStream(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\nevent: change\ndata: ${JSON.stringify({ rev: REV })}\n\n`);
  const client = { res, userId: user.id };
  clients.add(client);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function dropUser(userId) {
  for (const c of clients) if (c.userId === userId) c.res.end();
}
