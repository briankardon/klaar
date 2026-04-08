#!/bin/sh
cd /home/protected/klaar
exec /home/protected/venv/bin/gunicorn \
    --bind 127.0.0.1:8000 \
    server:app
