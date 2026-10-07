// Client QuickBooks réel, avec un faux serveur Intuit (aucun appel réseau).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase, lireReglage } from '../src/db.js';
import { creerQuickBooks, ErreurQbo } from '../src/quickbooks.js';

function fauxIntuit() {
  const appels = [];
  let numeroJeton = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const corps = typeof init.body === 'string' ? init.body : init.body;
    appels.push({ url: u, init, corps });
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'oauth.platform.intuit.com') {
      numeroJeton += 1;
      return json(200, { access_token: `acces-${numeroJeton}`, refresh_token: `refresh-${numeroJeton}`, expires_in: 3600 });
    }
    if (u.pathname.endsWith('/bill')) {
      const bill = JSON.parse(corps);
      if (!bill.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef?.value) {
        return json(400, { Fault: { Error: [{ Message: 'Business Validation Error', Detail: 'TaxCode requis' }] } });
      }
      return json(200, { Bill: { Id: '901', TotalAmt: 114.98 } });
    }
    if (u.pathname.endsWith('/query') && /TaxCode/.test(u.searchParams.get('query'))) {
      const achat = { TaxRateDetail: [{ TaxRateRef: { value: '9' } }] };
      return json(200, { QueryResponse: { TaxCode: [
        { Id: '3', Name: 'QST QC - 9.975 (ventes)', SalesTaxRateList: achat, PurchaseTaxRateList: { TaxRateDetail: [] } },
        { Id: '5', Name: 'Exempt', PurchaseTaxRateList: achat },
        { Id: '7', Name: 'GST/QST QC - 9.975', SalesTaxRateList: achat, PurchaseTaxRateList: achat },
      ] } });
    }
    if (u.pathname.endsWith('/query')) return json(200, { QueryResponse: { Vendor: [{ Id: '2', DisplayName: 'RONA' }, { Id: '1', DisplayName: 'BMR' }] } });
    if (u.pathname.endsWith('/upload')) return json(200, { AttachableResponse: [{}] });
    return json(404, {});
  };
  return appels;
}

const config = { clientId: 'cid', clientSecret: 'secret', urlRetour: 'https://app.exemple.ca/api/qbo/retour', environnement: 'sandbox', cleSecrete: 'cle-de-test' };

test('connexion, jetons chiffrés en base, création de facture à payer et pièce jointe', async () => {
  const appels = fauxIntuit();
  const db = ouvrirBase(':memory:');
  const qbo = creerQuickBooks(db, config);

  assert.equal(qbo.connecte(), false);
  const url = new URL(qbo.urlConnexion('etat123'));
  assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(url.searchParams.get('state'), 'etat123');

  await qbo.terminerConnexion('code-abc', '4620816365');
  assert.equal(qbo.connecte(), true);
  const brut = lireReglage(db, 'qbo_jetons');
  assert.ok(!brut.includes('refresh-1') && !brut.includes('acces-1'), 'les jetons ne sont pas en clair');

  const fournisseurs = await qbo.fournisseurs();
  assert.deepEqual(fournisseurs.map((f) => f.nom), ['BMR', 'RONA']);
  const requete = appels.at(-1);
  assert.equal(requete.url.hostname, 'sandbox-quickbooks.api.intuit.com');
  assert.match(requete.url.pathname, /\/v3\/company\/4620816365\/query$/);
  assert.equal(requete.init.headers.Authorization, 'Bearer acces-1');

  const r = await qbo.creerFactureAPayer({
    fournisseurId: '2', compteId: '100', codeTaxeId: '7', date: '2026-10-01', numero: 'A-123',
    sousTotal: 100, total: 114.98, description: 'Matériaux', note: 'Déposée par Marc',
  });
  assert.equal(r.id, '901');
  const bill = JSON.parse(appels.at(-1).corps);
  assert.equal(bill.VendorRef.value, '2');
  assert.equal(bill.GlobalTaxCalculation, 'TaxExcluded');
  assert.equal(bill.DocNumber, 'A-123');
  assert.equal(bill.Line[0].Amount, 100);
  assert.equal(bill.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, '100');

  await qbo.joindreFichier('901', { contenu: Buffer.from('x'), typeMime: 'image/png', nomFichier: 'facture-1.png' });
  const envoi = appels.at(-1);
  assert.match(envoi.url.pathname, /\/upload$/);
  const meta = JSON.parse(await envoi.corps.get('file_metadata_01').text());
  assert.deepEqual(meta.AttachableRef[0].EntityRef, { type: 'Bill', value: '901' });
});

test('le jeton expiré est renouvelé automatiquement', async () => {
  const appels = fauxIntuit();
  const db = ouvrirBase(':memory:');
  const qbo = creerQuickBooks(db, config);
  await qbo.terminerConnexion('code', '1');
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + 2 * 3600 * 1000;
  try {
    await qbo.fournisseurs();
  } finally {
    Date.now = realDateNow;
  }
  const renouvellement = appels.find((a) => a.url.hostname === 'oauth.platform.intuit.com' && String(a.corps).includes('refresh_token'));
  assert.ok(renouvellement, 'demande de renouvellement envoyée');
  assert.equal(appels.at(-1).init.headers.Authorization, 'Bearer acces-2');
});

test('une erreur QuickBooks remonte avec son message', async () => {
  fauxIntuit();
  const db = ouvrirBase(':memory:');
  const qbo = creerQuickBooks(db, config);
  await qbo.terminerConnexion('code', '1');
  await assert.rejects(
    qbo.creerFactureAPayer({ fournisseurId: '1', compteId: '1', codeTaxeId: undefined, date: '2026-10-01', sousTotal: 1 }),
    (e) => e instanceof ErreurQbo && /TaxCode requis/.test(e.message),
  );
});

test("seuls les codes de taxe valides pour un achat sont proposés, TPS + TVQ en premier", async () => {
  fauxIntuit();
  const db = ouvrirBase(':memory:');
  const qbo = creerQuickBooks(db, config);
  await qbo.terminerConnexion('code', '1');
  assert.deepEqual((await qbo.codesTaxe()).map((t) => t.id), ['7', '5']);
});
