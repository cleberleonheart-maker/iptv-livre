import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../auth.js';

function mkAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvauth-'));
  let created;
  const auth = createAuth(dir, { onFirstRun: (c) => (created = c) });
  return { auth, dir, created };
}
function mkRes() {
  const headers = {};
  return {
    headers,
    setHeader(k, v) {
      headers[k] = v;
    },
  };
}
function sidFrom(res) {
  return /iptv_sid=([^;]+)/.exec(res.headers['Set-Cookie'] || '')?.[1];
}
function mkReq(sid) {
  return { headers: { cookie: sid ? `iptv_sid=${sid}` : '' } };
}

test('changePassword derruba as sessoes antigas', () => {
  const { auth, dir, created } = mkAuth();
  try {
    const { user, pass } = created;
    const res = mkRes();
    assert.ok(auth.attempt(res, user, pass));
    const sid = sidFrom(res);
    assert.equal(auth.currentUser(mkReq(sid)), user);

    assert.ok(auth.changePassword(user, 'novaSenha123'));
    assert.equal(auth.currentUser(mkReq(sid)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeUser derruba as sessoes do usuario removido', () => {
  const { auth, dir } = mkAuth();
  try {
    auth.addUser('bob', 'senha123');
    const res = mkRes();
    assert.ok(auth.attempt(res, 'bob', 'senha123'));
    const sid = sidFrom(res);
    assert.equal(auth.currentUser(mkReq(sid)), 'bob');

    assert.ok(auth.removeUser('bob'));
    assert.equal(auth.currentUser(mkReq(sid)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cookie malformado nao lanca excecao', () => {
  const { auth, dir } = mkAuth();
  try {
    assert.doesNotThrow(() => auth.currentUser({ headers: { cookie: 'iptv_sid=%' } }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
