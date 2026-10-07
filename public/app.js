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
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
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
  if (ancre === 'messages') return u.role === 'bureau' ? vueConversations() : vueMessagerie();
  if (ancre.startsWith('messages/') && u.role === 'bureau') return vueMessagerie(Number(ancre.split('/')[1]));
  if (ancre.startsWith('projet/')) return vueProjet(Number(ancre.split('/')[1]), ancre.split('/')[2], Number(ancre.split('/')[3]) || 0);
  if (u.role === 'bureau') {
    if (requete?.includes('qbo=ok')) avis('QuickBooks est connecté.');
    if (requete?.includes('qbo=echec')) avis('La connexion à QuickBooks a échoué. Réessaie.');
    if (ancre === 'factures') return vueEmploye();
    if (ancre === 'employes') return vueEmployes();
    if (ancre === 'heures' || ancre.startsWith('heures/')) return vueHeures(ancre.split('/')[1]);
    if (ancre.startsWith('banques/')) return vueBanques(Number(ancre.split('/')[1]));
    if (ancre.startsWith('bureau/')) return vueBureau(ancre.split('/')[1]);
    return vueBureau('en_attente');
  }
  if (ancre === 'factures') return vueEmploye();
  return vuePunch();
}

document.getElementById('btn-deconnexion').addEventListener('click', async () => {
  await desabonnerNotifications();
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
  const messages = lien('messages', 'Messages <span class="compteur" data-non-lus hidden></span>');
  setTimeout(() => {
    // Sur téléphone, le menu défile : on garde l'onglet ouvert visible.
    document.querySelector('.onglets [aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    majNonLus();
  });
  if (etat.utilisateur.role !== 'bureau') {
    return `<nav class="onglets">${lien('punch', 'Punch')}${lien('factures', 'Mes factures')}${lien('projets', 'Projets')}${messages}</nav>`;
  }
  return `<nav class="onglets">
    ${lien('bureau/en_attente', 'À approuver')}${messages}${lien('bureau/approuvee', 'Approuvées')}
    ${lien('bureau/refusee', 'Refusées')}${lien('factures', 'Déposer')}${lien('heures', 'Heures')}${lien('projets', 'Projets')}${lien('employes', 'Employés')}
  </nav>`;
}

// Pastille des messages non lus dans le menu, rafraîchie à chaque écran et chaque minute.
async function majNonLus() {
  const pastilles = document.querySelectorAll('[data-non-lus]');
  if (!pastilles.length || !etat?.utilisateur) return;
  try {
    const { nonLus } = await api('/api/messagerie/non-lus');
    pastilles.forEach((p) => { p.textContent = nonLus; p.hidden = !nonLus; });
  } catch { /* réseau : on réessaie plus tard */ }
}
setInterval(() => { if (!document.hidden) majNonLus(); }, 60000);

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
  const peutCreer = bureau || Boolean(etat.utilisateur.chef_projet);
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
    ${peutCreer && !archives ? `
    <h2>Nouveau projet</h2>
    <form class="carte" id="f-projet">
      <div class="grille2">
        <div><label for="pn">Nom</label><input id="pn" name="nom" placeholder="Ex. : Toiture Tremblay" required></div>
        <div><label for="pa">Adresse (facultatif)</label><input id="pa" name="adresse"></div>
      </div>
      <div class="actions"><button>Créer le projet</button></div>
    </form>
    ${bureau ? '<p><a href="#projets/archives">Voir les projets archivés</a></p>' : ''}` : ''}`;

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

async function vueProjet(id, onglet, albumId = 0) {
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
  if (onglet === 'photos') return ongletPhotos(contenu, p, moi, albumId);
  if (onglet === 'documents') return ongletDossier(contenu, p, onglet, moi);
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
    ${photos ? '' : '<button class="pleine" type="button" id="btn-scanner">Scanner un document</button><div style="height:8px"></div>'}
    <button class="pleine ${photos ? '' : 'secondaire'}" type="button" id="btn-deposer">${photos ? 'Ajouter des photos' : 'Ajouter des fichiers'}</button>
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

  document.getElementById('btn-scanner')?.addEventListener('click', () => ecranScanner(contenu, p));

  // onclick plutôt qu'un écouteur ajouté : l'onglet peut être réaffiché après le scanner.
  contenu.onclick = (e) => {
    const b = e.target.closest('[data-effacer]');
    if (!b || !confirm('Effacer ce fichier ?')) return;
    occuper(b, async () => {
      await api(`/api/projets/${p.id}/fichiers/${b.dataset.effacer}`, { method: 'DELETE' });
      await afficher();
    });
  };

  await afficher();
}

// Onglet Photos : des sous-dossiers que l'équipe crée et renomme, puis les photos du dossier ouvert
// (à la racine, celles qui ne sont pas encore rangées). Le mode « Trier » déplace plusieurs photos d'un coup.
async function ongletPhotos(contenu, p, moi, albumId) {
  const { albums } = await api(`/api/projets/${p.id}/albums`);
  const album = albums.find((a) => a.id === albumId);
  if (albumId && !album) { location.hash = `projet/${p.id}/photos`; return; }
  const peutSupprimer = album && (album.cree_par === moi.id || moi.role === 'bureau');
  const choisies = new Map();
  let tri = false;

  contenu.innerHTML = `
    ${album ? `
      <p><a href="#projet/${p.id}/photos">← Tous les dossiers photos</a></p>
      <div class="titre-album"><h2>📁 ${h(album.nom)}</h2>
        ${p.actif ? `<button class="lien" type="button" id="btn-renommer">Renommer</button>
        ${peutSupprimer ? '<button class="lien" type="button" id="btn-supprimer-album">Supprimer le dossier</button>' : ''}` : ''}</div>`
    : `<div class="dossiers">
        ${albums.map((a) => `<a class="dossier-photo" href="#projet/${p.id}/photos/${a.id}">
          ${a.couverture ? `<img src="${a.couverture}" alt="" loading="lazy">` : '<span class="icone">📁</span>'}
          <strong>${h(a.nom)}</strong><span class="doux">${a.nb_photos} photo${a.nb_photos > 1 ? 's' : ''}</span></a>`).join('')}
        ${p.actif ? '<button class="dossier-photo nouveau" type="button" id="btn-nouvel-album"><span class="icone">＋</span><strong>Nouveau dossier</strong></button>' : ''}
      </div>`}
    ${p.actif ? `<input type="file" id="fichier-dossier" accept="image/*" multiple hidden>
      <button class="pleine" type="button" id="btn-deposer">${album ? `Ajouter des photos dans « ${h(album.nom)} »` : 'Ajouter des photos'}</button>` : ''}
    <div class="entete-photos"><h3>${album ? 'Photos du dossier' : (albums.length ? 'Photos non classées' : 'Photos')}</h3>
      ${p.actif ? '<button class="secondaire" type="button" id="btn-trier">Trier</button>' : ''}</div>
    <div class="barre-tri" id="barre-tri" hidden>
      <span id="nb-choisies">Touche les photos à déplacer</span>
      <select id="destination">
        ${album ? '<option value="">Non classées</option>' : ''}
        ${albums.filter((a) => a.id !== albumId).map((a) => `<option value="${a.id}">${h(a.nom)}</option>`).join('')}
        <option value="nouveau">+ Nouveau dossier…</option>
      </select>
      <button type="button" id="btn-deplacer" disabled>Déplacer</button>
    </div>
    ${!album && !albums.length ? '<p class="doux">Crée des dossiers (ex. « Avant », « Toiture ») pour démêler les photos.</p>' : ''}
    <div id="liste-dossier"><p class="vide">Chargement…</p></div>`;

  const nommer = (actuel) => {
    const nom = prompt('Nom du dossier de photos :', actuel || '');
    return nom?.trim() || null;
  };
  const creerAlbum = async () => {
    const nom = nommer();
    if (!nom) return null;
    return (await api(`/api/projets/${p.id}/albums`, { method: 'POST', json: { nom } })).album;
  };

  const liste = document.getElementById('liste-dossier');
  const afficher = async () => {
    const { fichiers } = await api(`/api/projets/${p.id}/dossiers/photos?album=${albumId}`);
    const effacable = (f) => f.source !== 'discussion' && (f.auteur_id === moi.id || moi.role === 'bureau');
    choisies.clear();
    majBarre();
    liste.innerHTML = !fichiers.length
      ? `<div class="carte vide">${album ? 'Ce dossier est vide.' : (albums.length ? 'Toutes les photos sont rangées.' : 'Aucune photo pour l\'instant.')}</div>`
      : `<div class="galerie">${fichiers.map((f) => `
        <figure data-photo="${f.source}:${f.id}">
          <a href="${f.url}" target="_blank" rel="noopener"><img src="${f.url}" alt="Photo du projet" loading="lazy"></a>
          <span class="coche" aria-hidden="true">✓</span>
          <figcaption class="doux">${h(f.auteur)} · ${heure(f.cree_le)}${f.source === 'discussion' ? ' · discussion' : ''}
            ${effacable(f) ? `<button class="lien" type="button" data-effacer="${f.id}">Effacer</button>` : ''}</figcaption>
        </figure>`).join('')}</div>`;
    liste.classList.toggle('en-tri', tri);
  };

  const barre = document.getElementById('barre-tri');
  const btnDeplacer = document.getElementById('btn-deplacer');
  function majBarre() {
    if (!barre) return;
    document.getElementById('nb-choisies').textContent = choisies.size
      ? `${choisies.size} photo${choisies.size > 1 ? 's' : ''} choisie${choisies.size > 1 ? 's' : ''}, vers :` : 'Touche les photos à déplacer';
    btnDeplacer.disabled = !choisies.size;
  }

  document.getElementById('btn-trier')?.addEventListener('click', (e) => {
    tri = !tri;
    e.currentTarget.textContent = tri ? 'Terminer' : 'Trier';
    barre.hidden = !tri;
    liste.classList.toggle('en-tri', tri);
    if (!tri) {
      choisies.clear();
      liste.querySelectorAll('figure.choisie').forEach((f) => f.classList.remove('choisie'));
      majBarre();
    }
  });

  btnDeplacer?.addEventListener('click', () => occuper(btnDeplacer, async () => {
    let cible = document.getElementById('destination').value;
    if (cible === 'nouveau') {
      const nouveau = await creerAlbum();
      if (!nouveau) return;
      cible = nouveau.id;
    }
    const photos = [...choisies.values()];
    await api(`/api/projets/${p.id}/albums/ranger`, { method: 'POST', json: { album_id: cible ? Number(cible) : null, photos } });
    avis(`${photos.length} photo${photos.length > 1 ? 's' : ''} déplacée${photos.length > 1 ? 's' : ''}.`);
    route();
  }));

  document.getElementById('btn-nouvel-album')?.addEventListener('click', (e) => occuper(e.currentTarget, async () => {
    const a = await creerAlbum();
    if (a) location.hash = `projet/${p.id}/photos/${a.id}`;
  }));

  document.getElementById('btn-renommer')?.addEventListener('click', (e) => {
    const nom = nommer(album.nom);
    if (!nom || nom === album.nom) return;
    occuper(e.currentTarget, async () => {
      await api(`/api/projets/${p.id}/albums/${album.id}`, { method: 'PATCH', json: { nom } });
      avis('Dossier renommé.');
      route();
    });
  });

  document.getElementById('btn-supprimer-album')?.addEventListener('click', (e) => {
    if (!confirm(`Supprimer le dossier « ${album.nom} » ? Ses photos ne sont pas effacées : elles retournent dans les photos non classées.`)) return;
    occuper(e.currentTarget, async () => {
      await api(`/api/projets/${p.id}/albums/${album.id}`, { method: 'DELETE' });
      location.hash = `projet/${p.id}/photos`;
    });
  });

  const champ = document.getElementById('fichier-dossier');
  const bouton = document.getElementById('btn-deposer');
  bouton?.addEventListener('click', () => champ.click());
  champ?.addEventListener('change', () => {
    const fichiers = [...champ.files];
    if (!fichiers.length) return;
    occuper(bouton, async () => {
      for (const [i, fichier] of fichiers.entries()) {
        bouton.textContent = `Envoi ${i + 1} de ${fichiers.length}…`;
        const donnees = new FormData();
        if (album) donnees.append('album_id', String(album.id));
        donnees.append('fichier', await reduireImage(fichier), fichier.name);
        await api(`/api/projets/${p.id}/dossiers/photos`, { method: 'POST', body: donnees });
      }
      avis(fichiers.length > 1 ? `${fichiers.length} photos ajoutées.` : 'Photo ajoutée.');
      route();
    });
    champ.value = '';
  });

  contenu.onclick = (e) => {
    const figure = e.target.closest('[data-photo]');
    if (tri && figure) {
      e.preventDefault();
      const [source, id] = figure.dataset.photo.split(':');
      if (choisies.has(figure.dataset.photo)) choisies.delete(figure.dataset.photo);
      else choisies.set(figure.dataset.photo, { source, id: Number(id) });
      figure.classList.toggle('choisie', choisies.has(figure.dataset.photo));
      majBarre();
      return;
    }
    const b = e.target.closest('[data-effacer]');
    if (!b || !confirm('Effacer cette photo ?')) return;
    occuper(b, async () => {
      await api(`/api/projets/${p.id}/fichiers/${b.dataset.effacer}`, { method: 'DELETE' });
      route();
    });
  };

  await afficher();
}

// Prépare une page scannée : redimensionnée, et en noir et blanc contrasté pour qu'elle soit lisible une fois imprimée.
async function preparerPage(fichier, noirEtBlanc) {
  const image = await createImageBitmap(fichier);
  const echelle = Math.min(1, 1800 / Math.max(image.width, image.height));
  const toile = document.createElement('canvas');
  toile.width = Math.round(image.width * echelle);
  toile.height = Math.round(image.height * echelle);
  const g = toile.getContext('2d');
  g.drawImage(image, 0, 0, toile.width, toile.height);
  if (noirEtBlanc) {
    const pixels = g.getImageData(0, 0, toile.width, toile.height);
    const d = pixels.data;
    for (let i = 0; i < d.length; i += 4) {
      const gris = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Le papier tire vers le blanc et l'encre vers le noir.
      const v = Math.max(0, Math.min(255, (gris - 128) * 1.8 + 165));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(pixels, 0, 0);
  }
  return new Promise((ok) => toile.toBlob(ok, 'image/jpeg', 0.8));
}

function ecranScanner(contenu, p) {
  const pages = [];
  const date = new Date().toLocaleDateString('fr-CA');
  contenu.innerHTML = `
    <div class="carte">
      <h2 style="margin-top:0">Scanner un document</h2>
      <p class="doux">Pose la feuille à plat dans un endroit éclairé et prends-la en photo d'aussi près que possible.
        Ajoute autant de pages que nécessaire.</p>
      <input type="file" id="page-scan" accept="image/*" capture="environment" hidden>
      <button class="pleine" type="button" id="btn-page">Prendre la page 1 en photo</button>
      <div class="galerie" id="pages-scan" style="margin-top:12px"></div>
      <label for="nom-scan">Nom du document</label>
      <input id="nom-scan" placeholder="Ex. : Permis de construction" value="Document scanné ${date}">
      <label style="display:flex;gap:8px;align-items:center;color:var(--texte)">
        <input type="checkbox" id="nb-scan" checked style="width:auto;min-height:0"> Noir et blanc (plus lisible)
      </label>
      <div class="actions">
        <button type="button" id="btn-creer-pdf" disabled>Créer le PDF</button>
        <button class="secondaire" type="button" id="btn-annuler-scan">Annuler</button>
      </div>
    </div>`;

  const champ = document.getElementById('page-scan');
  const boutonPage = document.getElementById('btn-page');
  const apercus = document.getElementById('pages-scan');
  const creer = document.getElementById('btn-creer-pdf');
  const rafraichir = () => {
    apercus.innerHTML = pages.map((pg, i) => `
      <figure><img src="${pg.url}" alt="Page ${i + 1}">
        <figcaption class="doux">Page ${i + 1} <button class="lien" type="button" data-retirer="${i}">Retirer</button></figcaption>
      </figure>`).join('');
    boutonPage.textContent = `Prendre la page ${pages.length + 1} en photo`;
    creer.disabled = !pages.length;
    creer.textContent = pages.length > 1 ? `Créer le PDF (${pages.length} pages)` : 'Créer le PDF';
  };

  boutonPage.addEventListener('click', () => champ.click());
  champ.addEventListener('change', () => {
    const fichier = champ.files[0];
    champ.value = '';
    if (!fichier) return;
    occuper(boutonPage, async () => {
      boutonPage.textContent = 'Préparation de la page…';
      const blob = await preparerPage(fichier, document.getElementById('nb-scan').checked);
      pages.push({ blob, url: URL.createObjectURL(blob) });
    }).then(rafraichir);
  });
  apercus.addEventListener('click', (e) => {
    const b = e.target.closest('[data-retirer]');
    if (!b) return;
    URL.revokeObjectURL(pages[b.dataset.retirer].url);
    pages.splice(Number(b.dataset.retirer), 1);
    rafraichir();
  });
  document.getElementById('btn-annuler-scan').addEventListener('click', () => {
    if (pages.length && !confirm('Abandonner les pages prises ?')) return;
    ongletDossier(contenu, p, 'documents', etat.utilisateur);
  });
  creer.addEventListener('click', () => occuper(creer, async () => {
    creer.textContent = 'Création du PDF…';
    const donnees = new FormData();
    donnees.append('nom', document.getElementById('nom-scan').value);
    pages.forEach((pg, i) => donnees.append('pages', pg.blob, `page-${i + 1}.jpg`));
    await api(`/api/projets/${p.id}/scanner`, { method: 'POST', body: donnees });
    pages.forEach((pg) => URL.revokeObjectURL(pg.url));
    avis('Document scanné ajouté.');
    ongletDossier(contenu, p, 'documents', etat.utilisateur);
  }));
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

// ---------- Messagerie avec le bureau ----------
async function vueConversations() {
  const { conversations } = await api('/api/bureau/messagerie');
  const apercu = (c) => (c.dernier_le ? `${c.dernier_photo && !c.dernier_texte ? '📷 Photo' : h(c.dernier_texte || '').slice(0, 80)} · ${heure(c.dernier_le)}`
    : 'Aucun message');
  vue.innerHTML = `${ongletsBureau('messages')}
    <div id="carte-notifications"></div>
    <p class="doux">Chaque employé a sa conversation privée avec le bureau.</p>
    <div class="carte"><ul class="liste">${conversations.map((c) => `
      <li>
        <div class="infos"><a href="#messages/${c.id}"><strong>${h(c.nom)}</strong></a>
          ${c.non_lus ? `<span class="compteur">${c.non_lus}</span>` : ''}
          <div class="doux">${apercu(c)}</div></div>
        <a class="bouton secondaire" href="#messages/${c.id}">Ouvrir</a>
      </li>`).join('') || '<li class="vide">Aucun employé pour l\'instant.</li>'}</ul></div>`;
  carteNotifications(document.getElementById('carte-notifications'));
}

function bulleMessagerie(m) {
  const moi = etat.utilisateur;
  const photo = `/api/messagerie/${m.id}/photo`;
  const qui = moi.role !== 'bureau' && m.du_bureau ? `Bureau (${h(m.auteur)})` : h(m.auteur);
  return `
    <li class="message ${m.auteur_id === moi.id ? 'moi' : ''}" data-id="${m.id}">
      <div class="doux"><strong>${qui}</strong> · ${heure(m.cree_le)}
        ${m.auteur_id === moi.id ? `<button class="lien" type="button" data-effacer="${m.id}">Effacer</button>` : ''}</div>
      ${m.photo ? `<a href="${photo}" target="_blank" rel="noopener"><img src="${photo}" alt="Photo envoyée" loading="lazy"></a>` : ''}
      ${m.texte ? `<div class="texte">${h(m.texte)}</div>` : ''}
    </li>`;
}

// ---------- Notifications sur le téléphone ----------
// iPhone : les notifications ne marchent que si l'app est ajoutée à l'écran d'accueil et ouverte depuis son icône.
const notificationsPossibles = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const iphoneHorsEcranAccueil = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;

async function abonnementActuel() {
  if (!notificationsPossibles() || Notification.permission !== 'granted') return null;
  const enregistrement = await navigator.serviceWorker.ready;
  return enregistrement.pushManager.getSubscription();
}

async function activerNotifications() {
  if (await Notification.requestPermission() !== 'granted') {
    throw new Error('Les notifications sont bloquées. Autorise-les dans les réglages du téléphone pour cette app.');
  }
  const { cle } = await api('/api/notifications/cle');
  const enregistrement = await navigator.serviceWorker.ready;
  const abonnement = await enregistrement.pushManager.getSubscription()
    || await enregistrement.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(cle.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) });
  await api('/api/notifications/abonnement', { method: 'POST', json: abonnement.toJSON() });
}

async function desabonnerNotifications() {
  try {
    const abonnement = await abonnementActuel();
    if (!abonnement) return;
    await api('/api/notifications/abonnement', { method: 'DELETE', json: { endpoint: abonnement.endpoint } });
    await abonnement.unsubscribe();
  } catch { /* hors ligne : le serveur oubliera l'appareil au prochain envoi refusé */ }
}

// Carte affichée en haut des messages tant que ce téléphone ne reçoit pas les notifications.
async function carteNotifications(conteneur) {
  if (iphoneHorsEcranAccueil()) {
    conteneur.innerHTML = `<div class="carte doux">Pour recevoir une notification à chaque message sur iPhone :
      touche Partager, puis « Sur l'écran d'accueil », et ouvre Vapro GUS depuis son icône.</div>`;
    return;
  }
  if (!notificationsPossibles()) return;
  const abonnement = await abonnementActuel().catch(() => null);
  if (abonnement) {
    // Rattache l'appareil au compte connecté (utile si quelqu'un d'autre s'est connecté avant sur ce téléphone).
    api('/api/notifications/abonnement', { method: 'POST', json: abonnement.toJSON() }).catch(() => {});
    return;
  }
  conteneur.innerHTML = `<div class="carte"><p style="margin-top:0">Reçois une notification sur ce téléphone quand un message arrive.</p>
    <button type="button" id="btn-notifications">Activer les notifications</button></div>`;
  const bouton = document.getElementById('btn-notifications');
  bouton.addEventListener('click', () => occuper(bouton, async () => {
    await activerNotifications();
    conteneur.innerHTML = '';
    avis('Notifications activées sur ce téléphone.');
  }));
}

// Employé : sa conversation avec le bureau. Bureau : la conversation d'un employé (employeId).
async function vueMessagerie(employeId) {
  const ancre = location.hash;
  const chemin = employeId ? `/api/bureau/messagerie/${employeId}` : '/api/messagerie';
  const { messages, employe } = await api(chemin);
  let dernier = messages.at(-1)?.id || 0;
  vue.innerHTML = `${ongletsBureau('messages')}
    <div id="carte-notifications"></div>
    ${employe ? `<p><a href="#messages">← Toutes les conversations</a></p><h1>${h(employe.nom)}</h1>`
      : '<h1>Messages au bureau</h1><p class="doux">Seul le bureau voit cette conversation.</p>'}
    <div class="carte"><ul class="liste fil" id="fil">${messages.map(bulleMessagerie).join('')
      || `<li class="vide" id="fil-vide">${employe ? 'Aucun message avec cet employé.' : 'Aucun message. Écris au bureau ici.'}</li>`}</ul></div>
    <form class="carte composer" id="f-message">
      <input type="file" id="photo" accept="image/*" hidden>
      <textarea name="texte" rows="3" placeholder="${employe ? `Écris à ${h(employe.nom)}…` : 'Écris au bureau…'}"></textarea>
      <div class="doux" id="photo-choisie" hidden></div>
      <div class="actions">
        <button class="secondaire" type="button" id="btn-photo">Ajouter une photo</button>
        <button>Envoyer</button>
      </div>
    </form>`;
  majNonLus();
  carteNotifications(document.getElementById('carte-notifications'));

  const fil = document.getElementById('fil');
  fil.lastElementChild?.scrollIntoView({ block: 'nearest' });
  const ajouter = (liste) => {
    if (!liste.length) return;
    document.getElementById('fil-vide')?.remove();
    for (const m of liste) {
      if (fil.querySelector(`[data-id="${m.id}"]`)) continue;
      fil.insertAdjacentHTML('beforeend', bulleMessagerie(m));
      dernier = Math.max(dernier, m.id);
    }
  };

  const form = document.getElementById('f-message');
  const champ = document.getElementById('photo');
  const choisie = document.getElementById('photo-choisie');
  document.getElementById('btn-photo').addEventListener('click', () => champ.click());
  champ.addEventListener('change', () => {
    choisie.hidden = !champ.files[0];
    choisie.textContent = champ.files[0] ? `Photo prête à envoyer : ${champ.files[0].name}` : '';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texte = form.texte.value.trim();
    if (!texte && !champ.files[0]) { avis('Écris un message ou ajoute une photo.'); return; }
    occuper(form.querySelector('button:not([type])'), async () => {
      const donnees = new FormData();
      donnees.append('texte', texte);
      if (champ.files[0]) donnees.append('photo', await reduireImage(champ.files[0]));
      const { message } = await api(chemin, { method: 'POST', body: donnees });
      ajouter([message]);
      form.reset();
      choisie.hidden = true;
      fil.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  fil.addEventListener('click', (e) => {
    const bouton = e.target.closest('[data-effacer]');
    if (!bouton || !confirm('Effacer ce message ?')) return;
    occuper(bouton, async () => {
      await api(`/api/messagerie/${bouton.dataset.effacer}`, { method: 'DELETE' });
      bouton.closest('li').remove();
    });
  });

  // Réponses : vérifiées toutes les 10 secondes tant que la conversation est ouverte.
  const minuterie = setInterval(async () => {
    if (location.hash !== ancre || !document.body.contains(fil)) { clearInterval(minuterie); return; }
    if (document.hidden) return;
    try { ajouter((await api(`${chemin}?apres=${dernier}`)).messages); } catch { /* réseau : on réessaie */ }
  }, 10000);
}

// ---------- Punch ----------
const dateSql = (t) => new Date(`${t.replace(' ', 'T')}Z`);
const heureCourte = (t) => dateSql(t).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });
const jourCourt = (t) => dateSql(t).toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' });
const duree = (ms) => {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
};
const dureeQuart = (p, maintenant) => (p.fin ? dateSql(p.fin) : maintenant) - dateSql(p.debut);
// Lundi 0 h (heure locale) de la semaine qui contient la date.
function lundi(d) {
  const l = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  l.setDate(l.getDate() - ((l.getDay() + 6) % 7));
  return l;
}

// Jour « AAAA-MM-JJ » à l'heure du Québec, comme le serveur le calcule.
const jourQc = (t) => new Date(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
// Heures décimales (7.5) affichées « 7 h 30 », avec le signe si négatif.
const heuresDec = (n) => `${n < 0 ? '−' : ''}${duree(Math.abs(n) * 3600000)}`;
const NOMS_BANQUES = { banque: 'Banque d\'heures', vacances: 'Vacances', maladie: 'Maladie' };
const tuilesSoldes = (s) => `<div class="soldes">${Object.entries(NOMS_BANQUES).map(([cle, nom]) => `
  <div class="solde ${s[cle] < 0 ? 'negatif' : ''}"><span class="doux">${nom}</span><strong>${heuresDec(s[cle])}</strong></div>`).join('')}</div>`;

async function vuePunch() {
  const ancre = location.hash || '#punch';
  const [{ enCours, recents }, mesHeures] = await Promise.all([api('/api/punch'), api('/api/mes-heures')]);
  const debutSemaine = lundi(new Date());
  const cetteSemaine = recents.filter((p) => dateSql(p.debut) >= debutSemaine);
  vue.innerHTML = `${ongletsBureau('punch')}
    <div class="carte punch ${enCours ? 'en-quart' : ''}">
      <div class="doux">${enCours ? `En quart depuis ${heureCourte(enCours.debut)}` : 'Tu n\'es pas en quart.'}</div>
      <div class="chrono" id="chrono">${enCours ? duree(Date.now() - dateSql(enCours.debut)) : '—'}</div>
      ${enCours?.note ? `<div class="doux">${h(enCours.note)}</div>` : ''}
    </div>
    ${enCours ? '' : '<input id="note-quart" placeholder="Chantier ou note (facultatif)" maxlength="500">'}
    <button class="geant ${enCours ? 'danger' : 'succes'}" type="button" id="btn-punch">${enCours ? 'Terminer mon quart' : 'Commencer mon quart'}</button>
    <h2>Mes banques</h2>
    ${tuilesSoldes(mesHeures.soldes)}
    <h2>Cette semaine : ${heuresDec(mesHeures.semaines.find((sem) => sem.lundi === jourQc(debutSemaine.toISOString()))?.heures || 0)}</h2>
    ${mesHeures.regles.dinerMinutes ? `<p class="doux">${mesHeures.regles.dinerMinutes} min de dîner non payées sont retirées chaque jour de ${
      String(mesHeures.regles.dinerSeuil).replace('.', ',')} h et plus, sauf si le bureau les paie.</p>` : ''}
    <div class="carte"><ul class="liste">${cetteSemaine.map((p) => `
      <li><div class="infos"><strong>${jourCourt(p.debut)}</strong>
        <div class="doux">${heureCourte(p.debut)} à ${p.fin ? heureCourte(p.fin) : 'en cours'}${p.note ? ` · ${h(p.note)}` : ''}</div></div>
        <strong>${duree(dureeQuart(p, Date.now()))}</strong></li>`).join('') || '<li class="vide">Aucun quart cette semaine.</li>'}</ul></div>
    <p class="doux">Un oubli ou une erreur ? Écris au bureau dans Messages, il peut corriger tes heures.</p>
    <h2>Semaines passées</h2>
    <div class="carte"><ul class="liste">${mesHeures.semaines.filter((sem) => new Date(`${sem.lundi}T00:00:00`) < debutSemaine).map((sem) => `
      <li><div class="infos"><strong>Semaine du ${new Date(`${sem.lundi}T12:00:00`).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>
        ${sem.banque ? `<div class="doux">+ ${heuresDec(sem.banque)} en banque</div>` : ''}</div>
        <strong>${heuresDec(sem.heures)}</strong></li>`).join('') || '<li class="vide">Aucune semaine pour l\'instant.</li>'}</ul></div>
    ${mesHeures.mouvements.length ? `<h2>Congés et ajustements</h2>
    <div class="carte"><ul class="liste">${mesHeures.mouvements.map((m) => `
      <li><div class="infos"><strong>${NOMS_BANQUES[m.type]}</strong>
        <div class="doux">${new Date(`${m.date}T12:00:00`).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' })}${m.note ? ` · ${h(m.note)}` : ''}</div></div>
        <strong>${m.heures > 0 ? '+' : ''}${heuresDec(m.heures)}</strong></li>`).join('')}</ul></div>` : ''}`;

  const bouton = document.getElementById('btn-punch');
  bouton.addEventListener('click', () => {
    if (enCours && !confirm('Terminer ton quart maintenant ?')) return;
    occuper(bouton, async () => {
      if (enCours) await api('/api/punch/fin', { method: 'POST' });
      else await api('/api/punch/debut', { method: 'POST', json: { note: document.getElementById('note-quart').value } });
      avis(enCours ? 'Quart terminé. Bon retour !' : 'Quart commencé. Bonne journée !');
      route();
    });
  });

  if (enCours) {
    const minuterie = setInterval(() => {
      const chrono = document.getElementById('chrono');
      if (!chrono || (location.hash || '#punch') !== ancre) { clearInterval(minuterie); return; }
      chrono.textContent = duree(Date.now() - dateSql(enCours.debut));
    }, 30000);
  }
}

// Valeur pour <input type="datetime-local"> à l'heure locale.
const versChamp = (t) => {
  const d = dateSql(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const depuisChamp = (v) => (v ? new Date(v).toISOString() : '');

// Employés dépliés dans l'onglet Heures : ils restent ouverts quand l'écran se rafraîchit (ex. après « Payer le dîner »).
const heuresOuvertes = new Set();

async function vueHeures(semaineChoisie) {
  const debut = lundi(semaineChoisie ? new Date(`${semaineChoisie}T12:00:00`) : new Date());
  const fin = new Date(debut);
  fin.setDate(fin.getDate() + 7);
  const cle = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const precedente = new Date(debut);
  precedente.setDate(precedente.getDate() - 7);
  const periode = `du=${encodeURIComponent(debut.toISOString())}&au=${encodeURIComponent(fin.toISOString())}`;
  const [{ employes, punchs, jours }, banques] = await Promise.all([api(`/api/bureau/heures?${periode}`), api('/api/bureau/soldes')]);
  const soldesDe = (id) => banques.employes.find((x) => x.id === id)?.soldes;
  const maintenant = Date.now();
  const titre = `${debut.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' })} au ${
    new Date(fin - 86400000).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const enQuart = punchs.filter((p) => !p.fin);

  vue.innerHTML = `${ongletsBureau('heures')}
    <div class="semaine">
      <a class="bouton secondaire" href="#heures/${cle(precedente)}">←</a>
      <strong>${titre}</strong>
      ${fin <= new Date() ? `<a class="bouton secondaire" href="#heures/${cle(fin)}">→</a>` : '<span></span>'}
    </div>
    ${enQuart.length ? `<div class="carte">En quart maintenant : ${enQuart.map((p) =>
      `<strong>${h(employes.find((e) => e.id === p.employe_id)?.nom)}</strong> depuis ${heureCourte(p.debut)}`).join(', ')}</div>` : ''}
    <div class="actions"><a class="bouton secondaire" href="/api/bureau/heures.csv?${periode}" download>Exporter pour la paie (Excel)</a></div>
    ${employes.map((e) => {
      const siens = punchs.filter((p) => p.employe_id === e.id);
      const journees = jours.filter((j) => j.employe_id === e.id).sort((a, b) => a.jour.localeCompare(b.jour));
      return `<details class="carte heures-employe" data-employe="${e.id}" ${heuresOuvertes.has(e.id) ? 'open' : ''}>
        <summary><strong>${h(e.nom)}</strong><span>${heuresDec(journees.reduce((t, j) => t + j.payees, 0))}</span>
        ${soldesDe(e.id) ? `<div class="doux soldes-ligne">Banque ${heuresDec(soldesDe(e.id).banque)} · Vacances ${heuresDec(soldesDe(e.id).vacances)} · Maladie ${heuresDec(soldesDe(e.id).maladie)}
          · <a href="#banques/${e.id}">Banques et congés</a></div>` : ''}</summary>
        ${journees.map((j) => `
          <div class="journee">
            <div class="entete-jour"><strong>${new Date(`${j.jour}T12:00:00`).toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'short' })}</strong>
              <span>${heuresDec(j.payees)} payées</span></div>
            ${j.dinerApplicable ? `<button class="diner ${j.dinerPaye ? 'paye' : ''}" type="button" data-diner="${e.id}|${j.jour}|${j.dinerPaye ? '' : '1'}">
              ${j.dinerPaye ? '✓ Dîner payé (pas de dîner pris)' : `Dîner −${banques.regles.dinerMinutes} min · Payer le dîner`}</button>` : ''}
            <ul class="liste">${siens.filter((p) => jourQc(p.debut) === j.jour).map((p) => `
              <li class="quart" data-id="${p.id}">
                <div class="infos">${heureCourte(p.debut)} à ${p.fin ? heureCourte(p.fin) : 'en cours'}
                  <div class="doux">${duree(dureeQuart(p, maintenant))}${p.note ? ` · ${h(p.note)}` : ''}${p.modifie_par ? ` · corrigé par ${h(p.modifie_par)}` : ''}</div></div>
                <button class="lien" type="button" data-corriger="${p.id}">Corriger</button>
              </li>`).join('')}</ul>
          </div>`).join('') || '<p class="vide">Aucun quart cette semaine.</p>'}
        <button class="secondaire" type="button" data-ajouter="${e.id}">Ajouter un quart oublié</button>
      </details>`;
    }).join('') || '<div class="carte vide">Aucun employé pour l\'instant.</div>'}
    <details class="carte">
      <summary><strong>Règles des banques</strong></summary>
      <form id="f-regles">
        <label>Heures normales par semaine (au-delà : banque)<input name="semaine" type="number" step="0.5" min="1" max="80" value="${banques.regles.semaine}"></label>
        <label>Heure supplémentaire mise en banque à<select name="multiplicateurBanque">
          ${[[1, 'temps simple (1 h = 1 h)'], [1.5, 'temps et demi (1 h = 1 h 30)'], [2, 'temps double (1 h = 2 h)']].map(([v, t]) =>
            `<option value="${v}" ${banques.regles.multiplicateurBanque === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Vacances : % des heures travaillées (par défaut)<input name="tauxVacances" type="number" step="0.5" min="0" max="20" value="${banques.regles.tauxVacances}"></label>
        <label>Heures de maladie payées par année<input name="maladieAnnuelle" type="number" step="0.5" min="0" max="200" value="${banques.regles.maladieAnnuelle}"></label>
        <label>Dîner non payé retiré chaque jour (minutes, 0 pour aucun)<input name="dinerMinutes" type="number" step="5" min="0" max="120" value="${banques.regles.dinerMinutes}"></label>
        <label>…quand la journée compte au moins (heures)<input name="dinerSeuil" type="number" step="0.5" min="0" max="24" value="${banques.regles.dinerSeuil}"></label>
        <div class="actions"><button>Enregistrer les règles</button></div>
      </form>
    </details>`;
  vue.querySelectorAll('details[data-employe]').forEach((d) => d.addEventListener('toggle', () => {
    heuresOuvertes[d.open ? 'add' : 'delete'](Number(d.dataset.employe));
  }));
  const formRegles = document.getElementById('f-regles');
  formRegles.addEventListener('submit', (ev) => {
    ev.preventDefault();
    occuper(formRegles.querySelector('button'), async () => {
      await api('/api/bureau/regles-heures', { method: 'PUT', json: lireFormulaire(formRegles) });
      avis('Règles enregistrées. Les soldes sont recalculés.');
      route();
    });
  });

  const formulaire = (p, employeId) => `
    <form class="carte correction">
      <label>Début<input type="datetime-local" name="debut" value="${p ? versChamp(p.debut) : ''}" required></label>
      <label>Fin<input type="datetime-local" name="fin" value="${p?.fin ? versChamp(p.fin) : ''}" ${p ? '' : 'required'}></label>
      <div class="actions">
        <button>Enregistrer</button>
        <button class="secondaire" type="button" data-annuler>Annuler</button>
        ${p ? '<button class="danger" type="button" data-supprimer>Supprimer</button>' : ''}
      </div>
    </form>`;

  vue.onclick = (e) => {
    const diner = e.target.closest('[data-diner]');
    if (diner) {
      const [employeId, jour, paye] = diner.dataset.diner.split('|');
      occuper(diner, async () => {
        await api('/api/bureau/diners', { method: 'POST', json: { employe_id: Number(employeId), jour, paye: Boolean(paye) } });
        route();
      });
      return;
    }
    const corriger = e.target.closest('[data-corriger]');
    const ajouter = e.target.closest('[data-ajouter]');
    if (!corriger && !ajouter) return;
    vue.querySelector('form.correction')?.remove();
    const p = corriger && punchs.find((x) => x.id === Number(corriger.dataset.corriger));
    const ancrage = corriger ? corriger.closest('li') : ajouter;
    ancrage.insertAdjacentHTML('afterend', formulaire(p));
    const form = vue.querySelector('form.correction');
    form.querySelector('[data-annuler]').onclick = () => form.remove();
    form.querySelector('[data-supprimer]')?.addEventListener('click', (ev) => {
      if (!confirm('Supprimer ce quart ?')) return;
      occuper(ev.currentTarget, async () => {
        await api(`/api/bureau/punchs/${p.id}`, { method: 'DELETE' });
        avis('Quart supprimé.');
        route();
      });
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      occuper(form.querySelector('button:not([type])'), async () => {
        const json = { debut: depuisChamp(form.debut.value), fin: depuisChamp(form.fin.value) || null };
        if (p) await api(`/api/bureau/punchs/${p.id}`, { method: 'PATCH', json });
        else await api('/api/bureau/punchs', { method: 'POST', json: { ...json, employe_id: Number(ajouter.dataset.ajouter) } });
        avis('Heures enregistrées.');
        route();
      });
    });
  };
}

// Bureau : soldes d'un employé, congés pris, soldes de départ et ajustements.
async function vueBanques(employeId) {
  const [{ employes, regles }, { mouvements }] = await Promise.all([
    api('/api/bureau/soldes'), api(`/api/bureau/mouvements/${employeId}`)]);
  const e = employes.find((x) => x.id === employeId);
  if (!e) { location.hash = 'heures'; return; }
  const aujourdhui = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  vue.innerHTML = `${ongletsBureau('heures')}
    <p><a href="#heures">← Heures</a></p>
    <h1>${h(e.nom)}</h1>
    ${tuilesSoldes(e.soldes)}
    <form class="carte" id="f-mouvement">
      <h2 style="margin-top:0">Inscrire</h2>
      <label>Banque<select name="type">${Object.entries(NOMS_BANQUES).map(([cle, nom]) => `<option value="${cle}">${nom}</option>`).join('')}</select></label>
      <label>Quoi<select name="sens"><option value="-1">Congé pris (retire du solde)</option><option value="1">Solde de départ ou ajout</option></select></label>
      <label>Heures<input name="heures" type="number" step="0.25" min="0.25" max="2000" required></label>
      <label>Date<input name="date" type="date" value="${aujourdhui}" required></label>
      <label>Note (facultatif)<input name="note" maxlength="300"></label>
      <div class="actions"><button>Inscrire</button></div>
    </form>
    <form class="carte" id="f-taux">
      <label>Taux de vacances de ${h(e.nom)} (%)<input name="taux_vacances" type="number" step="0.5" min="0" max="20"
        value="${e.taux_vacances ?? ''}" placeholder="Par défaut : ${regles.tauxVacances}"></label>
      <p class="doux">Ex. 6 % après 3 ans de service. Laisse vide pour le taux par défaut.</p>
      <div class="actions"><button class="secondaire">Enregistrer le taux</button></div>
    </form>
    <h2>Historique</h2>
    <div class="carte"><ul class="liste">${mouvements.map((m) => `
      <li><div class="infos"><strong>${NOMS_BANQUES[m.type]} ${m.heures > 0 ? '+' : ''}${heuresDec(m.heures)}</strong>
        <div class="doux">${m.date}${m.note ? ` · ${h(m.note)}` : ''}${m.par ? ` · par ${h(m.par)}` : ''}</div></div>
        <button class="lien" type="button" data-annuler-mvt="${m.id}">Annuler</button></li>`).join('')
      || '<li class="vide">Rien d\'inscrit. Commence par les soldes de départ (vacances déjà accumulées, banque, etc.).</li>'}</ul></div>`;

  const form = document.getElementById('f-mouvement');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const d = lireFormulaire(form);
    occuper(form.querySelector('button'), async () => {
      await api('/api/bureau/mouvements', { method: 'POST', json: {
        employe_id: employeId, type: d.type, heures: Number(d.sens) * Number(d.heures), date: d.date, note: d.note } });
      avis('Inscrit.');
      route();
    });
  });
  const formTaux = document.getElementById('f-taux');
  formTaux.addEventListener('submit', (ev) => {
    ev.preventDefault();
    occuper(formTaux.querySelector('button'), async () => {
      await api(`/api/bureau/soldes/${employeId}`, { method: 'PATCH', json: { taux_vacances: formTaux.taux_vacances.value } });
      avis('Taux enregistré.');
      route();
    });
  });
  vue.onclick = (ev) => {
    const b = ev.target.closest('[data-annuler-mvt]');
    if (!b || !confirm('Annuler cette inscription ?')) return;
    occuper(b, async () => {
      await api(`/api/bureau/mouvements/${b.dataset.annulerMvt}`, { method: 'DELETE' });
      route();
    });
  };
}

async function vueEmployes() {
  const { utilisateurs } = await api('/api/bureau/utilisateurs');
  vue.innerHTML = `${ongletsBureau('employes')}
    <div class="carte"><ul class="liste">${utilisateurs.map((u) => `
      <li class="employe">
        <div class="infos"><strong>${h(u.nom)}</strong>
          <div class="doux">${h(u.identifiant)} · ${u.role === 'bureau' ? 'Bureau' : u.chef_projet ? 'Chargé de projet' : 'Employé'}${u.actif ? '' : ' · désactivé'}</div></div>
        ${u.role === 'bureau' ? '' : `<button class="secondaire" data-chef="${u.id}" data-valeur="${u.chef_projet ? 0 : 1}" type="button">
          ${u.chef_projet ? 'Retirer chargé de projet' : 'Nommer chargé de projet'}</button>`}
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
  vue.querySelectorAll('[data-chef]').forEach((b) => b.addEventListener('click', () => occuper(b, async () => {
    await api(`/api/bureau/utilisateurs/${b.dataset.chef}`, { method: 'PATCH', json: { chef_projet: b.dataset.valeur === '1' } });
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
