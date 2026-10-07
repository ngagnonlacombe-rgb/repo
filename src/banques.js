// Semaines travaillées, banque d'heures, vacances et maladie, calculées à la volée à partir des punchs
// et des mouvements inscrits par le bureau (congés pris, soldes de départ, ajustements).
import { lireReglage, ecrireReglage } from './db.js';
import { exigerConnexion, exigerBureau } from './auth.js';

// Valeurs par défaut inspirées des normes du travail du Québec ; le bureau peut les changer.
export const REGLES_DEFAUT = {
  semaine: 40, // heures normales par semaine ; au-delà, les heures vont dans la banque
  multiplicateurBanque: 1.5, // heure supplémentaire mise en banque à temps et demi
  tauxVacances: 4, // % des heures travaillées
  maladieAnnuelle: 16, // heures de maladie payées par année civile (2 jours)
};
const TYPES = ['banque', 'vacances', 'maladie'];
const FUSEAU = 'America/Toronto';

const enDate = (t) => new Date(`${t.replace(' ', 'T')}Z`);
const arrondi = (n) => Math.round(n * 100) / 100;

// Date locale (Québec) « AAAA-MM-JJ » d'un moment.
const jourLocal = (d) => d.toLocaleDateString('en-CA', { timeZone: FUSEAU });
// Lundi (date locale) de la semaine qui contient ce jour.
function lundiDe(jour) {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function regles(db) {
  return { ...REGLES_DEFAUT, ...(lireReglage(db, 'regles_heures') || {}) };
}

// Heures par semaine (lundi local) ; un quart en cours compte jusqu'à maintenant. Un quart est rangé dans la semaine où il commence.
export function semaines(db, employeId, maintenant = new Date()) {
  const parSemaine = new Map();
  const punchs = db.prepare('SELECT debut, fin FROM punchs WHERE employe_id = ? ORDER BY debut').all(employeId);
  for (const p of punchs) {
    const debut = enDate(p.debut);
    const heures = ((p.fin ? enDate(p.fin) : maintenant) - debut) / 3600000;
    const cle = lundiDe(jourLocal(debut));
    parSemaine.set(cle, (parSemaine.get(cle) || 0) + Math.max(0, heures));
  }
  return [...parSemaine].map(([lundi, heures]) => ({ lundi, heures })).sort((a, b) => b.lundi.localeCompare(a.lundi));
}

export function soldes(db, employeId, maintenant = new Date()) {
  const r = regles(db);
  const employe = db.prepare('SELECT taux_vacances FROM utilisateurs WHERE id = ?').get(employeId);
  const taux = employe?.taux_vacances ?? r.tauxVacances;
  const liste = semaines(db, employeId, maintenant);
  const total = liste.reduce((t, s) => t + s.heures, 0);
  const gagnees = liste.reduce((t, s) => t + Math.max(0, s.heures - r.semaine) * r.multiplicateurBanque, 0);
  const mouvements = (type, depuis = '0000') => db.prepare(`SELECT COALESCE(SUM(heures), 0) AS h FROM heures_mouvements
    WHERE employe_id = ? AND type = ? AND date >= ?`).get(employeId, type, depuis).h;
  const annee = jourLocal(maintenant).slice(0, 4);
  return {
    banque: arrondi(gagnees + mouvements('banque')),
    vacances: arrondi(total * taux / 100 + mouvements('vacances')),
    // La maladie repart à neuf chaque 1er janvier.
    maladie: arrondi(r.maladieAnnuelle + mouvements('maladie', `${annee}-01-01`)),
    tauxVacances: taux,
  };
}

export function brancherBanques(app, { db }) {
  const employe = (id) => db.prepare("SELECT id, nom, taux_vacances FROM utilisateurs WHERE id = ? AND role = 'employe'").get(id);

  // Employé : ses semaines passées et ses soldes, au moment présent.
  app.get('/api/mes-heures', exigerConnexion, (req, res) => {
    const r = regles(db);
    const liste = semaines(db, req.utilisateur.id).slice(0, 52).map((s) => ({
      ...s, heures: arrondi(s.heures), banque: arrondi(Math.max(0, s.heures - r.semaine) * r.multiplicateurBanque),
    }));
    const pris = db.prepare(`SELECT type, heures, date, note FROM heures_mouvements WHERE employe_id = ?
      ORDER BY date DESC, id DESC LIMIT 30`).all(req.utilisateur.id);
    res.json({ semaines: liste, soldes: soldes(db, req.utilisateur.id), mouvements: pris, regles: r });
  });

  // ---------- Bureau ----------
  app.get('/api/bureau/soldes', exigerConnexion, exigerBureau, (_req, res) => {
    const employes = db.prepare("SELECT id, nom, taux_vacances FROM utilisateurs WHERE role = 'employe' AND actif = 1 ORDER BY nom").all();
    res.json({
      regles: regles(db),
      employes: employes.map((e) => ({ ...e, soldes: soldes(db, e.id) })),
    });
  });

  app.get('/api/bureau/mouvements/:employe', exigerConnexion, exigerBureau, (req, res) => {
    const e = employe(Number(req.params.employe));
    if (!e) return res.status(404).json({ erreur: 'Employé introuvable.' });
    const mouvements = db.prepare(`SELECT m.*, u.nom AS par FROM heures_mouvements m LEFT JOIN utilisateurs u ON u.id = m.cree_par
      WHERE m.employe_id = ? ORDER BY m.date DESC, m.id DESC LIMIT 200`).all(e.id);
    res.json({ mouvements });
  });

  // heures négatives = congé pris ; positives = solde de départ ou ajustement.
  app.post('/api/bureau/mouvements', exigerConnexion, exigerBureau, (req, res) => {
    const b = req.body || {};
    const e = employe(Number(b.employe_id));
    if (!e) return res.status(404).json({ erreur: 'Employé introuvable.' });
    if (!TYPES.includes(b.type)) return res.status(400).json({ erreur: 'Choisis banque, vacances ou maladie.' });
    const heures = Number(b.heures);
    if (!Number.isFinite(heures) || heures === 0 || Math.abs(heures) > 2000) return res.status(400).json({ erreur: 'Nombre d\'heures invalide.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) return res.status(400).json({ erreur: 'Date invalide.' });
    const { lastInsertRowid } = db.prepare(`INSERT INTO heures_mouvements (employe_id, type, heures, date, note, cree_par)
      VALUES (?, ?, ?, ?, ?, ?)`).run(e.id, b.type, arrondi(heures), b.date, String(b.note ?? '').trim().slice(0, 300) || null, req.utilisateur.id);
    res.status(201).json({ id: Number(lastInsertRowid), soldes: soldes(db, e.id) });
  });

  app.delete('/api/bureau/mouvements/:id', exigerConnexion, exigerBureau, (req, res) => {
    const { changes } = db.prepare('DELETE FROM heures_mouvements WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ erreur: 'Inscription introuvable.' });
    res.status(204).end();
  });

  app.put('/api/bureau/regles-heures', exigerConnexion, exigerBureau, (req, res) => {
    const b = req.body || {};
    const nombre = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
    const nouvelles = {
      semaine: nombre(b.semaine, 1, 80),
      multiplicateurBanque: nombre(b.multiplicateurBanque, 1, 3),
      tauxVacances: nombre(b.tauxVacances, 0, 20),
      maladieAnnuelle: nombre(b.maladieAnnuelle, 0, 200),
    };
    if (Object.values(nouvelles).some((v) => v == null)) return res.status(400).json({ erreur: 'Une des valeurs est invalide.' });
    ecrireReglage(db, 'regles_heures', nouvelles);
    res.json({ regles: regles(db) });
  });

  // Taux de vacances propre à un employé ; null le remet au taux par défaut.
  app.patch('/api/bureau/soldes/:employe', exigerConnexion, exigerBureau, (req, res) => {
    const e = employe(Number(req.params.employe));
    if (!e) return res.status(404).json({ erreur: 'Employé introuvable.' });
    const v = req.body?.taux_vacances;
    const taux = v == null || v === '' ? null : Number(v);
    if (taux != null && !(Number.isFinite(taux) && taux >= 0 && taux <= 20)) return res.status(400).json({ erreur: 'Taux invalide.' });
    db.prepare('UPDATE utilisateurs SET taux_vacances = ? WHERE id = ?').run(taux, e.id);
    res.json({ soldes: soldes(db, e.id) });
  });
}
