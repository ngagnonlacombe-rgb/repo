# Vapro GUS

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
npm test           # 20 tests (parcours complet, QuickBooks, lecture, installation)
```

Au premier démarrage, l'app demande de créer le compte du bureau.

## Brancher les vrais services

Toutes les clés vont dans le fichier `.env` du serveur (voir `.env.example`), jamais dans le code ni dans un message.

1. **Lecture automatique** : une clé API Anthropic dans `ANTHROPIC_API_KEY`.
2. **QuickBooks, compagnie de test** : sur developer.intuit.com, crée une app (« QuickBooks Online and Payments »), ajoute l'adresse de retour `https://<ton domaine>/api/qbo/retour`, copie les clés de développement dans `QBO_CLIENT_ID` et `QBO_CLIENT_SECRET`, garde `QBO_ENVIRONNEMENT=sandbox`. Dans l'app, onglet « À approuver », clique « Connecter QuickBooks ».
3. **QuickBooks réel** : quand tout est validé sur la compagnie de test, Intuit demande de remplir un court questionnaire pour obtenir les clés de production. On remplace alors les clés, on met `QBO_ENVIRONNEMENT=production` et on reconnecte.

## Taxes

La facture est créée dans QuickBooks avec le montant avant taxes et le code de taxe choisi (par défaut celui qui contient « TVQ »). QuickBooks calcule la TPS et la TVQ lui-même, comme lors d'une saisie manuelle. L'écran d'approbation avertit si avant taxes + TPS + TVQ ne correspond pas au total lu sur la facture.

## Mise en ligne (Fly.io, Toronto)

Chaque changement sur `main` lance les tests puis déploie l'app sur Fly.io (`.github/workflows/deployer.yml`, configuration dans `fly.toml`). Un seul petit serveur à Toronto, avec un disque de 1 Go pour la base et les photos. La machine s'endort quand personne ne s'en sert.

Pour l'activer, une seule fois :

1. Crée un compte sur fly.io.
2. Dans le tableau de bord Fly.io, menu **Tokens**, crée un jeton d'organisation et copie-le au complet (il commence par `FlyV1 `).
3. Sur GitHub, dans **Settings > Secrets and variables > Actions**, ajoute deux secrets :
   - `FLY_API_TOKEN` : le jeton copié à l'étape 2.
   - `CODE_INSTALLATION` : un mot de passe de ton choix, demandé une seule fois pour créer le compte du bureau.
4. Dans l'onglet **Actions** du dépôt, relance « Tests et déploiement ». L'app sera à `https://app-employes-ngl.fly.dev`.

Au premier déploiement, le flux crée l'app, le disque et la clé de chiffrement des jetons QuickBooks. Les clés QuickBooks et Anthropic s'ajoutent ensuite comme secrets Fly.io.

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
