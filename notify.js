/* Notificacoes externas opcionais (ntfy.sh ou Telegram).
   Configuracao por variaveis de ambiente:
     IPTV_NTFY_URL     ex.: https://ntfy.sh/meu-topico   (ou NTFY_URL)
     IPTV_TELEGRAM_TOKEN + IPTV_TELEGRAM_CHAT
   Sem nenhuma configurada, notify() nao faz nada. Nunca lanca erro. */

const NTFY = process.env.IPTV_NTFY_URL || process.env.NTFY_URL || '';
const TG_TOKEN = process.env.IPTV_TELEGRAM_TOKEN || '';
const TG_CHAT = process.env.IPTV_TELEGRAM_CHAT || '';

export function notificationsEnabled() {
  return !!(NTFY || (TG_TOKEN && TG_CHAT));
}

async function post(url, opts) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function notify(text, { title = 'IPTV Livre', priority = 'default' } = {}) {
  const jobs = [];
  if (NTFY) {
    jobs.push(
      post(NTFY, {
        method: 'POST',
        headers: { Title: title, Priority: priority, Tags: 'satellite' },
        body: text,
      })
    );
  }
  if (TG_TOKEN && TG_CHAT) {
    jobs.push(
      post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text: `${title}\n${text}`, disable_notification: false }),
      })
    );
  }
  const res = await Promise.all(jobs);
  return { sent: jobs.length, ok: jobs.length ? jobs.every(Boolean) : false, results: res };
}
