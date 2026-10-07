// Calcul des taxes du Québec quand seul le total taxes incluses est connu (reçus d'essence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completerTaxes } from '../src/app.js';

test('total seulement : avant-taxes, TPS et TVQ retombent exactement sur le total', () => {
  for (const total of [114.98, 80, 62.37, 0.5, 1234.56]) {
    const m = completerTaxes({ sous_total: null, tps: null, tvq: null, total });
    assert.equal(Math.round((m.sous_total + m.tps + m.tvq) * 100), Math.round(total * 100), `total ${total}`);
  }
  assert.deepEqual(completerTaxes({ sous_total: null, tps: null, tvq: null, total: 114.98 }),
    { sous_total: 100, tps: 5, tvq: 9.98, total: 114.98 });
});

test('les montants déjà connus ne sont jamais écrasés', () => {
  const exonere = { sous_total: 50, tps: null, tvq: null, total: 50 };
  assert.deepEqual(completerTaxes(exonere), exonere);
  const sansTotal = { sous_total: null, tps: null, tvq: null, total: null };
  assert.deepEqual(completerTaxes(sansTotal), sansTotal);
});

test('des taxes à 0 ou absentes ne bloquent pas le calcul', () => {
  assert.deepEqual(completerTaxes({ sous_total: null, tps: 0, tvq: 0, total: 114.98 }),
    { sous_total: 100, tps: 5, tvq: 9.98, total: 114.98 });
  assert.deepEqual(completerTaxes({ sous_total: null, tps: 5, tvq: null, total: 114.98 }),
    { sous_total: 100, tps: 5, tvq: 9.98, total: 114.98 });
});
