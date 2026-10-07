// Parcours complet en mode démo : premier compte, employé, dépôt, envoi, approbation, refus.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let serveur, base, dossier, qbo, lectures, db;

before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'app-employes-'));
  qbo = creerQuickBooksDemo();
  lectures = [];
  const lecteur = {
    actif: true,
    async lire(contenu, typeMime) {
      lectures.push(typeMime);
      return { est_une_facture: true, fournisseur: 'RONA inc.', numero: 'A-123', date_facture: '2026-10-01',
        sous_total: 100, tps: 5, tvq: 9.98, total: 114.98 };
    },
  };
  db = ouvrirBase(':memory:');
  const app = creerApp({ db, qbo, lecteur, dossierFichiers: path.join(dossier, 'f') });
  await new Promise((ok) => { serveur = app.listen(0, ok); });
  base = `http://127.0.0.1:${serveur.address().port}`;
});

after(() => {
  serveur.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (chemin, { method = 'GET', json, body } = {}) => {
    const headers = cookie ? { cookie } : {};
    if (json) headers['Content-Type'] = 'application/json';
    const rep = await fetch(base + chemin, { method, headers, body: json ? JSON.stringify(json) : body, redirect: 'manual' });
    const c = rep.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    const type = rep.headers.get('content-type') || '';
    return { status: rep.status, corps: type.includes('json') ? await rep.json() : await rep.arrayBuffer() };
  };
}

const bureau = client();
const employe = client();
const autre = client();
let idFacture;

test('premier démarrage : création du compte du bureau, une seule fois', async () => {
  assert.equal((await bureau('/api/etat')).corps.premierDemarrage, true);
  const court = await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'court' } });
  assert.equal(court.status, 400);
  const ok = await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  assert.equal(ok.status, 201);
  const encore = await autre('/api/premier-compte', { method: 'POST', json: { nom: 'X', identifiant: 'pirate', motDePasse: 'un-bon-mot-de-passe' } });
  assert.equal(encore.status, 409);
  assert.equal((await bureau('/api/etat')).corps.utilisateur.role, 'bureau');
});

