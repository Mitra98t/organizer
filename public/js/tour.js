// Giro di Organizer: passi sull'app vera, dentro un workspace di prova solo tuo con contenuti finti
// (server/tour.js). Ogni passo apre una pagina e mette in luce una sua parte con una scheda di spiegazione;
// intanto si può usare l'app normalmente. Lo stato (passo, workspace di prova, quello da cui si arriva) sta in
// localStorage, perché cambiare workspace ricarica la pagina. Alla prima entrata l'app chiede se fare il giro.
import { h, icon, S, api, act, render, toast, load, save, switchWorkspace, clearLocal } from './core.js';

const KEY = 'org.tour';
const kbd = t => h('code.k', t);

// sel: cosa mettere in luce (il primo elemento visibile); senza sel la scheda sta in un angolo, center: al
// centro con lo sfondo scurito.
function steps(ids) {
  return [
    { hash: '#/agenda', center: true, title: 'Benvenuto nel giro',
      text: ['Questo è un workspace di prova, solo tuo, con contenuti finti: Anna e Luca non esistono. Puoi scrivere, spuntare e cancellare quello che vuoi; alla fine lo elimini con un clic e torni al tuo.'] },
    { hash: '#/agenda', sel: '.qrow', title: 'La barra rapida',
      text: ['Una riga diventa una todo. Dentro: ', kbd('#codice'), ' un articolo, ', kbd('@progetto'), ', ', kbd('!ven'), ' la scadenza, ',
        kbd('+anna'), ' la condividi, ', kbd('++anna'), ' gliela assegni. Con ', kbd('m:'), ' davanti è una mail, con ', kbd('n:'), ' una nota del diario.'] },
    { hash: '#/agenda', title: 'Agenda',
      text: ['Le cose da fare, per scadenza. Tutto quello che scrivi è privato finché non lo condividi: qui vedi anche le todo che Anna e Luca hanno condiviso con te o ti hanno assegnato.'] },
    ids.entry && { hash: `#/v/${ids.entry}`, sel: '.editor', title: 'Una voce aperta',
      text: ['Dettagli, sotto-attività, aggiornamenti con la data (cosa hai scoperto, cosa manca) e "Visibile a" per scegliere con chi condividerla. I codici come SCH-042 portano all\'articolo.'] },
    { hash: '#/diario', title: 'Diario',
      text: ['Le cose successe una volta che vanno ricordate. Con ', kbd('!ieri'), ' o ', kbd('!12/10'), ' dici quando è successo; con i codici e i progetti le ritrovi nell\'articolo e nel progetto.'] },
    { hash: '#/progetti', title: 'Progetti',
      text: ['Ogni progetto (', kbd('@rover'), ') raccoglie le sue todo, le mail, le note del diario e gli articoli del magazzino che usa. Si possono mettere in pausa e avere sottoprogetti.'] },
    { hash: '#/magazzino', title: 'Magazzino',
      text: ['Gli articoli per codice, a colonne per categoria: posizione, quantità, firmware, codici alternativi e componenti (PRD-ROVER contiene SCH-042, PSU-12 e la staffa). Nei suggerimenti basta un pezzo: ',
        kbd('#sch42'), ' trova SCH-042.'] },
    ids.pdf && { hash: `#/d/${ids.pdf}`, title: 'Documenti',
      text: ['PDF, immagini e file di testo si leggono qui, con le versioni. Le note si attaccano a un punto preciso: sono tue, a meno che non le condividi (quella di Anna è condivisa con tutti).'] },
    ids.model && { hash: `#/d/${ids.model}`, title: 'Modelli 3D',
      text: ['STL, STEP e 3MF: trascina per ruotare, rotella o due dita per lo zoom. Anche qui una nota si aggancia a un punto del pezzo.'] },
    { hash: '#/mail', sel: '.tcard', title: 'Mail a thread',
      text: ['La posta è personale: gli altri del workspace non la vedono. Ogni conversazione è un thread: aprirlo lo legge e basta, il tasto a sinistra lo archivia. Con l\'estensione di Thunderbird arrivano qui anche le mail ricevute.'] },
    ids.thread && { hash: `#/t/${ids.thread}`, sel: '.mail-side', title: 'Dentro un thread',
      text: ['A sinistra i messaggi, con Rispondi e Rispondi a tutti: la bozza si scrive qui e parte da Thunderbird. A destra colleghi il thread ad articoli, progetti e documenti, e lo ritrovi anche lì. Un codice scritto in una mail si collega da solo.'] },
    { hash: '#/chat', title: 'Chat',
      text: ['Canali per tutti o per poche persone. ', kbd('+luca'), ' lo avvisa, ', kbd('[['), ' cita una voce, un documento o un articolo. Un canale si può silenziare: allora avvisa solo se ti citano.'] },
    { hash: '#/agenda', sel: '.bell', title: 'Notifiche',
      text: ['Qui arrivano citazioni, assegnazioni e mail. Da Impostazioni → Notifiche le ricevi anche sul telefono o sul computer, ad app chiusa.'] },
    { hash: '#/agenda', sel: '#search', title: 'Cerca',
      text: ['Cerca in tutto il workspace: voci, articoli, documenti, progetti e contatti.'] },
    { hash: '#/impostazioni', title: 'Impostazioni',
      text: ['Tema, notifiche, permessi del workspace, collegamento con Thunderbird e il comando ', kbd('org'), ' da terminale. Il giro si riapre da App e aiuto.'] },
    { hash: null, center: true, end: true, title: 'Fine del giro',
      text: ['Il workspace di prova si può eliminare adesso (torni al tuo) oppure tenere per provare ancora: lo trovi nel menu dei workspace e lo elimini da Impostazioni → App e aiuto.'] },
  ].filter(Boolean);
}

