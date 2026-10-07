// Punch : l'employé commence et termine son quart dans l'app ; le bureau consulte et corrige les heures.
// Les heures sont gardées en UTC (« AAAA-MM-JJ HH:MM:SS », comme datetime('now') de SQLite).
import { exigerConnexion, exigerBureau } from './auth.js';
import { jours, jourLocal } from './banques.js';

const DUREE_MAX = 24 * 3600 * 1000;
const enDate = (t) => new Date(`${t.replace(' ', 'T')}Z`);
const versSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// Accepte une date ISO (avec fuseau) envoyée par le navigateur ; renvoie le format de la base ou null.
function lireMoment(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : versSql(d);
}

export function brancherPunch(app, { db }) {
  const ouvert = (employeId) => db.prepare('SELECT * FROM punchs WHERE employe_id = ? AND fin IS NULL').get(employeId);
  const punch = (id) => db.prepare('SELECT * FROM punchs WHERE id = ?').get(id);
  const employe = (id) => db.prepare("SELECT id, nom FROM utilisateurs WHERE id = ? AND role = 'employe'").get(id);

  // Vérifie un quart saisi ou corrigé par le bureau : fin après début, moins de 24 h, pas de chevauchement.
  function erreurQuart(employeId, debut, fin, sauf = 0) {
    if (!debut) return 'Indique l\'heure de début.';
    if (fin && enDate(fin) <= enDate(debut)) return 'La fin doit être après le début.';
    if (fin && enDate(fin) - enDate(debut) > DUREE_MAX) return 'Un quart ne peut pas dépasser 24 heures.';
    if (enDate(debut) > new Date(Date.now() + 5 * 60000)) return 'Le début ne peut pas être dans le futur.';
    const chevauche = db.prepare(`SELECT 1 FROM punchs WHERE employe_id = ? AND id != ?
      AND debut < COALESCE(?, '9999') AND COALESCE(fin, '9999') > ?`).get(employeId, sauf, fin, debut);
    return chevauche ? 'Ce quart chevauche un autre quart de cet employé.' : null;
  }

  // ---------- Employé ----------
  app.get('/api/punch', exigerConnexion, (req, res) => {
    const recents = db.prepare(`SELECT id, debut, fin, note FROM punchs WHERE employe_id = ?
      ORDER BY debut DESC LIMIT 30`).all(req.utilisateur.id);
    res.json({ enCours: ouvert(req.utilisateur.id) || null, recents, maintenant: versSql(new Date()) });
  });

  app.post('/api/punch/debut', exigerConnexion, (req, res) => {
    if (ouvert(req.utilisateur.id)) return res.status(409).json({ erreur: 'Ton quart est déjà commencé.' });
    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;
    const { lastInsertRowid } = db.prepare('INSERT INTO punchs (employe_id, debut, note) VALUES (?, ?, ?)')
      .run(req.utilisateur.id, versSql(new Date()), note);
    res.status(201).json({ punch: punch(Number(lastInsertRowid)) });
  });

  app.post('/api/punch/fin', exigerConnexion, (req, res) => {
    const p = ouvert(req.utilisateur.id);
    if (!p) return res.status(409).json({ erreur: 'Aucun quart en cours.' });
    db.prepare('UPDATE punchs SET fin = ? WHERE id = ?').run(versSql(new Date()), p.id);
    res.json({ punch: punch(p.id) });
  });

  // ---------- Bureau ----------
  // ?du=&au= : bornes ISO de la période (la semaine affichée, calculée à l'heure locale par le navigateur).
  app.get('/api/bureau/heures', exigerConnexion, exigerBureau, (req, res) => {
    const du = lireMoment(req.query.du);
    const au = lireMoment(req.query.au);
    if (!du || !au) return res.status(400).json({ erreur: 'Période invalide.' });
    const punchs = db.prepare(`SELECT p.id, p.employe_id, p.debut, p.fin, p.note, u.nom AS modifie_par
      FROM punchs p LEFT JOIN utilisateurs u ON u.id = p.modifie_par
      WHERE p.debut < ? AND COALESCE(p.fin, '9999') > ? ORDER BY p.debut`).all(au, du);
    const employes = db.prepare(`SELECT id, nom, actif FROM utilisateurs WHERE role = 'employe'
      AND (actif = 1 OR id IN (SELECT employe_id FROM punchs WHERE debut < ? AND COALESCE(fin, '9999') > ?)) ORDER BY nom`).all(au, du);
    // Journées de la période (heure du Québec) avec le dîner retiré ou payé.
    const premier = jourLocal(enDate(du));
    const dernier = jourLocal(new Date(enDate(au) - 1));
    const journees = employes.flatMap((e) => jours(db, e.id)
      .filter((j) => j.jour >= premier && j.jour <= dernier).map((j) => ({ employe_id: e.id, ...j })));
    res.json({ employes, punchs, jours: journees, maintenant: versSql(new Date()) });
  });

  // Export pour la paie : une ligne par jour travaillé (heure du Québec), dîner retiré ou payé, puis le total de chaque employé.
  app.get('/api/bureau/heures.csv', exigerConnexion, exigerBureau, (req, res) => {
    const du = lireMoment(req.query.du);
    const au = lireMoment(req.query.au);
    if (!du || !au) return res.status(400).json({ erreur: 'Période invalide.' });
    const premier = jourLocal(enDate(du));
    const dernier = jourLocal(new Date(enDate(au) - 1));
    const heureLocale = (t) => enDate(t).toLocaleString('en-CA', { timeZone: 'America/Toronto', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    const nombre = (n) => n.toFixed(2).replace('.', ',');
    const champ = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [['Employé', 'Date', 'Début', 'Fin', 'Heures travaillées', 'Dîner non payé', 'Heures payées', 'Note']];
    const totaux = [];
    const employes = db.prepare("SELECT id, nom FROM utilisateurs WHERE role = 'employe' ORDER BY nom").all();
    for (const e of employes) {
      // Seules les journées terminées (aucun quart en cours) partent à la paie.
      const punchs = db.prepare('SELECT debut, fin, note FROM punchs WHERE employe_id = ? AND debut >= ? AND debut < ? ORDER BY debut')
        .all(e.id, du, au);
      const journees = jours(db, e.id).filter((j) => j.jour >= premier && j.jour <= dernier).reverse();
      let total = 0;
      let nbJours = 0;
      for (const j of journees) {
        const siens = punchs.filter((p) => jourLocal(enDate(p.debut)) === j.jour);
        if (!siens.length || siens.some((p) => !p.fin)) continue;
        csv.push([e.nom, j.jour, heureLocale(siens[0].debut), heureLocale(siens.at(-1).fin), nombre(j.travaillees),
          j.dinerPaye ? 'payé' : nombre(j.diner), nombre(j.payees), siens.map((p) => p.note).filter(Boolean).join(' / ')]);
        total += j.payees;
        nbJours += 1;
      }
      if (nbJours) totaux.push([`Total ${e.nom}`, '', '', '', '', '', nombre(total), '']);
    }
    csv.push([], ...totaux);
    // Point-virgule et BOM : Excel en français ouvre le fichier directement avec les accents.
    res.type('text/csv; charset=utf-8').attachment(`heures-${req.query.du.slice(0, 10)}.csv`)
      .send(`\ufeff${csv.map((l) => l.map(champ).join(';')).join('\r\n')}\r\n`);
  });

  app.post('/api/bureau/punchs', exigerConnexion, exigerBureau, (req, res) => {
    const e = employe(Number(req.body?.employe_id));
    if (!e) return res.status(404).json({ erreur: 'Employé introuvable.' });
    const debut = lireMoment(req.body.debut);
    const fin = lireMoment(req.body.fin);
    if (!fin) return res.status(400).json({ erreur: 'Indique l\'heure de fin.' });
    const erreur = erreurQuart(e.id, debut, fin);
    if (erreur) return res.status(400).json({ erreur });
    const { lastInsertRowid } = db.prepare('INSERT INTO punchs (employe_id, debut, fin, note, modifie_par) VALUES (?, ?, ?, ?, ?)')
      .run(e.id, debut, fin, String(req.body.note ?? '').trim().slice(0, 500) || null, req.utilisateur.id);
    res.status(201).json({ punch: punch(Number(lastInsertRowid)) });
  });

  // Correction d'un quart (heure oubliée, mauvais punch). fin vide garde le quart ouvert.
  app.patch('/api/bureau/punchs/:id', exigerConnexion, exigerBureau, (req, res) => {
    const p = punch(Number(req.params.id));
    if (!p) return res.status(404).json({ erreur: 'Quart introuvable.' });
    const debut = 'debut' in (req.body || {}) ? lireMoment(req.body.debut) : p.debut;
    const fin = 'fin' in (req.body || {}) ? (req.body.fin ? lireMoment(req.body.fin) : null) : p.fin;
    if (req.body?.fin && !fin) return res.status(400).json({ erreur: 'Heure de fin invalide.' });
    if (!fin && p.fin && ouvert(p.employe_id)) return res.status(400).json({ erreur: 'Cet employé a déjà un quart en cours.' });
    const erreur = erreurQuart(p.employe_id, debut, fin, p.id);
    if (erreur) return res.status(400).json({ erreur });
    db.prepare('UPDATE punchs SET debut = ?, fin = ?, modifie_par = ? WHERE id = ?').run(debut, fin, req.utilisateur.id, p.id);
    res.json({ punch: punch(p.id) });
  });

  app.delete('/api/bureau/punchs/:id', exigerConnexion, exigerBureau, (req, res) => {
    const { changes } = db.prepare('DELETE FROM punchs WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ erreur: 'Quart introuvable.' });
    res.status(204).end();
  });
}
