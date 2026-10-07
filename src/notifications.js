// Notifications sur le téléphone (Web Push), sans service externe : les clés VAPID sont créées au premier
// démarrage et gardées dans la base ; chaque message est chiffré pour l'appareil (RFC 8291, aes128gcm).
import crypto from 'node:crypto';
import { lireReglage, ecrireReglage } from './db.js';
import { exigerConnexion } from './auth.js';

const b64url = (b) => Buffer.from(b).toString('base64url');
const hmac = (cle, ...donnees) => crypto.createHmac('sha256', cle).update(Buffer.concat(donnees)).digest();

function clesVapid(db) {
  let jwk = lireReglage(db, 'vapid');
  if (!jwk) {
    jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    ecrireReglage(db, 'vapid', jwk);
  }
  const prive = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publique = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { prive, publique };
}

// Chiffre le contenu pour un abonnement (clé p256dh et secret auth fournis par le navigateur).
export function chiffrer(contenu, p256dh, auth) {
  const cleAppareil = Buffer.from(p256dh, 'base64url');
  const ephemere = crypto.createECDH('prime256v1');
  const clePublique = ephemere.generateKeys();
  const secret = ephemere.computeSecret(cleAppareil);
  const ikm = hmac(hmac(Buffer.from(auth, 'base64url'), secret),
    Buffer.from('WebPush: info\0'), cleAppareil, clePublique, Buffer.from([1]));
  const sel = crypto.randomBytes(16);
  const prk = hmac(sel, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const chiffreur = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const corps = Buffer.concat([chiffreur.update(Buffer.concat([Buffer.from(contenu), Buffer.from([2])])), chiffreur.final(), chiffreur.getAuthTag()]);
  const entete = Buffer.alloc(21);
  sel.copy(entete, 0);
  entete.writeUInt32BE(4096, 16);
  entete[20] = clePublique.length;
  return Buffer.concat([entete, clePublique, corps]);
}

export function creerNotifieur(db, { envoyer = fetch, contact = 'https://app-employes-ngl.fly.dev' } = {}) {
  const { prive, publique } = clesVapid(db);

  const jeton = (endpoint) => {
    const entete = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const charge = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact }));
    const signature = crypto.sign('sha256', Buffer.from(`${entete}.${charge}`), { key: prive, dsaEncoding: 'ieee-p1363' });
    return `${entete}.${charge}.${b64url(signature)}`;
  };

  // Envoie à tous les appareils des utilisateurs visés ; un abonnement expiré (404/410) est oublié.
  async function notifier(utilisateurIds, message) {
    if (!utilisateurIds.length) return 0;
    const abonnements = db.prepare(`SELECT * FROM push_abonnements WHERE utilisateur_id IN (${utilisateurIds.map(() => '?').join(',')})`)
      .all(...utilisateurIds);
    const resultats = await Promise.allSettled(abonnements.map(async (a) => {
      const rep = await envoyer(a.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${jeton(a.endpoint)}, k=${b64url(publique)}`,
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
        },
        body: chiffrer(JSON.stringify(message), a.p256dh, a.auth),
      });
      if (rep.status === 404 || rep.status === 410) db.prepare('DELETE FROM push_abonnements WHERE id = ?').run(a.id);
      if (!rep.ok) throw new Error(`push ${rep.status}`);
    }));
    return resultats.filter((r) => r.status === 'fulfilled').length;
  }

  function brancher(app) {
    app.get('/api/notifications/cle', exigerConnexion, (_req, res) => res.json({ cle: b64url(publique) }));

    app.post('/api/notifications/abonnement', exigerConnexion, (req, res) => {
      const { endpoint, keys } = req.body || {};
      let url;
      try { url = new URL(endpoint); } catch { url = null; }
      if (url?.protocol !== 'https:' || !keys?.p256dh || !keys?.auth) return res.status(400).json({ erreur: 'Abonnement invalide.' });
      db.prepare(`INSERT INTO push_abonnements (utilisateur_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET utilisateur_id = excluded.utilisateur_id, p256dh = excluded.p256dh, auth = excluded.auth`)
        .run(req.utilisateur.id, endpoint, String(keys.p256dh), String(keys.auth));
      res.status(201).json({ ok: true });
    });

    // À la déconnexion, le téléphone cesse de recevoir les notifications de ce compte.
    app.delete('/api/notifications/abonnement', exigerConnexion, (req, res) => {
      db.prepare('DELETE FROM push_abonnements WHERE endpoint = ? AND utilisateur_id = ?').run(String(req.body?.endpoint), req.utilisateur.id);
      res.status(204).end();
    });
  }

  return { notifier, brancher, clePublique: b64url(publique) };
}
