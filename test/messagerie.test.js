// Messagerie : conversation privée entre chaque employé et le bureau.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let serveur, base, dossier;

before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'messagerie-'));
  const app = creerApp({
    db: ouvrirBase(':memory:'), qbo: creerQuickBooksDemo(), lecteur: { actif: false, lire: async () => null },
    dossierFichiers: path.join(dossier, 'f'),
  });
  await new Promise((ok) => { serveur = app.listen(0, ok); });
  base = `http://127.0.0.1:${serveur.address().port}`;
});
after(() => { serveur.close(); fs.rmSync(dossier, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (chemin, { method = 'GET', json, body } = {}) => {
    const headers = cookie ? { cookie } : {};
    if (json) headers['Content-Type'] = 'application/json';
    const rep = await fetch(base + chemin, { method, headers, body: json ? JSON.stringify(json) : body });
    const c = rep.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    const type = rep.headers.get('content-type') || '';
    return { status: rep.status, corps: type.includes('json') ? await rep.json() : await rep.arrayBuffer() };
  };
}
const bureau = client();
const marc = client();
const julie = client();

test('un employé écrit au bureau, le bureau répond, chacun ne voit que sa conversation', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  for (const [nom, identifiant] of [['Marc', 'marc'], ['Julie', 'julie']]) {
    await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
  }
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });
  await julie('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } });

  assert.equal((await marc('/api/messagerie', { method: 'POST', json: { texte: ' ' } })).status, 400);
  const m1 = await marc('/api/messagerie', { method: 'POST', json: { texte: 'Je serai en retard demain' } });
  assert.equal(m1.status, 201);
  const form = new FormData();
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'bris.png');
  const m2 = await marc('/api/messagerie', { method: 'POST', body: form });
  assert.equal(m2.corps.message.photo, 1);

  // Le bureau voit 2 non-lus de Marc, rien pour Julie.
  assert.equal((await bureau('/api/messagerie/non-lus')).corps.nonLus, 2);
  const { conversations } = (await bureau('/api/bureau/messagerie')).corps;
  assert.deepEqual(conversations.map((c) => [c.nom, c.non_lus]), [['Marc', 2], ['Julie', 0]]);

  const idMarc = conversations[0].id;
  const fil = (await bureau(`/api/bureau/messagerie/${idMarc}`)).corps.messages;
  assert.deepEqual(fil.map((m) => m.texte), ['Je serai en retard demain', null]);
  assert.equal((await bureau('/api/messagerie/non-lus')).corps.nonLus, 0);
  assert.equal((await bureau(`/api/messagerie/${m2.corps.message.id}/photo`)).status, 200);

  await bureau(`/api/bureau/messagerie/${idMarc}`, { method: 'POST', json: { texte: 'Merci, pas de problème' } });
  assert.equal((await marc('/api/messagerie/non-lus')).corps.nonLus, 1);
  const vuParMarc = (await marc('/api/messagerie')).corps.messages;
  assert.equal(vuParMarc.at(-1).auteur, 'Nicolas');
  assert.equal(vuParMarc.at(-1).du_bureau, 1);
  assert.equal((await marc('/api/messagerie/non-lus')).corps.nonLus, 0);
  assert.equal((await marc(`/api/messagerie?apres=${vuParMarc.at(-1).id}`)).corps.messages.length, 0);

  // Julie ne voit ni la conversation ni la photo de Marc.
  assert.equal((await julie('/api/messagerie')).corps.messages.length, 0);
  assert.equal((await julie(`/api/messagerie/${m2.corps.message.id}/photo`)).status, 404);
  assert.equal((await julie(`/api/bureau/messagerie/${idMarc}`)).status, 403);

  // On n'efface que ses propres messages.
  assert.equal((await julie(`/api/messagerie/${m1.corps.message.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await marc(`/api/messagerie/${m1.corps.message.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc('/api/messagerie')).corps.messages.length, 2);
});
