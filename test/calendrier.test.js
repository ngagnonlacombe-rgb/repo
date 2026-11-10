// Calendrier : le bureau et les chargés de projet planifient les projets et leur équipe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';

let serveur, base, dossier;
before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'calendrier-'));
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
  return async (chemin, { method = 'GET', json } = {}) => {
    const headers = cookie ? { cookie } : {};
    if (json) headers['Content-Type'] = 'application/json';
    const rep = await fetch(base + chemin, { method, headers, body: json ? JSON.stringify(json) : undefined });
    const c = rep.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return { status: rep.status, corps: await rep.json() };
  };
}
const bureau = client();
const marc = client();
const julie = client();

test('planifier un projet sur plusieurs jours avec son équipe', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  const ids = {};
  for (const [nom, identifiant] of [['Marc', 'marc'], ['Julie', 'julie']]) {
    await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
  }
  for (const u of (await bureau('/api/bureau/utilisateurs')).corps.utilisateurs) ids[u.identifiant] = u.id;
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });
  await julie('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } });
  const projet = (await bureau('/api/projets', { method: 'POST', json: { nom: 'Toiture Tremblay' } })).corps.projet;

  // Un employé ordinaire n'a pas accès au calendrier ; un chargé de projet, oui.
  assert.equal((await marc('/api/calendrier?du=2026-11-01&au=2026-11-30')).status, 403);
  assert.equal((await marc('/api/calendrier', { method: 'POST', json: { titre: 'X', date_debut: '2026-11-10' } })).status, 403);
  await bureau(`/api/bureau/utilisateurs/${ids.julie}`, { method: 'PATCH', json: { chef_projet: true } });
  assert.equal((await julie('/api/calendrier?du=2026-11-01&au=2026-11-30')).status, 200);
  assert.deepEqual((await julie('/api/calendrier/equipe')).corps.equipe.map((e) => e.nom), ['Julie', 'Marc', 'Nicolas']);

  // Validation.
  for (const json of [
    { date_debut: '2026-11-10' },
    { titre: 'X', date_debut: '2026-02-30' },
    { titre: 'X', date_debut: '2026-11-10', date_fin: '2026-11-09' },
    { titre: 'X', date_debut: '2026-11-10', heure_debut: '25h' },
    { projet_id: 999, date_debut: '2026-11-10' },
  ]) assert.equal((await julie('/api/calendrier', { method: 'POST', json })).status, 400, JSON.stringify(json));

  const r = await julie('/api/calendrier', { method: 'POST', json: {
    projet_id: projet.id, date_debut: '2026-11-16', date_fin: '2026-11-18', heure_debut: '7h', heure_fin: '15h30',
    note: 'Bardeaux livrés lundi', equipe: [ids.marc, ids.julie, 9999],
  } });
  assert.equal(r.status, 201);
  const pl = r.corps.planification;
  assert.equal(pl.projet_nom, 'Toiture Tremblay');
  assert.equal(pl.heure_debut, '07:00');
  assert.equal(pl.heure_fin, '15:30');
  assert.deepEqual(pl.equipe.map((e) => e.nom), ['Julie', 'Marc']);
  // Un jour seulement, sans projet.
  const visite = (await bureau('/api/calendrier', { method: 'POST', json: { titre: 'Visite estimation Lévis', date_debut: '2026-11-30' } })).corps.planification;
  assert.equal(visite.date_fin, '2026-11-30');

  // La période ramène ce qui la touche, même un bloc commencé avant.
  const noms = async (du, au) => (await bureau(`/api/calendrier?du=${du}&au=${au}`)).corps.planifications.map((p) => p.projet_nom || p.titre);
  assert.deepEqual(await noms('2026-11-01', '2026-11-30'), ['Toiture Tremblay', 'Visite estimation Lévis']);
  assert.deepEqual(await noms('2026-11-18', '2026-11-18'), ['Toiture Tremblay']);
  assert.deepEqual(await noms('2026-11-19', '2026-11-29'), []);
  assert.equal((await bureau('/api/calendrier?du=2026-11-30&au=2026-11-01')).status, 400);

  // Déplacer d'une journée et changer l'équipe ; le reste ne bouge pas.
  const m = await julie(`/api/calendrier/${pl.id}`, { method: 'PATCH', json: { date_debut: '2026-11-17', date_fin: '2026-11-19', equipe: [ids.marc] } });
  assert.equal(m.status, 200);
  assert.equal(m.corps.planification.heure_debut, '07:00');
  assert.equal(m.corps.planification.note, 'Bardeaux livrés lundi');
  assert.deepEqual(m.corps.planification.equipe.map((e) => e.nom), ['Marc']);
  assert.equal((await julie(`/api/calendrier/${pl.id}`, { method: 'PATCH', json: { date_fin: '2026-11-01' } })).status, 400);

  // Supprimer.
  assert.equal((await marc(`/api/calendrier/${visite.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await bureau(`/api/calendrier/${visite.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await bureau(`/api/calendrier/${visite.id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual(await noms('2026-11-01', '2026-11-30'), ['Toiture Tremblay']);
});
