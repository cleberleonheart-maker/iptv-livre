import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* Autenticacao local: usuario/senha com hash scrypt e sessao em cookie.
   Nao ha back-end externo: tudo fica no arquivo .cache/users.json. */

const SESSION_TTL = 30 * 24 * 3600e3; // 30 dias
const COOKIE = 'iptv_sid';

export function createAuth(cacheDir, { onFirstRun } = {}) {
  const file = path.join(cacheDir, 'users.json');
  let db = load();
  let lastMtime = mtime();

  function mtime() {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.users && d.users.length) return d;
    } catch {}
    return null;
  }

  /* Enquanto o servidor fica de pe, um arquivo users.json editado de fora
     (ou por outra sessao) so entra quando reinicia. Este reload detecta a
     mudanca pelo mtime e aplica na hora - necessario para o CRUD via API. */
  function reloadIfChanged() {
    const m = mtime();
    if (m === lastMtime) return;
    lastMtime = m;
    const fresh = load();
    if (fresh) db = fresh;
  }

  if (!db) {
    const pass = process.env.IPTV_PASS || crypto.randomBytes(4).toString('hex');
    const user = process.env.IPTV_USER || 'admin';
    db = {
      users: [{ user, ...hash(pass) }],
      createdAt: Date.now(),
    };
    save();
    onFirstRun?.({ user, pass });
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    lastMtime = mtime();
  }

  function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash: derived };
  }

  const sessions = new Map();

  function verify(user, password) {
    reloadIfChanged();
    const rec = db.users.find((u) => u.user === user);
    if (!rec) return false;
    const { hash: h } = hash(password, rec.salt);
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(rec.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const sessionFile = path.join(cacheDir, 'sessions.json');

  // reabre as sessoes salvas para ninguem ser deslogado a cada restart
  try {
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    for (const [sid, s] of Object.entries(saved)) {
      if (Date.now() - s.at < SESSION_TTL) sessions.set(sid, s);
    }
  } catch {}

  /* Escritas atomicas (tmp + rename): nunca deixa o arquivo pela metade,
     mesmo com varias sessoes gravando ao mesmo tempo. */
  function saveSessions() {
    const tmp = sessionFile + '.tmp';
    const data = JSON.stringify(Object.fromEntries(sessions));
    fs.writeFile(tmp, data, { mode: 0o600 }, (err) => {
      if (err) return;
      fs.rename(tmp, sessionFile, () => {});
    });
  }

  function createSession(user) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { user, at: Date.now() });
    saveSessions();
    return sid;
  }

  function sessionUser(sid) {
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.at > SESSION_TTL) {
      sessions.delete(sid);
      saveSessions();
      return null;
    }
    // refresh deslizante: 30 dias a partir do ultimo uso, nao da criacao
    if (Date.now() - s.at > 3600e3) {
      s.at = Date.now();
      saveSessions();
    }
    return s.user;
  }

  function dropSession(sid) {
    if (sessions.delete(sid)) saveSessions();
  }

  function sessionCount(user) {
    let n = 0;
    for (const s of sessions.values()) if (s.user === user) n++;
    return n;
  }

  function dropUserSessions(user) {
    let changed = false;
    for (const [sid, s] of [...sessions]) {
      if (s.user === user) {
        sessions.delete(sid);
        changed = true;
      }
    }
    if (changed) saveSessions();
  }

  function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function setCookieHeader(sid) {
    return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;
  }

  function clearCookieHeader() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  return {
    file,
    enabled: db.users.length > 0,
    cookieName: COOKIE,
    users: () => db.users.map((u) => ({ user: u.user })),

    verify,
    addUser(user, password) {
      reloadIfChanged();
      if (db.users.some((u) => u.user === user)) return { ok: false, error: 'usuario ja existe' };
      db.users.push({ user, ...hash(password) });
      save();
      return { ok: true };
    },

    removeUser(user) {
      reloadIfChanged();
      const before = db.users.length;
      db.users = db.users.filter((u) => u.user !== user);
      save();
      return before !== db.users.length;
    },

    changePassword(user, next) {
      reloadIfChanged();
      const rec = db.users.find((u) => u.user === user);
      if (!rec) return false;
      Object.assign(rec, hash(next));
      save();
      return true;
    },

    attempt(res, user, password) {
      if (!verify(user, password)) return false;
      const sid = createSession(user);
      res.setHeader('Set-Cookie', setCookieHeader(sid));
      return true;
    },

    currentUser(req) {
      return sessionUser(parseCookies(req.headers.cookie)[COOKIE]);
    },

    logout(req, res) {
      dropSession(parseCookies(req.headers.cookie)[COOKIE]);
      res.setHeader('Set-Cookie', clearCookieHeader());
    },

    sessionCount,

    logoutAll(user, res) {
      dropUserSessions(user);
      res.setHeader('Set-Cookie', clearCookieHeader());
    },

    stop() {},
  };
}