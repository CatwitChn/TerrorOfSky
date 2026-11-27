#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 022

usage() {
  cat <<'EOF'
Usage: sudo bash tools/deploy-linux.sh --domain HOSTNAME [options]

  Supports Debian 12 and CentOS Stream 10 on x86_64 and ARM64.

  --domain HOSTNAME      Public HTTPS hostname, such as play.catwitchn.cn
  --ref REF              Git branch, tag, or commit (default: master)
  --repo URL             Git repository (default: CatwitChn/TerrorOfSky)
  --port PORT            Local Node.js port (default: 3000)
  --https-port PORT      Public Caddy HTTPS port (default: 443)
  --firewall-zone ZONE   Open HTTP and HTTPS in this firewalld zone
  --auto-update          Check this branch for updates every five minutes
  --help                 Show this help
EOF
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

app=/opt/tosky
maintenance_file=/run/tosky-update.pending
update_args=$app/auto-update.args
failed_update=$app/failed-update
automatic=0
enable_updates=0
if [[ ${1:-} == --check-update ]]; then
  ((EUID == 0)) || fail 'Run this deployer as root.'
  [[ $# == 1 && -f $update_args ]] || fail 'Automatic updates have not been configured.'
  automatic=1
  mapfile -d '' -t deployment_args <"$update_args"
  set -- "${deployment_args[@]}"
fi

domain=
ref=master
repo=https://github.com/CatwitChn/TerrorOfSky.git
port=3000
https_port=443
firewall_zone=
while (($#)); do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --auto-update) enable_updates=1; shift ;;
    --domain|--ref|--repo|--port|--https-port|--firewall-zone)
      [[ $# -ge 2 && -n $2 && $2 != -* ]] || fail "Missing value for $1"
      case $1 in
        --domain) domain=${2,,} ;;
        --ref) ref=$2 ;;
        --repo) repo=$2 ;;
        --port) port=$2 ;;
        --https-port) https_port=$2 ;;
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
[[ $https_port =~ ^[0-9]{1,5}$ ]] || fail 'Invalid --https-port.'
https_port=$((10#$https_port))
((https_port >= 1 && https_port <= 65535 && https_port != 80 && https_port != port)) \
  || fail '--https-port must be a valid TCP port different from 80 and the local Node.js port.'
((EUID == 0)) || fail 'Run this deployer with sudo or as root.'
[[ $(uname -s) == Linux && -r /etc/os-release ]] || fail 'Run on Debian 12 or CentOS Stream 10.'
command -v systemctl >/dev/null || fail 'systemd is required.'
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  debian:12|debian:12.*) platform=debian ;;
  centos:10) platform=centos ;;
  *) fail 'Run on Debian 12 or CentOS Stream 10.' ;;
esac

caddy_version=2.11.9
node_version=24.22.3
case $(uname -m) in
  x86_64)
    caddy_arch=amd64
    caddy_sha=5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb
    node_arch=x64
    node_sha=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
    ;;
  aarch64)
    caddy_arch=arm64
    caddy_sha=5e377cff994fc9362a6fcf695c53f226cfca3a3ef85bd3a3687cf252d6310165
    node_arch=arm64
    node_sha=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c
    ;;
  *) fail 'The server must use x86_64 or ARM64.' ;;
esac

if [[ -n $firewall_zone ]]; then
  command -v firewall-cmd >/dev/null || fail 'firewalld is required for --firewall-zone.'
  firewall-cmd --state >/dev/null || fail 'Start firewalld before using --firewall-zone.'
  firewall-cmd --zone="$firewall_zone" --list-services >/dev/null || fail 'Unknown firewalld zone.'
fi

site=$domain
tls_options=
http_redirect=
if ((https_port != 443)); then
  site=$domain:$https_port
  # ACME checks TLS-ALPN on 443. Use HTTP-01 on 80 when another service owns 443.
  tls_options=$'    tls {\n        issuer acme {\n            disable_tlsalpn_challenge\n        }\n    }'
  printf -v http_redirect '\nhttp://%s {\n    redir https://%s{uri} 308\n}' "$domain" "$site"
fi
origin=https://$site

current=$app/current
game=tosky-game.service
proxy=tosky-proxy.service
caddy=/usr/local/bin/tosky-caddy-$caddy_version