export const tourState = () => load(KEY, null);
const setState = st => (st ? save(KEY, st) : localStorage.removeItem(KEY));

// ---------- inizio e fine ----------
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

// Elimina il workspace di prova; se ci sei dentro torni a quello da cui sei partito (o al primo che hai).
export async function deleteTour() {
  const D = S.data;
  const st = tourState();
  setState(null);
  hide();
  await api('POST', '/tour/end', { delete: true });
  if (D.workspace.id !== D.tourWs) {
    D.tourWs = null;
    toast('Workspace di prova eliminato');
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
  toast('Il workspace di prova resta: lo trovi nel menu dei workspace');
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

// ---------- scheda e luce ----------
const spot = h('div.tour-spot', { hidden: true });
const card = h('div.tour-card', { hidden: true, role: 'dialog', 'aria-labelledby': 'tour-title' });
let shown = -1; // passo disegnato nella scheda (si ridisegna solo quando cambia)
let scrolled = -1;

function hide() {
  spot.hidden = true;
  card.hidden = true;
  shown = -1;
}

function drawCard(s, i, n) {
  card.replaceChildren(
    h('div.tour-h', h('h3#tour-title', s.title), !s.end && h('button.icon-btn.sm', { title: 'Esci dal giro', 'aria-label': 'Esci dal giro', onclick: () => go(n - 1) }, icon('x'))),
    h('p', s.text),
    s.end
      ? h('div.tour-foot.end',
        h('button.btn.primary', { onclick: () => act(deleteTour) }, icon('trash'), 'Elimina e torna al mio workspace'),
        h('button.btn', { onclick: keep }, 'Tienilo'),
        h('button.btn.ghost', { onclick: () => act(() => startTour({ restart: true })) }, icon('restore'), 'Ricomincia'))
      : h('div.tour-foot',
        h('span.tour-n', `${i + 1} di ${n}`),
        i > 0 && h('button.btn.sm.ghost', { onclick: () => go(i - 1) }, 'Indietro'),
        h('button.btn.sm.primary', { onclick: () => go(i + 1) }, i === 0 ? 'Iniziamo' : 'Avanti')));
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
  // Luce: sull'elemento, oppure (al centro) uno sfondo scuro su tutto; negli altri passi niente.
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
  // Scheda: su telefono in basso; al centro; sotto o sopra l'elemento; altrimenti in basso a destra.
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

// ---------- invito alla prima entrata ----------
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
      h('h2#ti-title', icon('help'), 'Vuoi fare il giro?'),
      h('p', 'Un giro guidato di Organizer in un paio di minuti: agenda, magazzino, documenti, mail, chat. Si fa su un workspace di prova con contenuti finti, che alla fine elimini con un clic.'),
      h('div.toolbar',
        h('button.btn.primary', { onclick: () => { close(false); act(startTour); } }, 'Inizia il giro'),
        h('button.btn.ghost', { onclick: () => close(true) }, 'Più tardi')),
      h('p.muted', 'Lo ritrovi sempre in Impostazioni → App e aiuto.')));
  document.body.append(dialog);
  dialog.showModal();
}

// Dopo ogni disegno dell'app (vedi app.js).
export function tourTick() {
  const D = S.data;
  if (!D?.workspace) return;
  const st = tourState();
  if (st && 'tourWs' in D && D.tourWs !== st.ws) setState(null); // il workspace di prova non c'è più
  if (!st && D.onboarded === false && !invited && D.workspace.id !== D.tourWs) invite();
  place();
}

// Le pagine cambiano altezza da sole (immagini, anteprime, colonne): la luce segue.
addEventListener('resize', () => requestAnimationFrame(place));
addEventListener('scroll', () => requestAnimationFrame(place), { passive: true });
setInterval(() => { if (!card.hidden || tourState()) place(); }, 500);
