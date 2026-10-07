// Projets : création par le bureau, notes partagées, fil de messages et photos entre employés.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirBase } from '../src/db.js';
import { creerApp } from '../src/app.js';
import { creerQuickBooksDemo } from '../src/quickbooks.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
// Plus petit JPEG valide (1 × 1 pixel, niveaux de gris).
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let serveur, base, dossier;

before(async () => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'projets-'));
  const app = creerApp({
    db: ouvrirBase(':memory:'), qbo: creerQuickBooksDemo(), lecteur: { actif: false, lire: async () => null },
    dossierFichiers: path.join(dossier, 'f'),
  });
  await new Promise((ok) => { serveur = app.listen(0, ok); });
  base = `http://127.0.0.1:${serveur.address().port}`;
});
after(() => { serveur.close(); fs.rmSync(dossier, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (chemin, { method = 'GET', json, body } = {}) => {
    const headers = cookie ? { cookie } : {};
    if (json) headers['Content-Type'] = 'application/json';
    const rep = await fetch(base + chemin, { method, headers, body: json ? JSON.stringify(json) : body });
    const c = rep.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    const type = rep.headers.get('content-type') || '';
    return { status: rep.status, corps: type.includes('json') ? await rep.json() : await rep.arrayBuffer() };
  };
}
const bureau = client();
const marc = client();
const julie = client();
let idProjet;

test('le bureau crée un projet, les employés le voient mais ne peuvent pas en créer', async () => {
  await bureau('/api/premier-compte', { method: 'POST', json: { nom: 'Nicolas', identifiant: 'nicolas', motDePasse: 'un-bon-mot-de-passe' } });
  for (const [nom, identifiant] of [['Marc', 'marc'], ['Julie', 'julie']]) {
    await bureau('/api/bureau/utilisateurs', { method: 'POST', json: { nom, identifiant, motDePasse: '4821' } });
  }
  await marc('/api/connexion', { method: 'POST', json: { identifiant: 'marc', motDePasse: '4821' } });
  await julie('/api/connexion', { method: 'POST', json: { identifiant: 'julie', motDePasse: '4821' } });

  assert.equal((await marc('/api/projets', { method: 'POST', json: { nom: 'X' } })).status, 403);
  assert.equal((await bureau('/api/projets', { method: 'POST', json: { nom: ' ' } })).status, 400);
  const r = await bureau('/api/projets', { method: 'POST', json: { nom: 'Toiture Tremblay', adresse: '12 rue des Pins' } });
  assert.equal(r.status, 201);
  idProjet = r.corps.projet.id;
  assert.deepEqual((await marc('/api/projets')).corps.projets.map((p) => p.nom), ['Toiture Tremblay']);
  assert.equal((await client()('/api/projets')).status, 401);
});

test('notes partagées : modifiables par tous, nom et archivage réservés au bureau', async () => {
  const r = await marc(`/api/projets/${idProjet}`, { method: 'PATCH', json: { notes: 'Bardeaux noirs, 32 paquets' } });
  assert.equal(r.status, 200);
  assert.equal((await julie(`/api/projets/${idProjet}`)).corps.projet.notes, 'Bardeaux noirs, 32 paquets');
  assert.equal((await marc(`/api/projets/${idProjet}`, { method: 'PATCH', json: { nom: 'Autre' } })).status, 403);
});

test('fil du projet : messages, photo, nouveaux messages seulement, suppression', async () => {
  assert.equal((await marc(`/api/projets/${idProjet}/messages`, { method: 'POST', json: { texte: '' } })).status, 400);
  const m1 = await marc(`/api/projets/${idProjet}/messages`, { method: 'POST', json: { texte: 'Arrivé sur place' } });
  assert.equal(m1.status, 201);
  assert.equal(m1.corps.message.auteur, 'Marc');

  const form = new FormData();
  form.append('texte', 'Avant les travaux');
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'toit.png');
  const m2 = await julie(`/api/projets/${idProjet}/messages`, { method: 'POST', body: form });
  assert.equal(m2.status, 201);
  assert.equal(m2.corps.message.photo, 1);
  const photo = await marc(`/api/projets/${idProjet}/messages/${m2.corps.message.id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(Buffer.from(photo.corps).length, PNG.length);

  const nouveaux = (await marc(`/api/projets/${idProjet}?apres=${m1.corps.message.id}`)).corps.messages;
  assert.deepEqual(nouveaux.map((m) => m.texte), ['Avant les travaux']);

  assert.equal((await marc(`/api/projets/${idProjet}/messages/${m2.corps.message.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await julie(`/api/projets/${idProjet}/messages/${m2.corps.message.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc(`/api/projets/${idProjet}`)).corps.messages.length, 1);
});

test('dossiers Photos et Documents : dépôt, liste, téléchargement, types refusés, suppression', async () => {
  const photo = new FormData();
  photo.append('fichier', new Blob([PNG], { type: 'image/png' }), 'facade.png');
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos`, { method: 'POST', body: photo })).status, 201);

  const pdfDansPhotos = new FormData();
  pdfDansPhotos.append('fichier', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'plan.pdf');
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos`, { method: 'POST', body: pdfDansPhotos })).status, 400);

  const plan = new FormData();
  plan.append('fichier', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'plan-étage.pdf');
  const d = await julie(`/api/projets/${idProjet}/dossiers/documents`, { method: 'POST', body: plan });
  assert.equal(d.status, 201);
  const devis = new FormData();
  devis.append('fichier', new Blob(['a,b'], { type: 'text/csv' }), 'devis.csv');
  assert.equal((await julie(`/api/projets/${idProjet}/dossiers/documents`, { method: 'POST', body: devis })).status, 201);
  const exe = new FormData();
  exe.append('fichier', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'virus.exe');
  assert.equal((await julie(`/api/projets/${idProjet}/dossiers/documents`, { method: 'POST', body: exe })).status, 400);
  assert.equal((await julie(`/api/projets/${idProjet}/dossiers/autre`)).status, 404);

  // Le dossier Photos réunit les photos déposées et celles envoyées dans la discussion.
  const discussion = new FormData();
  discussion.append('photo', new Blob([PNG], { type: 'image/png' }), 'chantier.png');
  await marc(`/api/projets/${idProjet}/messages`, { method: 'POST', body: discussion });
  const photos = (await julie(`/api/projets/${idProjet}/dossiers/photos`)).corps.fichiers;
  assert.deepEqual(photos.map((f) => f.source).sort(), ['discussion', 'dossier']);
  for (const f of photos) assert.equal((await julie(f.url)).status, 200);

  const docs = (await marc(`/api/projets/${idProjet}/dossiers/documents`)).corps.fichiers;
  assert.deepEqual(docs.map((f) => f.nom_original).sort(), ['devis.csv', 'plan-étage.pdf']);
  const telechargement = await fetch(base + docs.find((f) => f.nom_original === 'devis.csv').url, {
    headers: { cookie: (await (async () => {
      const r = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'marc', motDePasse: '4821' }) });
      return r.headers.get('set-cookie').split(';')[0];
    })()) },
  });
  assert.match(telechargement.headers.get('content-disposition'), /attachment; filename="devis.csv"/);

  const idPlan = d.corps.fichier.id;
  assert.equal((await marc(`/api/projets/${idProjet}/fichiers/${idPlan}`, { method: 'DELETE' })).status, 404);
  assert.equal((await bureau(`/api/projets/${idProjet}/fichiers/${idPlan}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/documents`)).corps.fichiers.length, 1);
  const liste = (await marc('/api/projets')).corps.projets[0];
  assert.deepEqual([liste.nb_photos, liste.nb_documents], [2, 1]);
});

test('un projet archivé disparaît pour les employés et reste visible au bureau', async () => {
  await bureau(`/api/projets/${idProjet}`, { method: 'PATCH', json: { actif: false } });
  assert.equal((await marc('/api/projets')).corps.projets.length, 0);
  assert.equal((await marc(`/api/projets/${idProjet}`)).status, 404);
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/documents`)).status, 404);
  assert.equal((await bureau('/api/projets?archives=1')).corps.projets.length, 1);
});

