import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  hacher, verifier, creerSession, poserCookie, chargerUtilisateur,
  exigerConnexion, exigerBureau, limiteurConnexion,
} from './auth.js';
import { lireReglage, ecrireReglage } from './db.js';
import { ErreurQbo } from './quickbooks.js';

const TYPES_ACCEPTES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
};
const CHAMPS_MONTANT = ['sous_total', 'tps', 'tvq', 'total'];

export function creerApp({ db, qbo, lecteur, dossierFichiers, production = false, dossierPublic }) {
  const app = express();
  const limiteur = limiteurConnexion();
  const enTraitement = new Set();
  fs.mkdirSync(dossierFichiers, { recursive: true });

  const televersement = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (_req, f, cb) => cb(null, Boolean(TYPES_ACCEPTES[f.mimetype])),
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use(chargerUtilisateur(db));
  if (dossierPublic) app.use(express.static(dossierPublic));

  const facture = (id) => db.prepare('SELECT * FROM factures WHERE id = ?').get(id);
  const avecEmploye = `SELECT f.*, u.nom AS employe FROM factures f JOIN utilisateurs u ON u.id = f.employe_id`;
  const nbUtilisateurs = () => db.prepare('SELECT COUNT(*) AS n FROM utilisateurs').get().n;

  // ---------- Connexion ----------
  app.get('/api/etat', (req, res) => {
    res.json({
      premierDemarrage: nbUtilisateurs() === 0,
      utilisateur: req.utilisateur || null,
      quickbooks: { mode: qbo.mode, connecte: qbo.connecte() },
      lectureAuto: lecteur.actif,
    });
  });

  app.post('/api/premier-compte', (req, res) => {
    if (nbUtilisateurs() > 0) return res.status(409).json({ erreur: 'Le compte du bureau existe déjà.' });
    const { nom, identifiant, motDePasse } = req.body || {};
    const erreur = validerCompte({ nom, identifiant, motDePasse, role: 'bureau' });
    if (erreur) return res.status(400).json({ erreur });
    const { lastInsertRowid } = db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES (?, ?, ?, ?)')
      .run(nom.trim(), identifiant.trim(), hacher(motDePasse), 'bureau');
    poserCookie(res, creerSession(db, Number(lastInsertRowid)), production);
    res.status(201).json({ ok: true });
  });

  app.post('/api/connexion', (req, res) => {
    const { identifiant = '', motDePasse = '' } = req.body || {};
    if (limiteur.bloque(identifiant)) {
      return res.status(429).json({ erreur: 'Trop d\'essais. Réessaie dans 15 minutes.' });
    }
    const u = db.prepare('SELECT * FROM utilisateurs WHERE identifiant = ? AND actif = 1').get(identifiant.trim());
    if (!u || !verifier(String(motDePasse), u.hash)) {
      limiteur.echec(identifiant);
      return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' });
    }
    limiteur.reussite(identifiant);
    poserCookie(res, creerSession(db, u.id), production);
    res.json({ utilisateur: { id: u.id, nom: u.nom, identifiant: u.identifiant, role: u.role } });
  });

  app.post('/api/deconnexion', (req, res) => {
    if (req.jeton) db.prepare('DELETE FROM sessions WHERE jeton = ?').run(req.jeton);
    res.clearCookie('session');
    res.json({ ok: true });
  });

  // ---------- Employé : dépôt de factures ----------
  app.post('/api/factures', exigerConnexion, televersement.single('fichier'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: 'Ajoute une photo ou un PDF de la facture (15 Mo max).' });
    const nomFichier = `${crypto.randomUUID()}.${TYPES_ACCEPTES[req.file.mimetype]}`;
    fs.writeFileSync(path.join(dossierFichiers, nomFichier), req.file.buffer);

    let lu = null;
    try {
      lu = await lecteur.lire(req.file.buffer, req.file.mimetype);
    } catch (e) {
      console.error('Lecture automatique impossible :', e.message);
    }

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO factures (employe_id, fichier, type_mime, nom_original, fournisseur, numero, date_facture,
                            sous_total, tps, tvq, total, lecture_auto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.utilisateur.id, nomFichier, req.file.mimetype, req.file.originalname?.slice(0, 200) || null,
      lu?.fournisseur ?? null, lu?.numero ?? null, dateValide(lu?.date_facture),
      ...CHAMPS_MONTANT.map((c) => montant(lu?.[c])), lu ? JSON.stringify(lu) : null,
    );
    res.status(201).json({ facture: facture(Number(lastInsertRowid)), luAutomatiquement: Boolean(lu) });
  });

  app.get('/api/factures/miennes', exigerConnexion, (req, res) => {
    const factures = db.prepare(`${avecEmploye} WHERE f.employe_id = ? ORDER BY f.id DESC LIMIT 100`).all(req.utilisateur.id);
    res.json({ factures });
  });

  app.put('/api/factures/:id', exigerConnexion, (req, res) => {
    const f = facture(Number(req.params.id));
    if (!f || f.employe_id !== req.utilisateur.id) return res.status(404).json({ erreur: 'Facture introuvable.' });
    if (!['brouillon', 'refusee'].includes(f.statut)) {
      return res.status(409).json({ erreur: 'Cette facture est déjà envoyée au bureau.' });
    }
    const b = req.body || {};
    const valeurs = {
      fournisseur: texte(b.fournisseur, 120), numero: texte(b.numero, 40), date_facture: dateValide(b.date_facture),
      note: texte(b.note, 500), ...Object.fromEntries(CHAMPS_MONTANT.map((c) => [c, montant(b[c])])),
    };
    if (b.soumettre) {
      if (!valeurs.fournisseur) return res.status(400).json({ erreur: 'Indique le fournisseur.' });
      if (valeurs.total == null) return res.status(400).json({ erreur: 'Indique le montant total.' });
    }
    db.prepare(`UPDATE factures SET fournisseur = ?, numero = ?, date_facture = ?, note = ?, sous_total = ?, tps = ?,
                tvq = ?, total = ?, statut = ?, raison_refus = CASE WHEN ? THEN NULL ELSE raison_refus END,
                maj_le = datetime('now') WHERE id = ?`).run(
      valeurs.fournisseur, valeurs.numero, valeurs.date_facture, valeurs.note, valeurs.sous_total, valeurs.tps,
      valeurs.tvq, valeurs.total, b.soumettre ? 'en_attente' : f.statut, b.soumettre ? 1 : 0, f.id,
    );
    res.json({ facture: facture(f.id) });
  });

  app.delete('/api/factures/:id', exigerConnexion, (req, res) => {
    const f = facture(Number(req.params.id));
    if (!f || f.employe_id !== req.utilisateur.id) return res.status(404).json({ erreur: 'Facture introuvable.' });
    if (f.statut !== 'brouillon') return res.status(409).json({ erreur: 'Seul un brouillon peut être supprimé.' });
    db.prepare('DELETE FROM factures WHERE id = ?').run(f.id);
    fs.rmSync(path.join(dossierFichiers, f.fichier), { force: true });
    res.json({ ok: true });
  });

  app.get('/api/factures/:id/fichier', exigerConnexion, (req, res) => {
    const f = facture(Number(req.params.id));
    if (!f || (f.employe_id !== req.utilisateur.id && req.utilisateur.role !== 'bureau')) {
      return res.status(404).json({ erreur: 'Fichier introuvable.' });
    }
    res.type(f.type_mime).set('Cache-Control', 'private, max-age=3600')
      .sendFile(path.join(dossierFichiers, f.fichier), { dotfiles: 'deny' });
  });

  // ---------- Bureau : approbation ----------
  app.get('/api/bureau/factures', exigerConnexion, exigerBureau, (req, res) => {
    const statut = ['en_attente', 'approuvee', 'refusee'].includes(req.query.statut) ? req.query.statut : 'en_attente';
    const ordre = statut === 'en_attente' ? 'f.maj_le ASC' : 'f.maj_le DESC';
    res.json({ factures: db.prepare(`${avecEmploye} WHERE f.statut = ? ORDER BY ${ordre} LIMIT 200`).all(statut) });
  });

  app.get('/api/bureau/listes', exigerConnexion, exigerBureau, async (_req, res, next) => {
    try {
      const [fournisseurs, comptes, codesTaxe] = await Promise.all([qbo.fournisseurs(), qbo.comptes(), qbo.codesTaxe()]);
      res.json({ fournisseurs, comptes, codesTaxe, comptesHabituels: lireReglage(db, 'compte_par_fournisseur') || {} });
    } catch (e) { next(e); }
  });

  app.post('/api/bureau/factures/:id/approuver', exigerConnexion, exigerBureau, async (req, res, next) => {
    const id = Number(req.params.id);
    const f = facture(id);
    if (!f) return res.status(404).json({ erreur: 'Facture introuvable.' });
    if (f.statut !== 'en_attente') return res.status(409).json({ erreur: 'Cette facture a déjà été traitée.' });
    if (enTraitement.has(id)) return res.status(409).json({ erreur: 'Approbation déjà en cours.' });

    const b = req.body || {};
    const sousTotal = montant(b.sousTotal);
    const date = dateValide(b.date);
    if (!b.fournisseurId && !texte(b.nouveauFournisseur, 100)) return res.status(400).json({ erreur: 'Choisis le fournisseur.' });
    if (!b.compteId) return res.status(400).json({ erreur: 'Choisis la catégorie de dépense.' });
    if (!b.codeTaxeId) return res.status(400).json({ erreur: 'Choisis le code de taxe.' });
    if (sousTotal == null || sousTotal <= 0) return res.status(400).json({ erreur: 'Le montant avant taxes est requis.' });
    if (!date) return res.status(400).json({ erreur: 'La date de la facture est requise.' });

    enTraitement.add(id);
    try {
      const fournisseur = b.fournisseurId
        ? { id: String(b.fournisseurId) }
        : await qbo.creerFournisseur(texte(b.nouveauFournisseur, 100));
      const employe = db.prepare('SELECT nom FROM utilisateurs WHERE id = ?').get(f.employe_id).nom;
      const resultat = await qbo.creerFactureAPayer({
        fournisseurId: fournisseur.id, compteId: String(b.compteId), codeTaxeId: String(b.codeTaxeId),
        date, numero: texte(b.numero, 40), sousTotal, total: montant(b.total),
        description: `Matériaux, déposée par ${employe}`,
        note: [`Déposée par ${employe} via l'app employés (facture #${f.id}).`, f.note].filter(Boolean).join(' '),
      });

      // La facture existe dans QuickBooks : on la marque approuvée avant de joindre la photo,
      // pour qu'un échec de pièce jointe ne crée jamais de doublon.
      db.prepare(`UPDATE factures SET statut = 'approuvee', qbo_facture_id = ?, traitee_par = ?,
                  maj_le = datetime('now') WHERE id = ?`).run(resultat.id, req.utilisateur.id, id);
      const habituels = lireReglage(db, 'compte_par_fournisseur') || {};
      habituels[fournisseur.id] = String(b.compteId);
      ecrireReglage(db, 'compte_par_fournisseur', habituels);

      let pieceJointe = true;
      try {
        await qbo.joindreFichier(resultat.id, {
          contenu: fs.readFileSync(path.join(dossierFichiers, f.fichier)),
          typeMime: f.type_mime, nomFichier: `facture-${f.id}.${TYPES_ACCEPTES[f.type_mime]}`,
        });
        db.prepare('UPDATE factures SET qbo_piece_jointe = 1 WHERE id = ?').run(id);
      } catch (e) {
        pieceJointe = false;
        console.error('Pièce jointe QuickBooks impossible :', e.message);
      }
      res.json({ facture: facture(id), pieceJointe });
    } catch (e) {
      next(e);
    } finally {
      enTraitement.delete(id);
    }
  });

  app.post('/api/bureau/factures/:id/refuser', exigerConnexion, exigerBureau, (req, res) => {
    const f = facture(Number(req.params.id));
    if (!f) return res.status(404).json({ erreur: 'Facture introuvable.' });
    if (f.statut !== 'en_attente') return res.status(409).json({ erreur: 'Cette facture a déjà été traitée.' });
    const raison = texte(req.body?.raison, 300);
    if (!raison) return res.status(400).json({ erreur: 'Indique la raison du refus à l\'employé.' });
    db.prepare(`UPDATE factures SET statut = 'refusee', raison_refus = ?, traitee_par = ?, maj_le = datetime('now')
                WHERE id = ?`).run(raison, req.utilisateur.id, f.id);
    res.json({ facture: facture(f.id) });
  });

  // ---------- Bureau : employés ----------
  app.get('/api/bureau/utilisateurs', exigerConnexion, exigerBureau, (_req, res) => {
    res.json({ utilisateurs: db.prepare('SELECT id, nom, identifiant, role, actif FROM utilisateurs ORDER BY actif DESC, nom').all() });
  });

  app.post('/api/bureau/utilisateurs', exigerConnexion, exigerBureau, (req, res) => {
    const { nom, identifiant, motDePasse, role = 'employe' } = req.body || {};
    const erreur = validerCompte({ nom, identifiant, motDePasse, role });
    if (erreur) return res.status(400).json({ erreur });
    if (db.prepare('SELECT 1 FROM utilisateurs WHERE identifiant = ?').get(identifiant.trim())) {
      return res.status(409).json({ erreur: 'Cet identifiant est déjà utilisé.' });
    }
    db.prepare('INSERT INTO utilisateurs (nom, identifiant, hash, role) VALUES (?, ?, ?, ?)')
      .run(nom.trim(), identifiant.trim(), hacher(motDePasse), role);
    res.status(201).json({ ok: true });
  });

  app.patch('/api/bureau/utilisateurs/:id', exigerConnexion, exigerBureau, (req, res) => {
    const u = db.prepare('SELECT * FROM utilisateurs WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
    const { actif, motDePasse } = req.body || {};
    if (u.id === req.utilisateur.id && actif === false) {
      return res.status(400).json({ erreur: 'Tu ne peux pas désactiver ton propre accès.' });
    }
    if (motDePasse !== undefined) {
      const erreur = validerMotDePasse(motDePasse, u.role);
      if (erreur) return res.status(400).json({ erreur });
      db.prepare('UPDATE utilisateurs SET hash = ? WHERE id = ?').run(hacher(motDePasse), u.id);
      db.prepare('DELETE FROM sessions WHERE utilisateur_id = ?').run(u.id);
    }
    if (typeof actif === 'boolean') {
      db.prepare('UPDATE utilisateurs SET actif = ? WHERE id = ?').run(actif ? 1 : 0, u.id);
      if (!actif) db.prepare('DELETE FROM sessions WHERE utilisateur_id = ?').run(u.id);
    }
    res.json({ ok: true });
  });

  // ---------- Bureau : connexion QuickBooks ----------
  app.get('/api/qbo/connecter', exigerConnexion, exigerBureau, (_req, res) => {
    if (qbo.mode === 'demo') return res.redirect('/#bureau');
    const etat = crypto.randomBytes(16).toString('hex');
    ecrireReglage(db, 'qbo_etat', { etat, expireA: Date.now() + 10 * 60 * 1000 });
    res.redirect(qbo.urlConnexion(etat));
  });

  app.get('/api/qbo/retour', exigerConnexion, exigerBureau, async (req, res) => {
    const attendu = lireReglage(db, 'qbo_etat');
    db.prepare("DELETE FROM reglages WHERE cle = 'qbo_etat'").run();
    if (!attendu || attendu.etat !== req.query.state || Date.now() > attendu.expireA || !req.query.code) {
      return res.redirect('/#bureau?qbo=echec');
    }
    try {
      await qbo.terminerConnexion(String(req.query.code), String(req.query.realmId));
      res.redirect('/#bureau?qbo=ok');
    } catch (e) {
      console.error(e);
      res.redirect('/#bureau?qbo=echec');
    }
  });

  app.post('/api/qbo/deconnecter', exigerConnexion, exigerBureau, async (_req, res) => {
    if (qbo.deconnecter) await qbo.deconnecter();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => res.status(404).json({ erreur: 'Adresse inconnue.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ErreurQbo) return res.status(502).json({ erreur: `QuickBooks : ${err.message}` });
    if (err instanceof multer.MulterError) return res.status(400).json({ erreur: 'Fichier trop gros (15 Mo max).' });
    console.error(err);
    res.status(500).json({ erreur: 'Erreur inattendue. Réessaie.' });
  });

  return app;
}

// ---------- Validation ----------
function texte(v, max) {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

function montant(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s|\$/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n * 100) / 100 : null;
}

function dateValide(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

function validerMotDePasse(motDePasse, role) {
  const m = String(motDePasse ?? '');
  if (role === 'bureau' && m.length < 10) return 'Le mot de passe du bureau doit avoir au moins 10 caractères.';
  if (role === 'employe' && m.length < 4) return 'Le NIP ou mot de passe doit avoir au moins 4 caractères.';
  return null;
}

function validerCompte({ nom, identifiant, motDePasse, role }) {
  if (!texte(nom, 80)) return 'Indique le nom.';
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(String(identifiant ?? '').trim())) {
    return 'L\'identifiant doit avoir 3 à 40 caractères (lettres, chiffres, point, tiret).';
  }
  if (!['employe', 'bureau'].includes(role)) return 'Rôle invalide.';
  return validerMotDePasse(motDePasse, role);
}
