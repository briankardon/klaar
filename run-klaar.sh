#!/bin/sh
cd /home/public/klaar
exec /home/public/venv/bin/gunicorn \
    --bind 127.0.0.1:8000 \
    --config /dev/null \
    server:app
