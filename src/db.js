// Base de données SQLite (module intégré à Node 22, aucun service externe requis).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function ouvrirBase(fichier) {
  if (fichier !== ':memory:') fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const db = new DatabaseSync(fichier);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS utilisateurs (
      id INTEGER PRIMARY KEY,
      nom TEXT NOT NULL,
      identifiant TEXT NOT NULL UNIQUE COLLATE NOCASE,
      hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('employe', 'bureau')),
      actif INTEGER NOT NULL DEFAULT 1,
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      jeton TEXT PRIMARY KEY,
      utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      expire_le TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS factures (
      id INTEGER PRIMARY KEY,
      employe_id INTEGER NOT NULL REFERENCES utilisateurs(id),
      fichier TEXT NOT NULL,
      type_mime TEXT NOT NULL,
      nom_original TEXT,
      statut TEXT NOT NULL DEFAULT 'brouillon'
        CHECK (statut IN ('brouillon', 'en_attente', 'approuvee', 'refusee')),
      fournisseur TEXT,
      numero TEXT,
      date_facture TEXT,
      sous_total REAL,
      tps REAL,
      tvq REAL,
      total REAL,
      note TEXT,
      lecture_auto TEXT,
      raison_refus TEXT,
      qbo_facture_id TEXT,
      qbo_piece_jointe INTEGER NOT NULL DEFAULT 0,
      traitee_par INTEGER REFERENCES utilisateurs(id),
      cree_le TEXT NOT NULL DEFAULT (datetime('now')),
      maj_le TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projets (
      id INTEGER PRIMARY KEY,
      nom TEXT NOT NULL,
      adresse TEXT,
      notes TEXT,
      actif INTEGER NOT NULL DEFAULT 1,
      cree_par INTEGER REFERENCES utilisateurs(id),
      cree_le TEXT NOT NULL DEFAULT (datetime('now')),
      maj_le TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projet_messages (
      id INTEGER PRIMARY KEY,
      projet_id INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
      auteur_id INTEGER NOT NULL REFERENCES utilisateurs(id),
      texte TEXT,
      fichier TEXT,
      type_mime TEXT,
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS projet_messages_projet ON projet_messages (projet_id, id);

    CREATE TABLE IF NOT EXISTS projet_fichiers (
      id INTEGER PRIMARY KEY,
      projet_id INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
      auteur_id INTEGER NOT NULL REFERENCES utilisateurs(id),
      dossier TEXT NOT NULL CHECK (dossier IN ('photos', 'documents')),
      fichier TEXT NOT NULL,
      nom_original TEXT,
      type_mime TEXT NOT NULL,
      taille INTEGER NOT NULL,
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS projet_fichiers_projet ON projet_fichiers (projet_id, dossier, id);

    -- Sous-dossiers du dossier Photos (ex. « Avant », « Toiture »), créés et renommés par l'équipe.
    CREATE TABLE IF NOT EXISTS projet_albums (
      id INTEGER PRIMARY KEY,
      projet_id INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
      nom TEXT NOT NULL,
      cree_par INTEGER NOT NULL REFERENCES utilisateurs(id),
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Messagerie privée : une conversation par employé avec le bureau (tous les comptes bureau la voient).
    CREATE TABLE IF NOT EXISTS messages_bureau (
      id INTEGER PRIMARY KEY,
      employe_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      auteur_id INTEGER NOT NULL REFERENCES utilisateurs(id),
      texte TEXT,
      fichier TEXT,
      type_mime TEXT,
      lu INTEGER NOT NULL DEFAULT 0,
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS messages_bureau_employe ON messages_bureau (employe_id, id);

    CREATE TABLE IF NOT EXISTS push_abonnements (
      id INTEGER PRIMARY KEY,
      utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Punchs : début et fin de quart (UTC). Un seul quart ouvert (fin NULL) par employé.
    CREATE TABLE IF NOT EXISTS punchs (
      id INTEGER PRIMARY KEY,
      employe_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      debut TEXT NOT NULL,
      fin TEXT,
      note TEXT,
      modifie_par INTEGER REFERENCES utilisateurs(id),
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS punchs_employe ON punchs (employe_id, debut);
    CREATE UNIQUE INDEX IF NOT EXISTS punchs_un_seul_ouvert ON punchs (employe_id) WHERE fin IS NULL;

    -- Banque d'heures, vacances et maladie : congés pris (heures négatives) et ajustements du bureau.
    CREATE TABLE IF NOT EXISTS heures_mouvements (
      id INTEGER PRIMARY KEY,
      employe_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('banque', 'vacances', 'maladie')),
      heures REAL NOT NULL,
      date TEXT NOT NULL,
      note TEXT,
      cree_par INTEGER REFERENCES utilisateurs(id),
      cree_le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS heures_mouvements_employe ON heures_mouvements (employe_id, date);

    -- Jours où le dîner (normalement non payé) est payé parce que l'employé n'a pas dîné.
    CREATE TABLE IF NOT EXISTS diners_payes (
      employe_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      jour TEXT NOT NULL,
      par INTEGER REFERENCES utilisateurs(id),
      PRIMARY KEY (employe_id, jour)
    );

    CREATE TABLE IF NOT EXISTS reglages (
      cle TEXT PRIMARY KEY,
      valeur TEXT NOT NULL
    );
  `);
  // Taux de vacances propre à un employé (ex. 6 % après 3 ans) ; NULL = taux par défaut des règles.
  if (!db.prepare('PRAGMA table_info(utilisateurs)').all().some((c) => c.name === 'taux_vacances')) {
    db.exec('ALTER TABLE utilisateurs ADD COLUMN taux_vacances REAL');
  }
  // Chargé de projet : un employé qui peut créer des projets.
  if (!db.prepare('PRAGMA table_info(utilisateurs)').all().some((c) => c.name === 'chef_projet')) {
    db.exec('ALTER TABLE utilisateurs ADD COLUMN chef_projet INTEGER NOT NULL DEFAULT 0');
  }
  // Bases déjà en service : une photo (déposée ou envoyée dans la discussion) peut être rangée dans un sous-dossier.
  for (const table of ['projet_fichiers', 'projet_messages']) {
    const colonnes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!colonnes.includes('album_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN album_id INTEGER REFERENCES projet_albums(id) ON DELETE SET NULL`);
    }
  }
  return db;
}

export function lireReglage(db, cle) {
  const ligne = db.prepare('SELECT valeur FROM reglages WHERE cle = ?').get(cle);
  return ligne ? JSON.parse(ligne.valeur) : null;
}

export function ecrireReglage(db, cle, valeur) {
  db.prepare(`INSERT INTO reglages (cle, valeur) VALUES (?, ?)
              ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`).run(cle, JSON.stringify(valeur));
}
