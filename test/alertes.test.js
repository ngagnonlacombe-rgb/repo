// Alertes au bureau : disque presque plein, QuickBooks déconnecté, erreur inattendue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { creerAlertes, espaceDisque } from '../src/alertes.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';
import { hacher } from '../src/auth.js';

function preparer({ pourcent = 50, connecte = true } = {}) {
  const db = ouvrirBase(':memory:');
  const ajout = db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role, actif) VALUES (?, ?, ?, ?, ?)');
  ajout.run('Bureau', 'bureau', 'x', 'bureau', 1);
  ajout.run('Ancien bureau', 'ancien', 'x', 'bureau', 0);
  ajout.run('Employé', 'emp', 'x', 'employe', 1);
  const envois = [];
  let temps = 0;
  const etat = { pourcent, connecte };
  const qbo = { mode: 'sandbox', connecte: () => etat.connecte };
  const alertes = creerAlertes({
    db, qbo, dossier: '.',
    notifieur: { notifier: async (ids, m) => { envois.push({ ids, ...m }); return ids.length; } },
    maintenant: () => temps,
    lireDisque: () => ({ total: 10 * 1024 ** 3, libre: (100 - etat.pourcent) / 10 * 1024 ** 3, pourcent: etat.pourcent }),
  });
  return { alertes, envois, etat, avancer: (ms) => { temps += ms; } };
}

test('espaceDisque lit le disque réel', () => {
  const d = espaceDisque('.');
  assert.ok(d.total > 0 && d.pourcent >= 0 && d.pourcent <= 100);
});

test('disque presque plein : une alerte au bureau actif seulement, pas répétée avant 24 h', async () => {
  const { alertes, envois, etat, avancer } = preparer({ pourcent: 50 });
  await alertes.verifier();
  assert.equal(envois.length, 0);
  etat.pourcent = 85;
  await alertes.verifier();
  assert.equal(envois.length, 1);
  assert.deepEqual(envois[0].ids, [1]);
  assert.match(envois[0].corps, /85 %.*1,5 Go libres/);
  avancer(3600 * 1000);
  await alertes.verifier();
  assert.equal(envois.length, 1, 'pas de répétition dans l\'heure');
  etat.pourcent = 96;
  await alertes.verifier();
  assert.equal(envois.length, 2, 'le niveau urgent alerte tout de suite');
  assert.match(envois[1].corps, /punch/);
  avancer(25 * 3600 * 1000);
  etat.pourcent = 85;
  await alertes.verifier();
  assert.equal(envois.length, 3);
});

test('QuickBooks qui passe de connecté à déconnecté alerte le bureau', async () => {
  const { alertes, envois, etat } = preparer();
  await alertes.verifier();
  assert.equal(envois.length, 0);
  etat.connecte = false;
  await alertes.verifier();
  assert.equal(envois.length, 1);
  assert.match(envois[0].corps, /QuickBooks est déconnecté/);
  await alertes.verifier();
  assert.equal(envois.length, 1);
});

test('erreur inattendue : alerte au plus une fois par heure ; disque plein reconnu', async () => {
  const { alertes, envois, avancer } = preparer();
  await alertes.erreur(new Error('boum'), { method: 'POST', path: '/api/punch/debut' });
  await alertes.erreur(new Error('boum encore'), { method: 'POST', path: '/api/punch/debut' });
  assert.equal(envois.length, 1);
  assert.match(envois[0].corps, /POST \/api\/punch\/debut.*boum/);
  await alertes.erreur(new Error('database or disk is full'), {});
  assert.equal(envois.length, 2);
  assert.match(envois[1].corps, /disque de l'app est plein/);
  avancer(3601 * 1000);
  await alertes.erreur(new Error('boum'), {});
  assert.equal(envois.length, 3);
});

test('le bureau voit le disque dans /api/etat quand il se remplit ; un employé non', async () => {
  const db = ouvrirBase(':memory:');
  db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES (?, ?, ?, ?)').run('Bureau', 'bureau', hacher('motdepasse-bureau'), 'bureau');
  db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES (?, ?, ?, ?)').run('Emp', 'emp', hacher('motdepasse-emp'), 'employe');
  const alertes = creerAlertes({ db, dossier: '.', lireDisque: () => ({ total: 100, libre: 10, pourcent: 90 }) });
  const app = creerApp({ db, alertes, qbo: creerQuickBooksDemo(), lecteur: { actif: false }, dossierFichiers: `/tmp/alertes-${process.pid}` });
  const serveur = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    for (const [identifiant, motDePasse, attendu] of [['bureau', 'motdepasse-bureau', 'avertissement'], ['emp', 'motdepasse-emp', undefined]]) {
      const c = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant, motDePasse }) });
      assert.equal(c.status, 200);
      const cookie = c.headers.get('set-cookie').split(';')[0];
      const e = await (await fetch(`${base}/api/etat`, { headers: { cookie } })).json();
      assert.equal(e.disque?.niveau, attendu);
    }
  } finally { serveur.close(); }
});

test('lecture automatique en échec : le bureau est averti, la facture est quand même déposée', async () => {
  const db = ouvrirBase(':memory:');
  db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES (?, ?, ?, ?)').run('Bureau', 'bureau', hacher('motdepasse-bureau'), 'bureau');
  db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES (?, ?, ?, ?)').run('Emp', 'emp', hacher('motdepasse-emp'), 'employe');
  const envois = [];
  const alertes = creerAlertes({ db, dossier: '.', notifieur: { notifier: async (ids, m) => { envois.push({ ids, ...m }); } } });
  const lecteur = { actif: true, lire: async () => { const e = new Error('Your credit balance is too low'); e.status = 400; throw e; } };
  const app = creerApp({ db, alertes, qbo: creerQuickBooksDemo(), lecteur, dossierFichiers: `/tmp/alertes-lecture-${process.pid}` });
  const serveur = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    const c = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'emp', motDePasse: 'motdepasse-emp' }) });
    const cookie = c.headers.get('set-cookie').split(';')[0];
    const form = new FormData();
    form.append('fichier', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'f.png');
    const r = await fetch(`${base}/api/factures`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).luAutomatiquement, false);
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(envois.length, 1);
    assert.deepEqual(envois[0].ids, [1]);
    assert.match(envois[0].corps, /lecture automatique.*erreur 400.*credit balance/);
  } finally { serveur.close(); }
});
