// Soumissions : accès donné par le bureau, numérotation, taxes du Québec et PDF.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';
import { calculerTotaux } from '../src/soumissions.js';

let serveur, base, dossier;
before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'soumissions-'));
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
    const type = rep.headers.get('content-type') || '';
    return { status: rep.status, entetes: rep.headers, corps: type.includes('json') ? await rep.json() : Buffer.from(await rep.arrayBuffer()) };
  };
}
const bureau = client();
const michael = client();
const marc = client();

test('taxes : TPS 5 % et TVQ 9,975 % sur le sous-total, arrondies au cent', () => {
  assert.deepEqual(calculerTotaux([{ quantite: 3, prix: 12.5 }, { quantite: 1.5, prix: 99.99 }]),
    { sous_total: 187.49, tps: 9.37, tvq: 18.7, total: 215.56 });
  assert.deepEqual(calculerTotaux([]), { sous_total: 0, tps: 0, tvq: 0, total: 0 });
});

test('le bureau donne l\'accès ; une soumission se crée, se modifie et sort en PDF', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  for (const [nom, identifiant] of [['Michael Plourde', 'michael'], ['Marc', 'marc']]) {
    await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
  }
  const ids = Object.fromEntries((await bureau('/api/bureau/utilisateurs')).corps.utilisateurs.map((u) => [u.identifiant, u]));
  assert.equal(ids.nicolas.soumissions, 1, 'le premier compte du bureau a l\'accès');
  assert.equal(ids.michael.soumissions, 0);
  await michael('/api/connexion', { method: 'POST', json: { identifiant: 'michael', motDePasse: '4821' } });
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });

  assert.equal((await michael('/api/soumissions')).status, 403);
  assert.equal((await michael(`/api/bureau/utilisateurs/${ids.michael.id}`, { method: 'PATCH', json: { soumissions: true } })).status, 403);
  assert.equal((await bureau(`/api/bureau/utilisateurs/${ids.michael.id}`, { method: 'PATCH', json: { soumissions: true } })).status, 200);
  assert.equal((await michael('/api/etat')).corps.utilisateur.soumissions, 1);
  assert.equal((await michael('/api/soumissions')).status, 200);
  assert.equal((await marc('/api/soumissions')).status, 403);

  // Coordonnées de l'entreprise.
  assert.equal((await michael('/api/soumissions/entreprise')).corps.entreprise.nom, 'GUS Urgence Sinistre');
  const e = await bureau('/api/soumissions/entreprise', { method: 'PUT', json: { adresse: '123 boul. Industriel, Lévis (Québec)', telephone: '418 555-0101', rbq: '5678-1234-01', tps: '123456789 RT0001', tvq: '1234567890 TQ0001' } });
  assert.equal(e.corps.entreprise.rbq, '5678-1234-01');
  assert.equal((await bureau('/api/soumissions/entreprise', { method: 'PUT', json: { nom: '' } })).status, 400);

  // Validation.
  assert.equal((await michael('/api/soumissions', { method: 'POST', json: {} })).status, 400);
  assert.equal((await michael('/api/soumissions', { method: 'POST', json: { client_nom: 'X', client_courriel: 'pas-un-courriel' } })).status, 400);
  assert.equal((await michael('/api/soumissions', { method: 'POST', json: { client_nom: 'X', statut: 'payee' } })).status, 400);

  const projet = (await bureau('/api/projets', { method: 'POST', json: { nom: 'Dégât d\'eau Gagnon', adresse: '45 rue Principale' } })).corps.projet;
  const r = await michael('/api/soumissions', { method: 'POST', json: {
    client_nom: 'Sylvie Gagnon', client_courriel: 'sylvie@example.com', projet_id: projet.id, adresse_travaux: '45 rue Principale, Lévis',
    titre: 'Remise en état du sous-sol', date_soumission: '2026-11-10',
    lignes: [
      { description: 'Démolition du gypse endommagé et disposition (« conteneur » inclus)', quantite: 1, unite: 'forfait', prix: 1850 },
      { description: 'Pose de gypse 1/2 po, tirage de joints, 2 couches', quantite: 640, unite: 'pi²', prix: 3.25 },
      { description: '', quantite: 1, prix: 0 },
    ],
  } });
  assert.equal(r.status, 201);
  const s = r.corps.soumission;
  assert.equal(s.numero, 'S-2026-001');
  assert.equal(s.statut, 'brouillon');
  assert.equal(s.lignes.length, 2, 'la ligne vide est retirée');
  assert.equal(s.sous_total, 3930);
  assert.equal(s.tps, 196.5);
  assert.equal(s.tvq, 392.02);
  assert.equal(s.total, 4518.52);
  assert.equal(s.projet_nom, 'Dégât d\'eau Gagnon');
  assert.equal((await bureau('/api/soumissions', { method: 'POST', json: { client_nom: 'Autre client', date_soumission: '2026-12-01' } })).corps.soumission.numero, 'S-2026-002');

  // Modifier : les totaux suivent les lignes, le reste ne bouge pas.
  const m = await michael(`/api/soumissions/${s.id}`, { method: 'PATCH', json: { lignes: [...s.lignes, { description: 'Peinture', quantite: 2, unite: 'jours', prix: 520 }], statut: 'envoyee' } });
  assert.equal(m.corps.soumission.sous_total, 4970);
  assert.equal(m.corps.soumission.total, 5714.26);
  assert.equal(m.corps.soumission.statut, 'envoyee');
  assert.equal(m.corps.soumission.client_nom, 'Sylvie Gagnon');
  assert.equal((await michael(`/api/soumissions/${s.id}`, { method: 'PATCH', json: { client_nom: ' ' } })).status, 400);
  assert.deepEqual((await michael('/api/soumissions')).corps.soumissions.map((x) => x.numero), ['S-2026-002', 'S-2026-001']);

  // PDF : un vrai PDF qui contient le client, le numéro, les numéros de taxes et le total.
  const pdf = await michael(`/api/soumissions/${s.id}/pdf?telecharger=1`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.entetes.get('content-disposition'), /^attachment; filename=/);
  assert.equal(pdf.corps.subarray(0, 5).toString(), '%PDF-');
  const fichier = path.join(dossier, 's.pdf');
  fs.writeFileSync(fichier, pdf.corps);
  let texte = '';
  try { texte = execFileSync('pdftotext', ['-layout', fichier, '-']).toString(); } catch { /* pdftotext absent */ }
  if (texte) {
    assert.equal(texte.split('\f').filter((page) => page.trim()).length, texte.split('\f').length - 1, 'aucune page blanche');
    for (const attendu of ['SOUMISSION', 'S-2026-001', 'Sylvie Gagnon', 'Remise en état du sous-sol', '5 714,26 $', '123456789 RT0001', 'Licence RBQ : 5678-1234-01', 'pi²', '«']) {
      assert.ok(texte.includes(attendu), `PDF sans « ${attendu} »`);
    }
  }
  assert.equal((await marc(`/api/soumissions/${s.id}/pdf`)).status, 403);

  // Supprimer.
  assert.equal((await michael(`/api/soumissions/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await michael(`/api/soumissions/${s.id}`)).status, 404);
});
