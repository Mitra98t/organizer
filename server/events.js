// Notifiche in tempo reale via Server-Sent Events: ad ogni modifica i client rileggono /api/sync.
// Ogni connessione appartiene a un workspace e riceve solo le modifiche di quel workspace.
let REV = Date.now();
const clients = new Set();

export const rev = () => REV;

// wsId null = modifica che riguarda tutti (es. account): avvisa ogni client.
export function bump(by, wsId = null) {
  REV++;
  const msg = `event: change\ndata: ${JSON.stringify({ rev: REV, by })}\n\n`;
  for (const c of clients) if (wsId == null || c.wsId === wsId) c.res.write(msg);
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
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

// Chiude le connessioni di una persona (in un workspace o in tutti): il client si riconnette e rilegge.
export function dropUser(userId, wsId = null) {
  for (const c of clients) if (c.userId === userId && (wsId == null || c.wsId === wsId)) c.res.end();
}
