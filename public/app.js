// Interface de l'app employés : une page, routes par ancre (#factures, #bureau, ...).
const vue = document.getElementById('vue');
const entete = document.querySelector('.entete');
let etat = null;
let listesQbo = null;

const STATUTS = {
  brouillon: 'Brouillon', en_attente: 'En attente', approuvee: 'Approuvée', refusee: 'Refusée',
};
const argent = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });

// ---------- Outils ----------
function h(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const fmt = (n) => (n == null ? '—' : argent.format(n));
const val = (n) => (n == null ? '' : String(n));

async function api(chemin, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const rep = await fetch(chemin, init);
  const corps = await rep.json().catch(() => ({}));
  if (rep.status === 401 && etat?.utilisateur) { etat.utilisateur = null; route(); }
  if (!rep.ok) throw new Error(corps.erreur || 'Erreur de connexion. Réessaie.');
  return corps;
}

let minuterieAvis;
function avis(message) {
  const el = document.getElementById('avis');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(minuterieAvis);
  minuterieAvis = setTimeout(() => { el.hidden = true; }, 4000);
}

function lireFormulaire(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function occuper(bouton, travail) {
  const texte = bouton.textContent;
  bouton.disabled = true;
  try { await travail(); } catch (e) { avis(e.message); } finally {
    bouton.disabled = false;
    bouton.textContent = texte;
  }
}

function pastille(statut) {
  return `<span class="pastille s-${statut}">${STATUTS[statut]}</span>`;
}

// ---------- Routage ----------
async function demarrer() {
  etat = await api('/api/etat');
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const [ancre, requete] = location.hash.slice(1).split('?');
  const u = etat?.utilisateur;
  entete.hidden = !u;
  if (u) entete.querySelector('.qui').textContent = u.nom;

  if (etat.premierDemarrage) return vuePremierCompte();
  if (!u) return vueConnexion();
  if (ancre.startsWith('facture/')) return vueEditionFacture(Number(ancre.split('/')[1]));
  if (ancre === 'projets' || ancre === 'projets/archives') return vueProjets(ancre === 'projets/archives');
  if (ancre.startsWith('projet/')) return vueProjet(Number(ancre.split('/')[1]), ancre.split('/')[2]);
  if (u.role === 'bureau') {
    if (requete?.includes('qbo=ok')) avis('QuickBooks est connecté.');
    if (requete?.includes('qbo=echec')) avis('La connexion à QuickBooks a échoué. Réessaie.');
    if (ancre === 'factures') return vueEmploye();
    if (ancre === 'employes') return vueEmployes();
    if (ancre.startsWith('bureau/')) return vueBureau(ancre.split('/')[1]);
    return vueBureau('en_attente');
  }
  return vueEmploye();
}

document.getElementById('btn-deconnexion').addEventListener('click', async () => {
  await api('/api/deconnexion', { method: 'POST' }).catch(() => {});
  etat.utilisateur = null;
  location.hash = '';
  route();
});

// ---------- Connexion ----------
function vueConnexion() {
  vue.innerHTML = `
    <form class="carte etroit" id="f-connexion">
      <h1>Connexion</h1>
      <label for="identifiant">Identifiant</label>
      <input id="identifiant" name="identifiant" autocomplete="username" autocapitalize="none" required>
      <label for="mdp">Mot de passe ou NIP</label>
      <input id="mdp" name="motDePasse" type="password" autocomplete="current-password" required>
      <div class="actions"><button class="pleine">Se connecter</button></div>
    </form>`;
  const form = document.getElementById('f-connexion');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    occuper(form.querySelector('button'), async () => {
      const { utilisateur } = await api('/api/connexion', { method: 'POST', json: lireFormulaire(form) });
      etat.utilisateur = utilisateur;
      location.hash = '';
      route();
    });
  });
}

function vuePremierCompte() {
  vue.innerHTML = `
    <form class="carte etroit" id="f-premier">
      <h1>Bienvenue</h1>
      <p class="doux">Crée le compte du bureau. C'est lui qui approuve les factures et ajoute les employés.</p>
      <label for="nom">Ton nom</label>
      <input id="nom" name="nom" autocomplete="name" required>
      <label for="identifiant">Identifiant</label>
      <input id="identifiant" name="identifiant" autocomplete="username" autocapitalize="none" required>
      <label for="mdp">Mot de passe (10 caractères minimum)</label>
      <input id="mdp" name="motDePasse" type="password" autocomplete="new-password" minlength="10" required>
      ${etat.codeInstallationRequis ? `<label for="code">Code d'installation</label>
      <input id="code" name="code" type="password" autocomplete="off" required>` : ''}
      <div class="actions"><button class="pleine">Créer le compte</button></div>
    </form>`;
  const form = document.getElementById('f-premier');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    occuper(form.querySelector('button'), async () => {
      await api('/api/premier-compte', { method: 'POST', json: lireFormulaire(form) });
      etat = await api('/api/etat');
      route();
    });
  });
}