install -d -m 0755 "$app" "$app/releases"
exec 9>"$app/.deploy.lock"
flock -n 9 || fail 'Another Terror of Sky deployment is running.'
[[ ! -e $current || -L $current ]] || fail "$current must be a symlink managed by this deployer."
previous=$(readlink "$current" || true)
[[ -z $previous || $previous == "$app/releases/"* && -d $previous ]] || fail 'Unexpected current release link.'
work=$(mktemp -d "$app/.deploy.XXXXXX")
switched=0
draining=0
fetch_ref=$ref
if ((automatic || enable_updates)); then
  fetch_ref=refs/heads/$ref
fi

switch_release() {
  ln -s -- "$1" "$work/current"
  mv -Tf -- "$work/current" "$current"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if ((draining)); then rm -f -- "$maintenance_file"; fi
  if ((status != 0 && switched)); then
    if ((automatic)); then printf '%s\n' "$commit" >"$failed_update"; fi
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

if ((automatic)); then
  remote_head=$(git ls-remote --exit-code --heads -- "$repo" "$fetch_ref") || fail "Could not check $fetch_ref in Git."
  read -r fetch_ref _ <<<"$remote_head"
  [[ $fetch_ref =~ ^[0-9a-f]{40}$ ]] || fail 'Git returned an invalid release commit.'
  if [[ $previous == "$app/releases/$fetch_ref-"* ]]; then exit 0; fi
  if [[ -f $failed_update && $(<"$failed_update") == "$fetch_ref" ]]; then
    printf 'Commit %s was rolled back. Waiting for a newer commit or a manual deployment.\n' "$fetch_ref"
    exit 0
  fi
fi

download_checked() {
  local url=$1 destination=$2 sha=$3
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 \
    --output "$destination" "$url"
  printf '%s  %s\n' "$sha" "$destination" | sha256sum --check
}

if [[ $platform == debian ]]; then
  if ((!automatic)); then
    apt-get update
    apt-get install -y --no-install-recommends git curl ca-certificates iproute2 tar xz-utils libstdc++6
  fi
  # Debian 12 ships Node.js 18. Keep the pinned game runtime under /opt/tosky.
  runtime_name=node-v$node_version-linux-$node_arch
  runtime=$app/$runtime_name
  node=$runtime/bin/node
  npm_cli=$runtime/lib/node_modules/npm/bin/npm-cli.js
  if [[ ! -x $node || ! -f $npm_cli ]]; then
    archive=$runtime_name.tar.xz
    download_checked "https://nodejs.org/dist/v$node_version/$archive" "$work/$archive" "$node_sha"
    tar --extract --xz --no-same-owner --file "$work/$archive" --directory "$work"
    mv -T -- "$work/$runtime_name" "$runtime"
  fi
  npm_command=("$node" "$npm_cli")
else
  if ((!automatic)); then
    dnf -y install git nodejs nodejs-npm iproute tar
    command -v curl >/dev/null || dnf -y install curl
  fi
  node=/usr/bin/node
  npm_command=(npm)
fi
"$node" --eval 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || fail 'Node.js 22 or later is required.'
if ((enable_updates)); then
  git check-ref-format "$fetch_ref" || fail 'Automatic updates require a Git branch in --ref.'
fi

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
check_port "$https_port" "$proxy"
check_port "$port" "$game"

# Use the fixed official release asset so installation does not depend on third-party RPM repositories.
if [[ ! -x $caddy ]]; then
  archive=caddy_${caddy_version}_linux_$caddy_arch.tar.gz
  download_checked "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/$archive" "$work/$archive" "$caddy_sha"
  tar -xzf "$work/$archive" -C "$work" caddy
  install -m 0755 "$work/caddy" "$caddy"
fi

git init --quiet "$work/source"
git -C "$work/source" fetch --quiet --depth 1 -- "$repo" "$fetch_ref"
commit=$(git -C "$work/source" rev-parse --verify 'FETCH_HEAD^{commit}')
# Rebuild any release staged by a deployer that did not generate version.json.
release_config=$(printf '%s\n' "$origin" "$port" "$caddy_version" "$node" 'layout-v2' | sha256sum)
release=$app/releases/$commit-${release_config:0:12}

if [[ ! -d $release ]]; then
  staged=$work/release
  install -d "$staged" "$staged/public"
  git -C "$work/source" archive "$commit" server lobby index.html | tar -x -C "$staged"
  [[ -z $(find "$staged" -type l -print -quit) ]] || fail 'The staged game source contains a symbolic link.'
  mv -- "$staged/lobby" "$staged/index.html" "$staged/public/"
  if [[ -f $staged/server/flight-model.mjs ]]; then
    install -m 644 "$staged/server/flight-model.mjs" "$staged/public/lobby/flight-model.mjs"
  fi
  "$node" -p 'JSON.stringify({ version: JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version })' \
    "$staged/server/package.json" \
    >"$staged/public/lobby/version.json"
  "${npm_command[@]}" ci --prefix "$staged/server" --omit=dev --ignore-scripts --no-audit --no-fund
  printf 'HOST=127.0.0.1\nPORT=%s\nLOBBY_ORIGINS=%s\n' "$port" "$origin" >"$staged/game.env"

  cat >"$staged/Caddyfile" <<EOF
{
    admin off
    https_port $https_port
    servers {
        protocols h1 h2
    }
}

$site {
$tls_options
    encode zstd gzip
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy same-origin
        X-Frame-Options SAMEORIGIN
    }

    handle /ws {
        @wrong_origin not header Origin $origin
        respond @wrong_origin 403
        reverse_proxy 127.0.0.1:$port
    }

    handle {
        root * $current/public
        redir / /lobby/ 302
        file_server
    }
}
$http_redirect
EOF

  XDG_DATA_HOME="$work/caddy-data" XDG_CONFIG_HOME="$work/caddy-config" \
    "$caddy" validate --config "$staged/Caddyfile" --adapter caddyfile
  mv -T -- "$staged" "$release"
