// Projets : chaque chantier a ses notes partagées et un fil où les employés échangent messages et photos.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exigerConnexion, exigerBureau } from './auth.js';

const PHOTOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };

// Dossier Documents : plans, soumissions, devis, permis… (PDF, Office, texte, images).
const DOCUMENTS = {
  ...PHOTOS,
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/csv': 'csv',
};
const TYPES_PAR_DOSSIER = { photos: PHOTOS, documents: DOCUMENTS };

const texte = (v, max) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};

export function brancherProjets(app, { db, dossierFichiers }) {
  const dossier = path.join(dossierFichiers, 'projets');
  fs.mkdirSync(dossier, { recursive: true });
  const televersement = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (_req, f, cb) => cb(null, Boolean(PHOTOS[f.mimetype])),
  });

  const depot = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, f, cb) => cb(null, Boolean(TYPES_PAR_DOSSIER[req.params.dossier]?.[f.mimetype])),
  });

  const projet = (id) => db.prepare('SELECT * FROM projets WHERE id = ?').get(id);
  const avecAuteur = `SELECT m.id, m.projet_id, m.texte, m.cree_le, m.fichier IS NOT NULL AS photo, m.auteur_id,
                             u.nom AS auteur FROM projet_messages m JOIN utilisateurs u ON u.id = m.auteur_id`;
  // Les employés voient les projets actifs ; un projet archivé reste consultable par le bureau.
  const visible = (p, u) => p && (p.actif || u.role === 'bureau');

  app.get('/api/projets', exigerConnexion, (req, res) => {
    const archives = req.query.archives === '1' && req.utilisateur.role === 'bureau';
    const projets = db.prepare(`
      SELECT p.id, p.nom, p.adresse, p.actif, p.maj_le,
             (SELECT COUNT(*) FROM projet_messages m WHERE m.projet_id = p.id) AS nb_messages,
             (SELECT COUNT(*) FROM projet_messages m WHERE m.projet_id = p.id AND m.fichier IS NOT NULL)
               + (SELECT COUNT(*) FROM projet_fichiers f WHERE f.projet_id = p.id AND f.dossier = 'photos') AS nb_photos,
             (SELECT COUNT(*) FROM projet_fichiers f WHERE f.projet_id = p.id AND f.dossier = 'documents') AS nb_documents
      FROM projets p WHERE p.actif = ? ORDER BY p.maj_le DESC LIMIT 200`).all(archives ? 0 : 1);
    res.json({ projets });
  });

  app.post('/api/projets', exigerConnexion, exigerBureau, (req, res) => {
    const nom = texte(req.body?.nom, 120);
    if (!nom) return res.status(400).json({ erreur: 'Donne un nom au projet.' });
    const { lastInsertRowid } = db.prepare('INSERT INTO projets (nom, adresse, cree_par) VALUES (?, ?, ?)')
      .run(nom, texte(req.body.adresse, 200), req.utilisateur.id);
    res.status(201).json({ projet: projet(Number(lastInsertRowid)) });
  });

  // Tout le monde peut mettre les notes à jour ; le nom, l'adresse et l'archivage relèvent du bureau.
  app.patch('/api/projets/:id', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur)) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const b = req.body || {};
    const bureau = req.utilisateur.role === 'bureau';
    if (!bureau && ['nom', 'adresse', 'actif'].some((c) => c in b)) {
      return res.status(403).json({ erreur: 'Seul le bureau peut modifier ce projet.' });
    }
    if ('nom' in b && !texte(b.nom, 120)) return res.status(400).json({ erreur: 'Donne un nom au projet.' });
    db.prepare(`UPDATE projets SET nom = ?, adresse = ?, notes = ?, actif = ?, maj_le = datetime('now') WHERE id = ?`).run(
      'nom' in b ? texte(b.nom, 120) : p.nom,
      'adresse' in b ? texte(b.adresse, 200) : p.adresse,
      'notes' in b ? texte(b.notes, 20000) : p.notes,
      'actif' in b ? (b.actif ? 1 : 0) : p.actif,
      p.id,
    );
    res.json({ projet: projet(p.id) });
  });

  // ?apres=<id> ne renvoie que les nouveaux messages : l'écran s'en sert pour se rafraîchir.
  app.get('/api/projets/:id', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur)) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const apres = Number(req.query.apres) || 0;
    const messages = db.prepare(`${avecAuteur} WHERE m.projet_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT 300`)
      .all(p.id, apres).reverse();
    res.json({ projet: p, messages });
  });

  app.post('/api/projets/:id/messages', exigerConnexion, televersement.single('photo'), (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur) || !p.actif) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const contenu = texte(req.body?.texte, 4000);
    if (!contenu && !req.file) return res.status(400).json({ erreur: 'Écris un message ou ajoute une photo.' });
    let fichier = null;
    if (req.file) {
      fichier = `${crypto.randomUUID()}.${PHOTOS[req.file.mimetype]}`;
      fs.writeFileSync(path.join(dossier, fichier), req.file.buffer);
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO projet_messages (projet_id, auteur_id, texte, fichier, type_mime)
      VALUES (?, ?, ?, ?, ?)`).run(p.id, req.utilisateur.id, contenu, fichier, req.file?.mimetype ?? null);
    db.prepare("UPDATE projets SET maj_le = datetime('now') WHERE id = ?").run(p.id);
    res.status(201).json({ message: db.prepare(`${avecAuteur} WHERE m.id = ?`).get(Number(lastInsertRowid)) });
  });

  app.get('/api/projets/:id/messages/:mid/photo', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    const m = db.prepare('SELECT * FROM projet_messages WHERE id = ? AND projet_id = ?').get(Number(req.params.mid), p?.id);
    if (!visible(p, req.utilisateur) || !m?.fichier) return res.status(404).json({ erreur: 'Photo introuvable.' });
    res.type(m.type_mime).set('Cache-Control', 'private, max-age=86400')
      .sendFile(path.join(dossier, m.fichier), { dotfiles: 'deny' });
  });

  // ---------- Dossiers Photos et Documents ----------
  // Le dossier Photos montre aussi les photos envoyées dans la discussion.
  app.get('/api/projets/:id/dossiers/:dossier', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    const { dossier: nomDossier } = req.params;
    if (!visible(p, req.utilisateur) || !TYPES_PAR_DOSSIER[nomDossier]) return res.status(404).json({ erreur: 'Dossier introuvable.' });
    const fichiers = db.prepare(`
      SELECT f.id, f.nom_original, f.type_mime, f.taille, f.cree_le AS cree_le, f.auteur_id, u.nom AS auteur,
             '/api/projets/' || f.projet_id || '/fichiers/' || f.id AS url, 'dossier' AS source
      FROM projet_fichiers f JOIN utilisateurs u ON u.id = f.auteur_id
      WHERE f.projet_id = ? AND f.dossier = ?
      ${nomDossier === 'photos' ? `UNION ALL
      SELECT m.id, NULL, m.type_mime, NULL, m.cree_le, m.auteur_id, u.nom,
             '/api/projets/' || m.projet_id || '/messages/' || m.id || '/photo', 'discussion'
      FROM projet_messages m JOIN utilisateurs u ON u.id = m.auteur_id
      WHERE m.projet_id = ? AND m.fichier IS NOT NULL` : ''}
      ORDER BY cree_le DESC LIMIT 500`).all(...(nomDossier === 'photos' ? [p.id, nomDossier, p.id] : [p.id, nomDossier]));
    res.json({ fichiers });
  });

  app.post('/api/projets/:id/dossiers/:dossier', exigerConnexion, depot.single('fichier'), (req, res) => {
    const p = projet(Number(req.params.id));
    const types = TYPES_PAR_DOSSIER[req.params.dossier];
    if (!visible(p, req.utilisateur) || !p.actif || !types) return res.status(404).json({ erreur: 'Dossier introuvable.' });
    if (!req.file) {
      return res.status(400).json({ erreur: req.params.dossier === 'photos'
        ? 'Choisis une photo.' : 'Type de fichier non accepté (PDF, Word, Excel, texte ou image).' });
    }
    const fichier = `${crypto.randomUUID()}.${types[req.file.mimetype]}`;
    fs.writeFileSync(path.join(dossier, fichier), req.file.buffer);
    // Les navigateurs envoient le nom en latin1 : on le remet en UTF-8 pour garder les accents.
    const nom = texte(Buffer.from(req.file.originalname || '', 'latin1').toString('utf8'), 200);
    const { lastInsertRowid } = db.prepare(`INSERT INTO projet_fichiers
      (projet_id, auteur_id, dossier, fichier, nom_original, type_mime, taille) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, req.utilisateur.id, req.params.dossier, fichier, nom, req.file.mimetype, req.file.size);
    db.prepare("UPDATE projets SET maj_le = datetime('now') WHERE id = ?").run(p.id);
    res.status(201).json({ fichier: { id: Number(lastInsertRowid), nom_original: nom } });
  });

  app.get('/api/projets/:id/fichiers/:fid', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    const f = db.prepare('SELECT * FROM projet_fichiers WHERE id = ? AND projet_id = ?').get(Number(req.params.fid), p?.id);
    if (!visible(p, req.utilisateur) || !f) return res.status(404).json({ erreur: 'Fichier introuvable.' });
    res.type(f.type_mime).set('Cache-Control', 'private, max-age=86400');
    // Les images et les PDF s'ouvrent dans le navigateur ; le reste se télécharge avec son nom d'origine.
    if (!/^image\/|^application\/pdf$/.test(f.type_mime)) res.attachment(f.nom_original || f.fichier);
    res.sendFile(path.join(dossier, f.fichier), { dotfiles: 'deny' });
  });

  app.delete('/api/projets/:id/fichiers/:fid', exigerConnexion, (req, res) => {
    const f = db.prepare('SELECT * FROM projet_fichiers WHERE id = ? AND projet_id = ?').get(Number(req.params.fid), Number(req.params.id));
    if (!f || (f.auteur_id !== req.utilisateur.id && req.utilisateur.role !== 'bureau')) {
      return res.status(404).json({ erreur: 'Fichier introuvable.' });
    }
    db.prepare('DELETE FROM projet_fichiers WHERE id = ?').run(f.id);
    fs.rm(path.join(dossier, f.fichier), { force: true }, () => {});
    res.status(204).end();
  });

  app.delete('/api/projets/:id/messages/:mid', exigerConnexion, (req, res) => {
    const m = db.prepare('SELECT * FROM projet_messages WHERE id = ? AND projet_id = ?').get(Number(req.params.mid), Number(req.params.id));
    if (!m || (m.auteur_id !== req.utilisateur.id && req.utilisateur.role !== 'bureau')) {
      return res.status(404).json({ erreur: 'Message introuvable.' });
    }
    db.prepare('DELETE FROM projet_messages WHERE id = ?').run(m.id);
    if (m.fichier) fs.rm(path.join(dossier, m.fichier), { force: true }, () => {});
    res.status(204).end();
  });
}
