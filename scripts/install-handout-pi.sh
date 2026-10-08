#!/usr/bin/env bash
set -euo pipefail
# Run on the venue's Pi, from a checkout of this repository.
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer with sudo bash.'; exit 1; fi
if [ "$(uname -s)" != Linux ]; then echo 'Run this on the Raspberry Pi, not your Mac.'; exit 1; fi
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$source_root/handout-server/server.mjs" ]; then echo 'The repository checkout is incomplete.'; exit 1; fi
pi_account="${SUDO_USER:-poolmaster}"
handout_hostname="${HANDOUT_HOSTNAME:-handout.guarasolutions.com}"
if [[ ! "$handout_hostname" =~ ^[a-zA-Z0-9.-]+$ ]]; then echo 'Invalid public hostname'; exit 1; fi
for tool in curl xz openssl python3; do
  if ! command -v "$tool" >/dev/null; then echo "Install $tool first, then rerun."; exit 1; fi
done
if ! id barhandout >/dev/null 2>&1; then useradd --system --user-group --home-dir /var/lib/bar-handout --shell /usr/sbin/nologin barhandout; fi
install -d -m 0755 /opt/bar-handout /opt/bar-handout/backend /opt/bar-handout-node/bin
install -d -m 0700 -o barhandout -g barhandout /var/lib/bar-handout
node_command="$(command -v node || true)"
if [ -n "$node_command" ] && [ "$($node_command -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]; then
  if [ "$node_command" != /opt/bar-handout-node/bin/node ]; then ln -sfn "$node_command" /opt/bar-handout-node/bin/node; fi
else
  if [ "$(uname -m)" != aarch64 ]; then echo 'This installer needs 64-bit Raspberry Pi OS (aarch64) for Node 24.'; exit 1; fi
  node_release=v24.19.0
  node_archive="node-$node_release-linux-arm64.tar.xz"
  node_stage="$(mktemp -d)"
  trap 'rm -rf "$node_stage"' EXIT
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$node_release/$node_archive" -o "$node_stage/$node_archive"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$node_release/SHASUMS256.txt" -o "$node_stage/SHASUMS256.txt"
  awk -v archive="$node_archive" '$2 == archive {print}' "$node_stage/SHASUMS256.txt" > "$node_stage/checksum.txt"
  test -s "$node_stage/checksum.txt"
  (cd "$node_stage" && sha256sum -c checksum.txt)
  tar -xJf "$node_stage/$node_archive" --no-same-owner -C "$node_stage"
  install -m 0755 "$node_stage/node-$node_release-linux-arm64/bin/node" /opt/bar-handout-node/bin/node
fi
install -m 0644 "$source_root"/handout-server/*.mjs /opt/bar-handout/backend/
if [ ! -s /var/lib/bar-handout/users.json ]; then
  read -rp "First Handout username [$pi_account]: " handout_user </dev/tty
  handout_user="${handout_user:-$pi_account}"
  handout_user="${handout_user,,}"
  read -rp 'Display name for this account: ' handout_name </dev/tty
  read -rsp 'Handout password (at least 12 characters): ' handout_password </dev/tty
  echo
  printf '%s' "$handout_password" | /opt/bar-handout-node/bin/node /opt/bar-handout/backend/add-user.mjs /var/lib/bar-handout/users.json "$handout_user" "$handout_name"
  unset handout_password
  chown barhandout:barhandout /var/lib/bar-handout/users.json
fi
if [ ! -f /etc/bar-handout.env ]; then
  umask 077
  handout_secret="$(openssl rand -hex 32)"
  cat > /etc/bar-handout.env <<CONFIG
HANDOUT_SESSION_SECRET=$handout_secret
HANDOUT_USERS_FILE=/var/lib/bar-handout/users.json
HANDOUT_DATA_DIR=/var/lib/bar-handout
HANDOUT_ALLOWED_ORIGINS=https://topd.guarasolutions.com,capacitor://localhost
HANDOUT_CLOSE_HOUR=2
HANDOUT_CLOSE_MINUTE=0
HANDOUT_PORT=8787
CONFIG
  unset handout_secret
fi
cat > /etc/systemd/system/bar-handout.service <<'SERVICE'
[Unit]
Description=Bot bar shared Handout and Brisbane daily archives
After=network-online.target time-sync.target
Wants=network-online.target
[Service]
Type=simple
User=barhandout
Group=barhandout
WorkingDirectory=/opt/bar-handout
EnvironmentFile=/etc/bar-handout.env
ExecStart=/opt/bar-handout-node/bin/node /opt/bar-handout/backend/server.mjs
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/bar-handout
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now bar-handout
systemctl restart bar-handout
for attempt in 1 2 3 4 5; do
  if curl --fail --silent http://127.0.0.1:8787/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:8787/health
printf '\nHandout server installed. Business days close at 02:00 Australia/Brisbane.\n'
# Add one ingress rule to the existing named tunnel, preserving all other rules.
if command -v cloudflared >/dev/null && [ -f /etc/cloudflared/config.yml ]; then
  candidate="$(mktemp /etc/cloudflared/config.yml.handout.XXXXXX)"
  python3 - /etc/cloudflared/config.yml "$candidate" "$handout_hostname" <<'PY'
import sys,re
from pathlib import Path
source,destination,hostname=sys.argv[1:]
text=Path(source).read_text()
if re.search(r'^\s*-\s*hostname:\s*'+re.escape(hostname)+r'\s*$',text,re.M):
    match=re.search(r'^\s*-\s*hostname:\s*'+re.escape(hostname)+r'\s*\n\s*service:\s*http://127\.0\.0\.1:8787\s*$',text,re.M)
    if not match: raise SystemExit('Handout hostname already exists with a different service. Configuration was not changed.')
    Path(destination).write_text(text)
    raise SystemExit(0)
lines=text.splitlines(True)
indices=[i for i,line in enumerate(lines) if re.fullmatch(r'\s*- service: http_status:404\s*',line)]
if len(indices)!=1: raise SystemExit('Could not find one tunnel fallback rule; configuration was not changed.')
index=indices[0];indent=re.match(r'\s*',lines[index])[0]
lines[index:index]=[f'{indent}- hostname: {hostname}\n',f'{indent}  service: http://127.0.0.1:8787\n']
Path(destination).write_text(''.join(lines))
PY
  cloudflared --config "$candidate" tunnel ingress validate
  cp -p /etc/cloudflared/config.yml "/etc/cloudflared/config.yml.before-handout-$(date +%Y%m%d%H%M%S)"
  chmod --reference=/etc/cloudflared/config.yml "$candidate"
  chown --reference=/etc/cloudflared/config.yml "$candidate"
  mv "$candidate" /etc/cloudflared/config.yml
  systemctl restart cloudflared
  tunnel_id="$(python3 - <<'PY'
import re
from pathlib import Path
match=re.search(r'^tunnel:\s*([a-f0-9-]+)',Path('/etc/cloudflared/config.yml').read_text(),re.M)
print(match[1] if match else '')
PY
)"
  pi_user_home="$(getent passwd "$pi_account" | cut -d: -f6)"
  origin_cert="$pi_user_home/.cloudflared/cert.pem"
  if [ -f "$origin_cert" ] && [ -n "$tunnel_id" ]; then
    if cloudflared --origincert "$origin_cert" tunnel route dns "$tunnel_id" "$handout_hostname"; then
      printf 'Public Handout: https://%s\n' "$handout_hostname"
    else
      printf 'Server is installed. Complete the DNS record for %s in Cloudflare.\n' "$handout_hostname"
    fi
  else
    printf 'In Cloudflare DNS, add a proxied CNAME: %s -> %s.cfargotunnel.com\n' "$handout_hostname" "$tunnel_id"
  fi
else
  echo 'Server is installed. Add a tunnel ingress to http://127.0.0.1:8787 and its public DNS record.'
fi
printf 'Archives: /var/lib/bar-handout/archives/\n'
