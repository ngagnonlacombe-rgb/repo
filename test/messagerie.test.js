// Messagerie : conversation privée entre chaque employé et le bureau.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';
import { creerNotifieur } from '../src/notifications.js';
import crypto from 'node:crypto';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let serveur, base, dossier;
const envois = [];
// Faux service de notifications : garde les requêtes ; l'appareil « expire » répond 410.
const envoyer = async (endpoint, init) => { envois.push({ endpoint, ...init }); return { ok: !endpoint.includes('expire'), status: endpoint.includes('expire') ? 410 : 201 }; };

before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'messagerie-'));
  const db = ouvrirBase(':memory:');
  const app = creerApp({
    db, notifieur: creerNotifieur(db, { envoyer }), qbo: creerQuickBooksDemo(), lecteur: { actif: false, lire: async () => null },
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

test('un employé écrit au bureau, le bureau répond, chacun ne voit que sa conversation', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  for (const [nom, identifiant] of [['Marc', 'marc'], ['Julie', 'julie']]) {
    await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
  }
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });
  await julie('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } });

  assert.equal((await marc('/api/messagerie', { method: 'POST', json: { texte: ' ' } })).status, 400);
  const m1 = await marc('/api/messagerie', { method: 'POST', json: { texte: 'Je serai en retard demain' } });
  assert.equal(m1.status, 201);
  const form = new FormData();
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'bris.png');
  const m2 = await marc('/api/messagerie', { method: 'POST', body: form });
  assert.equal(m2.corps.message.photo, 1);

  // Le bureau voit 2 non-lus de Marc, rien pour Julie.
  assert.equal((await bureau('/api/messagerie/non-lus')).corps.nonLus, 2);
  const { conversations } = (await bureau('/api/bureau/messagerie')).corps;
  assert.deepEqual(conversations.map((c) => [c.nom, c.non_lus]), [['Marc', 2], ['Julie', 0]]);

  const idMarc = conversations[0].id;
  const fil = (await bureau(`/api/bureau/messagerie/${idMarc}`)).corps.messages;
  assert.deepEqual(fil.map((m) => m.texte), ['Je serai en retard demain', null]);
  assert.equal((await bureau('/api/messagerie/non-lus')).corps.nonLus, 0);
  assert.equal((await bureau(`/api/messagerie/${m2.corps.message.id}/photo`)).status, 200);

  await bureau(`/api/bureau/messagerie/${idMarc}`, { method: 'POST', json: { texte: 'Merci, pas de problème' } });
  assert.equal((await marc('/api/messagerie/non-lus')).corps.nonLus, 1);
  const vuParMarc = (await marc('/api/messagerie')).corps.messages;
  assert.equal(vuParMarc.at(-1).auteur, 'Nicolas');
  assert.equal(vuParMarc.at(-1).du_bureau, 1);
  assert.equal((await marc('/api/messagerie/non-lus')).corps.nonLus, 0);
  assert.equal((await marc(`/api/messagerie?apres=${vuParMarc.at(-1).id}`)).corps.messages.length, 0);

  // Julie ne voit ni la conversation ni la photo de Marc.
  assert.equal((await julie('/api/messagerie')).corps.messages.length, 0);
  assert.equal((await julie(`/api/messagerie/${m2.corps.message.id}/photo`)).status, 404);
  assert.equal((await julie(`/api/bureau/messagerie/${idMarc}`)).status, 403);

  // On n'efface que ses propres messages.
  assert.equal((await julie(`/api/messagerie/${m1.corps.message.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await marc(`/api/messagerie/${m1.corps.message.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc('/api/messagerie')).corps.messages.length, 2);
});

// Ce que fait le téléphone à la réception : déchiffre le message (RFC 8291).
function dechiffrer(corps, appareil, auth) {
  const sel = corps.subarray(0, 16);
  const longueur = corps[20];
  const cleServeur = corps.subarray(21, 21 + longueur);
  const chiffre = corps.subarray(21 + longueur);
  const hmac = (cle, ...d) => crypto.createHmac('sha256', cle).update(Buffer.concat(d)).digest();
  const ikm = hmac(hmac(auth, appareil.computeSecret(cleServeur)), Buffer.from('WebPush: info\0'), appareil.getPublicKey(), cleServeur, Buffer.from([1]));
  const prk = hmac(sel, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(chiffre.subarray(-16));
  const clair = Buffer.concat([d.update(chiffre.subarray(0, -16)), d.final()]);
  return JSON.parse(clair.subarray(0, clair.lastIndexOf(2)).toString());
}

test('notifications : un message prévient le bureau ou l\'employé sur son téléphone', async () => {
  const { cle } = (await marc('/api/notifications/cle')).corps;
  assert.equal(Buffer.from(cle, 'base64url').length, 65);
  const appareil = crypto.createECDH('prime256v1');
  appareil.generateKeys();
  const auth = crypto.randomBytes(16);
  const abonnement = (endpoint) => ({ endpoint, keys: { p256dh: appareil.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });
  assert.equal((await marc('/api/notifications/abonnement', { method: 'POST', json: { endpoint: 'http://x' } })).status, 400);
  assert.equal((await bureau('/api/notifications/abonnement', { method: 'POST', json: abonnement('https://push.example/bureau') })).status, 201);
  assert.equal((await bureau('/api/notifications/abonnement', { method: 'POST', json: abonnement('https://push.example/expire') })).status, 201);
  assert.equal((await marc('/api/notifications/abonnement', { method: 'POST', json: abonnement('https://push.example/marc') })).status, 201);

  envois.length = 0;
  await marc('/api/messagerie', { method: 'POST', json: { texte: 'Le camion ne démarre pas' } });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(envois.map((e) => e.endpoint).sort(), ['https://push.example/bureau', 'https://push.example/expire']);
  const envoi = envois.find((e) => e.endpoint.endsWith('bureau'));
  const recu = dechiffrer(envoi.body, appareil, auth);
  assert.equal(recu.titre, 'Message de Marc');
  assert.equal(recu.corps, 'Le camion ne démarre pas');
  assert.match(recu.url, /^\/#messages\/\d+$/);

  // Signature VAPID vérifiable avec la clé publique annoncée.
  const [, jwt, k] = envoi.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, cle);
  const [entete, charge, signature] = jwt.split('.');
  const publique = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(cle, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(cle, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${entete}.${charge}`), { key: publique, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(charge, 'base64url')).aud, 'https://push.example');

  // L'appareil expiré (410) est oublié ; le bureau qui répond prévient seulement Marc.
  envois.length = 0;
  const idMarc = (await bureau('/api/bureau/messagerie')).corps.conversations.find((c) => c.nom === 'Marc').id;
  await bureau(`/api/bureau/messagerie/${idMarc}`, { method: 'POST', json: { texte: 'J\'appelle le garage' } });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(envois.map((e) => e.endpoint), ['https://push.example/marc']);
  assert.deepEqual(dechiffrer(envois[0].body, appareil, auth), { titre: 'Message du bureau', corps: 'J\'appelle le garage', url: '/#messages' });

  envois.length = 0;
  await marc('/api/messagerie', { method: 'POST', json: { texte: 'Merci' } });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(envois.map((e) => e.endpoint), ['https://push.example/bureau']);

  assert.equal((await marc('/api/notifications/abonnement', { method: 'DELETE', json: { endpoint: 'https://push.example/marc' } })).status, 204);
});
