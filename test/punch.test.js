// Punch : début et fin de quart par l'employé, consultation et corrections par le bureau.
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
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-'));
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
    return { status: rep.status, corps: rep.status === 204 ? null : await rep.json() };
  };
}
const bureau = client();
const marc = client();
const iso = (decalageHeures) => new Date(Date.now() + decalageHeures * 3600000).toISOString();
const semaine = () => `du=${encodeURIComponent(iso(-72))}&au=${encodeURIComponent(iso(1))}`;

test('l\'employé commence et termine son quart ; pas deux quarts ouverts', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom: 'Marc', identifiant: 'marc', motDePasse: '4821' } });
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });

  assert.equal((await marc('/api/punch')).corps.enCours, null);
  assert.equal((await marc('/api/punch/fin', { method: 'POST' })).status, 409);
  const d = await marc('/api/punch/debut', { method: 'POST', json: { note: 'Chantier Tremblay', position: { lat: 46.8139, lng: -71.208, precision: 12.4 } } });
  assert.equal(d.status, 201);
  assert.equal((await marc('/api/punch/debut', { method: 'POST' })).status, 409);
  assert.equal((await marc('/api/punch')).corps.enCours.note, 'Chantier Tremblay');

  // Le bureau voit Marc en quart.
  const h = (await bureau(`/api/bureau/heures?${semaine()}`)).corps;
  assert.deepEqual(h.employes.map((e) => e.nom), ['Marc']);
  assert.equal(h.punchs.length, 1);
  assert.equal(h.punchs[0].fin, null);
  assert.deepEqual([h.punchs[0].lat_debut, h.punchs[0].lng_debut, h.punchs[0].precision_debut], [46.8139, -71.208, 12]);

  const f = await marc('/api/punch/fin', { method: 'POST', json: { note: 'Toiture finie', position: { lat: 'abc', lng: 999 } } });
  assert.equal(f.status, 200);
  assert.equal(f.corps.punch.note, 'Chantier Tremblay · Fin : Toiture finie');
  // Position refusée ou invalide à la fin : le quart se termine quand même, sans position.
  assert.equal(f.corps.punch.lat_fin, null);
  assert.ok(f.corps.punch.fin >= f.corps.punch.debut);
  assert.equal((await marc('/api/punch')).corps.enCours, null);
  assert.equal((await marc(`/api/bureau/heures?${semaine()}`)).status, 403);
});

test('le bureau ajoute un quart oublié, le corrige et le supprime', async () => {
  const { employes } = (await bureau(`/api/bureau/heures?${semaine()}`)).corps;
  const idMarc = employes[0].id;
  const ajout = (debut, fin) => bureau('/api/bureau/punchs', { method: 'POST', json: { employe_id: idMarc, debut, fin } });
  assert.equal((await ajout(iso(-30), iso(-31))).status, 400); // fin avant début
  assert.equal((await ajout(iso(-60), iso(-30))).status, 400); // plus de 24 h
  assert.equal((await ajout(iso(48), iso(50))).status, 400); // dans le futur
  const r = await ajout(iso(-30), iso(-22));
  assert.equal(r.status, 201);
  assert.equal(r.corps.punch.modifie_par > 0, true);
  assert.equal((await ajout(iso(-25), iso(-20))).status, 400); // chevauchement

  const id = r.corps.punch.id;
  const corrige = await bureau(`/api/bureau/punchs/${id}`, { method: 'PATCH', json: { fin: iso(-21) } });
  assert.equal(corrige.status, 200);
  assert.equal((await bureau(`/api/bureau/punchs/${id}`, { method: 'PATCH', json: { fin: 'n\'importe quoi' } })).status, 400);
  assert.equal((await bureau(`/api/bureau/heures?${semaine()}`)).corps.punchs.length, 2);
  assert.equal((await bureau(`/api/bureau/heures?du=x&au=y`)).status, 400);

  assert.equal((await bureau(`/api/bureau/punchs/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await bureau(`/api/bureau/punchs/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await bureau(`/api/bureau/heures?${semaine()}`)).corps.punchs.length, 1);
});

test('export des heures pour la paie (CSV, heure du Québec)', async () => {
  const r = await fetch(`${base}/api/bureau/heures.csv?${semaine()}`, { headers: { cookie: await (async () => {
    const c = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' }) });
    return c.headers.get('set-cookie').split(';')[0];
  })() } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="heures-/);
  const texte = await r.text();
  const lignes = texte.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lignes[0], '"Employé";"Date";"Début";"Fin";"Heures travaillées";"Dîner non payé";"Heures payées";"Note"');
  assert.match(lignes[1], /^"Marc";"\d{4}-\d{2}-\d{2}";"\d{2}:\d{2}";"\d{2}:\d{2}";"0,0\d";"0,00";"0,0\d";"Chantier Tremblay · Fin : Toiture finie"$/);
  assert.match(lignes.at(-1), /^"Total Marc";"";"";"";"";"";"0,0\d";""$/);
});
