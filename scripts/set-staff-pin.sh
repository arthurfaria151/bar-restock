#!/usr/bin/env bash
set -euo pipefail
if [ "$EUID" -ne 0 ]; then echo 'Run with sudo.' >&2; exit 1; fi
if [ "$#" -lt 1 ]; then echo 'Usage: sudo bash scripts/set-staff-pin.sh account-id [admin|bartender] ["Display name"]' >&2; exit 1; fi
read -rsp 'Personal PIN (6–12 digits): ' staff_pin </dev/tty
echo
read -rsp 'Confirm PIN: ' staff_confirmation </dev/tty
echo
if [ "$staff_pin" != "$staff_confirmation" ]; then echo 'PINs do not match.' >&2; exit 1; fi
printf '%s' "$staff_pin" | /opt/bar-handout-node/bin/node /opt/bar-handout/backend/set-pin.mjs /var/lib/bar-handout/users.json "$@"
unset staff_pin staff_confirmation
chown barhandout:barhandout /var/lib/bar-handout/users.json
systemctl restart bar-handout
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8787/health
echo
