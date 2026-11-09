// Text of received mails: quotes, inline replies, the quote at the bottom, forwards, signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMail, newText, clean } from '../public/js/mailtext.js';

const shape = blocks => blocks.map(b => (b.type === 'quote' ? { quote: shape(b.blocks), ...(b.tail ? { tail: true } : {}) }
  : b.type === 'original' ? { original: b.messages.map(m => ({ ...m.headers, body: shape(m.blocks) })), ...(b.tail ? { tail: true } : {}) }
    : { [b.type]: b.text ?? b.head, ...(b.tail ? { tail: true } : {}) }));

test('inline replies: the answers between the quoted lines stay visible', () => {
  const mail = [
    'Hi Fede,',
    '',
    'On Mon, 3 Nov 2026 Fede <fede@lab.example> wrote:',
    '> Can you send the gerbers?',
    'Yes, attached.',
    '',
    '> And the BOM for rev C?',
    '> It must have the new LDO.',
    'Tomorrow, the LDO is not decided yet.',
    '',
    '-- ',
    'Mirko',
  ].join('\n');
  assert.deepEqual(shape(parseMail(mail)), [
    { text: 'Hi Fede,' },
    { attr: 'On Mon, 3 Nov 2026 Fede <fede@lab.example> wrote:' },
    { quote: [{ text: 'Can you send the gerbers?' }] },
    { text: 'Yes, attached.' },
    { quote: [{ text: 'And the BOM for rev C?\nIt must have the new LDO.' }] },
    { text: 'Tomorrow, the LDO is not decided yet.' },
    { sig: 'Mirko' },
  ]);
  assert.equal(newText(mail), 'Hi Fede,\nYes, attached.\nTomorrow, the LDO is not decided yet.');
});

test('top posting: the quote at the bottom is folded, nested quotes are read again', () => {
  const mail = [
    'Fine for me.',
    '',
    'Il giorno lun 3 nov 2026 alle 10:12 Fede <fede@lab.example> ha scritto:',
    '> Shall we move the review to Friday?',
    '>',
    '> On Sun, 2 Nov 2026 Mirko wrote:',
    '>> The review is on Thursday.',
  ].join('\n');
  assert.deepEqual(shape(parseMail(mail)), [
    { text: 'Fine for me.' },
    { attr: 'Il giorno lun 3 nov 2026 alle 10:12 Fede <fede@lab.example> ha scritto:', tail: true },
    { quote: [{ text: 'Shall we move the review to Friday?' }, { attr: 'On Sun, 2 Nov 2026 Mirko wrote:' }, { quote: [{ text: 'The review is on Thursday.' }] }], tail: true },
  ]);
  assert.equal(newText(mail), 'Fine for me.');
});

test('Outlook original message folded, forwards and empty replies open', () => {
  const outlook = parseMail('Ok, ordered.\n\nFrom: Purchasing <buy@company.example>\nSent: Monday\nTo: Fede\nSubject: PO 4411\n\nPlease confirm.');
  assert.deepEqual(outlook.map(b => [b.type, !!b.tail]), [['text', false], ['original', true]]);
  assert.deepEqual(outlook[1].messages[0].headers, { from: 'Purchasing <buy@company.example>', date: 'Monday', to: 'Fede', subject: 'PO 4411' });

  const fwd = parseMail('FYI\n\n---------- Forwarded message ---------\nFrom: Supplier <s@supplier.example>\nThe lead time is 12 weeks.');
  assert.deepEqual(fwd.map(b => [b.type, !!b.tail]), [['text', false], ['forward', false]]);
  assert.equal(newText('---------- Forwarded message ---------\nFrom: x\nLead time 12 weeks'), 'From: x\nLead time 12 weeks');

  // Only a quote (nothing written): it stays open, otherwise the mail would look empty.
  assert.deepEqual(parseMail('> just the quote').map(b => [b.type, !!b.tail]), [['quote', false]]);
  assert.deepEqual(parseMail(''), []);
});

test('Outlook history: one message per header, each with its own quotes', () => {
  const mail = [
    'Confirmed for Friday.',
    '',
    '*From:* Mirko Rossi <mirko@lab.example<mailto:mirko@lab.example>>',
    '*Sent:* Monday, 3 November 2026 10:12',
    '*To:* Fede <fede@lab.example>',
    '*Subject:* RE: review rev C',
    '',
    'Friday is fine. [cid:image001.png@01DB2C]',
    '',
    '',
    '',
    'Drawings: https://files.example/rev-c<https://files.example/rev-c>',
    '',
    '-----Original Message-----',
    'Da: Fede <fede@lab.example>',
    'Inviato: domenica 2 novembre 2026 18:40',
    'A: Mirko Rossi',
    'Oggetto: review rev C',
    '',
    'Can we do the review on Friday?',
    '> earlier: the review is on Thursday',
  ].join('\n');
  assert.deepEqual(shape(parseMail(mail)), [
    { text: 'Confirmed for Friday.' },
    { original: [
      { from: 'Mirko Rossi <mirko@lab.example>', date: 'Monday, 3 November 2026 10:12', to: 'Fede <fede@lab.example>', subject: 'RE: review rev C',
        body: [{ text: 'Friday is fine.\n\nDrawings: https://files.example/rev-c' }] },
      { from: 'Fede <fede@lab.example>', date: 'domenica 2 novembre 2026 18:40', to: 'Mirko Rossi', subject: 'review rev C',
        body: [{ text: 'Can we do the review on Friday?' }, { quote: [{ text: 'earlier: the review is on Thursday' }] }] },
    ], tail: true },
  ]);
});

test('attributions: who and when', () => {
  const who = text => parseMail(`ok\n\n${text}\n> x`).find(b => b.type === 'attr');
  assert.deepEqual([who('On Mon, 3 Nov 2026 at 10:12, Fede Rossi <fede@lab.example> wrote:').who, who('On Mon, 3 Nov 2026 at 10:12, Fede Rossi <fede@lab.example> wrote:').when],
    ['Fede Rossi', 'Mon, 3 Nov 2026 at 10:12']);
  assert.equal(who('Il giorno lun 3 nov 2026 alle ore 10:12 Mirko <mirko@lab.example> ha scritto:').who, 'Mirko');
  assert.equal(who('Il giorno lun 3 nov 2026 alle ore 10:12 Mirko <mirko@lab.example> ha scritto:').when, 'lun 3 nov 2026 alle ore 10:12');
  assert.equal(who('On 3 Nov 2026, at 10:12, Anna <anna@x.example> wrote:').who, 'Anna');
  assert.deepEqual([who('Am 03.11.2026 um 10:12 schrieb Max Muster <max@x.example>:').who, who('Am 03.11.2026 um 10:12 schrieb Max Muster <max@x.example>:').when], ['Max Muster', '03.11.2026 um 10:12']);
  assert.equal(who('On Mon, Nov 3, 2026 at 10:12 AM Fede <f@x.example> wrote:').who, 'Fede');
  // Not understood: the line as it is.
  assert.equal(who('On some day someone wrote:').who, undefined);
  assert.equal(clean('see <https://a.example/x> and a@b.example<mailto:a@b.example> [cid:img.png]'), 'see  https://a.example/x and a@b.example');
});

