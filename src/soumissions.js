// Soumissions : les personnes à qui le bureau a donné l'accès préparent des soumissions pour les clients
// et les envoient en PDF. Taxes du Québec : TPS 5 % et TVQ 9,975 % sur le sous-total.
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { exigerConnexion } from './auth.js';
import { lireReglage, ecrireReglage } from './db.js';

export const TAUX_TPS = 0.05;
export const TAUX_TVQ = 0.09975;
const STATUTS = ['brouillon', 'envoyee', 'acceptee', 'refusee'];
const LOGO = fileURLToPath(new URL('../public/logo-gus-512.png', import.meta.url));

const ENTREPRISE_DEFAUT = {
  nom: 'GUS Urgence Sinistre', adresse: '', telephone: '', courriel: '', site: '', rbq: '', tps: '', tvq: '',
  conditions: 'Soumission valide pour la durée indiquée. Les travaux non prévus à la présente soumission feront l\'objet d\'un avenant.',
};
const CHAMPS_ENTREPRISE = Object.keys(ENTREPRISE_DEFAUT);

const texte = (v, max) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};
// toPrecision corrige les erreurs binaires (1,5 × 99,99 = 149,98499999…) avant d'arrondir au cent.
const cents = (n) => Math.round(Number((n * 100).toPrecision(12))) / 100;
const estDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const aujourdhui = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

// Lignes reçues du téléphone → lignes propres (description obligatoire, quantité 1 par défaut).
function lireLignes(brutes) {
  if (!Array.isArray(brutes)) return null;
  return brutes.slice(0, 200).map((l) => ({
    description: texte(l?.description, 2000) || '',
    quantite: Number.isFinite(Number(l?.quantite)) && l?.quantite !== '' && l?.quantite != null ? Number(l.quantite) : 1,
    unite: texte(l?.unite, 20) || '',
    prix: Number.isFinite(Number(l?.prix)) ? cents(Number(l.prix)) : 0,
  })).filter((l) => l.description || l.prix);
}

export function calculerTotaux(lignes) {
  const sousTotal = cents(lignes.reduce((t, l) => t + cents(l.quantite * l.prix), 0));
  const tps = cents(sousTotal * TAUX_TPS);
  const tvq = cents(sousTotal * TAUX_TVQ);
  return { sous_total: sousTotal, tps, tvq, total: cents(sousTotal + tps + tvq) };
}

