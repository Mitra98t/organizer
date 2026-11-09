// Text of received mails: quotes, inline replies, the quote at the bottom, forwards, signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMail, newText } from '../public/js/mailtext.js';

const shape = blocks => blocks.map(b => (b.type === 'quote' ? { quote: shape(b.blocks), ...(b.tail ? { tail: true } : {}) } : { [b.type]: b.text ?? b.head, ...(b.tail ? { tail: true } : {}) }));

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
  assert.match(outlook[1].text, /^From: Purchasing/);

  const fwd = parseMail('FYI\n\n---------- Forwarded message ---------\nFrom: Supplier <s@supplier.example>\nThe lead time is 12 weeks.');
  assert.deepEqual(fwd.map(b => [b.type, !!b.tail]), [['text', false], ['forward', false]]);
  assert.equal(newText('---------- Forwarded message ---------\nFrom: x\nLead time 12 weeks'), 'From: x\nLead time 12 weeks');

  // Only a quote (nothing written): it stays open, otherwise the mail would look empty.
  assert.deepEqual(parseMail('> just the quote').map(b => [b.type, !!b.tail]), [['quote', false]]);
  assert.deepEqual(parseMail(''), []);
});
