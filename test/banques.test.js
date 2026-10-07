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

  // 30 min de dîner retirées par journée de 5 h et plus : 45 − 2,5 = 42,5 ; 38 − 1,5 = 36,5 (le quart de 4 h du dimanche n'en a pas).
  assert.deepEqual(semaines(db, idMarc).map((s) => [s.lundi, s.heures]), [['2026-09-28', 42.5], ['2026-09-21', 36.5]]);
  // Banque : 2,5 h au-delà de 40 h × 1,5 ; vacances : 4 % de 79 h payées ; maladie : 16 h par année.
  assert.deepEqual(soldes(db, idMarc), { banque: 3.75, vacances: 3.16, maladie: 16, absence: 0, conge_perso: 0, ferie: 0, maladie_np: 0, tauxVacances: 4 });

  const r = (await marc('/api/mes-heures')).corps;
  assert.deepEqual(r.semaines.map((s) => [s.lundi, s.heures, s.banque]), [['2026-09-28', 42.5, 3.75], ['2026-09-21', 36.5, 0]]);
  assert.equal(r.soldes.banque, 3.75);
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
  assert.deepEqual(ancienne.corps.soldes, { banque: 0.25, vacances: 27.16, maladie: 8, absence: 0, conge_perso: 0, ferie: 0, maladie_np: 0, tauxVacances: 4 });

  // Taux de vacances de 6 % pour Marc, puis règles changées pour tous.
  assert.equal((await bureau(`/api/bureau/soldes/${idMarc}`, { method: 'PATCH', json: { taux_vacances: 6 } })).corps.soldes.vacances, 28.74);
  assert.equal((await bureau('/api/bureau/regles-heures', { method: 'PUT', json: { semaine: 44, multiplicateurBanque: 1, tauxVacances: 4, maladieAnnuelle: 16 } })).status, 200);
  assert.equal((await bureau('/api/bureau/regles-heures', { method: 'PUT', json: { semaine: 0 } })).status, 400);
  const { employes } = (await bureau('/api/bureau/soldes')).corps;
  assert.deepEqual(employes[0].soldes, { banque: -3.5, vacances: 28.74, maladie: 8, absence: 0, conge_perso: 0, ferie: 0, maladie_np: 0, tauxVacances: 6 });

  // L'employé voit ses soldes et ses congés pris ; le bureau peut annuler une inscription.
  const vu = (await marc('/api/mes-heures')).corps;
  assert.equal(vu.soldes.maladie, 8);
  assert.equal(vu.mouvements[0].type, 'banque');
  const { mouvements } = (await bureau(`/api/bureau/mouvements/${idMarc}`)).corps;
  assert.equal(mouvements.length, 5);
  assert.equal((await bureau(`/api/bureau/mouvements/${mouvements[0].id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc('/api/mes-heures')).corps.soldes.banque, 0);
});

test('dîner : 30 min retirées par jour, payées en un clic quand l\'employé n\'a pas dîné', async () => {
  const diner = (jour, paye) => bureau('/api/bureau/diners', { method: 'POST', json: { employe_id: idMarc, jour, paye } });
  assert.equal((await marc('/api/bureau/diners', { method: 'POST', json: {} })).status, 403);
  assert.equal((await diner('hier', true)).status, 400);
  const r = await diner('2026-09-29', true);
  assert.equal(r.status, 200);
  assert.deepEqual([r.corps.jour.travaillees, r.corps.jour.diner, r.corps.jour.dinerPaye, r.corps.jour.payees], [9, 0, true, 9]);
  assert.equal((await diner('2026-09-29', true)).status, 200); // deuxième clic identique : sans effet
  assert.equal(semaines(db, idMarc)[0].heures, 43);

  // Le bureau voit la journée avec son dîner dans l'onglet Heures.
  const periode = `du=${encodeURIComponent('2026-09-28T04:00:00Z')}&au=${encodeURIComponent('2026-10-05T04:00:00Z')}`;
  const { jours } = (await bureau(`/api/bureau/heures?${periode}`)).corps;
  assert.deepEqual(jours.map((j) => [j.jour, j.payees, j.dinerPaye]).sort(), [
    ['2026-09-28', 8.5, false], ['2026-09-29', 9, true], ['2026-09-30', 8.5, false], ['2026-10-01', 8.5, false], ['2026-10-02', 8.5, false]]);
  const csv = await (await fetch(`${base}/api/bureau/heures.csv?${periode}`, { headers: { cookie: await (async () => {
    const c = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' }) });
    return c.headers.get('set-cookie').split(';')[0];
  })() } })).text();
  assert.match(csv, /"Marc";"2026-09-29";"08:00";"17:00";"9,00";"payé";"9,00";""/);
  assert.match(csv, /"Marc";"2026-09-30";"08:00";"17:00";"9,00";"0,50";"8,50";""/);
  assert.match(csv, /"Total Marc";"";"";"";"";"";"43,00";""/);

  await diner('2026-09-29', false);
  assert.equal(semaines(db, idMarc)[0].heures, 42.5);
  // Règle du dîner modifiable : sans dîner retiré, la semaine compte 45 h.
  await bureau('/api/bureau/regles-heures', { method: 'PUT', json: { semaine: 40, multiplicateurBanque: 1.5, tauxVacances: 4, maladieAnnuelle: 16, dinerMinutes: 0, dinerSeuil: 5 } });
  assert.equal(semaines(db, idMarc)[0].heures, 45);
});

test('mêmes catégories qu\'Agendrix ; une base existante accepte les nouvelles banques', async () => {
  const fichier = path.join(dossier, 'ancienne.db');
  const vieille = ouvrirBase(fichier);
  vieille.exec(`DROP TABLE heures_mouvements;
    CREATE TABLE heures_mouvements (id INTEGER PRIMARY KEY, employe_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('banque', 'vacances', 'maladie')), heures REAL NOT NULL, date TEXT NOT NULL, note TEXT,
      cree_par INTEGER REFERENCES utilisateurs(id), cree_le TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES ('Michael', 'michael', 'x', 'employe');
    INSERT INTO heures_mouvements (employe_id, type, heures, date) VALUES (1, 'banque', 19.47, '2026-10-07');`);
  vieille.close();
  const base = ouvrirBase(fichier);
  base.prepare("INSERT INTO heures_mouvements (employe_id, type, heures, date) VALUES (1, 'ferie', -26.98, '2026-10-07')").run();
  base.prepare("INSERT INTO heures_mouvements (employe_id, type, heures, date) VALUES (1, 'maladie_np', -8, '2026-10-07')").run();
  const s = soldes(base, 1);
  assert.deepEqual([s.banque, s.ferie, s.maladie_np, s.absence, s.conge_perso], [19.47, -26.98, -8, 0, 0]);
  base.close();

  const inscrire = (json) => bureau('/api/bureau/mouvements', { method: 'POST', json: { employe_id: idMarc, ...json } });
  const r = await inscrire({ type: 'conge_perso', heures: -7.5, date: '2026-10-01' });
  assert.equal(r.status, 201);
  assert.equal(r.corps.soldes.conge_perso, -7.5);
  assert.equal((await inscrire({ type: 'inventee', heures: 1, date: '2026-10-01' })).status, 400);
});
