import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveZip } from '../public/zip.js';

test('ArchiveZip : une archive lisible avec dossiers et noms accentués', async () => {
  const zip = new ArchiveZip();
  await zip.ajouter('Avant/Sinistre Tremblay - 001.jpg', new Blob([Buffer.from('photo un')]), new Date(2026, 9, 19, 14, 48, 10));
  await zip.ajouter('Non classées/Toiture été - 002.jpg', new Blob([Buffer.alloc(70000, 7)]));
  assert.equal(zip.nombre, 2);
  const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), 'photos.zip');
  fs.writeFileSync(fichier, Buffer.from(await zip.blob().arrayBuffer()));
  // unzip -t vérifie les CRC ; on passe par Python si unzip n'est pas installé.
  const sortie = execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for i in z.infolist(): print(i.filename, i.file_size, i.date_time)
print(z.read('Avant/Sinistre Tremblay - 001.jpg').decode())`, fichier]).toString();
  assert.match(sortie, /Avant\/Sinistre Tremblay - 001\.jpg 8 \(2026, 10, 19, 14, 48, 10\)/);
  assert.match(sortie, /Non classées\/Toiture été - 002\.jpg 70000/);
  assert.match(sortie, /photo un/);
});
