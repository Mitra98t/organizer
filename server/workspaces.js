// Workspaces: each has its own data and members. Anyone can create one (and becomes its admin); the others are
// joined with an invite.
import { route } from './api.js';
import {
  acc, atx, workspaceById, workspacesOf, roleIn, createWorkspace, removeMember, setSessionWorkspace,
} from './accounts.js';
import { dropUser } from './events.js';
import { fail, now, str } from './util.js';

const getWs = (id, user, { admin = false } = {}) => {
  const ws = workspaceById(id) || fail(404, 'Workspace not found');
  const role = roleIn(ws.id, user.id) || fail(404, 'Workspace not found');
  if (admin && role !== 'admin') fail(403, 'Only workspace admins can do that');
  return ws;
};

route('GET', '/api/workspaces', ({ user }) => workspacesOf(user.id), { ws: false });

route('POST', '/api/workspaces', async ({ user, token, body }) => {
  const b = await body();
  const name = str(b.name, 80) || fail(400, 'Give the workspace a name');
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
  acc.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(str(b.name, 80) || fail(400, 'The name cannot be empty'), ws.id);
}, { ws: false });

route('POST', '/api/workspaces/:id/leave', ({ params, user }) => {
  removeMember(getWs(params.id, user), user.id);
}, { ws: false });

// Deleting: no more members nor invites; the data file stays on the server (it can be recovered by hand).
route('DELETE', '/api/workspaces/:id', async ({ params, user, body }) => {
  const b = await body();
  const ws = getWs(params.id, user, { admin: true });
  if (str(b.confirm, 80) !== ws.name) fail(400, 'To delete it, type the workspace\'s name exactly');
  const members = acc.prepare('SELECT user_id FROM memberships WHERE workspace_id = ?').all(ws.id).map(m => m.user_id);
  atx(() => {
    acc.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(now(), ws.id);
    acc.prepare('DELETE FROM memberships WHERE workspace_id = ?').run(ws.id);
    acc.prepare('DELETE FROM invites WHERE workspace_id = ?').run(ws.id);
    acc.prepare('UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?').run(ws.id);
  });
  for (const id of members) dropUser(id, ws.id);
}, { ws: false });
