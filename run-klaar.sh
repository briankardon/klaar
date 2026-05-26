#!/bin/sh
cd /home/public/klaar
# Encryption key location — outside the data dir (so it's not in backups) and
# outside the public web root. /home/private is web-writable and never served.
export KLAAR_ENC_KEY_FILE=/home/private/klaar_enc_key
exec /home/public/venv/bin/gunicorn \
    --bind 127.0.0.1:8000 \
    --config /dev/null \
    server:app
