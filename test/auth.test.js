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

test('changePassword derruba as sessoes antigas', async () => {
  const { auth, dir, created } = mkAuth();
  try {
    const { user, pass } = created;
    const res = mkRes();
    assert.ok(await auth.attempt(res, user, pass));
    const sid = sidFrom(res);
    assert.equal(auth.currentUser(mkReq(sid)), user);

    assert.ok(await auth.changePassword(user, 'novaSenha123'));
    assert.equal(auth.currentUser(mkReq(sid)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeUser derruba as sessoes do usuario removido', async () => {
  const { auth, dir } = mkAuth();
  try {
    await auth.addUser('bob', 'senha123');
    const res = mkRes();
    assert.ok(await auth.attempt(res, 'bob', 'senha123'));
    const sid = sidFrom(res);
    assert.equal(auth.currentUser(mkReq(sid)), 'bob');

    assert.ok(auth.removeUser('bob'));
    assert.equal(auth.currentUser(mkReq(sid)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify (assincrono) aceita a senha certa e rejeita o resto', async () => {
  const { auth, dir, created } = mkAuth();
  try {
    assert.equal(await auth.verify(created.user, created.pass), true);
    assert.equal(await auth.verify(created.user, 'errada'), false);
    assert.equal(await auth.verify('fantasma', 'qualquer'), false);
    // apos trocar a senha, a antiga nao vale mais
    await auth.changePassword(created.user, 'maisNova456');
    assert.equal(await auth.verify(created.user, created.pass), false);
    assert.equal(await auth.verify(created.user, 'maisNova456'), true);
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
