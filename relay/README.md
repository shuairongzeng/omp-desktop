# omp-relay

The self-hosted relay for OMP Desktop's phone remote control
(`../docs/architecture/remote-control.md`). One static binary: serves the
phone UI from `../src` (or any `static_dir`), authenticates and joins
WebSocket rooms, and forwards frames verbatim between a desktop and its
paired phones. It never parses payloads.

## Build

```bash
cargo build --release   # target/release/omp-relay
```

## Configure

`relay-config.json` (path = argv[1], default `./relay-config.json`):

```json
{
  "bind": "127.0.0.1:8787",
  "static_dir": "/opt/omp-relay/public",
  "devices": { "<desktop device id>": "<sha256-hex of the device token>" },
  "state_file": "/opt/omp-relay/relay-state.json"
}
```

- `static_dir`: the app's **precompiled `dist/`** (`npm run build:frontend`
  in the repo), not `src/` — the relay's CSP has no `'unsafe-inline'` for
  scripts, which the in-browser Babel of `src/` needs.
- `devices`: one entry per desktop. The desktop's Settings → Remote shows
  its device id and (once) the token; store only the token's SHA-256 here:
  `printf %s "<token>" | sha256sum` (Git Bash on Windows works too).
- `state_file`: paired phones (hashed tokens) and each desktop's
  self-reported display info (name/os, for the phone's device picker),
  rewritten atomically.

## Run

```bash
./omp-relay /etc/omp-relay/relay-config.json
```

Log level via `RUST_LOG` (default `info`). Tokens are never logged.

## TLS (required)

The relay itself speaks plain HTTP/WebSocket and must sit behind a TLS
terminator. Pairing codes ride in URLs and tokens in the WS handshake's
query string — browsers cannot set custom headers on a WebSocket, so the
query string is the only credential channel. The relay never logs tokens,
but a reverse proxy WILL write the full request URL (query included) to
its access log unless configured not to; see the nginx directives below.

**Caddy** (`Caddyfile`):

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate … / ssl_certificate_key …

    # Tokens ride the WS query string: either silence the access log
    # entirely (simplest)…
    access_log off;
    # …or keep it with a format that drops $args (the query string):
    # log_format noquery '$remote_addr [$time_local] "$request_method $uri" '
    #                    '$status $body_bytes_sent';
    # access_log /var/log/nginx/omp-relay.log noquery;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # let the 25s app-level ping keep it up
    }
}
```

## systemd

```ini
[Unit]
Description=OMP Desktop remote-control relay
After=network.target

[Service]
ExecStart=/usr/local/bin/omp-relay /etc/omp-relay/relay-config.json
Restart=on-failure
DynamicUser=yes
ProtectSystem=strict
ReadWritePaths=/etc/omp-relay

[Install]
WantedBy=multi-user.target
```

## Test

```bash
cargo test            # unit + integration (rooms, pairing, revoke, oversize, res unicast, hello, phone names)
curl -s http://127.0.0.1:8787/healthz   # ok
```
