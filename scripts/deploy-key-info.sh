#!/usr/bin/env bash
# costcap#252: read-only. Prints the PUBLIC half of the deploy SSH key and where the deploy
# target points, so someone with shell on the app host can authorize exactly that key.
# Never prints the private key. Never connects to the host.
# Usage: deploy-key-info.sh <private key file> <user@host> <known_hosts file>
set -euo pipefail
key="${1:?private key file}"; target="${2:?user@host}"; pins="${3:?known_hosts file}"
case "$target" in *@*) ;; *) echo "deploy-key-info: target is not user@host" >&2; exit 2;; esac
user="${target%@*}"; host="${target#*@}"
pub="$(ssh-keygen -y -f "$key" 2>/dev/null | awk '{print $1" "$2}')" && [ -n "$pub" ] || { echo "deploy-key-info: not a readable private key" >&2; exit 2; }
fp="$(printf '%s\n' "$pub" | ssh-keygen -lf - | awk '{print $2}')"
if grep -Eq "^${host//./\\.}[[:space:]]" "$pins"; then pinned=yes; else pinned=no; fi
echo "deploy user: $user"
echo "deploy host: $host (pinned in known_hosts: $pinned)"
echo "deploy key fingerprint: $fp"
echo "authorized_keys line: $pub costcap-deploy"
