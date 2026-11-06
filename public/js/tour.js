// Organizer tour: steps on the real app, inside a demo workspace of your own with fake content (server/tour.js).
// Each step opens a page and highlights a part of it with an explanation card; meanwhile the app can be used
// normally. The state (step, demo workspace, the one you came from) is in localStorage, because switching workspace
// reloads the page. On the first visit the app asks whether to take the tour.
import { h, icon, S, api, act, render, toast, load, save, switchWorkspace, clearLocal } from './core.js';
import { tr } from './i18n.js';

const KEY = 'org.tour';
const kbd = t => h('code.k', t);

// sel: what to highlight (the first visible element); without sel the card sits in a corner, center: in the middle
// with the background darkened.
function steps(ids) {
  return [
    { hash: '#/agenda', center: true, title: tr('Welcome to the tour'),
      text: [tr('This is a demo workspace, yours only, with fake content: Anna and Luca do not exist. You can write, tick and delete whatever you like; at the end you delete it with a click and go back to yours.')] },
    { hash: '#/agenda', sel: '.qrow', title: tr('The quick bar'),
      text: [tr('A line becomes a todo. Inside: '), kbd('#code'), tr(' an item, '), kbd('@project'), ', ', kbd('!fri'), tr(' the due date, '),
        kbd('+anna'), tr(' shares it, '), kbd('++anna'), tr(' assigns it to her. With '), kbd('m:'), tr(' in front it is a mail, with '), kbd('n:'), tr(' a journal note.')] },
    { hash: '#/agenda', title: tr('Agenda'),
      text: [tr('Things to do, by due date. Everything you write is private until you share it: here you also see the todos Anna and Luca shared with you or assigned to you.')] },
    ids.entry && { hash: `#/v/${ids.entry}`, sel: '.editor', title: tr('An open entry'),
      text: [tr('Details, subtasks, dated updates (what you found out, what is missing) and "Visible to" to choose who to share it with. Codes like SCH-042 lead to the item.')] },
    { hash: '#/diario', title: tr('Journal'),
      text: [tr('Things that happened once and should be remembered. With '), kbd('!yesterday'), tr(' or '), kbd('!12/10'), tr(' you say when it happened; with codes and projects you find them again in the item and the project.')] },
    { hash: '#/progetti', title: tr('Projects'),
      text: [tr('Each project ('), kbd('@rover'), tr(') gathers its todos, mails, journal notes and the inventory items it uses. Projects can be paused and have subprojects.')] },
    { hash: '#/magazzino', title: tr('Inventory'),
      text: [tr('Items by code, in columns by category: location, quantity, firmware, alternative codes and components (PRD-ROVER contains SCH-042, PSU-12 and the bracket). In the suggestions a piece is enough: '),
        kbd('#sch42'), tr(' finds SCH-042.')] },
    ids.pdf && { hash: `#/d/${ids.pdf}`, title: tr('Documents'),
      text: [tr('PDFs, images and text files are read here, with their versions. Notes are pinned to a precise point: they are yours unless you share them (Anna\'s is shared with everyone).')] },
    ids.model && { hash: `#/d/${ids.model}`, title: tr('3D models'),
      text: [tr('STL, STEP and 3MF: drag to rotate, wheel or two fingers to zoom. Here too a note hooks onto a point of the part.')] },
    { hash: '#/mail', sel: '.topic-card', title: tr('Mail by topic'),
      text: [tr('Mail is personal: the others in the workspace do not see it. Each card is a topic with its conversations: the button on the left archives a conversation, dragging it onto another topic merges them. Star and colour to find them again.')] },
    ids.thread && { hash: `#/t/${ids.thread}`, sel: '.tp-tree', title: tr('Inside a topic'),
      text: [tr('On the left the mail tree, like a forum: each reply under the one it answers. In the middle the chosen mail, with Reply and Reply all (the draft is written here and leaves from Thunderbird). On the right the links: items and projects mentioned in the mails link by themselves, and you remove them if they are wrong.')] },
    { hash: '#/chat', title: tr('Chat'),
      text: [tr('Channels for everyone or for a few people. '), kbd('+luca'), tr(' notifies him, '), kbd('[['), tr(' mentions an entry, a document or an item. A channel can be muted: then it notifies only when you are mentioned.')] },
    { hash: '#/agenda', sel: '.bell', title: tr('Notifications'),
      text: [tr('Mentions, assignments and mails arrive here. From Settings → Notifications you also get them on the phone or the computer, with the app closed.')] },
    { hash: '#/agenda', sel: '#search', title: tr('Search'),
      text: [tr('Searches the whole workspace: entries, items, documents, projects and contacts.')] },
    { hash: '#/impostazioni', title: tr('Settings'),
      text: [tr('Theme, notifications, workspace permissions, connection with Thunderbird and the '), kbd('org'), tr(' terminal command. The tour opens again from App and help.')] },
    { hash: null, center: true, end: true, title: tr('End of the tour'),
      text: [tr('The demo workspace can be deleted now (you go back to yours) or kept to keep trying: you find it in the workspace menu and delete it from Settings → App and help.')] },
  ].filter(Boolean);
}