fi

if ((automatic)); then
  : >"$maintenance_file"
  draining=1
  sleep 3
  idle=0
  for ((attempt=0; attempt<165; attempt++)); do
    if curl --noproxy '*' --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" |
      "$node" -e 'try {
        const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        process.exit(data.maintenance === true && data.activeMatches === 0 ? 0 : 1);
      } catch { process.exit(1); }'; then
      idle=1
      break
    fi
    sleep 2
  done
  ((idle)) || fail 'Waiting for the current matches to finish timed out. The running release is still active.'
fi

cat >/etc/systemd/system/tosky-game.service <<EOF
[Unit]
Description=Terror of Sky game server
After=network.target

[Service]
DynamicUser=yes
WorkingDirectory=$current
EnvironmentFile=$current/game.env
Environment=TOS_MAINTENANCE_FILE=$maintenance_file
ExecStart=$node $current/server/server.mjs
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
if ((automatic)); then
  curl --noproxy '*' --fail --silent --show-error --max-time 5 --retry 2 --resolve "$domain:$https_port:127.0.0.1" \
    "$origin/lobby/" >/dev/null
fi
systemctl enable "$game" "$proxy"
switched=0

if [[ -n $firewall_zone ]]; then
  https_rule=--add-service=https
  if ((https_port != 443)); then https_rule=--add-port=$https_port/tcp; fi
  for rule in --add-service=http "$https_rule"; do
    firewall-cmd --permanent --zone="$firewall_zone" "$rule"
    firewall-cmd --zone="$firewall_zone" "$rule"
  done
fi

if ((enable_updates)); then
  args=(--domain "$domain" --ref "$ref" --repo "$repo" --port "$port" --https-port "$https_port")
  if [[ -n $firewall_zone ]]; then args+=(--firewall-zone "$firewall_zone"); fi
  printf '%s\0' "${args[@]}" >"$work/auto-update.args"
  chmod 0600 "$work/auto-update.args"
  mv -Tf -- "$work/auto-update.args" "$update_args"
  install -m 0755 "${BASH_SOURCE[0]}" "$work/deploy-linux.sh"
  mv -Tf -- "$work/deploy-linux.sh" "$app/deploy-linux.sh"
  cat >/etc/systemd/system/tosky-update.service <<EOF
[Unit]
Description=Terror of Sky update check
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $app/deploy-linux.sh --check-update
ExecStopPost=-/usr/bin/rm -f $maintenance_file
TimeoutStartSec=15min
EOF
  cat >/etc/systemd/system/tosky-update.timer <<EOF
[Unit]
Description=Check Terror of Sky for new releases

[Timer]
OnBootSec=5min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now tosky-update.timer
  printf 'Automatic updates enabled for %s.\n' "$ref"
fi

printf 'Installed commit %s\n' "$commit"
for ((attempt=0; attempt<12; attempt++)); do
  if curl --noproxy '*' --fail --silent --max-time 2 --resolve "$domain:$https_port:127.0.0.1" \
       "$origin/lobby/" >/dev/null; then
    printf 'HTTPS lobby is ready at %s/\n' "$origin"
    exit 0
  fi
  sleep 1
done
printf 'Services are running. HTTPS validation is pending for %s/.\n' "$origin" >&2
printf 'Check DNS and inbound TCP 80/%s, then run journalctl -u %s -n 50.\n' "$https_port" "$proxy" >&2
