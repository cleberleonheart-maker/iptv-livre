/* Tela de login: bloqueia o app ate o servidor aceitar as credenciais.
   O cookie de sessao (HttpOnly) e quem mantem o acesso depois. */

const Login = (() => {
  const screen = document.getElementById('login');
  const form = document.getElementById('loginForm');
  const userEl = document.getElementById('loginUser');
  const passEl = document.getElementById('loginPass');
  const btn = document.getElementById('btnLogin');
  const msg = document.getElementById('loginMsg');
  const buildEl = document.getElementById('buildTag');
  const BUILD = '2026.10.09-6';
  if (buildEl) buildEl.textContent = 'build ' + BUILD;

  function hide() {
    screen.hidden = true;
    document.getElementById('app').hidden = false;
    document.dispatchEvent(new CustomEvent('app:ready'));
  }

  async function check() {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.ok) {
        hide();
        return true;
      }
    } catch {}
    screen.hidden = false;
    setTimeout(() => userEl.focus(), 60);
    return false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    msg.textContent = '';
    msg.className = 'msg';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          user: userEl.value.trim(),
          pass: passEl.value,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'falha no login');
      passEl.value = '';
      hide();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg err';
      passEl.select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  return { check };
})();