// ---------- Employé ----------
function ongletsBureau(actif) {
  const lien = (ancre, texte) => `<a href="#${ancre}" ${actif === ancre ? 'aria-current="page"' : ''}>${texte}</a>`;
  if (etat.utilisateur.role !== 'bureau') {
    return `<nav class="onglets">${lien('factures', 'Mes factures')}${lien('projets', 'Projets')}</nav>`;
  }
  return `<nav class="onglets">
    ${lien('bureau/en_attente', 'À approuver')}${lien('bureau/approuvee', 'Approuvées')}
    ${lien('bureau/refusee', 'Refusées')}${lien('factures', 'Déposer')}${lien('projets', 'Projets')}${lien('employes', 'Employés')}
  </nav>`;
}

async function vueEmploye() {
  vue.innerHTML = `${ongletsBureau('factures')}
    <input type="file" id="fichier" accept="image/*,application/pdf" hidden>
    <button class="geant" id="btn-deposer" type="button">Déposer une facture</button>
    <p class="doux" style="text-align:center">Prends la facture en photo ou choisis un PDF.</p>
    <h2>Mes factures</h2>
    <div class="carte"><ul class="liste" id="mes-factures"><li class="vide">Chargement…</li></ul></div>`;

  const champ = document.getElementById('fichier');
  const bouton = document.getElementById('btn-deposer');
  bouton.addEventListener('click', () => champ.click());
  champ.addEventListener('change', () => {
    const fichier = champ.files[0];
    if (!fichier) return;
    occuper(bouton, async () => {
      bouton.textContent = etat.lectureAuto ? 'Lecture de la facture…' : 'Envoi…';
      const donnees = new FormData();
      donnees.append('fichier', await reduireImage(fichier));
      const { facture, luAutomatiquement } = await api('/api/factures', { method: 'POST', body: donnees });
      if (etat.lectureAuto && !luAutomatiquement) avis('Facture difficile à lire : remplis les montants à la main.');
      location.hash = `facture/${facture.id}`;
    });
    champ.value = '';
  });

  const { factures } = await api('/api/factures/miennes');
  const liste = document.getElementById('mes-factures');
  if (!liste) return;
  liste.innerHTML = factures.length ? factures.map((f) => `
    <li>
      <div class="infos">
        <div><strong>${h(f.fournisseur || 'Sans fournisseur')}</strong></div>
        <div class="doux">${h(f.date_facture || f.cree_le.slice(0, 10))}
          ${f.statut === 'refusee' && f.raison_refus ? ` · Refusée : ${h(f.raison_refus)}` : ''}</div>
      </div>
      <div style="text-align:right">
        <div class="montant">${fmt(f.total)}</div>
        ${['brouillon', 'refusee'].includes(f.statut)
          ? `<a href="#facture/${f.id}">${pastille(f.statut)}</a>` : pastille(f.statut)}
      </div>
    </li>`).join('') : '<li class="vide">Aucune facture déposée pour l\'instant.</li>';
}

