// Messagerie : chaque employé a une conversation privée avec le bureau ; tous les comptes bureau la lisent et y répondent.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exigerConnexion, exigerBureau } from './auth.js';

const PHOTOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };

export function brancherMessagerie(app, { db, dossierFichiers }) {
  const dossier = path.join(dossierFichiers, 'messages');
  fs.mkdirSync(dossier, { recursive: true });
  const televersement = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (_req, f, cb) => cb(null, Boolean(PHOTOS[f.mimetype])),
  });

  const avecAuteur = `SELECT m.id, m.employe_id, m.auteur_id, m.texte, m.cree_le, m.lu, m.fichier IS NOT NULL AS photo,
                             u.nom AS auteur, u.role = 'bureau' AS du_bureau
                      FROM messages_bureau m JOIN utilisateurs u ON u.id = m.auteur_id`;
  const employe = (id) => db.prepare("SELECT id, nom, actif FROM utilisateurs WHERE id = ? AND role = 'employe'").get(id);

  // Un message est « non lu » tant que l'autre côté n'a pas ouvert la conversation.
  const lire = (employeId, apres, lecteurBureau) => {
    db.prepare(`UPDATE messages_bureau SET lu = 1 WHERE employe_id = ? AND lu = 0
      AND auteur_id IN (SELECT id FROM utilisateurs WHERE role = ?)`).run(employeId, lecteurBureau ? 'employe' : 'bureau');
    return db.prepare(`${avecAuteur} WHERE m.employe_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT 300`)
      .all(employeId, apres).reverse();
  };

  const envoyer = (req, res, employeId) => {
    const texte = String(req.body?.texte ?? '').trim().slice(0, 4000) || null;
    if (!texte && !req.file) return res.status(400).json({ erreur: 'Écris un message ou ajoute une photo.' });
    let fichier = null;
    if (req.file) {
      fichier = `${crypto.randomUUID()}.${PHOTOS[req.file.mimetype]}`;
      fs.writeFileSync(path.join(dossier, fichier), req.file.buffer);
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO messages_bureau (employe_id, auteur_id, texte, fichier, type_mime)
      VALUES (?, ?, ?, ?, ?)`).run(employeId, req.utilisateur.id, texte, fichier, req.file?.mimetype ?? null);
    res.status(201).json({ message: db.prepare(`${avecAuteur} WHERE m.id = ?`).get(Number(lastInsertRowid)) });
  };

  // Pastille du menu : messages reçus et pas encore lus.
  app.get('/api/messagerie/non-lus', exigerConnexion, (req, res) => {
    const bureau = req.utilisateur.role === 'bureau';
    const { n } = bureau
      ? db.prepare(`SELECT COUNT(*) AS n FROM messages_bureau m JOIN utilisateurs u ON u.id = m.auteur_id
          WHERE m.lu = 0 AND u.role = 'employe'`).get()
      : db.prepare(`SELECT COUNT(*) AS n FROM messages_bureau m JOIN utilisateurs u ON u.id = m.auteur_id
          WHERE m.lu = 0 AND u.role = 'bureau' AND m.employe_id = ?`).get(req.utilisateur.id);
    res.json({ nonLus: n });
  });

  // Employé : sa conversation avec le bureau.
  app.get('/api/messagerie', exigerConnexion, (req, res) => {
    if (req.utilisateur.role === 'bureau') return res.status(400).json({ erreur: 'Choisis un employé.' });
    res.json({ messages: lire(req.utilisateur.id, Number(req.query.apres) || 0, false) });
  });

  app.post('/api/messagerie', exigerConnexion, televersement.single('photo'), (req, res) => {
    if (req.utilisateur.role === 'bureau') return res.status(400).json({ erreur: 'Choisis un employé.' });
    envoyer(req, res, req.utilisateur.id);
  });

  // Bureau : liste des conversations, avec le dernier message et le nombre de non-lus.
  app.get('/api/bureau/messagerie', exigerConnexion, exigerBureau, (_req, res) => {
    const conversations = db.prepare(`
      SELECT u.id, u.nom, u.actif,
             (SELECT COUNT(*) FROM messages_bureau m JOIN utilisateurs a ON a.id = m.auteur_id
                WHERE m.employe_id = u.id AND m.lu = 0 AND a.role = 'employe') AS non_lus,
             d.texte AS dernier_texte, d.fichier IS NOT NULL AS dernier_photo, d.cree_le AS dernier_le
      FROM utilisateurs u
      LEFT JOIN messages_bureau d ON d.id = (SELECT MAX(id) FROM messages_bureau WHERE employe_id = u.id)
      WHERE u.role = 'employe' AND (u.actif = 1 OR d.id IS NOT NULL)
      ORDER BY d.id IS NULL, d.id DESC, u.nom`).all();
    res.json({ conversations });
  });

  app.get('/api/bureau/messagerie/:employe', exigerConnexion, exigerBureau, (req, res) => {
    const e = employe(Number(req.params.employe));
    if (!e) return res.status(404).json({ erreur: 'Employé introuvable.' });
    res.json({ employe: e, messages: lire(e.id, Number(req.query.apres) || 0, true) });
  });

  app.post('/api/bureau/messagerie/:employe', exigerConnexion, exigerBureau, televersement.single('photo'), (req, res) => {
    const e = employe(Number(req.params.employe));
    if (!e) return res.status(404).json({ erreur: 'Employé introuvable.' });
    envoyer(req, res, e.id);
  });

  app.get('/api/messagerie/:mid/photo', exigerConnexion, (req, res) => {
    const m = db.prepare('SELECT * FROM messages_bureau WHERE id = ?').get(Number(req.params.mid));
    const permis = m && (req.utilisateur.role === 'bureau' || m.employe_id === req.utilisateur.id);
    if (!permis || !m.fichier) return res.status(404).json({ erreur: 'Photo introuvable.' });
    res.type(m.type_mime).set('Cache-Control', 'private, max-age=86400')
      .sendFile(path.join(dossier, m.fichier), { dotfiles: 'deny' });
  });

  // Chacun peut effacer ses propres messages.
  app.delete('/api/messagerie/:mid', exigerConnexion, (req, res) => {
    const m = db.prepare('SELECT * FROM messages_bureau WHERE id = ? AND auteur_id = ?').get(Number(req.params.mid), req.utilisateur.id);
    if (!m) return res.status(404).json({ erreur: 'Message introuvable.' });
    db.prepare('DELETE FROM messages_bureau WHERE id = ?').run(m.id);
    if (m.fichier) fs.rm(path.join(dossier, m.fichier), { force: true }, () => {});
    res.status(204).end();
  });
}
