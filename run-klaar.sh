#!/bin/sh
cd /home/public/klaar
# Encryption key location. Must be writable by the user the daemon runs as
# (web). The data dir qualifies (the daemon writes list files there), and a
# dotfile here is excluded from backups (which only archive *.json) and isn't
# web-served (same dir as .secret_key). NOTE: /home/private is the member's
# own 0700 home and is NOT accessible to the web user — don't use it here.
export KLAAR_ENC_KEY_FILE=/home/public/klaar/data/.klaar_enc_key
exec /home/public/venv/bin/gunicorn \
    --bind 127.0.0.1:8000 \
    --config /dev/null \
    server:app