test('scanner : les pages photographiées deviennent un PDF dans Documents', async () => {
  // Le projet a été archivé au test précédent : on le réactive.
  await bureau(`/api/projets/${idProjet}`, { method: 'PATCH', json: { actif: true } });
  const form = new FormData();
  form.append('nom', 'Permis de construction');
  for (let i = 0; i < 2; i += 1) form.append('pages', new Blob([JPEG], { type: 'image/jpeg' }), `page${i}.jpg`);
  const r = await marc(`/api/projets/${idProjet}/scanner`, { method: 'POST', body: form });
  assert.equal(r.status, 201);
  assert.equal(r.corps.fichier.nom_original, 'Permis de construction.pdf');
  assert.equal(r.corps.fichier.pages, 2);

  const pdf = Buffer.from((await marc(`/api/projets/${idProjet}/fichiers/${r.corps.fichier.id}`)).corps).toString('latin1');
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /\/Count 2/);
  // Chaque entrée de la table xref pointe bien sur son objet.
  const debut = Number(pdf.match(/startxref\n(\d+)/)[1]);
  const entrees = pdf.slice(debut).split('\n').slice(3).filter((l) => / n $/.test(l));
  entrees.forEach((l, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, Number(l.slice(0, 10)))));

  const vide = await marc(`/api/projets/${idProjet}/scanner`, { method: 'POST', body: new FormData() });
  assert.equal(vide.status, 400);
});

