import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuick, parseDate, extractCodes } from '../public/js/parse.js';

const T = '2026-10-27'; // a Tuesday

test('relative and absolute dates', () => {
  assert.equal(parseDate('today', T), '2026-10-27');
  assert.equal(parseDate('tomorrow', T), '2026-10-28');
  assert.equal(parseDate('fri', T), '2026-10-30');
  assert.equal(parseDate('tue', T), '2026-11-03'); // same day -> the week after
  assert.equal(parseDate('friday', T), '2026-10-30');
  assert.equal(parseDate('sun', T), '2026-11-01');
  assert.equal(parseDate('3d', T), '2026-10-30');
  assert.equal(parseDate('2w', T), '2026-11-10');
  assert.equal(parseDate('1m', T), '2026-11-27');
  assert.equal(parseDate('eom', T), '2026-10-31');
  assert.equal(parseDate('25/11', T), '2026-11-25');
  assert.equal(parseDate('3/2', T), '2027-02-03'); // already past -> next year
  assert.equal(parseDate('31/12/27', T), '2027-12-31');
  assert.equal(parseDate('2026-12-01', T), '2026-12-01');
  assert.equal(parseDate('none', T), null);
  assert.equal(parseDate('31/02', T), undefined);
  assert.equal(parseDate('important', T), undefined);
});

test('the Italian date words work too', () => {
  assert.equal(parseDate('oggi', T), '2026-10-27');
  assert.equal(parseDate('domani', T), '2026-10-28');
  assert.equal(parseDate('ven', T), '2026-10-30');
  assert.equal(parseDate('mar', T), '2026-11-03');
  assert.equal(parseDate('venerdì', T), '2026-10-30');
  assert.equal(parseDate('dom', T), '2026-11-01');
  assert.equal(parseDate('3g', T), '2026-10-30');
  assert.equal(parseDate('2s', T), '2026-11-10');
  assert.equal(parseDate('fm', T), '2026-10-31');
  assert.equal(parseDate('no', T), null);
});

test('full quick line', () => {
  const p = parseQuick('fix bootloader #SCH-042 @rover !fri ++marco', { today: T });
  assert.deepEqual(
    { kind: p.kind, title: p.title, due: p.due, project: p.project, assignee: p.assignee, shares: p.shares, codes: p.codes },
    { kind: 'todo', title: 'fix bootloader #SCH-042', due: '2026-10-30', project: 'rover', assignee: 'marco', shares: ['marco'], codes: ['SCH-042'] },
  );
});

test('sharing: +person, ++person, +all', () => {
  const p = parseQuick('review schematic +luca ++marco +Luca +all', { today: T });
  assert.deepEqual([p.title, p.shares, p.assignee, p.shareAll], ['review schematic', ['luca', 'marco'], 'marco', true]);
  assert.deepEqual([parseQuick('just for me').shares, parseQuick('just for me').shareAll], [[], false]);
  assert.equal(parseQuick('to everyone +tutti').shareAll, true);
});

test('kind prefix and recipient', () => {
  const p = parseQuick('m: quote for boards >purchasing@company.example !tomorrow', { today: T });
  assert.equal(p.kind, 'mail');
  assert.equal(p.kindExplicit, true);
  assert.equal(p.contact, 'purchasing@company.example');
  assert.equal(p.title, 'quote for boards');
  assert.equal(p.due, '2026-10-28');
});

test('normal text is not eaten', () => {
  const p = parseQuick('write to mario@x.example, add +1 to the counter !! if fw >= 2.3 -> ok', { today: T });
  assert.equal(p.title, 'write to mario@x.example, add +1 to the counter !! if fw >= 2.3 -> ok');
  assert.equal(p.assignee, null);
  assert.equal(p.contact, null);
  assert.equal(p.due, undefined);
});

test('code extraction', () => {
  assert.deepEqual(extractCodes('use #PRD-10.2, (#sch_7) and#no #A/B'), ['PRD-10.2', 'sch_7', 'A/B']);
  assert.deepEqual(extractCodes('#X1 and #x1'), ['x1']);
});

test('in notes the dates look at the past', () => {
  assert.equal(parseDate('fri', T, { past: true }), '2026-10-23');
  assert.equal(parseDate('tue', T, { past: true }), '2026-10-20');
  assert.equal(parseDate('15/9', T, { past: true }), '2026-09-15');
  assert.equal(parseDate('3/12', T, { past: true }), '2025-12-03');
  assert.equal(parseQuick('n: bench crashed !mon', { today: T }).due, '2026-10-26');
  assert.equal(parseQuick('bench crashed !mon', { today: T }).due, '2026-11-02');
});

test('item line and project line', async () => {
  const { parseItemLine, parseProjectLine } = await import('../public/js/parse.js');
  assert.deepEqual(parseItemLine('#SCH-060 8-channel relay board /board @rover'),
    { code: 'SCH-060', name: '8-channel relay board', category: 'board', project: 'rover', valid: true });
  assert.equal(parseItemLine('/board').valid, false);
  assert.equal(parseItemLine('CAB-1 /radio_module').category, 'radio module');
  assert.deepEqual(parseProjectLine('Motor firmware @rover'), { name: 'Motor firmware', parent: 'rover', share: [] });
  assert.deepEqual(parseProjectLine('Test bench +marco +all').share, ['marco', 'all']);
});

test('several projects', () => {
  const p = parseQuick('align fw @rover @greenhouse-iot @Rover !fri', { today: T });
  assert.equal(p.project, 'rover');
  assert.deepEqual(p.projects, ['rover', 'greenhouse-iot']);
  assert.equal(p.title, 'align fw');
});

test('^ID: the entry waits for another', () => {
  const p = parseQuick('try the PS5 with Mirko ^12 ^7 ^12 !fri', { today: T });
  assert.deepEqual([p.title, p.after, p.due], ['try the PS5 with Mirko', [12, 7], '2026-10-30']);
  assert.deepEqual(parseQuick('2^10 is 1024').after, []); // not at the start of a word
  assert.equal(parseQuick('2^10 is 1024').title, '2^10 is 1024');
});
