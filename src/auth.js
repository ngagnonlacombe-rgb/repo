// Connexion par identifiant + mot de passe (ou NIP), sessions en base, cookie httpOnly.
import crypto from 'node:crypto';

const DUREE_SESSION_JOURS = 30;
const COOKIE = 'session';

export function hacher(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = crypto.scryptSync(motDePasse, sel, 64);
  return `${sel.toString('hex')}:${cle.toString('hex')}`;
}

export function verifier(motDePasse, hash) {
  const [selHex, cleHex] = hash.split(':');
  const cle = crypto.scryptSync(motDePasse, Buffer.from(selHex, 'hex'), 64);
  return crypto.timingSafeEqual(cle, Buffer.from(cleHex, 'hex'));
}

export function creerSession(db, utilisateurId) {
  const jeton = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (jeton, utilisateur_id, expire_le)
              VALUES (?, ?, datetime('now', ?))`).run(jeton, utilisateurId, `+${DUREE_SESSION_JOURS} days`);
  return jeton;
}

export function poserCookie(res, jeton, production) {
  res.cookie(COOKIE, jeton, {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    maxAge: DUREE_SESSION_JOURS * 24 * 3600 * 1000,
  });
}

function lireCookie(req) {
  const brut = req.headers.cookie || '';
  for (const morceau of brut.split(';')) {
    const [nom, ...reste] = morceau.trim().split('=');
    if (nom === COOKIE) return decodeURIComponent(reste.join('='));
  }
  return null;
}

// Ajoute req.utilisateur si la session est valide.
export function chargerUtilisateur(db) {
  return (req, _res, next) => {
    const jeton = lireCookie(req);
    req.jeton = jeton;
    if (jeton) {
      req.utilisateur = db.prepare(`
        SELECT u.id, u.nom, u.identifiant, u.role, u.chef_projet FROM sessions s
        JOIN utilisateurs u ON u.id = s.utilisateur_id
        WHERE s.jeton = ? AND s.expire_le > datetime('now') AND u.actif = 1`).get(jeton) || null;
    }
    next();
  };
}

export function exigerConnexion(req, res, next) {
  if (!req.utilisateur) return res.status(401).json({ erreur: 'Connexion requise.' });
  next();
}

export function exigerBureau(req, res, next) {
  if (req.utilisateur?.role !== 'bureau') return res.status(403).json({ erreur: 'Réservé au bureau.' });
  next();
}

// Limite simple contre les essais de mot de passe en rafale (par identifiant).
export function limiteurConnexion() {
  const essais = new Map();
  return {
    bloque(identifiant) {
      const e = essais.get(identifiant.toLowerCase());
      return e && e.nombre >= 5 && Date.now() - e.depuis < 15 * 60 * 1000;
    },
    echec(identifiant) {
      const cle = identifiant.toLowerCase();
      const e = essais.get(cle);
      if (!e || Date.now() - e.depuis > 15 * 60 * 1000) essais.set(cle, { nombre: 1, depuis: Date.now() });
      else e.nombre += 1;
    },
    reussite(identifiant) {
      essais.delete(identifiant.toLowerCase());
    },
  };
}