// Réduit les photos de cellulaire (souvent 5 à 12 Mo) avant l'envoi.
async function reduireImage(fichier) {
  if (!fichier.type.startsWith('image/') || fichier.size < 1.5 * 1024 * 1024) return fichier;
  try {
    const image = await createImageBitmap(fichier);
    const echelle = Math.min(1, 2200 / Math.max(image.width, image.height));
    const toile = document.createElement('canvas');
    toile.width = Math.round(image.width * echelle);
    toile.height = Math.round(image.height * echelle);
    toile.getContext('2d').drawImage(image, 0, 0, toile.width, toile.height);
    const blob = await new Promise((ok) => toile.toBlob(ok, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'facture.jpg', { type: 'image/jpeg' }) : fichier;
  } catch {
    return fichier;
  }
}

function apercu(f) {
  const url = `/api/factures/${f.id}/fichier`;
  return f.type_mime === 'application/pdf'
    ? `<div class="apercu"><iframe src="${url}" title="Facture"></iframe></div>`
    : `<div class="apercu"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Photo de la facture"></a></div>`;
}

async function vueEditionFacture(id) {
  const { factures } = await api('/api/factures/miennes');
  const f = factures.find((x) => x.id === id);
  if (!f || !['brouillon', 'refusee'].includes(f.statut)) { location.hash = 'factures'; return; }

  vue.innerHTML = `
    <h1>Vérifie la facture</h1>
    ${f.statut === 'refusee' ? `<div class="bandeau erreur">Refusée par le bureau : ${h(f.raison_refus)}</div>` : ''}
    <div class="approbation">
      ${apercu(f)}
      <form class="carte" id="f-facture">
        <label for="fournisseur">Fournisseur</label>
        <input id="fournisseur" name="fournisseur" value="${h(f.fournisseur)}" required>
        <div class="grille2">
          <div><label for="date">Date</label><input id="date" name="date_facture" type="date" value="${h(f.date_facture)}"></div>
          <div><label for="numero">No de facture</label><input id="numero" name="numero" value="${h(f.numero)}"></div>
          <div><label for="st">Avant taxes</label><input id="st" name="sous_total" inputmode="decimal" value="${val(f.sous_total)}"></div>
          <div><label for="tps">TPS</label><input id="tps" name="tps" inputmode="decimal" value="${val(f.tps)}"></div>
          <div><label for="tvq">TVQ</label><input id="tvq" name="tvq" inputmode="decimal" value="${val(f.tvq)}"></div>
          <div><label for="total">Total</label><input id="total" name="total" inputmode="decimal" value="${val(f.total)}" required></div>
        </div>
        <label for="note">Note pour le bureau (facultatif)</label>
        <textarea id="note" name="note" placeholder="Ex. : matériaux pour la toiture">${h(f.note)}</textarea>
        <div class="actions">
          <button class="pleine">Envoyer au bureau</button>
          ${f.statut === 'brouillon' ? '<button class="danger pleine" type="button" id="btn-supprimer">Supprimer</button>' : ''}
        </div>
      </form>
    </div>`;

  const form = document.getElementById('f-facture');
  // Total taxes incluses seulement (essence, etc.) : on remplit l'avant-taxes, la TPS et la TVQ, tant que
  // l'employé n'a pas saisi ces cases lui-même.
  const casesTaxes = [form.sous_total, form.tps, form.tvq];
  let calculAuto = !form.sous_total.value;
  casesTaxes.forEach((c) => c.addEventListener('input', () => { calculAuto = false; }));
  form.total.addEventListener('input', () => {
    if (!calculAuto) return;
    const cents = Math.round(Number(form.total.value.replace(/\s|\$/g, '').replace(',', '.')) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { casesTaxes.forEach((c) => { c.value = ''; }); return; }
    const st = Math.round(cents / 1.14975);
    const tps = Math.round(st * 0.05);
    [st, tps, cents - st - tps].forEach((v, i) => { casesTaxes[i].value = (v / 100).toFixed(2); });
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    occuper(form.querySelector('button'), async () => {
      await api(`/api/factures/${id}`, { method: 'PUT', json: { ...lireFormulaire(form), soumettre: true } });
      avis('Facture envoyée au bureau.');
      location.hash = 'factures';
    });
  });
  document.getElementById('btn-supprimer')?.addEventListener('click', (e) => {
    if (!confirm('Supprimer cette facture ?')) return;
    occuper(e.currentTarget, async () => {
      await api(`/api/factures/${id}`, { method: 'DELETE' });
      location.hash = 'factures';
    });
  });
}

// ---------- Bureau ----------
function bandeauQuickBooks() {
  const q = etat.quickbooks;
  if (q.mode === 'demo') {
    return '<div class="bandeau alerte">Mode démo : QuickBooks est simulé, rien n\'est envoyé dans tes comptes.</div>';
  }
  if (!q.connecte) {
    return `<div class="bandeau alerte">QuickBooks n'est pas connecté.
      <a class="bouton" href="/api/qbo/connecter" style="margin-left:8px">Connecter QuickBooks</a></div>`;
  }
  return q.mode === 'sandbox'
    ? '<div class="bandeau">Connecté à une compagnie QuickBooks de test.</div>'
    : '';
}

async function vueBureau(statut) {
  if (!STATUTS[statut]) statut = 'en_attente';
  etat = await api('/api/etat');
  vue.innerHTML = `${ongletsBureau(`bureau/${statut}`)}${bandeauQuickBooks()}<div id="contenu"><p class="vide">Chargement…</p></div>`;
  const contenu = document.getElementById('contenu');
  const { factures } = await api(`/api/bureau/factures?statut=${statut}`);

  if (statut !== 'en_attente') {
    contenu.innerHTML = `<div class="carte"><ul class="liste">${factures.length ? factures.map((f) => `
      <li>
        <div class="infos"><strong>${h(f.fournisseur)}</strong>
          <div class="doux">${h(f.employe)} · ${h(f.date_facture || '')}
          ${f.statut === 'refusee' ? ` · ${h(f.raison_refus)}` : ''}
          ${f.statut === 'approuvee' && !f.qbo_piece_jointe ? ' · photo non jointe dans QuickBooks' : ''}</div>
        </div>
        <div style="text-align:right"><div class="montant">${fmt(f.total)}</div>
          <a class="doux" href="/api/factures/${f.id}/fichier" target="_blank" rel="noopener">Voir</a></div>
      </li>`).join('') : '<li class="vide">Rien ici.</li>'}</ul></div>`;
    return;
  }

  if (!factures.length) {
    contenu.innerHTML = '<div class="carte vide">Aucune facture à approuver. Bon travail !</div>';
    return;
  }
  if (etat.quickbooks.mode !== 'demo' && !etat.quickbooks.connecte) {
    contenu.innerHTML = `<p class="doux">${factures.length} facture(s) en attente. Connecte QuickBooks pour les approuver.</p>`;
    return;
  }
  try {
    listesQbo = await api('/api/bureau/listes');
  } catch (e) {
    contenu.innerHTML = `<div class="bandeau erreur">${h(e.message)}</div>`;
    return;
  }
  contenu.innerHTML = `<p class="doux">${factures.length} facture(s) en attente, la plus ancienne en premier.</p>`;
  for (const f of factures) contenu.insertAdjacentHTML('beforeend', carteApprobation(f));
  for (const f of factures) brancherApprobation(f);
}

function normaliser(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function trouverFournisseur(nom) {
  const cible = normaliser(nom);
  if (!cible) return null;
  return listesQbo.fournisseurs.find((v) => normaliser(v.nom) === cible)
    || listesQbo.fournisseurs.find((v) => {
      const n = normaliser(v.nom);
      return n.length >= 3 && (cible.includes(n) || n.includes(cible));
    }) || null;
}

function carteApprobation(f) {
  const fournisseur = trouverFournisseur(f.fournisseur);
  // La catégorie lue sur la facture (carburant, matériaux…) passe avant l'habitude du fournisseur.
  const compteCategorie = f.categorie ? listesQbo.comptesParCategorie?.[f.categorie] : null;
  const compteHabituel = compteCategorie || (fournisseur ? listesQbo.comptesHabituels[fournisseur.id] : null);
  const nomCategorie = f.categorie ? listesQbo.categories?.[f.categorie] : null;
  // Le serveur ne renvoie que les codes valides pour un achat, TPS + TVQ en premier.
  const taxeQuebec = listesQbo.codesTaxe.find((t) => /tvq|qst/i.test(t.nom) && /tps|gst/i.test(t.nom))
    || listesQbo.codesTaxe.find((t) => /tvq|qst/i.test(t.nom));
  const taxeDefaut = taxeQuebec || listesQbo.codesTaxe.find((t) => /qc/i.test(t.nom)) || listesQbo.codesTaxe[0];
  const options = (liste, choisi) => liste.map((x) => `<option value="${h(x.id)}" ${x.id === choisi ? 'selected' : ''}>${h(x.nom)}</option>`).join('');

  return `
  <section class="carte" id="carte-${f.id}">
    <h2 style="margin-top:0">${h(f.fournisseur)} · ${fmt(f.total)}</h2>
    <p class="doux">Déposée par ${h(f.employe)}${f.note ? ` · « ${h(f.note)} »` : ''}</p>
    <div class="approbation">
      ${apercu(f)}
      <form data-id="${f.id}">
        <label>Fournisseur dans QuickBooks</label>
        <select name="fournisseurId">
          <option value="">${fournisseur ? '' : '— Choisir —'}</option>
          ${options(listesQbo.fournisseurs, fournisseur?.id)}
          <option value="__nouveau">+ Créer « ${h(f.fournisseur)} »</option>
        </select>
        <label>Catégorie de dépense${nomCategorie ? ` <span class="doux">(lue sur la facture : ${h(nomCategorie)}${compteCategorie ? '' : ', aucun compte correspondant dans QuickBooks'})</span>` : ''}</label>
        <select name="compteId" required>
          <option value="">— Choisir —</option>${options(listesQbo.comptes, compteHabituel)}
        </select>
        ${taxeQuebec
          // Tous les achats sont soumis à la TPS et à la TVQ : pas de choix à faire.
          ? `<input type="hidden" name="codeTaxeId" value="${h(taxeQuebec.id)}">`
          : `<label>Code de taxe</label>
        <select name="codeTaxeId" required>${options(listesQbo.codesTaxe, taxeDefaut?.id)}</select>`}
        <div class="grille2">
          <div><label>Date</label><input name="date" type="date" value="${h(f.date_facture)}" required></div>
          <div><label>No de facture</label><input name="numero" value="${h(f.numero)}"></div>
          <div><label>Avant taxes</label><input name="sousTotal" inputmode="decimal" value="${val(f.sous_total)}" required></div>
          <div><label>Total</label><input name="total" inputmode="decimal" value="${val(f.total)}"></div>
        </div>
        <p class="doux">TPS ${fmt(f.tps)} · TVQ ${fmt(f.tvq)} (TPS et TVQ du Québec appliquées par QuickBooks)</p>
        <div class="ecart" hidden></div>
        <div class="actions">
          <button>Approuver et envoyer</button>
          <button class="danger" type="button" data-refuser>Refuser</button>
        </div>
      </form>
    </div>
  </section>`;
}

function brancherApprobation(f) {
  const carte = document.getElementById(`carte-${f.id}`);
  const form = carte.querySelector('form');
  const ecart = carte.querySelector('.ecart');

  const verifierEcart = () => {
    const st = Number(String(form.sousTotal.value).replace(',', '.'));
    const total = Number(String(form.total.value).replace(',', '.'));
    const attendu = st + (f.tps || 0) + (f.tvq || 0);
    const trop = st > 0 && total > 0 && Math.abs(attendu - total) > 0.05;
    ecart.hidden = !trop;
    if (trop) ecart.textContent = `Attention : avant taxes + TPS + TVQ = ${fmt(attendu)}, mais le total indiqué est ${fmt(total)}.`;
  };
  form.sousTotal.addEventListener('input', verifierEcart);
  form.total.addEventListener('input', verifierEcart);
  verifierEcart();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const donnees = lireFormulaire(form);
    if (!donnees.fournisseurId) { avis('Choisis le fournisseur.'); return; }
    if (donnees.fournisseurId === '__nouveau') {
      donnees.nouveauFournisseur = f.fournisseur;
      delete donnees.fournisseurId;
    }
    occuper(form.querySelector('button'), async () => {
      const { pieceJointe } = await api(`/api/bureau/factures/${f.id}/approuver`, { method: 'POST', json: donnees });
      avis(pieceJointe ? 'Facture créée dans QuickBooks.' : 'Facture créée dans QuickBooks, mais la photo n\'a pas pu être jointe.');
      carte.remove();
      if (donnees.nouveauFournisseur) listesQbo = await api('/api/bureau/listes');
    });
  });

  carte.querySelector('[data-refuser]').addEventListener('click', (e) => {
    const raison = prompt('Raison du refus (l\'employé la verra) :');
    if (!raison?.trim()) return;
    occuper(e.currentTarget, async () => {
      await api(`/api/bureau/factures/${f.id}/refuser`, { method: 'POST', json: { raison } });
      avis('Facture refusée.');
      carte.remove();
    });
  });
}

// ---------- Projets ----------
const heure = (d) => new Date(`${d.replace(' ', 'T')}Z`).toLocaleString('fr-CA', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

async function vueProjets(archives) {
  const bureau = etat.utilisateur.role === 'bureau';
  vue.innerHTML = `${ongletsBureau('projets')}<div id="contenu"><p class="vide">Chargement…</p></div>`;
  const { projets } = await api(`/api/projets${archives ? '?archives=1' : ''}`);
  const contenu = document.getElementById('contenu');
  if (!contenu) return;
  contenu.innerHTML = `
    ${archives ? '<p><a href="#projets">← Projets en cours</a></p>' : ''}
    <div class="carte"><ul class="liste">${projets.length ? projets.map((p) => `
      <li>
        <div class="infos"><a href="#projet/${p.id}"><strong>${h(p.nom)}</strong></a>
          <div class="doux">${p.adresse ? `${h(p.adresse)} · ` : ''}${p.nb_messages} message(s) · ${p.nb_photos} photo(s) · ${p.nb_documents} document(s)</div></div>
        <a class="bouton secondaire" href="#projet/${p.id}">Ouvrir</a>
      </li>`).join('') : `<li class="vide">${archives ? 'Aucun projet archivé.' : 'Aucun projet en cours.'}</li>`}</ul></div>
    ${bureau && !archives ? `
    <h2>Nouveau projet</h2>
    <form class="carte" id="f-projet">
      <div class="grille2">
        <div><label for="pn">Nom</label><input id="pn" name="nom" placeholder="Ex. : Toiture Tremblay" required></div>
        <div><label for="pa">Adresse (facultatif)</label><input id="pa" name="adresse"></div>
      </div>
      <div class="actions"><button>Créer le projet</button></div>
    </form>
    <p><a href="#projets/archives">Voir les projets archivés</a></p>` : ''}`;

  const form = document.getElementById('f-projet');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    occuper(form.querySelector('button'), async () => {
      const { projet } = await api('/api/projets', { method: 'POST', json: lireFormulaire(form) });
      location.hash = `projet/${projet.id}`;
    });
  });
}

