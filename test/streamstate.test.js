import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOFT_WHY, isSoft, whyHardDead, whyLabel } from '../streamstate.js';

test('isSoft: identifica falhas que nao provam morte', () => {
  for (const w of ['HTTP 403', 'HTTP 429', 'timeout', 'ECONNRESET', 'retornou HTML']) {
    assert.equal(isSoft(w), true, w);
  }
  assert.equal(isSoft('ENOTFOUND'), false);
  assert.equal(isSoft('HTTP 404'), false);
  assert.equal(isSoft(null), false);
});

test('whyHardDead: morte conclusiva x falha mole', () => {
  assert.equal(whyHardDead('ENOTFOUND'), true);
  assert.equal(whyHardDead('HTTP 404'), true);
  assert.equal(whyHardDead('HTTP 410'), true);
  assert.equal(whyHardDead('HTTP 403'), false);
  assert.equal(whyHardDead('timeout'), false);
  assert.equal(whyHardDead(''), false);
  assert.equal(whyHardDead(null), false);
});

test('SOFT_WHY: cobre os codigos HTTP transitorios', () => {
  for (const c of [401, 403, 429, 500, 502, 503, 504]) {
    assert.ok(SOFT_WHY.has(`HTTP ${c}`), `HTTP ${c}`);
  }
});

test('whyLabel: traduz motivos comuns para pt-BR', () => {
  assert.match(whyLabel('ENOTFOUND'), /não existe/i);
  assert.match(whyLabel('HTTP 404'), /removido/i);
  assert.match(whyLabel('HTTP 403'), /recusou/i);
  assert.match(whyLabel('PolicyViolation'), /bloqueou/i);
  assert.match(whyLabel('timeout'), /não respondeu/i);
  assert.equal(whyLabel(''), '');
});
