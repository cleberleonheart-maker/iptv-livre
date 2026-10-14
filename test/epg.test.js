import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Fallback do guia: as fontes do mesmo pais se socorrem; uma fonte de outro
   pais nunca troca de regiao sozinha. */

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvepg-'));
process.env.PORT = '0';
process.env.IPTV_CACHE_DIR = cache;
process.env.IPTV_USER = 'tester';
process.env.IPTV_PASS = 'senha123';
process.env.IPTV_EPG = 'https://epg.pw/xmltv/epg_BR.xml.gz';
process.env.IPTV_EPG_FALLBACK =
  'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz,https://epgshare01.online/epgshare01/epg_ripper_BR2.xml.gz';

const { epgSourceChain } = await import('../server.js');

const BR = 'https://epg.pw/xmltv/epg_BR.xml.gz';
const BR1 = 'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz';
const BR2 = 'https://epgshare01.online/epgshare01/epg_ripper_BR2.xml.gz';

test('epgSourceChain: fonte BR padrao puxa as alternativas do mesmo pais', () => {
  const chain = epgSourceChain();
  assert.equal(chain[0], BR, 'a principal vem primeiro');
  assert.ok(chain.includes(BR1) && chain.includes(BR2), 'inclui as alternativas BR');
  assert.equal(new Set(chain).size, chain.length, 'sem fontes repetidas');
});

test('epgSourceChain: uma alternativa BR tambem puxa as outras', () => {
  const chain = epgSourceChain(BR1);
  assert.equal(chain[0], BR1);
  assert.ok(chain.includes(BR) && chain.includes(BR2));
});

test('epgSourceChain: fonte de outro pais nao troca de regiao', () => {
  const us = 'https://epg.pw/xmltv/epg_US.xml.gz';
  assert.deepEqual(epgSourceChain(us), [us]);
});
