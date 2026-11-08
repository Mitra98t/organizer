// Names of downloaded documents: the name given in the app, always with the right extension.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-names-test-'));
process.env.DATA_DIR = dir;
const { downloadName } = await import('../server/api.js');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('renamed documents keep the extension of the original file', () => {
  const name = (label, filename, mime = 'application/octet-stream') => downloadName({ id: 7, label, filename, mime });
  assert.equal(name('Datasheet STM32', 'stm32f103.pdf', 'application/pdf'), 'Datasheet STM32.pdf');
  assert.equal(name('datasheet.pdf', 'stm32f103.pdf'), 'datasheet.pdf'); // not doubled
  assert.equal(name('Datasheet.PDF', 'stm32f103.pdf'), 'Datasheet.PDF'); // upper case is the same extension
  assert.equal(name('datasheet.', 'stm32f103.pdf'), 'datasheet.pdf'); // no "datasheet..pdf"
  assert.equal(name('datasheet .pdf', 'stm32f103.pdf'), 'datasheet.pdf');
  assert.equal(name('fw v1.2', 'relay_fw.bin'), 'fw v1.2.bin');
  assert.equal(name('backup', 'site.tar.gz'), 'backup.tar.gz'); // double extension
  assert.equal(name('notes.txt', 'stm32f103.pdf'), 'notes.txt.pdf'); // the file is a PDF
  assert.equal(name('a/b: c?', 'x.png'), 'a b c.png'); // characters not allowed in file names
  // A file uploaded without an extension: it comes from the type.
  assert.equal(name('Scan', 'scan', 'application/pdf'), 'Scan.pdf');
  assert.equal(name('', 'photo', 'image/jpeg'), 'photo.jpg');
  assert.equal(name('Firmware', 'firmware'), 'Firmware'); // unknown type: nothing to add
  // Without a name.
  assert.equal(name('', 'board.step'), 'board.step');
  assert.equal(downloadName({ id: 7, label: '', filename: null, mime: 'application/pdf' }), 'document-7.pdf');
});