test('sous-dossiers de photos : création et renommage par les employés, rangement, suppression', async () => {
  const url = `/api/projets/${idProjet}/albums`;
  assert.equal((await marc(url, { method: 'POST', json: { nom: ' ' } })).status, 400);
  const a = await marc(url, { method: 'POST', json: { nom: 'Avant' } });
  assert.equal(a.status, 201);
  const idAvant = a.corps.album.id;
  const r = await julie(`${url}/${idAvant}`, { method: 'PATCH', json: { nom: 'Avant les travaux' } });
  assert.equal(r.corps.album.nom, 'Avant les travaux');
  const idToit = (await julie(url, { method: 'POST', json: { nom: 'Toiture' } })).corps.album.id;

  // Dépôt directement dans un sous-dossier.
  const photo = new FormData();
  photo.append('album_id', String(idToit));
  photo.append('fichier', new Blob([PNG], { type: 'image/png' }), 'pignon.png');
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos`, { method: 'POST', body: photo })).status, 201);

  // Les photos déjà là (déposée et discussion) sont « non classées » ; on les range dans « Avant les travaux ».
  const nonClassees = (await marc(`/api/projets/${idProjet}/dossiers/photos?album=0`)).corps.fichiers;
  assert.equal(nonClassees.length, 2);
  const rangement = await marc(`${url}/ranger`, {
    method: 'POST', json: { album_id: idAvant, photos: nonClassees.map((f) => ({ source: f.source, id: f.id })) },
  });
  assert.equal(rangement.corps.ranges, 2);
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos?album=0`)).corps.fichiers.length, 0);
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos?album=${idAvant}`)).corps.fichiers.length, 2);
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos`)).corps.fichiers.length, 3);

  const albums = (await marc(url)).corps.albums;
  assert.deepEqual(albums.map((x) => [x.nom, x.nb_photos]), [['Avant les travaux', 2], ['Toiture', 1]]);

  // Seul le créateur ou le bureau supprime un sous-dossier ; ses photos reviennent dans « Non classées ».
  assert.equal((await julie(`${url}/${idAvant}`, { method: 'DELETE' })).status, 404);
  assert.equal((await marc(`${url}/${idAvant}`, { method: 'DELETE' })).status, 204);
  assert.equal((await marc(`/api/projets/${idProjet}/dossiers/photos?album=0`)).corps.fichiers.length, 2);
  assert.equal((await marc(url, { method: 'PATCH', json: {} })).status, 404);
});

test('un chargé de projet désigné par le bureau peut créer des projets', async () => {
  const { utilisateurs } = (await bureau('/api/bureau/utilisateurs')).corps;
  const idJulie = utilisateurs.find((u) => u.identifiant === 'julie').id;
  assert.equal((await julie('/api/projets', { method: 'POST', json: { nom: 'Agrandissement Roy' } })).status, 403);
  assert.equal((await marc(`/api/bureau/utilisateurs/${idJulie}`, { method: 'PATCH', json: { chef_projet: true } })).status, 403);

  assert.equal((await bureau(`/api/bureau/utilisateurs/${idJulie}`, { method: 'PATCH', json: { chef_projet: true } })).status, 200);
  assert.equal((await julie('/api/etat')).corps.utilisateur.chef_projet, 1);
  const r = await julie('/api/projets', { method: 'POST', json: { nom: 'Agrandissement Roy', adresse: '8 rang Saint-Paul' } });
  assert.equal(r.status, 201);
  assert.ok((await marc('/api/projets')).corps.projets.some((p) => p.nom === 'Agrandissement Roy'));
  assert.equal((await julie(`/api/projets/${r.corps.projet.id}`, { method: 'PATCH', json: { actif: false } })).status, 403);

  await bureau(`/api/bureau/utilisateurs/${idJulie}`, { method: 'PATCH', json: { chef_projet: false } });
  assert.equal((await julie('/api/projets', { method: 'POST', json: { nom: 'Autre' } })).status, 403);
});
