// Lecture automatique avec un faux client Claude (aucun appel réseau).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerLecteur } from '../src/extraction.js';

function fauxClient(reponse) {
  const demandes = [];
  return { demandes, beta: { messages: { create: async (d) => { demandes.push(d); return reponse; } } } };
}

test('sans clé, la lecture est désactivée', async () => {
  const l = creerLecteur({ cleApi: '' });
  assert.equal(l.actif, false);
  assert.equal(await l.lire(Buffer.from('x'), 'image/png'), null);
});

test('photo : champs extraits et renvoyés', async () => {
  const champs = { est_une_facture: true, fournisseur: 'BMR', numero: '77', date_facture: '2026-09-30', sous_total: 10, tps: 0.5, tvq: 1, total: 11.5 };
  const client = fauxClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(champs) }] });
  const r = await creerLecteur({ client }).lire(Buffer.from('img'), 'image/jpeg');
  assert.deepEqual(r, champs);
  const d = client.demandes[0];
  assert.equal(d.messages[0].content[0].type, 'image');
  assert.equal(d.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(d.output_config.format.type, 'json_schema');
});

test('PDF envoyé comme document ; une image qui n\'est pas une facture donne null', async () => {
  const client = fauxClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ est_une_facture: false }) }] });
  assert.equal(await creerLecteur({ client }).lire(Buffer.from('%PDF'), 'application/pdf'), null);
  assert.equal(client.demandes[0].messages[0].content[0].type, 'document');
});

test('refus du modèle : null, l\'employé saisit à la main', async () => {
  const client = fauxClient({ stop_reason: 'refusal', content: [] });
  assert.equal(await creerLecteur({ client }).lire(Buffer.from('x'), 'image/png'), null);
});
