import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ouvrirBase } from './src/db.js';
import { creerApp } from './src/app.js';
import { creerQuickBooks } from './src/quickbooks.js';
import { creerLecteur } from './src/extraction.js';

const ici = path.dirname(fileURLToPath(import.meta.url));
const dossierDonnees = process.env.DOSSIER_DONNEES || path.join(ici, 'donnees');
const production = process.env.NODE_ENV === 'production';

if (production && !process.env.CODE_INSTALLATION) {
  console.error('CODE_INSTALLATION est requis en production pour protéger la création du compte du bureau.');
  process.exit(1);
}
if (process.env.QBO_CLIENT_ID && !process.env.CLE_SECRETE) {
  console.error('CLE_SECRETE est requise pour protéger les jetons QuickBooks.');
  process.exit(1);
}

const db = ouvrirBase(path.join(dossierDonnees, 'app.db'));
const qbo = creerQuickBooks(db, {
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  urlRetour: process.env.QBO_URL_RETOUR,
  environnement: process.env.QBO_ENVIRONNEMENT === 'production' ? 'production' : 'sandbox',
  cleSecrete: process.env.CLE_SECRETE,
});
const lecteur = creerLecteur();

const app = creerApp({
  db, qbo, lecteur, production,
  codeInstallation: process.env.CODE_INSTALLATION || null,
  dossierFichiers: path.join(dossierDonnees, 'factures'),
  dossierPublic: path.join(ici, 'public'),
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`App employés : http://localhost:${port}`);
  console.log(`QuickBooks : ${qbo.mode === 'demo' ? 'mode démo (rien n\'est envoyé)' : qbo.mode}`);
  console.log(`Lecture automatique des factures : ${lecteur.actif ? 'active' : 'inactive (saisie manuelle)'}`);
});
