// Connexion à QuickBooks Online (OAuth 2.0) et création des factures à payer (« Bill »).
// Sans QBO_CLIENT_ID, un mode démo imite QuickBooks pour tester l'app sans toucher à tes comptes.
import crypto from 'node:crypto';
import { lireReglage, ecrireReglage } from './db.js';

const URL_AUTORISATION = 'https://appcenter.intuit.com/connect/oauth2';
const URL_JETONS = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const URL_REVOCATION = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};
const VERSION_MINEURE = 75;

// --- Chiffrement des jetons au repos (AES-256-GCM, clé dérivée de CLE_SECRETE) ---
function chiffreur(cleSecrete) {
  const cle = crypto.createHash('sha256').update(cleSecrete).digest();
  return {
    chiffrer(objet) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', cle, iv);
      const donnees = Buffer.concat([c.update(JSON.stringify(objet), 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), donnees].map((b) => b.toString('base64')).join('.');
    },
    dechiffrer(texte) {
      const [iv, tag, donnees] = texte.split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', cle, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(donnees), d.final()]).toString('utf8'));
    },
  };
}

export function creerQuickBooks(db, config) {
  if (!config.clientId) return creerQuickBooksDemo();

  const { clientId, clientSecret, urlRetour, environnement = 'sandbox', cleSecrete } = config;
  const coffre = chiffreur(cleSecrete);
  const base = API[environnement];
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const lireJetons = () => {
    const brut = lireReglage(db, 'qbo_jetons');
    return brut ? coffre.dechiffrer(brut) : null;
  };
  const ecrireJetons = (j) => ecrireReglage(db, 'qbo_jetons', coffre.chiffrer(j));

  async function demanderJetons(corps) {
    const rep = await fetch(URL_JETONS, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(corps),
    });
    if (!rep.ok) throw new Error(`QuickBooks a refusé l'autorisation (${rep.status}).`);
    return rep.json();
  }

  async function jetonAcces() {
    const j = lireJetons();
    if (!j) throw new ErreurQbo('QuickBooks n\'est pas connecté.');
    if (Date.now() < j.expireA - 60_000) return j;
    const neuf = await demanderJetons({ grant_type: 'refresh_token', refresh_token: j.refresh });
    const maj = { ...j, acces: neuf.access_token, refresh: neuf.refresh_token, expireA: Date.now() + neuf.expires_in * 1000 };
    ecrireJetons(maj);
    return maj;
  }

  async function appel(chemin, { method = 'GET', corps, formulaire } = {}) {
    const j = await jetonAcces();
    const sep = chemin.includes('?') ? '&' : '?';
    const rep = await fetch(`${base}/v3/company/${j.realmId}/${chemin}${sep}minorversion=${VERSION_MINEURE}`, {
      method,
      headers: {
        Authorization: `Bearer ${j.acces}`,
        Accept: 'application/json',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : formulaire,
    });
    const json = await rep.json().catch(() => ({}));
    if (!rep.ok) {
      const detail = json?.Fault?.Error?.[0];
      throw new ErreurQbo(detail ? `${detail.Message} : ${detail.Detail}` : `Erreur QuickBooks (${rep.status}).`);
    }
    return json;
  }

  const requete = async (sql) => (await appel(`query?query=${encodeURIComponent(sql)}`)).QueryResponse || {};

  return {
    mode: environnement,
    connecte: () => Boolean(lireJetons()),

    urlConnexion(etat) {
      const p = new URLSearchParams({
        client_id: clientId, response_type: 'code', scope: 'com.intuit.quickbooks.accounting',
        redirect_uri: urlRetour, state: etat,
      });
      return `${URL_AUTORISATION}?${p}`;
    },

    async terminerConnexion(code, realmId) {
      const j = await demanderJetons({ grant_type: 'authorization_code', code, redirect_uri: urlRetour });
      ecrireJetons({ realmId, acces: j.access_token, refresh: j.refresh_token, expireA: Date.now() + j.expires_in * 1000 });
    },

    async deconnecter() {
      const j = lireJetons();
      if (j) {
        await fetch(URL_REVOCATION, {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: j.refresh }),
        }).catch(() => {});
      }
      db.prepare("DELETE FROM reglages WHERE cle = 'qbo_jetons'").run();
    },

    async fournisseurs() {
      const r = await requete('select Id, DisplayName from Vendor where Active = true maxresults 1000');
      return (r.Vendor || []).map((v) => ({ id: v.Id, nom: v.DisplayName })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    },

    async comptes() {
      const r = await requete("select Id, Name, AccountType from Account where Active = true and Classification in ('Expense', 'Asset') maxresults 1000");
      return (r.Account || [])
        .filter((c) => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Fixed Asset'].includes(c.AccountType))
        .map((c) => ({ id: c.Id, nom: c.Name })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    },

    async codesTaxe() {
      // Une facture fournisseur exige un code avec un taux d'achat : les codes « ventes seulement »
      // font échouer QuickBooks (« error while calculating tax »).
      const r = await requete('select * from TaxCode where Active = true');
      const tpsEtTvq = (nom) => /tps|gst/i.test(nom) && /tvq|qst/i.test(nom);
      return (r.TaxCode || [])
        .filter((t) => t.PurchaseTaxRateList?.TaxRateDetail?.length)
        .map((t) => ({ id: t.Id, nom: t.Name }))
        .sort((a, b) => tpsEtTvq(b.nom) - tpsEtTvq(a.nom));
    },

    async creerFournisseur(nom) {
      const r = await appel('vendor', { method: 'POST', corps: { DisplayName: nom } });
      return { id: r.Vendor.Id, nom: r.Vendor.DisplayName };
    },

    async creerFactureAPayer(f) {
      const corps = {
        VendorRef: { value: f.fournisseurId },
        TxnDate: f.date,
        GlobalTaxCalculation: 'TaxExcluded',
        PrivateNote: f.note,
        Line: [{
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: f.sousTotal,
          Description: f.description,
          AccountBasedExpenseLineDetail: { AccountRef: { value: f.compteId }, TaxCodeRef: { value: f.codeTaxeId } },
        }],
      };
      if (f.numero) corps.DocNumber = String(f.numero).slice(0, 21);
      const r = await appel('bill', { method: 'POST', corps });
      return { id: r.Bill.Id, total: r.Bill.TotalAmt };
    },

    async joindreFichier(factureQboId, { contenu, typeMime, nomFichier }) {
      const formulaire = new FormData();
      formulaire.append('file_metadata_01', new Blob([JSON.stringify({
        AttachableRef: [{ EntityRef: { type: 'Bill', value: factureQboId } }],
        FileName: nomFichier, ContentType: typeMime,
      })], { type: 'application/json' }), 'metadata.json');
      formulaire.append('file_content_01', new Blob([contenu], { type: typeMime }), nomFichier);
      await appel('upload', { method: 'POST', formulaire });
    },
  };
}

export class ErreurQbo extends Error {}

// --- Mode démo : mêmes fonctions, données fictives, rien n'est envoyé ---
export function creerQuickBooksDemo() {
  const fournisseurs = ['BMR', 'Canac', 'Home Depot', 'Patrick Morin', 'RONA'].map((nom, i) => ({ id: String(i + 1), nom }));
  const comptes = [
    'Matériaux et fournitures', 'Coût des marchandises vendues', 'Frais de véhicule', 'Frais de bureau / Fournitures',
    "Location d'équipement", 'Réparations et entretien', 'Outillage (petit équipement)',
  ].map((nom, i) => ({ id: String(100 + i), nom }));
  const codesTaxe = [{ id: 'T1', nom: 'TPS/TVQ QC - 9,975' }, { id: 'T2', nom: 'Exonéré' }];
  const creees = [];
  let suivant = 1;

  return {
    mode: 'demo',
    connecte: () => true,
    creees,
    async fournisseurs() { return [...fournisseurs]; },
    async comptes() { return [...comptes]; },
    async codesTaxe() { return [...codesTaxe]; },
    async creerFournisseur(nom) {
      const f = { id: String(fournisseurs.length + 1), nom };
      fournisseurs.push(f);
      return f;
    },
    async creerFactureAPayer(f) {
      const id = `DEMO-${suivant++}`;
      creees.push({ id, ...f });
      return { id, total: f.total };
    },
    async joindreFichier() {},
  };
}
