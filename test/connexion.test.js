// Connexion : identifiant sans égard aux majuscules, mot de passe du bureau oublié, changement de son propre mot de passe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';

let serveur, base;
before(async () => {
  const app = creerApp({
    db: ouvrirBase(':memory:'), qbo: creerQuickBooksDemo(), lecteur: { actif: false, lire: async () => null },
    dossierFichiers: path.join(os.tmpdir(), `connexion-${process.pid}`), codeInstallation: 'toiture-2026',
  });
  await new Promise((ok) => { serveur = app.listen(0, ok); });
  base = `http://127.0.0.1:${serveur.address().port}`;
});
after(() => serveur.close());

function client() {
  let cookie = '';
  return async (chemin, { method = 'GET', json } = {}) => {
    const headers = cookie ? { cookie } : {};
    if (json) headers['Content-Type'] = 'application/json';
    const rep = await fetch(base + chemin, { method, headers, body: json ? JSON.stringify(json) : undefined });
    const c = rep.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return { status: rep.status, corps: await rep.json().catch(() => ({})) };
  };
}

test('connexion, mot de passe oublié et changement de son propre mot de passe', async () => {
  const bureau = client();
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe', code: 'toiture-2026' } });
  await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom: 'Marc', identifiant: 'marc', motDePasse: '4821' } });
  assert.equal((await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom: 'Autre', identifiant: 'Marc', motDePasse: '4821' } })).status, 409);

  // Le téléphone met une majuscule au début de l'identifiant : ça fonctionne quand même.
  const tel = client();
  assert.equal((await tel('/api/connexion', { method: 'POST', json: { identifiant: 'Nicolas ', motDePasse: 'un-bon-mot-de-passe' } })).status, 200);
  assert.equal((await tel('/api/connexion', { method: 'POST', json: { identifiant: 'nicolas', motDePasse: 'Un-bon-mot-de-passe' } })).status, 401);

  // Changer son propre mot de passe : on reste connecté ici, les autres appareils sont déconnectés.
  assert.equal((await bureau('/api/bureau/utilisateurs/1', { method: 'PATCH', json: { motDePasse: 'nouveau-mot-de-passe' } })).status, 200);
  assert.equal((await bureau('/api/etat')).corps.utilisateur?.nom, 'Nicolas');
  assert.equal((await tel('/api/etat')).corps.utilisateur, null);
  assert.equal((await tel('/api/connexion', { method: 'POST', json: { identifiant: 'nicolas', motDePasse: 'nouveau-mot-de-passe' } })).status, 200);

  // Mot de passe oublié : il faut le code d'installation, et seulement pour un compte du bureau.
  const oubli = client();
  const demande = (json) => oubli('/api/mot-de-passe-oublie', { method: 'POST', json });
  assert.equal((await demande({ identifiant: 'nicolas', code: 'mauvais', motDePasse: 'encore-un-autre-mdp' })).status, 401);
  assert.equal((await demande({ identifiant: 'marc', code: 'toiture-2026', motDePasse: 'encore-un-autre-mdp' })).status, 404);
  assert.equal((await demande({ identifiant: 'nicolas', code: 'toiture-2026', motDePasse: 'court' })).status, 400);
  const r = await demande({ identifiant: 'Nicolas', code: 'toiture-2026', motDePasse: 'encore-un-autre-mdp' });
  assert.equal(r.status, 200);
  assert.equal(r.corps.utilisateur.nom, 'Nicolas');
  assert.equal((await oubli('/api/etat')).corps.utilisateur?.nom, 'Nicolas', 'connecté tout de suite');
  assert.equal((await bureau('/api/etat')).corps.utilisateur, null, 'les anciennes sessions sont fermées');
  assert.equal((await client()('/api/connexion', { method: 'POST', json: { identifiant: 'nicolas', motDePasse: 'encore-un-autre-mdp' } })).status, 200);

  // Trop d'essais avec un mauvais code : bloqué 15 minutes, même avec le bon code.
  for (let i = 0; i < 5; i += 1) await demande({ identifiant: 'nicolas', code: `faux-${i}`, motDePasse: 'encore-un-autre-mdp' });
  assert.equal((await demande({ identifiant: 'nicolas', code: 'toiture-2026', motDePasse: 'encore-un-autre-mdp' })).status, 429);
});
