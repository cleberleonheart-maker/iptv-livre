import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseM3U,
  parseXMLTV,
  rewritePlaylist,
  srtToVtt,
  paginate,
  makeCastToken,
  verifyCastToken,
  parseSsdp,
  extractDlnaServices,
  xmlEscape,
  dlnaEnvelope,
} from '../server.js';

test('parseM3U: extrai nome, logo, grupo e url', () => {
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="Band.br" tvg-logo="http://logo/x.png" group-title="News",Band
http://stream.example/band.m3u8
#EXTINF:-1,Radio Test
http://stream.example/radio.mp3`;
  const out = parseM3U(m3u);
  assert.equal(out.length, 2);
  assert.equal(out[0].channel, 'Band.br');
  assert.equal(out[0].title, 'Band');
  assert.equal(out[0].logo, 'http://logo/x.png');
  assert.equal(out[0].group, 'News');
  assert.equal(out[0].url, 'http://stream.example/band.m3u8');
  assert.equal(out[1].url, 'http://stream.example/radio.mp3');
});

test('parseM3U: ignora comentarios e linhas de tag', () => {
  const out = parseM3U('#EXTM3U\n# comment\n#EXT-X-TARGETDURATION:6\n');
  assert.equal(out.length, 0);
});

test('parseXMLTV: extrai canais e programas', () => {
  const xml = `<?xml version="1.0"?>
<tv>
  <channel id="globo.br">
    <display-name>Globo</display-name>
    <icon src="http://logo/globo.png"/>
  </channel>
  <programme start="20261008100000 +0000" stop="20261008120000 +0000" channel="globo.br">
    <title lang="pt">Rede BBB</title>
    <desc lang="pt">Descricao&lt;br&gt;com entidades</desc>
  </programme>
</tv>`;
  const { channels, programs } = parseXMLTV(xml);
  assert.equal(channels.size, 1);
  const ch = channels.get('globo.br');
  assert.equal(ch.name, 'Globo');
  assert.equal(ch.logo, 'http://logo/globo.png');
  const list = programs.get('globo.br');
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Rede BBB');
  assert.equal(list[0].desc, 'Descricao<br>com entidades');
  assert.match(list[0].start, /^2026-10-08T10:00:00/);
});

test('rewritePlaylist: reescreve segmentos para o proxy', () => {
  const pl = '#EXTM3U\n#EXTINF:8,\nsegment_1.ts\n#EXTINF:8,\n../segments/2.ts\n';
  const out = rewritePlaylist(pl, 'http://orig.example/ch/live.m3u8');
  const lines = out.split('\n');
  assert.match(lines[2], /^\/proxy\?u=/);
  assert.match(decodeURIComponent(lines[4]), /http:\/\/orig\.example\/segments\/2\.ts$/);
  assert.ok(lines[4].startsWith('/proxy?u='));
});

test('rewritePlaylist: reescreve URI= dentro de #EXT-X-KEY e #EXT-X-MAP', () => {
  const pl = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"',
    '#EXTINF:4,',
    'seg.ts',
  ].join('\n');
  const out = rewritePlaylist(pl, 'http://orig.example/ch/live.m3u8');
  assert.match(out, /EXT-X-KEY[^\n]*\/proxy\?u=/);
  assert.match(out, /URI="\/proxy\?u=/);
  assert.match(out, /EXT-X-MAP[^\n]*\/proxy\?u=/);
  assert.ok(out.includes('BYTERANGE'));
});

test('rewritePlaylist: nao mexe em tags sem URI nem em URLs ja proxied', () => {
  const pl = '#EXT-X-TARGETDURATION:6\n#EXTINF:4,\n/proxy?u=seg.ts\n';
  const out = rewritePlaylist(pl, 'http://orig.example/live.m3u8');
  assert.equal(out, pl);
});

test('rewritePlaylist: propaga o token de cast nos segmentos', () => {
  const pl = '#EXTM3U\n#EXTINF:4,\nseg.ts\n';
  const out = rewritePlaylist(pl, 'http://orig.example/live.m3u8', 'TOK123');
  assert.ok(out.includes('/proxy?u=') && out.includes('&token=TOK123'));
});

test('cast token: ida e volta devolve o usuario', () => {
  const t = makeCastToken('ana');
  assert.equal(verifyCastToken(t), 'ana');
});

test('cast token: assinatura adulterada e rejeitada', () => {
  const t = makeCastToken('ana');
  assert.equal(verifyCastToken(t.slice(0, -2) + 'xy'), null);
  assert.equal(verifyCastToken('lixo'), null);
  assert.equal(verifyCastToken(''), null);
});

test('paginate: fatia, total e sinaliza hasMore', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const p1 = paginate(items, 0, 4);
  assert.deepEqual(p1.items, [0, 1, 2, 3]);
  assert.equal(p1.total, 10);
  assert.equal(p1.offset, 0);
  assert.equal(p1.hasMore, true);

  const p2 = paginate(items, 4, 4);
  assert.deepEqual(p2.items, [4, 5, 6, 7]);
  assert.equal(p2.hasMore, true);

  const last = paginate(items, 8, 4);
  assert.deepEqual(last.items, [8, 9]);
  assert.equal(last.hasMore, false);

  const beyond = paginate(items, 50, 4);
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.hasMore, false);
});

test('parseSsdp: extrai os cabecalhos da resposta M-SEARCH', () => {
  const msg = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.0.10:8200/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n';
  const h = parseSsdp(msg);
  assert.equal(h.location, 'http://192.168.0.10:8200/desc.xml');
  assert.equal(h['cache-control'], 'max-age=1800');
  assert.equal(h.st, 'urn:schemas-upnp-org:device:MediaRenderer:1');
});

test('extractDlnaServices: acha AVTransport e controlURL', () => {
  const xml =
    '<root><device><friendlyName>TV da Sala</friendlyName>' +
    '<serviceList>' +
    '<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>' +
    '<controlURL>/upnp/control/AVTransport1</controlURL></service>' +
    '<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>' +
    '<controlURL>/upnp/control/RenderingControl1</controlURL></service>' +
    '</serviceList></device></root>';
  const services = extractDlnaServices(xml);
  assert.equal(services.length, 2);
  assert.ok(services.some((s) => /AVTransport/.test(s.type) && s.control === '/upnp/control/AVTransport1'));
});

test('xmlEscape e dlnaEnvelope geram SOAP valido', () => {
  assert.equal(xmlEscape('a<b&"c">'), 'a&lt;b&amp;&quot;c&quot;&gt;');
  const env = dlnaEnvelope('Play', '<Speed>1</Speed>');
  assert.match(env, /u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/);
  assert.match(env, /<InstanceID>0<\/InstanceID>/);
  assert.match(env, /<Speed>1<\/Speed>/);
});

test('srtToVtt: converte timestamps e adiciona cabecalho WEBVTT', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nOla\n\n2\n00:00:05,500 --> 00:00:07,000\nMundo';
  const vtt = srtToVtt(srt);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.000'));
  assert.ok(vtt.includes('00:00:05.500 --> 00:00:07.000'));
  assert.ok(!vtt.includes(',000'));
});

test('srtToVtt: mantem VTT existente', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOi';
  assert.equal(srtToVtt(vtt), vtt);
});