export const tourState = () => load(KEY, null);
const setState = st => (st ? save(KEY, st) : localStorage.removeItem(KEY));

// ---------- start and end ----------
export async function startTour({ restart = false } = {}) {
  const D = S.data;
  const r = await api('POST', '/tour/start');
  const prev = tourState();
  const same = prev?.ws === r.workspace_id;
  const home = D.workspace.id !== r.workspace_id ? D.workspace.id : same ? prev.home : null;
  const st = { step: same && !restart ? prev.step : 0, ws: r.workspace_id, home, ids: r.ids };
  D.tourWs = r.workspace_id;
  D.onboarded = true;
  setState(st);
  const hash = steps(st.ids)[st.step].hash || '#/agenda';
  if (D.workspace.id !== r.workspace_id) return switchWorkspace(r.workspace_id, hash);
  shown = -1;
  location.hash = hash;
  render();
}

// Deletes the demo workspace; if you are in it you go back to the one you came from (or to your first one).
export async function deleteTour() {
  const D = S.data;
  const st = tourState();
  setState(null);
  hide();
  await api('POST', '/tour/end', { delete: true });
  if (D.workspace.id !== D.tourWs) {
    D.tourWs = null;
    toast(tr('Demo workspace deleted'));
    return render();
  }
  const home = D.workspaces.find(w => w.id === st?.home && !w.tour) || D.workspaces.find(w => !w.tour && w.id !== D.tourWs);
  if (home) return switchWorkspace(home.id, '#/agenda');
  clearLocal();
  location.hash = '#/agenda';
  location.reload();
}

function keep() {
  setState(null);
  hide();
  toast(tr('The demo workspace stays: you find it in the workspace menu'));
  render();
}

function go(n) {
  const st = tourState();
  const list = steps(st.ids);
  st.step = Math.max(0, Math.min(list.length - 1, n));
  setState(st);
  const s = list[st.step];
  if (s.hash && location.hash !== s.hash) location.hash = s.hash;
  else render();
}

// ---------- card and highlight ----------
const spot = h('div.tour-spot', { hidden: true });
const card = h('div.tour-card', { hidden: true, role: 'dialog', 'aria-labelledby': 'tour-title' });
let shown = -1; // step drawn in the card (redrawn only when it changes)
let scrolled = -1;

function hide() {
  spot.hidden = true;
  card.hidden = true;
  shown = -1;
}

function drawCard(s, i, n) {
  card.replaceChildren(
    h('div.tour-h', h('h3#tour-title', s.title), !s.end && h('button.icon-btn.sm', { title: tr('Leave the tour'), 'aria-label': tr('Leave the tour'), onclick: () => go(n - 1) }, icon('x'))),
    h('p', s.text),
    s.end
      ? h('div.tour-foot.end',
        h('button.btn.primary', { onclick: () => act(deleteTour) }, icon('trash'), tr('Delete it and go back to my workspace')),
        h('button.btn', { onclick: keep }, tr('Keep it')),
        h('button.btn.ghost', { onclick: () => act(() => startTour({ restart: true })) }, icon('restore'), tr('Start over')))
      : h('div.tour-foot',
        h('span.tour-n', tr('{i} of {n}', { i: i + 1, n })),
        i > 0 && h('button.btn.sm.ghost', { onclick: () => go(i - 1) }, tr('Back')),
        h('button.btn.sm.primary', { onclick: () => go(i + 1) }, i === 0 ? tr('Let\'s start') : tr('Next'))));
}

