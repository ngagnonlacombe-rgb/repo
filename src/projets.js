// Projets : chaque chantier a ses notes partagées et un fil où les employés échangent messages et photos.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exigerConnexion } from './auth.js';
import { pdfDePages } from './pdf.js';

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

// Lien de partage magicplan : une adresse https, rien d'autre (on l'ouvre dans un nouvel onglet).
// Le partage depuis le téléphone colle parfois une phrase autour du lien : on garde le lien seul.
const lienPlan = (v) => {
  const t = texte(v, 1000);
  if (!t) return null;
  try {
    const u = new URL(t.match(/https:\/\/\S+/)?.[0] ?? t);
    return u.protocol === 'https:' ? u.href : undefined;
  } catch { return undefined; }
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

  // Le bureau et les chargés de projet créent les projets.
  app.post('/api/projets', exigerConnexion, (req, res) => {
    if (req.utilisateur.role !== 'bureau' && !req.utilisateur.chef_projet) {
      return res.status(403).json({ erreur: 'Seuls le bureau et les chargés de projet peuvent créer un projet.' });
    }
    const nom = texte(req.body?.nom, 120);
    if (!nom) return res.status(400).json({ erreur: 'Donne un nom au projet.' });
    const { lastInsertRowid } = db.prepare('INSERT INTO projets (nom, adresse, cree_par) VALUES (?, ?, ?)')
      .run(nom, texte(req.body.adresse, 200), req.utilisateur.id);
    res.status(201).json({ projet: projet(Number(lastInsertRowid)) });
  });

  // Tout le monde peut mettre les notes à jour ; le nom, l'adresse et l'archivage relèvent du bureau ;
  // le lien du plan magicplan, du bureau et des chargés de projet.
  app.patch('/api/projets/:id', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur)) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const b = req.body || {};
    const bureau = req.utilisateur.role === 'bureau';
    if (!bureau && ['nom', 'adresse', 'actif'].some((c) => c in b)) {
      return res.status(403).json({ erreur: 'Seul le bureau peut modifier ce projet.' });
    }
    if ('magicplan_url' in b && !bureau && !req.utilisateur.chef_projet) {
      return res.status(403).json({ erreur: 'Seuls le bureau et les chargés de projet peuvent changer le plan.' });
    }
    if ('nom' in b && !texte(b.nom, 120)) return res.status(400).json({ erreur: 'Donne un nom au projet.' });
    const plan = 'magicplan_url' in b ? lienPlan(b.magicplan_url) : p.magicplan_url;
    if (plan === undefined) return res.status(400).json({ erreur: 'Colle le lien de partage magicplan (il commence par https://).' });
    db.prepare(`UPDATE projets SET nom = ?, adresse = ?, notes = ?, actif = ?, magicplan_url = ?, maj_le = datetime('now') WHERE id = ?`).run(
      'nom' in b ? texte(b.nom, 120) : p.nom,
      'adresse' in b ? texte(b.adresse, 200) : p.adresse,
      'notes' in b ? texte(b.notes, 20000) : p.notes,
      'actif' in b ? (b.actif ? 1 : 0) : p.actif,
      plan,
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
    // ?album=<id> : un sous-dossier de photos ; ?album=0 : les photos pas encore rangées ; sans paramètre : toutes.
    const album = nomDossier === 'photos' && req.query.album != null ? Number(req.query.album) || 0 : null;
    const filtre = (t) => (album == null ? '' : album ? `AND ${t}.album_id = ?` : `AND ${t}.album_id IS NULL`);
    const valeurs = album ? [album] : [];
    const fichiers = db.prepare(`
      SELECT f.id, f.nom_original, f.type_mime, f.taille, f.cree_le AS cree_le, f.auteur_id, u.nom AS auteur,
             '/api/projets/' || f.projet_id || '/fichiers/' || f.id AS url, 'dossier' AS source, f.album_id AS album_id
      FROM projet_fichiers f JOIN utilisateurs u ON u.id = f.auteur_id
      WHERE f.projet_id = ? AND f.dossier = ? ${filtre('f')}
      ${nomDossier === 'photos' ? `UNION ALL
      SELECT m.id, NULL, m.type_mime, NULL, m.cree_le, m.auteur_id, u.nom,
             '/api/projets/' || m.projet_id || '/messages/' || m.id || '/photo', 'discussion', m.album_id
      FROM projet_messages m JOIN utilisateurs u ON u.id = m.auteur_id
      WHERE m.projet_id = ? AND m.fichier IS NOT NULL ${filtre('m')}` : ''}
      ORDER BY cree_le DESC LIMIT 500`).all(...(nomDossier === 'photos' ? [p.id, nomDossier, ...valeurs, p.id, ...valeurs] : [p.id, nomDossier]));
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
    const album = req.params.dossier === 'photos' && Number(req.body?.album_id) ? albumDe(p.id, Number(req.body.album_id)) : null;
    if (req.body?.album_id && Number(req.body.album_id) && !album) return res.status(404).json({ erreur: 'Dossier de photos introuvable.' });
    const fichier = `${crypto.randomUUID()}.${types[req.file.mimetype]}`;
    fs.writeFileSync(path.join(dossier, fichier), req.file.buffer);
    // Les navigateurs envoient le nom en latin1 : on le remet en UTF-8 pour garder les accents.
    const nom = texte(Buffer.from(req.file.originalname || '', 'latin1').toString('utf8'), 200);
    const { lastInsertRowid } = db.prepare(`INSERT INTO projet_fichiers
      (projet_id, auteur_id, dossier, fichier, nom_original, type_mime, taille, album_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, req.utilisateur.id, req.params.dossier, fichier, nom, req.file.mimetype, req.file.size, album?.id ?? null);
    db.prepare("UPDATE projets SET maj_le = datetime('now') WHERE id = ?").run(p.id);
    res.status(201).json({ fichier: { id: Number(lastInsertRowid), nom_original: nom } });
  });

  // ---------- Sous-dossiers de photos ----------
  // Toute l'équipe peut créer, renommer et trier ; supprimer un sous-dossier remet ses photos dans « Non classées ».
  const albumDe = (projetId, id) => db.prepare('SELECT * FROM projet_albums WHERE id = ? AND projet_id = ?').get(id, projetId);
  const projetOuvert = (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur)) { res.status(404).json({ erreur: 'Projet introuvable.' }); return null; }
    if (!p.actif) { res.status(403).json({ erreur: 'Ce projet est archivé.' }); return null; }
    return p;
  };

  app.get('/api/projets/:id/albums', exigerConnexion, (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur)) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const albums = db.prepare(`
      SELECT a.id, a.nom, a.cree_par,
             (SELECT COUNT(*) FROM projet_fichiers f WHERE f.album_id = a.id)
               + (SELECT COUNT(*) FROM projet_messages m WHERE m.album_id = a.id) AS nb_photos,
             (SELECT '/api/projets/' || a.projet_id || '/fichiers/' || f.id FROM projet_fichiers f
                WHERE f.album_id = a.id ORDER BY f.id DESC LIMIT 1) AS couverture
      FROM projet_albums a WHERE a.projet_id = ? ORDER BY a.nom COLLATE NOCASE`).all(p.id);
    res.json({ albums });
  });

  app.post('/api/projets/:id/albums', exigerConnexion, (req, res) => {
    const p = projetOuvert(req, res);
    if (!p) return;
    const nom = texte(req.body?.nom, 80);
    if (!nom) return res.status(400).json({ erreur: 'Donne un nom au dossier.' });
    const { lastInsertRowid } = db.prepare('INSERT INTO projet_albums (projet_id, nom, cree_par) VALUES (?, ?, ?)')
      .run(p.id, nom, req.utilisateur.id);
    res.status(201).json({ album: albumDe(p.id, Number(lastInsertRowid)) });
  });

  app.patch('/api/projets/:id/albums/:aid', exigerConnexion, (req, res) => {
    const p = projetOuvert(req, res);
    if (!p) return;
    const a = albumDe(p.id, Number(req.params.aid));
    if (!a) return res.status(404).json({ erreur: 'Dossier de photos introuvable.' });
    const nom = texte(req.body?.nom, 80);
    if (!nom) return res.status(400).json({ erreur: 'Donne un nom au dossier.' });
    db.prepare('UPDATE projet_albums SET nom = ? WHERE id = ?').run(nom, a.id);
    res.json({ album: albumDe(p.id, a.id) });
  });

  app.delete('/api/projets/:id/albums/:aid', exigerConnexion, (req, res) => {
    const p = projetOuvert(req, res);
    if (!p) return;
    const a = albumDe(p.id, Number(req.params.aid));
    if (!a || (a.cree_par !== req.utilisateur.id && req.utilisateur.role !== 'bureau')) {
      return res.status(404).json({ erreur: 'Dossier de photos introuvable.' });
    }
    db.prepare('UPDATE projet_fichiers SET album_id = NULL WHERE album_id = ?').run(a.id);
    db.prepare('UPDATE projet_messages SET album_id = NULL WHERE album_id = ?').run(a.id);
    db.prepare('DELETE FROM projet_albums WHERE id = ?').run(a.id);
    res.status(204).end();
  });

  // Range des photos dans un sous-dossier (album_id null : les remet dans « Non classées »).
  app.post('/api/projets/:id/albums/ranger', exigerConnexion, (req, res) => {
    const p = projetOuvert(req, res);
    if (!p) return;
    const { album_id: albumId, photos } = req.body || {};
    const album = albumId == null ? null : albumDe(p.id, Number(albumId));
    if (albumId != null && !album) return res.status(404).json({ erreur: 'Dossier de photos introuvable.' });
    if (!Array.isArray(photos) || !photos.length || photos.length > 500) return res.status(400).json({ erreur: 'Choisis au moins une photo.' });
    const fichier = db.prepare("UPDATE projet_fichiers SET album_id = ? WHERE id = ? AND projet_id = ? AND dossier = 'photos'");
    const message = db.prepare('UPDATE projet_messages SET album_id = ? WHERE id = ? AND projet_id = ? AND fichier IS NOT NULL');
    let ranges = 0;
    for (const ph of photos) {
      const requete = ph?.source === 'discussion' ? message : fichier;
      ranges += Number(requete.run(album?.id ?? null, Number(ph?.id), p.id).changes);
    }
    res.json({ ranges });
  });

  // Scanner : le téléphone envoie les pages photographiées (JPEG), le serveur en fait un PDF du dossier Documents.
  const scan = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 30 },
    fileFilter: (_req, f, cb) => cb(null, f.mimetype === 'image/jpeg'),
  });
  app.post('/api/projets/:id/scanner', exigerConnexion, scan.array('pages', 30), (req, res) => {
    const p = projet(Number(req.params.id));
    if (!visible(p, req.utilisateur) || !p.actif) return res.status(404).json({ erreur: 'Projet introuvable.' });
    if (!req.files?.length) return res.status(400).json({ erreur: 'Prends au moins une page en photo.' });
    let pdf;
    try {
      pdf = pdfDePages(req.files.map((f) => f.buffer));
    } catch (e) {
      return res.status(400).json({ erreur: e.message });
    }
    const date = new Date().toISOString().slice(0, 10);
    const nom = `${(texte(req.body?.nom, 150) || `Document scanné ${date}`).replace(/[\\/:*?"<>|]/g, '-').replace(/\.pdf$/i, '')}.pdf`;
    const fichier = `${crypto.randomUUID()}.pdf`;
    fs.writeFileSync(path.join(dossier, fichier), pdf);
    const { lastInsertRowid } = db.prepare(`INSERT INTO projet_fichiers
      (projet_id, auteur_id, dossier, fichier, nom_original, type_mime, taille) VALUES (?, ?, 'documents', ?, ?, 'application/pdf', ?)`)
      .run(p.id, req.utilisateur.id, fichier, nom, pdf.length);
    db.prepare("UPDATE projets SET maj_le = datetime('now') WHERE id = ?").run(p.id);
    res.status(201).json({ fichier: { id: Number(lastInsertRowid), nom_original: nom, pages: req.files.length } });
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