test('le bureau ajoute des employés qui se connectent avec un NIP', async () => {
  for (const [nom, identifiant] of [['Marc Tremblay', 'marc'], ['Julie Roy', 'julie']]) {
    const r = await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
    assert.equal(r.status, 201);
  }
  assert.equal((await employe('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '0000' } })).status, 401);
  assert.equal((await employe('/api/connexion', { method: 'POST', json: { identifiant: 'MARC', motDePasse: '4821' } })).status, 200);
  assert.equal((await autre('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } })).status, 200);
});

test("un employé n'a pas accès au bureau", async () => {
  assert.equal((await employe('/api/bureau/factures')).status, 403);
  assert.equal((await employe('/api/bureau/utilisateurs', { method: 'POST', json: {} })).status, 403);
  assert.equal((await client()('/api/factures/miennes')).status, 401);
});

test('dépôt d\'une photo : lecture automatique et brouillon prérempli', async () => {
  const form = new FormData();
  form.append('fichier', new Blob([PNG], { type: 'image/png' }), 'recu.png');
  const r = await employe('/api/factures', { method: 'POST', body: form });
  assert.equal(r.status, 201);
  assert.equal(r.corps.luAutomatiquement, true);
  assert.equal(r.corps.facture.statut, 'brouillon');
  assert.equal(r.corps.facture.fournisseur, 'RONA inc.');
  assert.equal(r.corps.facture.total, 114.98);
  assert.deepEqual(lectures, ['image/png']);
  idFacture = r.corps.facture.id;
});

test('un fichier qui n\'est pas une image ni un PDF est refusé', async () => {
  const form = new FormData();
  form.append('fichier', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'virus.exe');
  assert.equal((await employe('/api/factures', { method: 'POST', body: form })).status, 400);
});

test('la photo est visible par son auteur et le bureau seulement', async () => {
  assert.equal((await employe(`/api/factures/${idFacture}/fichier`)).status, 200);
  assert.equal((await bureau(`/api/factures/${idFacture}/fichier`)).status, 200);
  assert.equal((await autre(`/api/factures/${idFacture}/fichier`)).status, 404);
  assert.equal((await autre(`/api/factures/${idFacture}`, { method: 'PUT', json: { fournisseur: 'X' } })).status, 404);
});

test("l'employé corrige et envoie au bureau ; le total est obligatoire", async () => {
  const sansTotal = await employe(`/api/factures/${idFacture}`, { method: 'PUT', json: { fournisseur: 'RONA', soumettre: true } });
  assert.equal(sansTotal.status, 400);
  const r = await employe(`/api/factures/${idFacture}`, {
    method: 'PUT',
    json: { fournisseur: 'RONA', numero: 'A-123', date_facture: '2026-10-01', sous_total: '100,00', tps: '5', tvq: '9.98', total: '114,98', note: 'Toiture', soumettre: true },
  });
  assert.equal(r.status, 200);
  assert.equal(r.corps.facture.statut, 'en_attente');
  assert.equal(r.corps.facture.sous_total, 100);
  const encore = await employe(`/api/factures/${idFacture}`, { method: 'PUT', json: { fournisseur: 'Autre' } });
  assert.equal(encore.status, 409, 'une facture envoyée ne se modifie plus');
});

test('le bureau voit la facture en attente et les listes QuickBooks', async () => {
  const { corps } = await bureau('/api/bureau/factures');
  assert.equal(corps.factures.length, 1);
  assert.equal(corps.factures[0].employe, 'Marc Tremblay');
  const listes = (await bureau('/api/bureau/listes')).corps;
  assert.ok(listes.fournisseurs.some((f) => f.nom === 'RONA'));
  assert.ok(listes.comptes.length > 0 && listes.codesTaxe.length > 0);
});

test('approbation : validation, création dans QuickBooks, pas de doublon', async () => {
  const listes = (await bureau('/api/bureau/listes')).corps;
  const rona = listes.fournisseurs.find((f) => f.nom === 'RONA');
  const materiaux = listes.comptes.find((c) => c.nom === 'Matériaux et fournitures');

  const incomplet = await bureau(`/api/bureau/factures/${idFacture}/approuver`, { method: 'POST', json: { fournisseurId: rona.id } });
  assert.equal(incomplet.status, 400);
  assert.equal(qbo.creees.length, 0);

  const demande = { fournisseurId: rona.id, compteId: materiaux.id, codeTaxeId: 'T1', date: '2026-10-01', numero: 'A-123', sousTotal: '100', total: '114.98' };
  const [a, b] = await Promise.all([
    bureau(`/api/bureau/factures/${idFacture}/approuver`, { method: 'POST', json: demande }),
    bureau(`/api/bureau/factures/${idFacture}/approuver`, { method: 'POST', json: demande }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(qbo.creees.length, 1, 'une seule facture créée malgré deux clics');
  const creee = qbo.creees[0];
  assert.equal(creee.fournisseurId, rona.id);
  assert.equal(creee.sousTotal, 100);
  assert.match(creee.note, /Marc Tremblay/);
  assert.match(creee.note, /Toiture/);

  const ok = a.status === 200 ? a : b;
  assert.equal(ok.corps.facture.statut, 'approuvee');
  assert.equal(ok.corps.facture.qbo_facture_id, creee.id);
  assert.equal(ok.corps.pieceJointe, true);
  assert.equal((await bureau('/api/bureau/listes')).corps.comptesHabituels[rona.id], materiaux.id, 'catégorie retenue pour ce fournisseur');
});

test('refus avec raison, puis l\'employé corrige et renvoie ; nouveau fournisseur créé', async () => {
  const form = new FormData();
  form.append('fichier', new Blob([PNG], { type: 'image/png' }), 'recu2.png');
  const id = (await employe('/api/factures', { method: 'POST', body: form })).corps.facture.id;
  await employe(`/api/factures/${id}`, { method: 'PUT', json: { fournisseur: 'Quincaillerie Ste-Julie', total: '57.49', soumettre: true } });

  assert.equal((await bureau(`/api/bureau/factures/${id}/refuser`, { method: 'POST', json: {} })).status, 400);
  const refus = await bureau(`/api/bureau/factures/${id}/refuser`, { method: 'POST', json: { raison: 'Photo floue, reprends-la' } });
  assert.equal(refus.corps.facture.statut, 'refusee');
  const miennes = (await employe('/api/factures/miennes')).corps.factures;
  assert.equal(miennes.find((f) => f.id === id).raison_refus, 'Photo floue, reprends-la');

  const renvoi = await employe(`/api/factures/${id}`, { method: 'PUT', json: { fournisseur: 'Quincaillerie Ste-Julie', total: '57.49', soumettre: true } });
  assert.equal(renvoi.corps.facture.statut, 'en_attente');
  assert.equal(renvoi.corps.facture.raison_refus, null);

  const r = await bureau(`/api/bureau/factures/${id}/approuver`, {
    method: 'POST',
    json: { nouveauFournisseur: 'Quincaillerie Ste-Julie', compteId: '100', codeTaxeId: 'T1', date: '2026-10-02', sousTotal: '50' },
  });
  assert.equal(r.status, 200);
  assert.ok((await bureau('/api/bureau/listes')).corps.fournisseurs.some((f) => f.nom === 'Quincaillerie Ste-Julie'));
});

test('un employé désactivé est déconnecté immédiatement', async () => {
  const { utilisateurs } = (await bureau('/api/bureau/utilisateurs')).corps;
  const julie = utilisateurs.find((u) => u.identifiant === 'julie');
  await bureau(`/api/bureau/utilisateurs/${julie.id}`, { method: 'PATCH', json: { actif: false } });
  assert.equal((await autre('/api/factures/miennes')).status, 401);
  assert.equal((await autre('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } })).status, 401);
});

test('trop d\'essais de mot de passe bloque temporairement', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c('/api/connexion', { method: 'POST', json: { identifiant: 'nicolas', motDePasse: 'mauvais' } });
  const r = await c('/api/connexion', { method: 'POST', json: { identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  assert.equal(r.status, 429);
});

test("reçu d'essence : avec seulement le total, l'app calcule les taxes", async () => {
  const form = new FormData();
  form.append('fichier', new Blob([PNG], { type: 'image/png' }), 'essence.png');
  const id = (await employe('/api/factures', { method: 'POST', body: form })).corps.facture.id;
  const r = await employe(`/api/factures/${id}`, { method: 'PUT', json: { fournisseur: 'Ultramar', total: '80,00', soumettre: true } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.corps.facture.sous_total, r.corps.facture.tps, r.corps.facture.tvq], [69.58, 3.48, 6.94]);
});

test('une facture envoyée avant le calcul automatique arrive au bureau avec les taxes calculées', async () => {
  const form = new FormData();
  form.append('fichier', new Blob([PNG], { type: 'image/png' }), 'ancien.png');
  const id = (await employe('/api/factures', { method: 'POST', body: form })).corps.facture.id;
  await employe(`/api/factures/${id}`, { method: 'PUT', json: { fournisseur: 'Esso', total: '114.98', soumettre: true } });
  db.prepare('UPDATE factures SET sous_total = NULL, tps = NULL, tvq = NULL WHERE id = ?').run(id);
  const f = (await bureau('/api/bureau/factures')).corps.factures.find((x) => x.id === id);
  assert.deepEqual([f.sous_total, f.tps, f.tvq], [100, 5, 9.98]);
});
