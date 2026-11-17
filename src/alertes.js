// Alertes au bureau : une notification sur le téléphone des comptes du bureau quand quelque chose brise
// (erreur inattendue, QuickBooks déconnecté) ou est sur le point de briser (disque presque plein).
// Les délais entre deux alertes sont gardés en mémoire, pas dans la base : quand le disque est plein,
// la base ne peut plus rien écrire, et c'est justement là que l'alerte compte.
import fs from 'node:fs';

export const SEUIL_DISQUE = 80; // % utilisé : avertissement
export const SEUIL_DISQUE_URGENT = 95; // % utilisé : les écritures vont bientôt échouer
const HEURE = 3600 * 1000;

// Espace du disque qui contient le dossier ; null si le système ne le dit pas.
export function espaceDisque(dossier) {
  try {
    const s = fs.statfsSync(dossier);
    if (!s.blocks) return null;
    // Même calcul que df : l'espace réservé au système ne compte pas comme disponible.
    const utilise = s.blocks - s.bfree;
    return { total: s.blocks * s.bsize, libre: s.bavail * s.bsize, pourcent: Math.ceil((utilise / (utilise + s.bavail)) * 100) };
  } catch { return null; }
}

const go = (octets) => `${(octets / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;

export function creerAlertes({ db, notifieur, dossier, qbo, maintenant = () => Date.now(), lireDisque = espaceDisque }) {
  const derniers = new Map();
  let qboEtaitConnecte = null;

  // Envoie au plus une alerte par sujet (cle) pendant le délai.
  async function signaler(cle, corps, delai = 6 * HEURE) {
    const avant = derniers.get(cle);
    if (avant != null && maintenant() - avant < delai) return false;
    derniers.set(cle, maintenant());
    console.error(`Alerte bureau (${cle}) : ${corps}`);
    try {
      const bureau = db.prepare("SELECT id FROM utilisateurs WHERE role = 'bureau' AND actif = 1 AND supprime = 0").all().map((u) => u.id);
      await notifieur?.notifier(bureau, { titre: '⚠️ Vapro GUS : alerte', corps, url: '/#bureau' });
    } catch (e) { console.error('Alerte non envoyée :', e.message); }
    return true;
  }

  function disque() {
    const d = lireDisque(dossier);
    if (!d || d.pourcent < SEUIL_DISQUE) return d && { ...d, niveau: null };
    return { ...d, niveau: d.pourcent >= SEUIL_DISQUE_URGENT ? 'urgent' : 'avertissement' };
  }

  // Vérification régulière : disque et connexion QuickBooks.
  async function verifier() {
    const d = disque();
    if (d?.niveau === 'urgent') {
      await signaler('disque-urgent', `Le disque de l'app est plein à ${d.pourcent} % (${go(d.libre)} libres). `
        + 'Le punch et l\'envoi de photos vont arrêter de fonctionner : il faut agrandir le disque.', 6 * HEURE);
    } else if (d?.niveau === 'avertissement') {
      await signaler('disque', `Le disque de l'app est plein à ${d.pourcent} % (${go(d.libre)} libres). `
        + 'Prévois de l\'agrandir avant qu\'il soit plein.', 24 * HEURE);
    }
    if (qbo && qbo.mode !== 'demo') {
      const connecte = qbo.connecte();
      if (qboEtaitConnecte && !connecte) await quickBooksDeconnecte();
      qboEtaitConnecte = connecte;
    }
  }

  const quickBooksDeconnecte = () => signaler('quickbooks', 'QuickBooks est déconnecté : les factures ne peuvent plus être approuvées. '
    + 'Ouvre l\'onglet Factures et touche « Connecter QuickBooks ».', 24 * HEURE);

  // Appelée par le gestionnaire d'erreurs du serveur pour chaque erreur inattendue.
  function erreur(err, req) {
    const texte = String(err?.message || err);
    if (/disk is full|SQLITE_FULL|ENOSPC/i.test(texte)) {
      return signaler('disque-plein', 'Le disque de l\'app est plein : le punch, les connexions et les photos ne fonctionnent plus. '
        + 'Il faut agrandir le disque.', 2 * HEURE);
    }
    return signaler('erreur', `Erreur inattendue dans l'app (${req?.method ?? ''} ${req?.path ?? ''}) : ${texte.slice(0, 120)}`, HEURE);
  }

  function demarrer(intervalle = 30 * 60 * 1000) {
    verifier().catch(() => {});
    const minuterie = setInterval(() => verifier().catch(() => {}), intervalle);
    minuterie.unref();
    return () => clearInterval(minuterie);
  }

  return { signaler, verifier, erreur, disque, quickBooksDeconnecte, demarrer };
}