function bulleMessage(m, idProjet) {
  const moi = etat.utilisateur;
  const peutEffacer = m.auteur_id === moi.id || moi.role === 'bureau';
  const photo = `/api/projets/${idProjet}/messages/${m.id}/photo`;
  return `
    <li class="message ${m.auteur_id === moi.id ? 'moi' : ''}" data-id="${m.id}">
      <div class="doux"><strong>${h(m.auteur)}</strong> · ${heure(m.cree_le)}
        ${peutEffacer ? `<button class="lien" type="button" data-effacer="${m.id}">Effacer</button>` : ''}</div>
      ${m.photo ? `<a href="${photo}" target="_blank" rel="noopener"><img src="${photo}" alt="Photo du projet" loading="lazy"></a>` : ''}
      ${m.texte ? `<div class="texte">${h(m.texte)}</div>` : ''}
    </li>`;
}

const ONGLETS_PROJET = { discussion: 'Discussion', photos: 'Photos', documents: 'Documents', notes: 'Notes' };
const taille = (o) => (o >= 1024 * 1024 ? `${(o / 1024 / 1024).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(o / 1024))} Ko`);

async function vueProjet(id, onglet) {
  if (!ONGLETS_PROJET[onglet]) onglet = 'discussion';
  const ancre = location.hash;
  const { projet: p, messages } = await api(`/api/projets/${id}`);
  const bureau = etat.utilisateur.role === 'bureau';
  const moi = etat.utilisateur;

  vue.innerHTML = `${ongletsBureau('projets')}
    <p><a href="#projets">← Tous les projets</a></p>
    <h1>${h(p.nom)}${p.actif ? '' : ' <span class="pastille s-brouillon">Archivé</span>'}</h1>
    ${p.adresse ? `<p class="doux"><a href="https://maps.google.com/?q=${encodeURIComponent(p.adresse)}" target="_blank" rel="noopener">${h(p.adresse)}</a></p>` : ''}
    <nav class="onglets">${Object.entries(ONGLETS_PROJET).map(([cle, nom]) =>
      `<a href="#projet/${id}/${cle}" ${cle === onglet ? 'aria-current="page"' : ''}>${nom}</a>`).join('')}</nav>
    <div id="contenu-projet"></div>
    ${bureau ? `<div class="actions"><button class="${p.actif ? 'danger' : 'secondaire'}" type="button" id="btn-archiver">
      ${p.actif ? 'Archiver le projet' : 'Réactiver le projet'}</button></div>` : ''}`;

  document.getElementById('btn-archiver')?.addEventListener('click', (e) => {
    if (p.actif && !confirm('Archiver ce projet ? Les employés ne le verront plus.')) return;
    occuper(e.currentTarget, async () => {
      await api(`/api/projets/${id}`, { method: 'PATCH', json: { actif: !p.actif } });
      location.hash = 'projets';
    });
  });

  const contenu = document.getElementById('contenu-projet');
  if (onglet === 'notes') return ongletNotes(contenu, p);
  if (onglet === 'photos' || onglet === 'documents') return ongletDossier(contenu, p, onglet, moi);
  return ongletDiscussion(contenu, p, messages, ancre);
}

