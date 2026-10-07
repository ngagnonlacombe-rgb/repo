// Semaines passées, banque d'heures, vacances et maladie.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';
import { semaines, soldes } from '../src/banques.js';

let serveur, base, dossier, db;

before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'banques-'));
  db = ouvrirBase(':memory:');
  const app = creerApp({
    db, qbo: creerQuickBooksDemo(), lecteur: { actif: false, lire: async () => null }, dossierFichiers: path.join(dossier, 'f'),
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
    return { status: rep.status, corps: rep.status === 204 ? null : await rep.json() };
  };
}
const bureau = client();
const marc = client();
let idMarc;
const annee = new Date().getFullYear();

test('semaines à l\'heure du Québec et soldes calculés', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom: 'Marc', identifiant: 'marc', motDePasse: '4821' } });
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });
  idMarc = db.prepare("SELECT id FROM utilisateurs WHERE identifiant = 'marc'").get().id;
  const ajout = db.prepare('INSERT INTO punchs (employe_id, debut, fin) VALUES (?, ?, ?)');
  // Semaine du lundi 28 sept. 2026 : 5 × 9 h (8 h à 17 h, heure du Québec = 12 h à 21 h UTC).
  for (let j = 28; j <= 32; j += 1) {
    const jour = j <= 30 ? `2026-09-${j}` : `2026-10-0${j - 30}`;
    ajout.run(idMarc, `${jour} 12:00:00`, `${jour} 21:00:00`);
  }
  // Semaine du 21 sept. : 38 h, dont un quart le dimanche 27 à 22 h (heure du Québec), donc lundi 02:00 UTC.
  ajout.run(idMarc, '2026-09-21 12:00:00', '2026-09-22 00:00:00'); // 12 h
  ajout.run(idMarc, '2026-09-23 12:00:00', '2026-09-24 00:00:00'); // 12 h
  ajout.run(idMarc, '2026-09-25 12:00:00', '2026-09-25 22:00:00'); // 10 h
  ajout.run(idMarc, '2026-09-28 02:00:00', '2026-09-28 06:00:00'); // 4 h, dimanche soir au Québec

  assert.deepEqual(semaines(db, idMarc).map((s) => [s.lundi, s.heures]), [['2026-09-28', 45], ['2026-09-21', 38]]);
  // Banque : 5 h au-delà de 40 h × 1,5 ; vacances : 4 % de 83 h ; maladie : 16 h par année.
  assert.deepEqual(soldes(db, idMarc), { banque: 7.5, vacances: 3.32, maladie: 16, tauxVacances: 4 });

  const r = (await marc('/api/mes-heures')).corps;
  assert.deepEqual(r.semaines.map((s) => [s.lundi, s.heures, s.banque]), [['2026-09-28', 45, 7.5], ['2026-09-21', 38, 0]]);
  assert.equal(r.soldes.banque, 7.5);
});

test('le bureau inscrit les congés pris et les soldes de départ ; règles et taux modifiables', async () => {
  const inscrire = (json) => bureau('/api/bureau/mouvements', { method: 'POST', json: { employe_id: idMarc, ...json } });
  assert.equal((await marc('/api/bureau/mouvements', { method: 'POST', json: {} })).status, 403);
  assert.equal((await inscrire({ type: 'autre', heures: 8, date: `${annee}-01-02` })).status, 400);
  assert.equal((await inscrire({ type: 'banque', heures: 0, date: `${annee}-01-02` })).status, 400);
  assert.equal((await inscrire({ type: 'banque', heures: 4, date: 'demain' })).status, 400);

  assert.equal((await inscrire({ type: 'vacances', heures: 40, date: `${annee}-01-01`, note: 'Solde de départ' })).status, 201);
  assert.equal((await inscrire({ type: 'vacances', heures: -16, date: `${annee}-03-02`, note: 'Relâche' })).status, 201);
  assert.equal((await inscrire({ type: 'banque', heures: -3.5, date: `${annee}-10-02` })).status, 201);
  assert.equal((await inscrire({ type: 'maladie', heures: -8, date: `${annee}-02-10` })).status, 201);
  const ancienne = await inscrire({ type: 'maladie', heures: -8, date: `${annee - 1}-12-10` }); // l'an passé : ne compte plus
  assert.deepEqual(ancienne.corps.soldes, { banque: 4, vacances: 27.32, maladie: 8, tauxVacances: 4 });

  // Taux de vacances de 6 % pour Marc, puis règles changées pour tous.
  assert.equal((await bureau(`/api/bureau/soldes/${idMarc}`, { method: 'PATCH', json: { taux_vacances: 6 } })).corps.soldes.vacances, 28.98);
  assert.equal((await bureau('/api/bureau/regles-heures', { method: 'PUT', json: { semaine: 44, multiplicateurBanque: 1, tauxVacances: 4, maladieAnnuelle: 16 } })).status, 200);
  assert.equal((await bureau('/api/bureau/regles-heures', { method: 'PUT', json: { semaine: 0 } })).status, 400);
  const { employes } = (await bureau('/api/bureau/soldes')).corps;
  assert.deepEqual(employes[0].soldes, { banque: -2.5, vacances: 28.98, maladie: 8, tauxVacances: 6 });

  // L'employé voit ses soldes et ses congés pris ; le bureau peut annuler une inscription.
  const vu = (await marc('/api/mes-heures')).corps;
  assert.equal(vu.soldes.maladie, 8);
  assert.equal(vu.mouvements[0].type, 'banque');
  const { mouvements } = (await bureau(`/api/bureau/mouvements/${idMarc}`)).corps;
  assert.equal(mouvements.length, 5);
  assert.equal((await bureau(`/api/bureau/mouvements/${mouvements[0].id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc('/api/mes-heures')).corps.soldes.banque, 1);
});
