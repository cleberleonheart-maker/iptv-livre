# IPTV Livre

IPTV completa e **gratuita**: servidor Node sem dependências + player web (PWA)
+ APK para Android TV / Fire TV, tudo com **login e senha**.

Catálogo atual: **~11.500 canais abertos de TV de 184 países** (272 brasileiros)
**+ 1.421 estações de rádio**, com proxy de stream (resolve CORS e HTTP),
guia de programação (EPG), favoritos, busca e importação de listas M3U.

---

## Aviso honesto sobre "tudo grátis"

Só funcionam canais **abertos** (free-to-air). Canais por assinatura — Globoplay,
Premiere, Sky, Claro, Vivo, DAZN, HBO Max, Netflix — **não funcionam** e não
entram: eles usam DRM e exigem login e pagamento. Nenhum player legal reproduz
isso. O catálogo também ignora canais fechados e adultos.

O que vocêgets de graça: SBT, Band, Record, RedeTV, TV Brasil, CNN Brasil,
BandNews, TV Câmara, TV Senado, +, FOX, Sky News, Al Jazeera, DW, France 24,
NASA, CGTN e centenas de outros. A lista vem do projeto aberto
[iptv-org](https://github.com/iptv-org/iptv).

---

## Rodando

```bash
cd ~/iptv
./ctl.sh start       # sobe o servidor
./ctl.sh status      # status
./ctl.sh stop        # para
./ctl.sh restart     # reinicia
```

Ou direto: `node server.js` / `npm start`.

Ao subir pela primeira vez o servidor imprime o **usuário e a senha** gerados:

```
  ================================================
   LOGIN CRIADO (guarde este usuario e senha)
   usuario: admin
   senha:   3d2fda76
  ================================================
```

Abra no navegador: **http://localhost:8090**

Para trocar o usuário e a senha, defina antes de subir:

```bash
IPTV_USER=meuuser IPTV_PASS=minhasenha123 ./ctl.sh start
```

As senhas ficam em `.cache/users.json` com hash **scrypt** (o arquivo é criado
com permissão `600`). Sessões via cookie `HttpOnly` com 30 dias, salvas em
disco — reiniciar o servidor **não** desloga.

### Acesso pela TV

O servidor escuta em `0.0.0.0:8090`. Descubra o IP da máquina:

```bash
hostname -I | awk '{print $1}'
```

Na TV, abra o navegador (ou o APK) e acesse `http://SEU_IP:8090`. Deixe a porta
8090 liberada no firewall se houver.

### HTTPS (opcional, auto-assinado)

Para servir em `https://` (necessário para alguns recursos do navegador, como
Chromecast em rede), gere um certificado auto-assinado:

```bash
./ctl.sh tls        # cria .cache/tls/{cert,key}.pem e reinicia em HTTPS
./ctl.sh tls --off  # remove o certificado e volta para HTTP
```

O certificado vale para `localhost` e para os IPs da máquina. Abra
`https://SEU_IP:8090` e aceite o aviso de segurança do navegador (é
auto-assinado). Também dá para usar variáveis: `TLS=1` força HTTPS,
`TLS_CERT`/`TLS_KEY` apontam para outros arquivos.

---

## Docker

Sem dependências — a imagem só copia os arquivos e roda o Node.

```bash
cd ~/iptv
IPTV_PASS=minhasenha docker compose up -d --build
```

Acesse `http://IP:8090`. O catálogo, o EPG, os usuários e as sessões ficam no
volume `iptv-cache` (montado em `/app/.cache`), então sobrevivem a rebuilds.
Sem `IPTV_PASS`, o primeiro boot gera uma senha aleatória e a mostra em
`docker compose logs iptv`.

Baixar e rodar sem clonar nada:

```bash
docker run -d --name iptv-livre -p 8090:8090 \
  -e IPTV_USER=admin -e IPTV_PASS=minhasenha \
  -v iptv-cache:/app/.cache iptv-livre
```

---

## Serviço (reinício automático)

Duas opções, ambas com restart automático se o processo cair:

```bash
# systemd de usuário (sem root) — cria e habilita iptv.service
./ctl.sh service --install
./ctl.sh status
./ctl.sh service --uninstall

# systemd de sistema (com root) — use o template pronto
sudo cp systemd/iptv-livre.service /etc/systemd/system/
sudo systemctl enable --now iptv-livre
```

---

## APK (Android TV / Fire TV / TV Box)

```bash
cd ~/iptv/android && ./build.sh
```

Saída: `~/iptv/apk/iptv-livre.apk`

Instale via USB (com "depuração USB" ligada) ou copie para a TV e abra o
arquivo com um gerenciador. Na primeira abertura o app pede o **endereço do
servidor** (ex.: `http://192.168.0.10:8090`), testa a conexão e salva. O botão
**MENU** do controle remoto volta para essa tela.

O APK é só um WebView: quem tem o catálogo, o proxy e o login é o servidor.

## PWA

No celular ou tablet, abra a URL, use **Adicionar à tela inicial**. Instala
como app e funciona offline no shell (os streams, claro, precisam de internet).

---

## ⚠️ Philips com Roku TV: o APK NÃO instala

Se a sua Philco roda **Roku TV**, o sistema é fechado:

- ❌ não aceita APK (nem sideload, nem por USB)
- ❌ não tem navegador para abrir a interface web
- ❌ não tem loja para instalar player de IPTV

Isso vale para qualquer TV com Roku, não é específico da Philco. O que fazer:

| Opção | Como |
|---|---|
| **Fire TV Stick** (recomendado) | Conecte na HDMI da Roku e instale o APK. R (~R$200) |
| **Android TV Box / Chromecast com Google TV** | Mesma ideia, roda o APK ou a PWA |
| **Espelhar a tela** |PC/celular abre `http://IP:8090`; na Roku use **AirPlay** ou **Miracast** (botão *casting*) para enviar a imagem e o som |
| **Roku com canais próprios** | A Roku tem app de TV aberta próprio, mas não aceita listas M3U |

O espelhamento é o caminho sem gastar nada, mas a qualidade é pior e há
atraso. O Fire TV Stick é o melhor resultado.

---

## Recursos

| Recurso | Onde |
|---|---|
| Aba **Rádio** | 1.421 estações de rádio abertas, com filtro por país e gênero |
| Busca por nome | barra superior (também com o controle remoto) |
| **Agora na TV** | botão **Agora**: o que está passando neste instante, canal por canal |
| **Busca no EPG** | botão 📅 ao lado da busca: procura por título de programa |
| **Continuar de onde parou** | histórico por usuário; retoma a posição em conteúdo sob demanda |
| **Sinal do canal** | bolinha no card: verde = stream verificado no ar (dados do `health.js`) |
| **Painel da conta** | botão **Conta**: usuários, sessões, histórico e estatísticas |
| Filtro por país | menu lateral (Brasil em destaque) |
| Filtro por categoria | menu lateral (general, news, sports, movies, kids…) |
| Favoritos | clique na estrela; sincroniza entre aparelhos (mistura TV e rádio) |
| EPG | botão **Guia EPG**; mostra a programação atual e os próximos (só TV) |
| Fallback de stream | se um link cai, o player tenta o próximo do canal |
| Importar M3U | botão **Importar M3U** com a URL da sua lista |
| Exportar M3U | `http://IP:8090/api/m3u?country=BR` — abre em VLC, Kodi, TiviMate |
| Logos em cache | os logos passam pelo próprio servidor e ficam em disco (`.cache/`) |
| **Legendas** | botão **CC** no player: cole uma URL `.srt`/`.vtt` (o servidor converte para WebVTT) |
| **Transmitir para a TV** | botão **⧉** no player: AirPlay (Safari/iOS) ou Chromecast |
| **Controle parental** | no painel **Conta**: PIN + categorias bloqueadas (libera por 30 min) |

### Atalhos de teclado

- `Enter`/`Espaço` na caixa do canal: toca
- Setas: navega no grid
- `Esc`: fecha o player / o menu
- `F`: favorita o canal aberto

---

## API

Todas exigem o cookie de sessão, exceto `/health` e `/api/login`.

| Rota | O que faz |
|---|---|
| `GET /health` | vivo ou morto (não exige login) |
| `POST /api/login` | `{user, pass}` → cookie de sessão |
| `POST /api/logout` | encerra a sessão |
| `POST /api/logout-all` | encerra todas as sessões do usuário (todos os aparelhos) |
| `GET /api/me` | usuário logado |
| `GET /api/account` | painel: usuário, nº de sessões, favoritos, histórico, uptime e saúde |
| `GET /api/meta` | países e categorias com contagem; `?kind=tv\|radio\|all` |
| `GET /api/catalog` | canais; `?kind=tv&country=BR&category=news&q=sbt&id=Band.br&limit=100` |
| `GET /api/favs` · `POST /api/favs` | lê/grava favoritos do usuário |
| `GET /api/history` · `POST /api/history` · `DELETE /api/history` | histórico e posição de playback ("continuar de onde parou") |
| `GET /api/m3u` | exporta M3U; `?country=BR` |
| `GET /api/import?url=` | importa uma M3U para junto do catálogo |
| `GET /api/epg/sources` | guias disponíveis |
| `GET /api/epg/load?src=` | baixa e indexa um guia |
| `GET /api/epg/guide?channel=Band.br` | programação de um canal |
| `GET /api/epg/now` | "agora na TV": o que passa neste momento; `?kind=tv&country=BR` |
| `GET /api/epg/search?q=` | busca por título de programa no guia |
| `GET /api/health` | resumo da varredura de saúde |
| `GET /api/health/channels?ids=Band.br,Globo.br` | sinal (`on`/`off`/`unknown`) por canal |
| `GET /api/health/recheck` · `POST` · `GET /api/health/report` | re-verificação sob demanda |
| `GET /proxy?u=<url>` | proxy de stream (reescreve as playlists HLS) |
| `GET /sub?u=<url>` | baixa uma legenda e devolve como WebVTT (`.srt` convertido) |
| `GET /logo?u=<url>` | cache local de logos (tipo detectado pelo conteúdo) |
| `GET /api/parental` | estado do controle parental + categorias disponíveis |
| `POST /api/parental` | `{action:"set"\|"unlock"\|"lock"\|"disable", pin, blocked[]}` |

---

## Estrutura

```
~/iptv
├── server.js            servidor HTTP, catálogo, EPG, histórico e proxy
├── auth.js              login/senha (scrypt + sessão em cookie)
├── health.js            varredura de saúde dos streams
├── ctl.sh               start / stop / restart / status / health / service
├── Dockerfile           imagem (sem dependências)
├── docker-compose.yml   sobe com volume para o .cache
├── systemd/             template de unit para systemd de sistema
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/{login,app,player}.js
│   ├── vendor/hls.min.js
│   ├── sw.js            service worker (PWA offline)
│   └── manifest.webmanifest
├── android/             projeto do APK (sem Gradle)
│   ├── build.sh
│   ├── AndroidManifest.xml
│   ├── java/br/com/iptvlivre/MainActivity.java
│   └── make_launcher_icons.py
├── apk/iptv-livre.apk   APK assinado
└── .cache/              catálogo, EPG, saúde, usuários, histórico, sessões e TLS
```

`.cache/` guarda tudo: catálogo, EPG e saúde se reconstroem sozinhos. Já os
usuários/senhas e o PIN do controle parental moram aqui — faça backup se importam.

---

## Problemas comuns

**"nenhum canal encontrado"** — o servidor ainda está baixando o catálogo
(6 MB). Espere alguns segundos e recarregue.

**Vídeo não toca, fica "carregando"** — o canal caiu. O player tenta o próximo
link sozinho; se todos falharem, o stream morreu. Escolha outro canal.

**Rádio não toca** — algumas estações morrem ou bloqueiam o proxy. Tente outra
da lista. O player só aceita MP3/AAC (o que o navegador decodifica sem plugin),
então servidoras HLS-only de rádio ficam de fora.

**O logo dos canais não aparece** — o servidor de logos (`cdn.iptv-org.net`)
não responde na sua rede. Os canais funcionam normalmente, só a imagem falta.

**"não autenticado"** — a sessão expirou ou o servidor foi reiniciado com o
`.cache` apagado. Entre de novo.

**A TV não acha o servidor** — confira se estão no mesmo Wi-Fi, use o IP em vez
de `localhost` e veja se o firewall libera a porta 8090.

---

## Licença

MIT. Os canais pertencem aos seus donos; este projeto só reúne links públicos de
transmissão aberta. Você é responsável por como usa.