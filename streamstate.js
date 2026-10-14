/* ------------------------------------------------------------------ *
 * Veredito de saude de um stream (compartilhado)
 *
 * Distingue falha CONCLUSIVA (canal morto: DNS inexistente, 404, formato
 * invalido) de falha MOLE (CDN anti-bot, timeout, rede) — que nao prova
 * morte e por isso nao deve esconder o canal.
 *
 * Fica num modulo so para o servidor (server.js) e o verificador
 * (health.js) usarem exatamente a mesma regra.
 * ------------------------------------------------------------------ */

export const SOFT_WHY = new Set([
  'HTTP 401',
  'HTTP 403',
  'HTTP 429',
  'HTTP 500',
  'HTTP 502',
  'HTTP 503',
  'HTTP 504',
  'timeout',
  'ECONNRESET',
  'EPIPE',
  'socket hang up',
  'retornou HTML',
]);

export function isSoft(why) {
  return SOFT_WHY.has(why);
}

/* Morto conclusivo: foi checado, falhou e o motivo nao esta na lista mole. */
export function whyHardDead(why) {
  return !!why && !SOFT_WHY.has(why);
}

/* Traducao do motivo tecnico para algo que o usuario entende no player. */
export function whyLabel(why) {
  const w = String(why || '');
  if (/ENOTFOUND|EAI_NODATA|EAI_AGAIN/i.test(w))
    return 'o endereço não existe mais (provedor fora do ar)';
  if (/^HTTP 404|^HTTP 410/.test(w)) return 'arquivo removido no servidor';
  if (/PolicyViolation|retornou HTML/i.test(w))
    return 'o provedor bloqueou o acesso a este conteúdo';
  if (/^HTTP 403/.test(w)) return 'o provedor recusou o acesso (bloqueio)';
  if (/^HTTP 429/.test(w)) return 'o provedor limitou as conexões (429)';
  if (/^HTTP 401/.test(w)) return 'o provedor exige autenticação';
  if (/^HTTP 5\d\d/.test(w)) return 'erro no servidor do provedor';
  if (/timeout/i.test(w)) return 'o servidor não respondeu (demorou demais)';
  if (/ECONNREFUSED/i.test(w)) return 'o provedor recusou a conexão';
  if (/ECONNRESET|EPIPE|socket hang up/i.test(w))
    return 'a conexão caiu durante a transmissão';
  if (/segmento invalido/i.test(w)) return 'o vídeo veio corrompido no servidor';
  if (/playlist|m3u/i.test(w)) return 'resposta inválida do provedor (não é vídeo)';
  if (/protocolo|url invalida|url bloqueada/i.test(w)) return 'endereço inválido';
  return w ? `não respondeu (${w})` : '';
}
