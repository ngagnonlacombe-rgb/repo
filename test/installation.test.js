// Le compte du bureau ne peut être créé qu'avec le code d'installation, quand il est configuré.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';

test('code d\'installation exigé pour le premier compte', async () => {
  const app = creerApp({
    db: ouvrirBase(':memory:'), qbo: creerQuickBooksDemo(), lecteur: { actif: false, lire: async () => null },
    dossierFichiers: path.join(os.tmpdir(), `ae-${process.pid}`), codeInstallation: 'toiture-2026',
  });
  const serveur = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = `http://127.0.0.1:${serveur.address().port}`;
  const envoyer = (corps) => fetch(`${url}/api/premier-compte`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps),
  });
  try {
    assert.equal((await (await fetch(`${url}/api/etat`)).json()).codeInstallationRequis, true);
    const compte = { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' };
    assert.equal((await envoyer(compte)).status, 403);
    assert.equal((await envoyer({ ...compte, code: 'mauvais' })).status, 403);
    assert.equal((await envoyer({ ...compte, code: 'toiture-2026' })).status, 201);
  } finally {
    serveur.close();
  }
});
