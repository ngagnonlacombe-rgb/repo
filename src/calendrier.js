// Calendrier : le bureau et les chargés de projet planifient les projets jour par jour et y placent leur équipe.
import { exigerConnexion } from './auth.js';

const texte = (v, max) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};
const estDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
// « 7:30 », « 07h30 » ou « 7h » deviennent « 07:30 » / « 07:00 » ; vide = journée sans heure précise.
const lireHeure = (v) => {
  const t = texte(v, 10);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\s*[:h]\s*(\d{2})?$/i);
  if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return undefined;
  return `${m[1].padStart(2, '0')}:${m[2] || '00'}`;
};

export function brancherCalendrier(app, { db }) {
  const planificateur = (u) => u.role === 'bureau' || Boolean(u.chef_projet);
  const exigerPlanificateur = (req, res, suite) => (planificateur(req.utilisateur)
    ? suite() : res.status(403).json({ erreur: 'Réservé au bureau et aux chargés de projet.' }));

  const equipeDe = db.prepare(`SELECT u.id, u.nom FROM planification_employes pe JOIN utilisateurs u ON u.id = pe.employe_id
                               WHERE pe.planification_id = ? ORDER BY u.nom`);
  const lire = (id) => {
    const p = db.prepare(`SELECT pl.*, pr.nom AS projet_nom, pr.adresse AS projet_adresse, u.nom AS auteur
                          FROM planifications pl LEFT JOIN projets pr ON pr.id = pl.projet_id
                          LEFT JOIN utilisateurs u ON u.id = pl.cree_par WHERE pl.id = ?`).get(id);
    return p && { ...p, equipe: equipeDe.all(p.id) };
  };

  // Valide le corps d'une planification ; retourne { erreur } ou les valeurs prêtes à enregistrer.
  function valider(b, actuelle = {}) {
    const debut = 'date_debut' in b ? b.date_debut : actuelle.date_debut;
    const v = {
      projet_id: 'projet_id' in b ? (Number(b.projet_id) || null) : actuelle.projet_id ?? null,
      titre: 'titre' in b ? texte(b.titre, 150) : actuelle.titre ?? null,
      date_debut: debut,
      // Sans date de fin, le bloc dure une journée.
      date_fin: b.date_fin || ('date_fin' in b || !actuelle.date_fin ? debut : actuelle.date_fin),
      heure_debut: 'heure_debut' in b ? lireHeure(b.heure_debut) : actuelle.heure_debut ?? null,
      heure_fin: 'heure_fin' in b ? lireHeure(b.heure_fin) : actuelle.heure_fin ?? null,
      note: 'note' in b ? texte(b.note, 2000) : actuelle.note ?? null,
    };
    if (!estDate(v.date_debut) || !estDate(v.date_fin)) return { erreur: 'Choisis une date de début et de fin valides.' };
    if (v.date_fin < v.date_debut) return { erreur: 'La date de fin est avant la date de début.' };
    if (v.heure_debut === undefined || v.heure_fin === undefined) return { erreur: 'Heure invalide (ex. 7h30).' };
    if (v.projet_id && !db.prepare('SELECT 1 FROM projets WHERE id = ?').get(v.projet_id)) return { erreur: 'Projet introuvable.' };
    if (!v.projet_id && !v.titre) return { erreur: 'Choisis un projet ou écris un titre.' };
    return { v };
  }

  const majEquipe = (id, equipe) => {
    if (!Array.isArray(equipe)) return;
    db.prepare('DELETE FROM planification_employes WHERE planification_id = ?').run(id);
    const ajout = db.prepare(`INSERT OR IGNORE INTO planification_employes (planification_id, employe_id)
                              SELECT ?, id FROM utilisateurs WHERE id = ? AND supprime = 0`);
    for (const e of equipe.slice(0, 50)) ajout.run(id, Number(e));
  };

  // ?du=AAAA-MM-JJ&au=AAAA-MM-JJ : tout ce qui touche cette période (un bloc de plusieurs jours peut commencer avant).
  app.get('/api/calendrier', exigerConnexion, exigerPlanificateur, (req, res) => {
    const { du, au } = req.query;
    if (!estDate(du) || !estDate(au) || au < du) return res.status(400).json({ erreur: 'Période invalide.' });
    const ids = db.prepare(`SELECT id FROM planifications WHERE date_debut <= ? AND date_fin >= ?
                            ORDER BY date_debut, COALESCE(heure_debut, ''), id LIMIT 1000`).all(au, du);
    res.json({ planifications: ids.map((r) => lire(r.id)) });
  });

  // Les gens qu'on peut placer dans l'équipe : tous les comptes actifs.
  app.get('/api/calendrier/equipe', exigerConnexion, exigerPlanificateur, (_req, res) => {
    res.json({ equipe: db.prepare(`SELECT id, nom, role, chef_projet FROM utilisateurs
                                   WHERE actif = 1 AND supprime = 0 ORDER BY nom`).all() });
  });

  app.post('/api/calendrier', exigerConnexion, exigerPlanificateur, (req, res) => {
    const { erreur, v } = valider(req.body || {});
    if (erreur) return res.status(400).json({ erreur });
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO planifications
      (projet_id, titre, date_debut, date_fin, heure_debut, heure_fin, note, cree_par) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.projet_id, v.titre, v.date_debut, v.date_fin, v.heure_debut, v.heure_fin, v.note, req.utilisateur.id);
    majEquipe(id, req.body.equipe);
    res.status(201).json({ planification: lire(id) });
  });

  app.patch('/api/calendrier/:id', exigerConnexion, exigerPlanificateur, (req, res) => {
    const actuelle = lire(Number(req.params.id));
    if (!actuelle) return res.status(404).json({ erreur: 'Planification introuvable.' });
    const { erreur, v } = valider(req.body || {}, actuelle);
    if (erreur) return res.status(400).json({ erreur });
    db.prepare(`UPDATE planifications SET projet_id = ?, titre = ?, date_debut = ?, date_fin = ?, heure_debut = ?,
                heure_fin = ?, note = ? WHERE id = ?`)
      .run(v.projet_id, v.titre, v.date_debut, v.date_fin, v.heure_debut, v.heure_fin, v.note, actuelle.id);
    majEquipe(actuelle.id, req.body.equipe);
    res.json({ planification: lire(actuelle.id) });
  });

  app.delete('/api/calendrier/:id', exigerConnexion, exigerPlanificateur, (req, res) => {
    const r = db.prepare('DELETE FROM planifications WHERE id = ?').run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ erreur: 'Planification introuvable.' });
    res.json({ ok: true });
  });
}