function ongletNotes(contenu, p) {
  contenu.innerHTML = `
    <form class="carte" id="f-notes">
      <label for="notes">Notes du projet (visibles par toute l'équipe)</label>
      <textarea id="notes" name="notes" rows="10" placeholder="Matériaux, mesures, codes de porte, contacts…">${h(p.notes)}</textarea>
      <div class="actions"><button>Enregistrer les notes</button></div>
    </form>`;
  const form = document.getElementById('f-notes');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    occuper(form.querySelector('button'), async () => {
      await api(`/api/projets/${p.id}`, { method: 'PATCH', json: { notes: form.notes.value } });
      avis('Notes enregistrées.');
    });
  });
}

async function ongletDossier(contenu, p, dossier, moi) {
  const photos = dossier === 'photos';
  contenu.innerHTML = `
    ${p.actif ? `<input type="file" id="fichier-dossier" ${photos ? 'accept="image/*" multiple'
      : 'accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,image/*" multiple'} hidden>
    <button class="pleine" type="button" id="btn-deposer">${photos ? 'Ajouter des photos' : 'Ajouter des documents'}</button>
    <p class="doux" style="text-align:center">${photos ? 'Les photos envoyées dans la discussion apparaissent aussi ici.'
      : 'PDF, Word, Excel, texte ou image, 25 Mo maximum par fichier.'}</p>` : ''}
    <div id="liste-dossier"><p class="vide">Chargement…</p></div>`;

  const afficher = async () => {
    const { fichiers } = await api(`/api/projets/${p.id}/dossiers/${dossier}`);
    const liste = document.getElementById('liste-dossier');
    if (!liste) return;
    const effacable = (f) => f.source !== 'discussion' && (f.auteur_id === moi.id || moi.role === 'bureau');
    if (!fichiers.length) {
      liste.innerHTML = `<div class="carte vide">${photos ? 'Aucune photo pour l\'instant.' : 'Aucun document pour l\'instant.'}</div>`;
    } else if (photos) {
      liste.innerHTML = `<div class="galerie">${fichiers.map((f) => `
        <figure>
          <a href="${f.url}" target="_blank" rel="noopener"><img src="${f.url}" alt="Photo du projet" loading="lazy"></a>
          <figcaption class="doux">${h(f.auteur)} · ${heure(f.cree_le)}
            ${effacable(f) ? `<button class="lien" type="button" data-effacer="${f.id}">Effacer</button>` : ''}</figcaption>
        </figure>`).join('')}</div>`;
    } else {
      liste.innerHTML = `<div class="carte"><ul class="liste">${fichiers.map((f) => `
        <li>
          <div class="infos"><a href="${f.url}" target="_blank" rel="noopener"><strong>${h(f.nom_original || 'Document')}</strong></a>
            <div class="doux">${h(f.auteur)} · ${heure(f.cree_le)} · ${taille(f.taille)}</div></div>
          ${effacable(f) ? `<button class="danger" type="button" data-effacer="${f.id}">Effacer</button>` : ''}
        </li>`).join('')}</ul></div>`;
    }
  };

  const champ = document.getElementById('fichier-dossier');
  const bouton = document.getElementById('btn-deposer');
  bouton?.addEventListener('click', () => champ.click());
  champ?.addEventListener('change', () => {
    const choisis = [...champ.files];
    if (!choisis.length) return;
    occuper(bouton, async () => {
      for (const [i, fichier] of choisis.entries()) {
        bouton.textContent = `Envoi ${i + 1} de ${choisis.length}…`;
        const donnees = new FormData();
        donnees.append('fichier', photos ? await reduireImage(fichier) : fichier, fichier.name);
        await api(`/api/projets/${p.id}/dossiers/${dossier}`, { method: 'POST', body: donnees });
      }
      avis(choisis.length > 1 ? `${choisis.length} fichiers ajoutés.` : 'Fichier ajouté.');
      await afficher();
    });
    champ.value = '';
  });

  contenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-effacer]');
    if (!b || !confirm('Effacer ce fichier ?')) return;
    occuper(b, async () => {
      await api(`/api/projets/${p.id}/fichiers/${b.dataset.effacer}`, { method: 'DELETE' });
      await afficher();
    });
  });

  await afficher();
}

