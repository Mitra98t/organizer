// Trascinamento con eventi pointer (non il drag nativo HTML5), così funziona uguale con mouse e touch.
// Mouse: parte dopo 5 px. Touch: pressione lunga, così lo scorrimento della pagina resta normale.
//
// draggable({ handle, bodyClass, data(el), ghost(data), target(el, data) → { el, ok, value } | null, drop(data, target) })
//   handle: selettore degli elementi trascinabili; target: dato l'elemento sotto il puntatore, dove si rilascerebbe.
import { h, RS, render, isReadOnly } from './core.js';

const specs = [];
let drag = null;

export function draggable(spec) {
  specs.push(spec);
}

function start() {
  drag.active = true;
  RS.hold = true; // niente ridisegni sotto il puntatore durante il trascinamento
  drag.ghost = h('div.drag-ghost', drag.spec.ghost(drag.data));
  document.body.append(drag.ghost);
  document.body.classList.add('dnd', drag.spec.bodyClass);
  drag.el.classList.add('dragging');
  drag.spec.onStart?.(drag.data);
  navigator.vibrate?.(15);
}

function end(drop) {
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  if (!d.active) return;
  d.ghost.remove();
  d.el.classList.remove('dragging');
  d.target?.el.classList.remove('drop-ok', 'drop-no');
  document.body.classList.remove('dnd', d.spec.bodyClass);
  // Il rilascio non deve diventare anche un clic sul link trascinato; se il clic non arriva il blocco scade.
  const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 80);
  RS.hold = false;
  if (drop && d.target?.ok) d.spec.drop(d.data, d.target);
  if (RS.pending) {
    RS.pending = false;
    render();
  }
}

document.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  for (const spec of specs) {
    const el = ev.target.closest(spec.handle);
    if (!el || isReadOnly(el)) continue; // in sola lettura non si sposta niente
    drag = { spec, el, data: spec.data(el), x: ev.clientX, y: ev.clientY, touch: ev.pointerType !== 'mouse', active: false };
    if (drag.touch) drag.timer = setTimeout(() => drag && start(), 380);
    return;
  }
});

document.addEventListener('pointermove', ev => {
  if (!drag) return;
  if (!drag.active) {
    const dist = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y);
    if (drag.touch) { if (dist > 8) end(false); } // ha iniziato a scorrere: niente trascinamento
    else if (dist > 5) start();
    if (!drag?.active) return;
  }
  ev.preventDefault();
  drag.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const t = under ? drag.spec.target(under, drag.data) : null;
  if (drag.target?.el !== t?.el) {
    drag.target?.el.classList.remove('drop-ok', 'drop-no');
    t?.el.classList.add(t.ok ? 'drop-ok' : 'drop-no');
  }
  drag.target = t;
  // Scorrimento automatico vicino ai bordi della finestra.
  const edge = 70;
  if (ev.clientY < edge) window.scrollBy(0, -12);
  else if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
}, { passive: false });

document.addEventListener('pointerup', () => drag && end(true));
document.addEventListener('pointercancel', () => drag && end(false));
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && drag?.active) { ev.preventDefault(); end(false); } }, true);
// Su touch, dopo la pressione lunga, il dito non deve far scorrere la pagina né aprire il menu del link.
document.addEventListener('touchmove', ev => { if (drag?.active) ev.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', ev => { if (drag) ev.preventDefault(); });
