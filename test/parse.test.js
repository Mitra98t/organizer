import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuick, parseDate, extractCodes } from '../public/js/parse.js';

const T = '2026-10-27'; // martedì

test('date relative e assolute', () => {
  assert.equal(parseDate('oggi', T), '2026-10-27');
  assert.equal(parseDate('domani', T), '2026-10-28');
  assert.equal(parseDate('ven', T), '2026-10-30');
  assert.equal(parseDate('mar', T), '2026-11-03'); // stesso giorno -> settimana dopo
  assert.equal(parseDate('venerdì', T), '2026-10-30');
  assert.equal(parseDate('dom', T), '2026-11-01');
  assert.equal(parseDate('3g', T), '2026-10-30');
  assert.equal(parseDate('2s', T), '2026-11-10');
  assert.equal(parseDate('1m', T), '2026-11-27');
  assert.equal(parseDate('fm', T), '2026-10-31');
  assert.equal(parseDate('25/11', T), '2026-11-25');
  assert.equal(parseDate('3/2', T), '2027-02-03'); // già passato -> anno prossimo
  assert.equal(parseDate('31/12/27', T), '2027-12-31');
  assert.equal(parseDate('2026-12-01', T), '2026-12-01');
  assert.equal(parseDate('no', T), null);
  assert.equal(parseDate('31/02', T), undefined);
  assert.equal(parseDate('importante', T), undefined);
});

test('riga rapida completa', () => {
  const p = parseQuick('fix bootloader #SCH-042 @rover !ven +marco', { today: T });
  assert.deepEqual(
    { kind: p.kind, title: p.title, due: p.due, project: p.project, assignee: p.assignee, codes: p.codes },
    { kind: 'todo', title: 'fix bootloader #SCH-042', due: '2026-10-30', project: 'rover', assignee: 'marco', codes: ['SCH-042'] },
  );
});

test('prefisso tipo e destinatario', () => {
  const p = parseQuick('m: preventivo schede >acquisti@ditta.it !domani', { today: T });
  assert.equal(p.kind, 'mail');
  assert.equal(p.kindExplicit, true);
  assert.equal(p.contact, 'acquisti@ditta.it');
  assert.equal(p.title, 'preventivo schede');
  assert.equal(p.due, '2026-10-28');
});

test('il testo normale non viene mangiato', () => {
  const p = parseQuick('scrivere a mario@x.it, aggiungere +1 al counter !! se fw >= 2.3 -> ok', { today: T });
  assert.equal(p.title, 'scrivere a mario@x.it, aggiungere +1 al counter !! se fw >= 2.3 -> ok');
  assert.equal(p.assignee, null);
  assert.equal(p.contact, null);
  assert.equal(p.due, undefined);
});

test('estrazione codici', () => {
  assert.deepEqual(extractCodes('usa #PRD-10.2, (#sch_7) e#no #A/B'), ['PRD-10.2', 'sch_7', 'A/B']);
  assert.deepEqual(extractCodes('#X1 e #x1'), ['x1']);
});

test('nelle note le date guardano al passato', () => {
  assert.equal(parseDate('ven', T, { past: true }), '2026-10-23');
  assert.equal(parseDate('mar', T, { past: true }), '2026-10-20');
  assert.equal(parseDate('15/9', T, { past: true }), '2026-09-15');
  assert.equal(parseDate('3/12', T, { past: true }), '2025-12-03');
  assert.equal(parseQuick('n: banco in crash !lun', { today: T }).due, '2026-10-26');
  assert.equal(parseQuick('banco in crash !lun', { today: T }).due, '2026-11-02');
});