function ongletDiscussion(contenu, p, messages, ancre) {
  const id = p.id;
  let dernier = messages.at(-1)?.id || 0;
  contenu.innerHTML = `
    <div class="carte"><ul class="liste fil" id="fil">${messages.map((m) => bulleMessage(m, id)).join('')
      || '<li class="vide" id="fil-vide">Aucun message. Lance la discussion ou ajoute une photo.</li>'}</ul></div>
    ${p.actif ? `
    <form class="carte composer" id="f-message">
      <input type="file" id="photo" accept="image/*" hidden>
      <textarea name="texte" rows="2" placeholder="Écris un message…"></textarea>
      <div class="doux" id="photo-choisie" hidden></div>
      <div class="actions">
        <button class="secondaire" type="button" id="btn-photo">Ajouter une photo</button>
        <button>Envoyer</button>
      </div>
    </form>` : ''}`;

  const fil = document.getElementById('fil');
  const ajouter = (liste) => {
    if (!liste.length) return;
    document.getElementById('fil-vide')?.remove();
    for (const m of liste) {
      if (fil.querySelector(`[data-id="${m.id}"]`)) continue;
      fil.insertAdjacentHTML('beforeend', bulleMessage(m, id));
      dernier = Math.max(dernier, m.id);
    }
  };

  const formMessage = document.getElementById('f-message');
  if (formMessage) {
    const champ = document.getElementById('photo');
    const choisie = document.getElementById('photo-choisie');
    document.getElementById('btn-photo').addEventListener('click', () => champ.click());
    champ.addEventListener('change', () => {
      choisie.hidden = !champ.files[0];
      choisie.textContent = champ.files[0] ? `Photo prête à envoyer : ${champ.files[0].name}` : '';
    });
    formMessage.addEventListener('submit', (e) => {
      e.preventDefault();
      const texte = formMessage.texte.value.trim();
      if (!texte && !champ.files[0]) { avis('Écris un message ou ajoute une photo.'); return; }
      occuper(formMessage.querySelector('button:not([type])'), async () => {
        const donnees = new FormData();
        donnees.append('texte', texte);
        if (champ.files[0]) donnees.append('photo', await reduireImage(champ.files[0]));
        const { message } = await api(`/api/projets/${id}/messages`, { method: 'POST', body: donnees });
        ajouter([message]);
        formMessage.reset();
        choisie.hidden = true;
        fil.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  fil.addEventListener('click', (e) => {
    const bouton = e.target.closest('[data-effacer]');
    if (!bouton || !confirm('Effacer ce message ?')) return;
    occuper(bouton, async () => {
      await api(`/api/projets/${id}/messages/${bouton.dataset.effacer}`, { method: 'DELETE' });
      bouton.closest('li').remove();
    });
  });

  // Nouveaux messages des collègues : vérifiés toutes les 10 secondes tant que la discussion est ouverte.
  const minuterie = setInterval(async () => {
    if (location.hash !== ancre || !document.body.contains(fil)) { clearInterval(minuterie); return; }
    if (document.hidden) return;
    try { ajouter((await api(`/api/projets/${id}?apres=${dernier}`)).messages); } catch { /* réseau : on réessaie */ }
  }, 10000);
}

async function vueEmployes() {
  const { utilisateurs } = await api('/api/bureau/utilisateurs');
  vue.innerHTML = `${ongletsBureau('employes')}
    <div class="carte"><ul class="liste">${utilisateurs.map((u) => `
      <li>
        <div class="infos"><strong>${h(u.nom)}</strong>
          <div class="doux">${h(u.identifiant)} · ${u.role === 'bureau' ? 'Bureau' : 'Employé'}${u.actif ? '' : ' · désactivé'}</div></div>
        <button class="secondaire" data-mdp="${u.id}" type="button">Nouveau NIP</button>
        ${u.id === etat.utilisateur.id ? '' : `<button class="${u.actif ? 'danger' : 'secondaire'}" data-actif="${u.id}" data-valeur="${u.actif ? 0 : 1}" type="button">${u.actif ? 'Désactiver' : 'Réactiver'}</button>`}
      </li>`).join('')}</ul></div>
    <h2>Ajouter un employé</h2>
    <form class="carte" id="f-employe">
      <div class="grille2">
        <div><label for="n">Nom</label><input id="n" name="nom" required></div>
        <div><label for="i">Identifiant</label><input id="i" name="identifiant" autocapitalize="none" required></div>
        <div><label for="p">NIP ou mot de passe</label><input id="p" name="motDePasse" type="password" autocomplete="new-password" minlength="4" required></div>
        <div><label for="r">Rôle</label><select id="r" name="role"><option value="employe">Employé</option><option value="bureau">Bureau</option></select></div>
      </div>
      <div class="actions"><button>Ajouter</button></div>
    </form>`;

  const form = document.getElementById('f-employe');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    occuper(form.querySelector('button'), async () => {
      await api('/api/bureau/utilisateurs', { method: 'POST', json: lireFormulaire(form) });
      avis('Employé ajouté.');
      vueEmployes();
    });
  });
  vue.querySelectorAll('[data-actif]').forEach((b) => b.addEventListener('click', () => occuper(b, async () => {
    await api(`/api/bureau/utilisateurs/${b.dataset.actif}`, { method: 'PATCH', json: { actif: b.dataset.valeur === '1' } });
    vueEmployes();
  })));
  vue.querySelectorAll('[data-mdp]').forEach((b) => b.addEventListener('click', () => {
    const motDePasse = prompt('Nouveau NIP ou mot de passe :');
    if (!motDePasse) return;
    occuper(b, async () => {
      await api(`/api/bureau/utilisateurs/${b.dataset.mdp}`, { method: 'PATCH', json: { motDePasse } });
      avis('Mot de passe changé.');
    });
  }));
}

demarrer().catch((e) => { vue.innerHTML = `<div class="bandeau erreur">${h(e.message)}</div>`; });
