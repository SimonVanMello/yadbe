#!/usr/bin/env bash
# Throwaway OpenSSH servers for the SSH tunnel tests (F-010). Linux, as root (it creates the
# `yadbe-ssh` user); needs `openssh-server` (`apt-get install openssh-server`).
#
#   dev/ssh-test.sh [dir]        start (again) the servers, print the variables to export
#   dev/ssh-test.sh stop [dir]   stop them
#
# Everything lives in `dir` (default /tmp/yadbe-sshd): host keys, client keys, configs, logs
# and an ssh-agent socket. Servers listen on 127.0.0.1 only:
#   $PORT     tunnel server (password + public keys, TCP forwarding allowed)
#   $PORT+1   jump host (same user, its own host key)
#   $PORT+2   server with AllowTcpForwarding no ("channel refused")
# Client keys: id_ed25519 (OpenSSH), id_ecdsa_enc (OpenSSH, encrypted), id_rsa_pem_enc (PEM
# PKCS#1, encrypted), id_rsa_pkcs8 (PEM PKCS#8); id_agent is only in the agent.
# The tests read: YADBE_TEST_SSH_DIR, YADBE_TEST_SSH_PORT (default 2222), and the password /
# passphrase below (fixed: these servers only ever listen on the loopback).
set -euo pipefail

USER_NAME=yadbe-ssh
PASSWORD=yadbe-ssh-pw1
PASSPHRASE=yadbe-key-pw1
PORT=${YADBE_TEST_SSH_PORT:-2222}

if [[ ${1:-} == stop ]]; then
  DIR=${2:-/tmp/yadbe-sshd}
  for pid in "$DIR"/*.pid; do
    [[ -f $pid ]] && kill "$(cat "$pid")" 2>/dev/null || true
    rm -f "$pid"
  done
  exit 0
fi

DIR=${1:-/tmp/yadbe-sshd}
mkdir -p "$DIR" /run/sshd
chmod 711 "$DIR" # the servers read authorized_keys as the test user
cd "$DIR"

# Stop servers left over from a previous run.
for pid in "$DIR"/*.pid; do
  [[ -f $pid ]] && kill "$(cat "$pid")" 2>/dev/null || true
  rm -f "$pid"
done

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh "$USER_NAME"
fi
echo "$USER_NAME:$PASSWORD" | chpasswd

keygen() { # file type extra-args...
  local file=$1 type=$2
  shift 2
  [[ -f $file ]] || ssh-keygen -q -t "$type" -C "yadbe-test" -f "$file" "$@"
}
keygen host_ed25519 ed25519 -N ''
keygen host_jump_ed25519 ed25519 -N ''
keygen host_nofwd_ed25519 ed25519 -N ''
keygen id_ed25519 ed25519 -N ''
keygen id_ecdsa_enc ecdsa -b 256 -N "$PASSPHRASE"
keygen id_rsa_pem_enc rsa -b 2048 -m PEM -N "$PASSPHRASE"
keygen id_rsa_pkcs8 rsa -b 2048 -m PKCS8 -N ''
keygen id_agent ed25519 -N ''
cat id_ed25519.pub id_ecdsa_enc.pub id_rsa_pem_enc.pub id_rsa_pkcs8.pub id_agent.pub >authorized_keys
chmod 644 authorized_keys

config() { # port host-key forwarding
  cat >"sshd_$1.conf" <<EOF
Port $1
ListenAddress 127.0.0.1
HostKey $DIR/$2
PidFile $DIR/sshd_$1.pid
UsePAM no
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile $DIR/authorized_keys
StrictModes no
AllowUsers $USER_NAME
AllowTcpForwarding $3
PermitTTY no
LogLevel VERBOSE
EOF
  /usr/sbin/sshd -f "$DIR/sshd_$1.conf" -E "$DIR/sshd_$1.log"
}
config "$PORT" host_ed25519 yes
config "$((PORT + 1))" host_jump_ed25519 yes
config "$((PORT + 2))" host_nofwd_ed25519 no

rm -f agent.sock
ssh-agent -a "$DIR/agent.sock" | sed -n 's/^SSH_AGENT_PID=\([0-9]*\);.*/\1/p' >agent.pid
SSH_AUTH_SOCK="$DIR/agent.sock" ssh-add -q id_agent

cat <<EOF
# SSH test servers on 127.0.0.1:$PORT (tunnel), $((PORT + 1)) (jump), $((PORT + 2)) (no forwarding)
export YADBE_TEST_SSH_DIR=$DIR
export YADBE_TEST_SSH_PORT=$PORT
EOF
