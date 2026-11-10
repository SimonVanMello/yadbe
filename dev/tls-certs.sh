#!/usr/bin/env bash
# Generates a throwaway CA and a server certificate for `localhost` in dev/certs/ (ignored by
# Git), used by the TLS integration tests (YADBE_TEST_PG_CA) and by dev/compose.yml.
# The certificate is valid for DNS:localhost only, so connecting to 127.0.0.1 exercises a
# host name mismatch.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$dir"
cd "$dir"
if [[ -f server.crt && -f ca.crt ]]; then
  echo "Certificates already in $dir"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=yadbe test CA" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 \
  -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext ca.srl
chmod 600 server.key
# The PostgreSQL image runs as uid 999 and refuses a key readable by others.
echo "Certificates written to $dir"
