#!/usr/bin/env bash
# Sobe/derruba o servidor do IPTV.
# Se existir o servico systemd de usuario (iptv.service), usa ele
# (com reinicio automatico). Senao, cai no modo antigo com nohup.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.cache/server.pid"
mkdir -p "$DIR/.cache"

UNIT="iptv.service"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

has_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user cat "$UNIT" >/dev/null 2>&1 || return 1
}

stop_legacy() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
    kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

start_legacy() {
  stop_legacy
  cd "$DIR"
  setsid nohup env IPTV_LOG=1 node server.js > "$DIR/.cache/server.log" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  sleep 1
  if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "iniciado (pid $(cat "$PIDFILE")) - log em .cache/server.log"
  else
    echo "FALHOU ao iniciar - veja .cache/server.log"
    tail -20 "$DIR/.cache/server.log"
    exit 1
  fi
}

case "${1:-start}" in
  stop)
    if has_systemd; then
      systemctl --user stop "$UNIT"
      echo "parado (systemd)"
    else
      stop_legacy
      echo "parado"
    fi
    ;;
  restart|start)
    if has_systemd; then
      systemctl --user restart "$UNIT"
      echo "iniciado via systemd ($UNIT) - reinicia sozinho se cair"
    else
      start_legacy
    fi
    ;;
  status)
    if has_systemd; then
      systemctl --user is-active "$UNIT" || true
      systemctl --user status "$UNIT" --no-pager 2>/dev/null | head -n 6 || true
    elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "rodando (pid $(cat "$PIDFILE"))"
    else
      echo "parado"
    fi
    ;;
  health)
    cd "$DIR"
    shift || true
    case "${1:-}" in
      --install)
        UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT_DIR/iptv-health.service" <<EOF
[Unit]
Description=IPTV Livre varredura de saude dos streams
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/usr/bin/node $DIR/health.js
StandardOutput=append:$DIR/.cache/health.log
StandardError=append:$DIR/.cache/health.log
EOF
        cat > "$UNIT_DIR/iptv-health.timer" <<EOF
[Unit]
Description=Varredura de saude do IPTV (2x ao dia)

[Timer]
OnCalendar=*-*-* 06:00,18:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
        export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
        systemctl --user daemon-reload
        systemctl --user enable --now iptv-health.timer
        rm -f "$DIR/.cache/health.log" "$DIR/.cache/health.pid"
        # varredura inicial incremental (recheca so o que esta velho/duvidoso)
        setsid nohup node "$DIR/health.js" >> "$DIR/.cache/health.log" 2>&1 < /dev/null &
        echo $! > "$DIR/.cache/health.pid"
        echo "timer instalado (06:00 e 18:00) e varredura inicial comecou em background (incremental)."
        echo "acompanhe: tail -f .cache/health.log | ./ctl.sh health --stats"
        ;;
      --uninstall)
        UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
        export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
        systemctl --user disable --now iptv-health.timer 2>/dev/null || true
        rm -f "$UNIT_DIR/iptv-health.timer" "$UNIT_DIR/iptv-health.service"
        systemctl --user daemon-reload
        echo "timer de saude removido"
        ;;
      *) 
        if [ "${1:-}" = "--stats" ]; then
          node health.js --stats
        else
          node health.js "$@"
        fi
        ;;
    esac
    ;;
  service)
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    NODE_BIN="$(command -v node || echo /usr/bin/node)"
    shift || true
    case "${1:-}" in
      --install)
        mkdir -p "$UNIT_DIR"
        # Unit de usuario lida pelo iptv.service que o proprio ctl.sh ja procura.
        cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=IPTV Livre (servidor + player)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/server.js
Environment=PORT=${PORT:-8090}
Environment=HOST=${HOST:-0.0.0.0}
Environment=IPTV_LOG=1
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
        export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
        systemctl --user daemon-reload
        systemctl --user enable --now "$UNIT"
        echo "servico instalado e iniciado ($UNIT) - reinicia sozinho se cair"
        echo "status: ./ctl.sh status"
        ;;
      --uninstall)
        export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
        systemctl --user disable --now "$UNIT" 2>/dev/null || true
        rm -f "$UNIT_DIR/$UNIT"
        systemctl --user daemon-reload
        echo "servico removido"
        ;;
      *)
        echo "uso: $0 service [--install|--uninstall]"
        exit 1
        ;;
    esac
    ;;
  tls)
    shift || true
    TLSDIR="$DIR/.cache/tls"
    case "${1:-}" in
      --off|--clean|--remove)
        rm -f "$TLSDIR/cert.pem" "$TLSDIR/key.pem"
        echo "TLS desativado (certificado removido). Reiniciando..."
        ;;
      *)
        command -v openssl >/dev/null 2>&1 || { echo "openssl nao encontrado"; exit 1; }
        mkdir -p "$TLSDIR"
        IPS="$(hostname -I 2>/dev/null || true)"
        SAN="DNS:localhost,IP:127.0.0.1,IP:::1"
        for ip in $IPS; do SAN="$SAN,IP:$ip"; done
        openssl req -x509 -newkey rsa:2048 -nodes \
          -keyout "$TLSDIR/key.pem" -out "$TLSDIR/cert.pem" \
          -days 825 -subj "/CN=iptv-livre" \
          -addext "subjectAltName=$SAN" >/dev/null 2>&1
        chmod 600 "$TLSDIR/key.pem"
        echo "certificado auto-assinado criado em $TLSDIR"
        echo "valido para: $SAN"
        echo "abra https://localhost:${PORT:-8090} e aceite o aviso do navegador."
        echo "Reiniciando para ativar HTTPS..."
        ;;
    esac
    if has_systemd; then
      systemctl --user restart "$UNIT"
      echo "reiniciado via systemd ($UNIT)"
    else
      start_legacy
    fi
    ;;
  *)
    echo "uso: $0 {start|stop|restart|status|health [--all|--stats|--install|--uninstall]|service [--install|--uninstall]|tls [--off]}"
    exit 1
    ;;
esac
