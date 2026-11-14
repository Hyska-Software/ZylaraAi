#!/usr/bin/env bash
set -euo pipefail

# A one-off command (`docker run <image> sh -lc …`) must not boot the desktop:
# health checks and image validation expect the container to exit on its own.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

# The two RFB servers are reachable only inside the container. The host bridges
# them over an authenticated, short-lived local WebSocket via docker exec.
Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
openbox >/tmp/openbox.log 2>&1 &
x11vnc -display :99 -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport 5900 >/tmp/x11vnc-view.log 2>&1 &
x11vnc -display :99 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5901 >/tmp/x11vnc-control.log 2>&1 &

# Keep the container alive and reap X if it dies.
wait -n