// ---------- PDF ----------
// Les polices de base du PDF ne connaissent pas l'espace fine insécable que met fr-CA dans les montants.
const propre = (t) => String(t ?? '').replace(/[  ]/g, ' ');
const argent = (n) => propre(new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n));
const nombre = (n) => propre(new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 3 }).format(n));
const dateLongue = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function pdfSoumission(s, entreprise) {
  return new Promise((ok, echec) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true,
      info: { Title: `Soumission ${s.numero}`, Author: entreprise.nom } });
    const morceaux = [];
    doc.on('data', (m) => morceaux.push(m));
    doc.on('end', () => ok(Buffer.concat(morceaux)));
    doc.on('error', echec);

    const G = 50; const D = 562; const L = D - G;
    const ORANGE = '#e8740c'; const GRIS = '#5b6675'; const TRAIT = '#d9dee5';

    // En-tête : logo et coordonnées à gauche, numéro et dates à droite.
    try { doc.image(LOGO, G, 45, { width: 62, height: 62 }); } catch { /* logo absent : on continue sans */ }
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#1b2430').text(propre(entreprise.nom), G + 74, 48, { width: 260 });
    doc.font('Helvetica').fontSize(9).fillColor(GRIS);
    const coords = [entreprise.adresse, [entreprise.telephone, entreprise.courriel].filter(Boolean).join(' · '), entreprise.site,
      entreprise.rbq && `Licence RBQ : ${entreprise.rbq}`,
      [entreprise.tps && `TPS : ${entreprise.tps}`, entreprise.tvq && `TVQ : ${entreprise.tvq}`].filter(Boolean).join(' · ')].filter(Boolean);
    for (const c of coords) doc.text(propre(c), { width: 260 });

    doc.font('Helvetica-Bold').fontSize(20).fillColor(ORANGE).text('SOUMISSION', 362, 46, { width: 200, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#1b2430');
    const echeance = new Date(`${s.date_soumission}T12:00:00Z`);
    echeance.setUTCDate(echeance.getUTCDate() + s.validite_jours);
    for (const [k, v] of [['No', s.numero], ['Date', dateLongue(s.date_soumission)], ['Valide jusqu\'au', dateLongue(echeance.toISOString().slice(0, 10))]]) {
      doc.text(`${k} : ${v}`, 312, doc.y + 2, { width: 250, align: 'right' });
    }

    // Client et lieu des travaux.
    let y = Math.max(doc.y, 125) + 18;
    doc.moveTo(G, y).lineTo(D, y).strokeColor(TRAIT).lineWidth(1).stroke();
    y += 12;
    const bloc = (titre, lignes, x) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text(titre.toUpperCase(), x, y, { width: 240 });
      doc.font('Helvetica').fontSize(10.5).fillColor('#1b2430');
      for (const [i, l] of lignes.filter(Boolean).entries()) doc.font(i ? 'Helvetica' : 'Helvetica-Bold').text(propre(l), x, doc.y + 1, { width: 240 });
      return doc.y;
    };
    const finClient = bloc('Préparée pour', [s.client_nom || 'Client', s.client_adresse, s.client_telephone, s.client_courriel], G);
    const finLieu = s.adresse_travaux || s.projet_nom ? bloc('Lieu des travaux', [s.projet_nom, s.adresse_travaux], 322) : y;
    y = Math.max(finClient, finLieu) + 16;

    if (s.titre) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#1b2430').text(propre(s.titre), G, y, { width: L });
      y = doc.y + 10;
    }

    // Tableau des lignes.
    const COL = [{ t: 'Description', x: G, l: 262, a: 'left' }, { t: 'Qté', x: G + 266, l: 46, a: 'right' },
      { t: 'Unité', x: G + 316, l: 48, a: 'left' }, { t: 'Prix unitaire', x: G + 366, l: 70, a: 'right' },
      { t: 'Montant', x: G + 440, l: 72, a: 'right' }];
    const entete = () => {
      doc.rect(G, y, L, 20).fill('#f4f6f8');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS);
      for (const c of COL) doc.text(c.t, c.x + (c.a === 'left' ? 6 : 0), y + 6, { width: c.l - 6, align: c.a });
      y += 24;
    };
    const basDePage = doc.page.height - 70;
    entete();
    doc.font('Helvetica').fontSize(10).fillColor('#1b2430');
    const lignes = s.lignes.length ? s.lignes : [];
    for (const ligne of lignes) {
      const hauteur = doc.heightOfString(propre(ligne.description) || ' ', { width: COL[0].l - 6 }) + 8;
      if (y + hauteur > basDePage) { doc.addPage(); y = 50; entete(); doc.font('Helvetica').fontSize(10).fillColor('#1b2430'); }
      doc.text(propre(ligne.description) || ' ', COL[0].x + 6, y, { width: COL[0].l - 6 });
      doc.text(nombre(ligne.quantite), COL[1].x, y, { width: COL[1].l, align: 'right' });
      doc.text(propre(ligne.unite), COL[2].x + 6, y, { width: COL[2].l - 6 });
      doc.text(argent(ligne.prix), COL[3].x, y, { width: COL[3].l, align: 'right' });
      doc.text(argent(cents(ligne.quantite * ligne.prix)), COL[4].x, y, { width: COL[4].l, align: 'right' });
      y += hauteur;
      doc.moveTo(G, y - 3).lineTo(D, y - 3).strokeColor(TRAIT).lineWidth(0.5).stroke();
    }
    if (!lignes.length) { doc.fillColor(GRIS).text('Aucune ligne.', G + 6, y); y += 20; }

    // Totaux.
    if (y + 90 > basDePage) { doc.addPage(); y = 50; }
    y += 8;
    const total = (libelle, valeur, gras) => {
      doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(gras ? 12 : 10).fillColor('#1b2430');
      doc.text(libelle, G + 280, y, { width: 150, align: 'right' });
      doc.text(argent(valeur), G + 432, y, { width: 80, align: 'right' });
      y += gras ? 20 : 16;
    };
    total('Sous-total', s.sous_total);
    total('TPS (5 %)', s.tps);
    total('TVQ (9,975 %)', s.tvq);
    doc.moveTo(G + 320, y).lineTo(D, y).strokeColor(ORANGE).lineWidth(1.2).stroke();
    y += 6;
    total('Total', s.total, true);

    // Notes et conditions, puis signature du client.
    const conditions = [s.notes, entreprise.conditions].filter(Boolean).map(propre).join('\n\n');
    y += 12;
    if (conditions) {
      if (y + 60 > basDePage) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text('NOTES ET CONDITIONS', G, y, { width: L });
      doc.font('Helvetica').fontSize(9.5).fillColor('#1b2430').text(conditions, G, doc.y + 3, { width: L });
      y = doc.y + 16;
    }
    if (y + 60 > basDePage) { doc.addPage(); y = 50; }
    y += 20;
    doc.font('Helvetica').fontSize(9.5).fillColor(GRIS);
    doc.moveTo(G, y + 22).lineTo(G + 230, y + 22).moveTo(G + 290, y + 22).lineTo(D, y + 22).strokeColor('#9aa7b5').lineWidth(0.7).stroke();
    doc.text('Acceptée par (signature du client)', G, y + 26, { width: 230 });
    doc.text('Date', G + 290, y + 26, { width: 222 });

    // Pied de page sur chaque page.
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // sinon écrire sous la marge du bas ajoute une page blanche
      doc.font('Helvetica').fontSize(8).fillColor(GRIS)
        .text(`${propre(entreprise.nom)} · Soumission ${s.numero} · Page ${i + 1} de ${pages.count}`, G, doc.page.height - 40,
          { width: L, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

// ---------- Routes ----------
export function brancherSoumissions(app, { db }) {
  const exigerAcces = (req, res, suite) => (req.utilisateur.soumissions
    ? suite() : res.status(403).json({ erreur: 'Le bureau ne t\'a pas donné accès aux soumissions.' }));
  const entreprise = () => ({ ...ENTREPRISE_DEFAUT, ...(lireReglage(db, 'entreprise') || {}) });

  const lire = (id) => {
    const s = db.prepare(`SELECT s.*, p.nom AS projet_nom, u.nom AS auteur FROM soumissions s
                          LEFT JOIN projets p ON p.id = s.projet_id LEFT JOIN utilisateurs u ON u.id = s.cree_par
                          WHERE s.id = ?`).get(id);
    return s && { ...s, lignes: JSON.parse(s.lignes) };
  };

  // Valide le corps ; retourne { erreur } ou { v } avec les colonnes à enregistrer (totaux recalculés ici).
  function valider(b, actuelle) {
    const v = {};
    for (const [champ, max] of [['client_nom', 150], ['client_adresse', 300], ['client_courriel', 200],
      ['client_telephone', 50], ['adresse_travaux', 300], ['titre', 200], ['notes', 5000]]) {
      if (champ in b) v[champ] = texte(b[champ], max);
    }
    if (v.client_courriel && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.client_courriel)) return { erreur: 'Courriel du client invalide.' };
    if ('projet_id' in b) {
      v.projet_id = Number(b.projet_id) || null;
      if (v.projet_id && !db.prepare('SELECT 1 FROM projets WHERE id = ?').get(v.projet_id)) return { erreur: 'Projet introuvable.' };
    }
    if ('date_soumission' in b) {
      if (!estDate(b.date_soumission)) return { erreur: 'Date invalide.' };
      v.date_soumission = b.date_soumission;
    }
    if ('validite_jours' in b) {
      const j = Number(b.validite_jours);
      if (!Number.isInteger(j) || j < 1 || j > 365) return { erreur: 'Validité : entre 1 et 365 jours.' };
      v.validite_jours = j;
    }
    if ('statut' in b) {
      if (!STATUTS.includes(b.statut)) return { erreur: 'Statut invalide.' };
      v.statut = b.statut;
    }
    if ('lignes' in b) {
      const lignes = lireLignes(b.lignes);
      if (!lignes) return { erreur: 'Lignes invalides.' };
      if (lignes.some((l) => Math.abs(l.quantite) > 1e6 || Math.abs(l.prix) > 1e8)) return { erreur: 'Quantité ou prix trop grand.' };
      v.lignes = JSON.stringify(lignes);
      Object.assign(v, calculerTotaux(lignes));
    }
    if (!actuelle && !v.client_nom) return { erreur: 'Indique le nom du client.' };
    if (actuelle && 'client_nom' in v && !v.client_nom) return { erreur: 'Indique le nom du client.' };
    return { v };
  }

  app.get('/api/soumissions', exigerConnexion, exigerAcces, (_req, res) => {
    res.json({ soumissions: db.prepare(`SELECT s.id, s.numero, s.statut, s.client_nom, s.titre, s.total, s.date_soumission,
                                               p.nom AS projet_nom, u.nom AS auteur
                                        FROM soumissions s LEFT JOIN projets p ON p.id = s.projet_id
                                        LEFT JOIN utilisateurs u ON u.id = s.cree_par
                                        ORDER BY s.id DESC LIMIT 500`).all() });
  });

  // Coordonnées de l'entreprise imprimées en haut de chaque soumission (avec les numéros de taxes).
  app.get('/api/soumissions/entreprise', exigerConnexion, exigerAcces, (_req, res) => res.json({ entreprise: entreprise() }));
  app.put('/api/soumissions/entreprise', exigerConnexion, exigerAcces, (req, res) => {
    const e = entreprise();
    for (const c of CHAMPS_ENTREPRISE) if (c in (req.body || {})) e[c] = texte(req.body[c], c === 'conditions' ? 3000 : 200) || '';
    if (!e.nom) return res.status(400).json({ erreur: 'Indique le nom de l\'entreprise.' });
    ecrireReglage(db, 'entreprise', e);
    res.json({ entreprise: e });
  });

  app.get('/api/soumissions/:id', exigerConnexion, exigerAcces, (req, res) => {
    const s = lire(Number(req.params.id));
    if (!s) return res.status(404).json({ erreur: 'Soumission introuvable.' });
    res.json({ soumission: s });
  });

  app.post('/api/soumissions', exigerConnexion, exigerAcces, (req, res) => {
    const { erreur, v } = valider(req.body || {});
    if (erreur) return res.status(400).json({ erreur });
    const date = v.date_soumission || aujourdhui();
    // Numéro S-AAAA-001, qui repart à 1 chaque année.
    const annee = date.slice(0, 4);
    const dernier = db.prepare("SELECT numero FROM soumissions WHERE numero LIKE ? ORDER BY id DESC LIMIT 1").get(`S-${annee}-%`);
    const suivant = (dernier ? Number(dernier.numero.split('-')[2]) : 0) + 1;
    const ligne = { ...calculerTotaux([]), lignes: '[]', ...v, date_soumission: date, numero: `S-${annee}-${String(suivant).padStart(3, '0')}`, cree_par: req.utilisateur.id };
    const cols = Object.keys(ligne);
    const { lastInsertRowid } = db.prepare(`INSERT INTO soumissions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => ligne[c]));
    res.status(201).json({ soumission: lire(Number(lastInsertRowid)) });
  });

  app.patch('/api/soumissions/:id', exigerConnexion, exigerAcces, (req, res) => {
    const s = lire(Number(req.params.id));
    if (!s) return res.status(404).json({ erreur: 'Soumission introuvable.' });
    const { erreur, v } = valider(req.body || {}, s);
    if (erreur) return res.status(400).json({ erreur });
    const cols = Object.keys(v);
    if (cols.length) {
      db.prepare(`UPDATE soumissions SET ${cols.map((c) => `${c} = ?`).join(', ')}, maj_le = datetime('now') WHERE id = ?`)
        .run(...cols.map((c) => v[c]), s.id);
    }
    res.json({ soumission: lire(s.id) });
  });

  app.delete('/api/soumissions/:id', exigerConnexion, exigerAcces, (req, res) => {
    const r = db.prepare('DELETE FROM soumissions WHERE id = ?').run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ erreur: 'Soumission introuvable.' });
    res.json({ ok: true });
  });

  // PDF à télécharger ou à envoyer au client (?telecharger=1 force l'enregistrement plutôt que l'affichage).
  app.get('/api/soumissions/:id/pdf', exigerConnexion, exigerAcces, async (req, res) => {
    const s = lire(Number(req.params.id));
    if (!s) return res.status(404).json({ erreur: 'Soumission introuvable.' });
    const pdf = await pdfSoumission(s, entreprise());
    const nom = `Soumission ${s.numero}${s.client_nom ? ` - ${s.client_nom}` : ''}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
    res.type('application/pdf');
    if ('telecharger' in req.query) res.attachment(nom);
    else res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nom)}`);
    res.send(pdf);
  });
}
