#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 022

usage() {
  cat <<'EOF'
Usage: sudo bash tools/deploy-centos.sh --domain HOSTNAME [options]

  --domain HOSTNAME      Public HTTPS hostname, such as play.catwitchn.cn
  --ref REF              Git branch, tag, or commit (default: master)
  --repo URL             Git repository (default: CatwitChn/TerrorOfSky)
  --port PORT            Local Node.js port (default: 3000)
  --firewall-zone ZONE   Open HTTP and HTTPS in this firewalld zone
  --help                 Show this help
EOF
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

domain=
ref=master
repo=https://github.com/CatwitChn/TerrorOfSky.git
port=3000
firewall_zone=
while (($#)); do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --domain|--ref|--repo|--port|--firewall-zone)
      [[ $# -ge 2 && -n $2 && $2 != -* ]] || fail "Missing value for $1"
      case $1 in
        --domain) domain=${2,,} ;;
        --ref) ref=$2 ;;
        --repo) repo=$2 ;;
        --port) port=$2 ;;
        --firewall-zone) firewall_zone=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown argument $1. See --help." ;;
  esac
done

[[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ && ${#domain} -le 253 ]] \
  || fail 'Provide a DNS hostname with --domain, without a scheme, port, or path.'
[[ $port =~ ^[0-9]{1,5}$ ]] || fail 'Invalid --port.'
port=$((10#$port))
((port >= 1024 && port <= 65535)) || fail '--port must be between 1024 and 65535.'
((EUID == 0)) || fail 'Run this deployer with sudo or as root.'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'This deployer targets CentOS Stream 10 x86_64.'
command -v dnf >/dev/null && command -v systemctl >/dev/null || fail 'DNF and systemd are required.'
if [[ -n $firewall_zone ]]; then
  command -v firewall-cmd >/dev/null || fail 'firewalld is required for --firewall-zone.'
  firewall-cmd --state >/dev/null || fail 'Start firewalld before using --firewall-zone.'
  firewall-cmd --zone="$firewall_zone" --list-services >/dev/null || fail 'Unknown firewalld zone.'
fi

app=/opt/tosky
current=$app/current
game=tosky-game.service
proxy=tosky-proxy.service
caddy_version=2.11.9
caddy_sha=5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb
caddy=/usr/local/bin/tosky-caddy-$caddy_version

install -d -m 0755 "$app" "$app/releases"
exec 9>"$app/.deploy.lock"
flock -n 9 || fail 'Another Terror of Sky deployment is running.'
[[ ! -e $current || -L $current ]] || fail "$current must be a symlink managed by this deployer."
previous=$(readlink "$current" || true)
[[ -z $previous || $previous == "$app/releases/"* && -d $previous ]] || fail 'Unexpected current release link.'
work=$(mktemp -d "$app/.deploy.XXXXXX")
switched=0

switch_release() {
  ln -s -- "$1" "$work/current"
  mv -Tf -- "$work/current" "$current"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if ((status != 0 && switched)); then
    printf 'Activation failed. Check journalctl -u %s -u %s.\n' "$game" "$proxy" >&2
    if [[ -n $previous ]]; then
      switch_release "$previous" && systemctl restart "$game" "$proxy" \
        || printf 'Previous release could not be restarted.\n' >&2
    else
      systemctl disable --now "$proxy" "$game"
      rm -f -- "$current"
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

dnf -y install git nodejs nodejs-npm iproute tar
command -v curl >/dev/null || dnf -y install curl
/usr/bin/node --eval 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || fail 'Node.js 22 or later is required.'

check_port() {
  local listening process line
  listening=$(ss -H -ltnp "sport = :$1")
  [[ -n $listening ]] || return 0
  process=$(systemctl show --property=MainPID --value "$2" || true)
  while IFS= read -r line; do
    [[ $process =~ ^[1-9][0-9]*$ && $line == *"pid=$process,"* ]] \
      || fail "TCP port $1 is used by another service. $line"
  done <<< "$listening"
}
check_port 80 "$proxy"
check_port 443 "$proxy"
check_port "$port" "$game"

# Use the fixed official release asset so installation does not depend on third-party RPM repositories.
if [[ ! -x $caddy ]]; then
  archive="caddy_${caddy_version}_linux_amd64.tar.gz"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 \
    --output "$work/$archive" "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/$archive"
  printf '%s  %s\n' "$caddy_sha" "$work/$archive" | sha256sum --check
  tar -xzf "$work/$archive" -C "$work" caddy
  install -m 0755 "$work/caddy" "$caddy"
fi

git init --quiet "$work/source"
git -C "$work/source" fetch --quiet --depth 1 -- "$repo" "$ref"
commit=$(git -C "$work/source" rev-parse --verify 'FETCH_HEAD^{commit}')
release_config=$(printf '%s\n' "$domain" "$port" "$caddy_version" | sha256sum)
release=$app/releases/$commit-${release_config:0:12}

if [[ ! -d $release ]]; then
  staged=$work/release
  install -d "$staged" "$staged/public"
  git -C "$work/source" archive "$commit" server lobby index.html | tar -x -C "$staged"
  mv -- "$staged/lobby" "$staged/index.html" "$staged/public/"
  [[ -z $(find "$staged/public" -type l -print -quit) ]] || fail 'The public web root contains a symbolic link.'
  npm ci --prefix "$staged/server" --omit=dev --ignore-scripts --no-audit --no-fund
  printf 'HOST=127.0.0.1\nPORT=%s\nLOBBY_ORIGINS=https://%s\n' "$port" "$domain" >"$staged/game.env"

  cat >"$staged/Caddyfile" <<EOF
{
    admin off
    servers {
        protocols h1 h2
    }
}

$domain {
    encode zstd gzip
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy same-origin
        X-Frame-Options SAMEORIGIN
    }

    handle /ws {
        @wrong_origin not header Origin https://$domain
        respond @wrong_origin 403
        reverse_proxy 127.0.0.1:$port
    }

    handle {
        root * $current/public
        redir / /lobby/ 302
        file_server
    }
}
EOF

  XDG_DATA_HOME="$work/caddy-data" XDG_CONFIG_HOME="$work/caddy-config" \
    "$caddy" validate --config "$staged/Caddyfile" --adapter caddyfile
  mv -T -- "$staged" "$release"
fi

cat >/etc/systemd/system/tosky-game.service <<EOF
[Unit]
Description=Terror of Sky game server
After=network.target

[Service]
DynamicUser=yes
WorkingDirectory=$current
EnvironmentFile=$current/game.env
ExecStart=/usr/bin/node $current/server/server.mjs
Restart=on-failure
RestartSec=3s
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/tosky-proxy.service <<EOF
[Unit]
Description=Terror of Sky HTTPS gateway
Wants=network-online.target $game
After=network-online.target $game

[Service]
Type=notify
DynamicUser=yes
StateDirectory=tosky-caddy
Environment=XDG_DATA_HOME=/var/lib/tosky-caddy
Environment=XDG_CONFIG_HOME=/var/lib/tosky-caddy
ExecStart=$caddy run --config $current/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=3s
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

if command -v restorecon >/dev/null; then
  restorecon "$caddy" /etc/systemd/system/tosky-game.service /etc/systemd/system/tosky-proxy.service
fi
systemctl daemon-reload

if [[ $previous != "$release" ]] || ! systemctl is-active --quiet "$game" || ! systemctl is-active --quiet "$proxy"; then
  switch_release "$release"
  switched=1
  systemctl restart "$game" "$proxy"
fi

curl --noproxy '*' --fail --silent --show-error --max-time 2 --retry 8 --retry-connrefused \
  --retry-delay 1 "http://127.0.0.1:$port/healthz" >/dev/null
curl --noproxy '*' --fail --silent --show-error --max-time 2 --resolve "$domain:80:127.0.0.1" \
  "http://$domain/" >/dev/null
systemctl enable "$game" "$proxy"
switched=0

if [[ -n $firewall_zone ]]; then
  for service in http https; do
    firewall-cmd --permanent --zone="$firewall_zone" --add-service="$service"
    firewall-cmd --zone="$firewall_zone" --add-service="$service"
  done
fi

printf 'Installed commit %s\n' "$commit"
for ((attempt=0; attempt<12; attempt++)); do
  if curl --noproxy '*' --fail --silent --max-time 2 --resolve "$domain:443:127.0.0.1" \
       "https://$domain/lobby/" >/dev/null; then
    printf 'HTTPS lobby is ready at https://%s/\n' "$domain"
    exit 0
  fi
  sleep 1
done
printf 'Services are running. HTTPS validation is pending for https://%s/.\n' "$domain" >&2
printf 'Check DNS and inbound TCP 80/443, then run journalctl -u %s -n 50.\n' "$proxy" >&2
