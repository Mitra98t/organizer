// Workspace: ognuno ha i suoi dati e i suoi membri. Chiunque può crearne uno (e ne diventa admin);
// negli altri si entra con un invito.
import { route } from './api.js';
import {
  acc, atx, workspaceById, workspacesOf, roleIn, createWorkspace, removeMember, setSessionWorkspace,
} from './accounts.js';
import { dropUser } from './events.js';
import { fail, now, str } from './util.js';

const getWs = (id, user, { admin = false } = {}) => {
  const ws = workspaceById(id) || fail(404, 'Workspace non trovato');
  const role = roleIn(ws.id, user.id) || fail(404, 'Workspace non trovato');
  if (admin && role !== 'admin') fail(403, 'Solo gli admin del workspace possono farlo');
  return ws;
};

route('GET', '/api/workspaces', ({ user }) => workspacesOf(user.id), { ws: false });

route('POST', '/api/workspaces', async ({ user, token, body }) => {
  const b = await body();
  const name = str(b.name, 80) || fail(400, 'Dai un nome al workspace');
  const ws = createWorkspace(name, user.id);
  setSessionWorkspace(token, user.id, ws.id);
  return { id: ws.id };
}, { ws: false });

route('POST', '/api/workspaces/:id/switch', ({ params, user, token }) => {
  const ws = getWs(params.id, user);
  setSessionWorkspace(token, user.id, ws.id);
  return { id: ws.id };
}, { ws: false });

route('PATCH', '/api/workspaces/:id', async ({ params, user, body }) => {
  const b = await body();
  const ws = getWs(params.id, user, { admin: true });
  acc.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(str(b.name, 80) || fail(400, 'Il nome non può essere vuoto'), ws.id);
}, { ws: false });

route('POST', '/api/workspaces/:id/leave', ({ params, user }) => {
  removeMember(getWs(params.id, user), user.id);
}, { ws: false });

// Eliminazione: niente più membri né inviti; il file dei dati resta sul server (si può recuperare a mano).
route('DELETE', '/api/workspaces/:id', async ({ params, user, body }) => {
  const b = await body();
  const ws = getWs(params.id, user, { admin: true });
  if (str(b.confirm, 80) !== ws.name) fail(400, 'Per eliminare scrivi esattamente il nome del workspace');
  const members = acc.prepare('SELECT user_id FROM memberships WHERE workspace_id = ?').all(ws.id).map(m => m.user_id);
  atx(() => {
    acc.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(now(), ws.id);
    acc.prepare('DELETE FROM memberships WHERE workspace_id = ?').run(ws.id);
    acc.prepare('DELETE FROM invites WHERE workspace_id = ?').run(ws.id);
    acc.prepare('UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?').run(ws.id);
  });
  for (const id of members) dropUser(id, ws.id);
}, { ws: false });
