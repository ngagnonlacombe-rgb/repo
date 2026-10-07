// Projets : création par le bureau, notes partagées, fil de messages et photos entre employés.
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
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'projets-'));
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
let idProjet;

test('le bureau crée un projet, les employés le voient mais ne peuvent pas en créer', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  for (const [nom, identifiant] of [['Marc', 'marc'], ['Julie', 'julie']]) {
    await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
  }
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });
  await julie('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } });

  assert.equal((await marc('/api/projets', { method: 'POST', json: { nom: 'X' } })).status, 403);
  assert.equal((await bureau('/api/projets', { method: 'POST', json: { nom: ' ' } })).status, 400);
  const r = await bureau('/api/projets', { method: 'POST', json: { nom: 'Toiture Tremblay', adresse: '12 rue des Pins' } });
  assert.equal(r.status, 201);
  idProjet = r.corps.projet.id;
  assert.deepEqual((await marc('/api/projets')).corps.projets.map((p) => p.nom), ['Toiture Tremblay']);
  assert.equal((await client()('/api/projets')).status, 401);
});

test('notes partagées : modifiables par tous, nom et archivage réservés au bureau', async () => {
  const r = await marc(`/api/projets/${idProjet}`, { method: 'PATCH', json: { notes: 'Bardeaux noirs, 32 paquets' } });
  assert.equal(r.status, 200);
  assert.equal((await julie(`/api/projets/${idProjet}`)).corps.projet.notes, 'Bardeaux noirs, 32 paquets');
  assert.equal((await marc(`/api/projets/${idProjet}`, { method: 'PATCH', json: { nom: 'Autre' } })).status, 403);
});

test('fil du projet : messages, photo, nouveaux messages seulement, suppression', async () => {
  assert.equal((await marc(`/api/projets/${idProjet}/messages`, { method: 'POST', json: { texte: '' } })).status, 400);
  const m1 = await marc(`/api/projets/${idProjet}/messages`, { method: 'POST', json: { texte: 'Arrivé sur place' } });
  assert.equal(m1.status, 201);
  assert.equal(m1.corps.message.auteur, 'Marc');

  const form = new FormData();
  form.append('texte', 'Avant les travaux');
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'toit.png');
  const m2 = await julie(`/api/projets/${idProjet}/messages`, { method: 'POST', body: form });
  assert.equal(m2.status, 201);
  assert.equal(m2.corps.message.photo, 1);
  const photo = await marc(`/api/projets/${idProjet}/messages/${m2.corps.message.id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(Buffer.from(photo.corps).length, PNG.length);

  const nouveaux = (await marc(`/api/projets/${idProjet}?apres=${m1.corps.message.id}`)).corps.messages;
  assert.deepEqual(nouveaux.map((m) => m.texte), ['Avant les travaux']);

  assert.equal((await marc(`/api/projets/${idProjet}/messages/${m2.corps.message.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await julie(`/api/projets/${idProjet}/messages/${m2.corps.message.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc(`/api/projets/${idProjet}`)).corps.messages.length, 1);
});

test('un projet archivé disparaît pour les employés et reste visible au bureau', async () => {
  await bureau(`/api/projets/${idProjet}`, { method: 'PATCH', json: { actif: false } });
  assert.equal((await marc('/api/projets')).corps.projets.length, 0);
  assert.equal((await marc(`/api/projets/${idProjet}`)).status, 404);
  assert.equal((await bureau('/api/projets?archives=1')).corps.projets.length, 1);
});