const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

function place() {
  const st = tourState();
  const D = S.data;
  if (!st || !D || D.workspace?.id !== st.ws) return hide();
  const list = steps(st.ids);
  const i = Math.min(st.step, list.length - 1);
  const s = list[i];
  if (shown !== i) {
    drawCard(s, i, list.length);
    shown = i;
  }
  if (!card.isConnected) document.body.append(spot, card);
  card.hidden = false;
  const narrow = innerWidth < 700;
  const here = !s.hash || location.hash === s.hash || (s.hash === '#/agenda' && !location.hash.replace(/^#\/?/, ''));
  const el = here && s.sel && [...document.querySelectorAll(s.sel)].find(visible);
  if (el && scrolled !== i) {
    scrolled = i;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: 'center' });
  }
  // Highlight: on the element, or (centred) a dark background over everything; nothing in the other steps.
  spot.classList.toggle('dim', !!s.center);
  if (el) {
    const r = el.getBoundingClientRect();
    const pad = 6;
    Object.assign(spot.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    spot.hidden = false;
  } else if (s.center) {
    Object.assign(spot.style, { top: `${innerHeight / 2}px`, left: `${innerWidth / 2}px`, width: '0px', height: '0px' });
    spot.hidden = false;
  } else spot.hidden = true;
  // Card: at the bottom on a phone; in the centre; below or above the element; otherwise bottom right.
  card.className = 'tour-card';
  Object.assign(card.style, { top: '', left: '', right: '', bottom: '' });
  if (narrow) return card.classList.add('bottom');
  if (s.center) return card.classList.add('center');
  if (!el) return card.classList.add('corner');
  const r = el.getBoundingClientRect();
  const ch = card.offsetHeight;
  const cw = card.offsetWidth;
  const below = r.bottom + 14 + ch < innerHeight;
  const above = r.top - 14 - ch > 0;
  if (!below && !above) return card.classList.add('corner');
  card.style.top = `${below ? r.bottom + 14 : r.top - 14 - ch}px`;
  card.style.left = `${Math.max(16, Math.min(innerWidth - cw - 16, r.left))}px`;
}

// ---------- invitation on the first visit ----------
let invited = false;
function invite() {
  invited = true;
  const close = seen => {
    dialog.close();
    dialog.remove();
    if (seen) {
      S.data.onboarded = true;
      api('POST', '/tour/seen').catch(() => {});
    }
  };
  const dialog = h('dialog.fb.tour-invite', { 'aria-labelledby': 'ti-title', oncancel: () => close(true) },
    h('div.ti-body',
      h('h2#ti-title', icon('help'), tr('Take the tour?')),
      h('p', tr('A guided tour of Organizer in a couple of minutes: agenda, inventory, documents, mail, chat. It runs on a demo workspace with fake content, which you delete with a click at the end.')),
      h('div.toolbar',
        h('button.btn.primary', { onclick: () => { close(false); act(startTour); } }, tr('Start the tour')),
        h('button.btn.ghost', { onclick: () => close(true) }, tr('Later'))),
      h('p.muted', tr('You can always find it in Settings → App and help.'))));
  document.body.append(dialog);
  dialog.showModal();
}

// After every render of the app (see app.js).
export function tourTick() {
  const D = S.data;
  if (!D?.workspace) return;
  const st = tourState();
  if (st && 'tourWs' in D && D.tourWs !== st.ws) setState(null); // the demo workspace is gone
  if (!st && D.onboarded === false && !invited && D.workspace.id !== D.tourWs) invite();
  place();
}

// Pages change height by themselves (images, previews, columns): the highlight follows.
addEventListener('resize', () => requestAnimationFrame(place));
addEventListener('scroll', () => requestAnimationFrame(place), { passive: true });
setInterval(() => { if (!card.hidden || tourState()) place(); }, 500);
