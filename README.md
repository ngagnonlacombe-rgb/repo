# App employés

App web pour cellulaire : les employés déposent leurs factures de matériaux (photo ou PDF), le bureau les approuve, et chaque facture approuvée devient une facture à payer dans QuickBooks Online, avec la photo jointe. Le punch Agendrix viendra à l'étape 3.

## Ce que fait l'app

**Employé**
- Se connecte avec son identifiant et son NIP.
- Prend la facture en photo. L'app lit le fournisseur, la date, le numéro, le sous-total, la TPS, la TVQ et le total.
- Vérifie, corrige au besoin, ajoute une note et envoie au bureau.
- Voit le statut de ses factures (en attente, approuvée, refusée avec la raison) et peut corriger une facture refusée.

**Bureau**
- Voit les factures en attente, la photo à côté des montants.
- Choisit le fournisseur QuickBooks (reconnu automatiquement quand le nom correspond), la catégorie de dépense (l'app retient la dernière utilisée pour chaque fournisseur) et le code de taxe.
- Approuve : la facture à payer est créée dans QuickBooks avec la photo en pièce jointe. Ou refuse avec une raison.
- Ajoute, désactive des employés et change leur NIP.

## Essayer en mode démo

Sans aucune clé, QuickBooks est simulé et la lecture automatique est désactivée (l'employé tape les montants).

```bash
npm install
npm start          # http://localhost:3000
npm test           # 19 tests (parcours complet, QuickBooks, lecture)
```

Au premier démarrage, l'app demande de créer le compte du bureau.

## Brancher les vrais services

Toutes les clés vont dans le fichier `.env` du serveur (voir `.env.example`), jamais dans le code ni dans un message.

1. **Lecture automatique** : une clé API Anthropic dans `ANTHROPIC_API_KEY`.
2. **QuickBooks, compagnie de test** : sur developer.intuit.com, crée une app (« QuickBooks Online and Payments »), ajoute l'adresse de retour `https://<ton domaine>/api/qbo/retour`, copie les clés de développement dans `QBO_CLIENT_ID` et `QBO_CLIENT_SECRET`, garde `QBO_ENVIRONNEMENT=sandbox`. Dans l'app, onglet « À approuver », clique « Connecter QuickBooks ».
3. **QuickBooks réel** : quand tout est validé sur la compagnie de test, Intuit demande de remplir un court questionnaire pour obtenir les clés de production. On remplace alors les clés, on met `QBO_ENVIRONNEMENT=production` et on reconnecte.

## Taxes

La facture est créée dans QuickBooks avec le montant avant taxes et le code de taxe choisi (par défaut celui qui contient « TVQ »). QuickBooks calcule la TPS et la TVQ lui-même, comme lors d'une saisie manuelle. L'écran d'approbation avertit si avant taxes + TPS + TVQ ne correspond pas au total lu sur la facture.

## Hébergement

Un seul petit serveur Node.js (version 22.5 ou plus) avec un disque persistant pour `DOSSIER_DONNEES` (base SQLite et photos). Le `Dockerfile` fonctionne chez la plupart des hébergeurs. Choisir une région au Canada (par exemple Toronto ou Montréal) pour la Loi 25, et un domaine en HTTPS (obligatoire pour QuickBooks).

## Organisation du code

| Fichier | Rôle |
|---|---|
| `server.js` | Démarrage, lecture de la configuration |
| `src/app.js` | Toutes les routes : connexion, dépôt, approbation, employés, QuickBooks |
| `src/quickbooks.js` | Connexion OAuth, fournisseurs, comptes, codes de taxe, création de facture et pièce jointe ; mode démo |
| `src/extraction.js` | Lecture de la facture avec Claude |
| `src/auth.js`, `src/db.js` | Comptes, sessions, base SQLite |
| `public/` | Écrans (installable sur le cellulaire comme une app) |
| `test/` | Tests du parcours complet et du client QuickBooks |
