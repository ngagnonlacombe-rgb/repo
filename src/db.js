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

    CREATE TABLE IF NOT EXISTS reglages (
      cle TEXT PRIMARY KEY,
      valeur TEXT NOT NULL
    );
  `);
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
