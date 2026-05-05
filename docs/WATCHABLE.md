# vanta-watchable v0.1 — operator guide

VANTA's "watchable" layer: a Minecraft world where the agent's reasoning is
rendered as physical actions. Wizard at a desk, signed events as torch
flickers and bell rings, third-person spectator camera served as a WebGL
canvas in any browser.

This file walks the operator through booting the stack against a running
VANTA runtime. Lives on the `vanta-watchable` branch of `vanta2`.

## What's in this stack

Three containers, one extra runtime flag:

| Service | Container | Port  | What it does                                              |
|---------|-----------|-------|-----------------------------------------------------------|
| paper   | paper     | 25565 | PaperMC 1.21.4 + the vanta-bridge plugin (Kotlin)         |
| npcs    | npcs      | —     | Wizard + Ada + Ren — mineflayer bots wandering the tower  |
| viewer  | viewer    | 8080+ | CameraBot + prismarine-viewer WebGL on :8080, menu :8081  |

Outside this stack:
- `runtime` — the VANTA core. Run separately (host or another compose) on
  `:8787` with `WATCHABLE_ENABLED=1`. The bridge-plugin and npcs subscribe
  to `/api/events/stream`, `/api/state`, and the new `/bridge/wizard/*`
  + `/bridge/town/*` routes.

## Prerequisites

- Docker Desktop (or Docker Engine ≥ 24 with `compose` plugin) on the host.
- `vendor/paper/paper-1.21.4.jar` — gitignored at 49 MB; fetch with:
  ```sh
  mkdir -p vendor/paper
  curl -L -o vendor/paper/paper-1.21.4.jar \
    "https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/232/downloads/paper-1.21.4-232.jar"
  ```
  (Build #232 was the last 1.21.4 build at the time of writing; bump to
  the latest 1.21.4 build if Paper's API rejects 232. The plugin is
  built fresh inside the docker image; you only need the server jar.)
- VANTA runtime running with `WATCHABLE_ENABLED=1`. From the repo root:
  ```sh
  WATCHABLE_ENABLED=1 pnpm --filter @vanta/runtime start
  ```

## Boot

```sh
docker compose -f docker-compose.watchable.yml up --build
```

First run downloads ~1 GB of base images and ~500 MB of gradle / npm deps.
Subsequent boots reuse the build cache (~30 s).

When the stack is up:
- Visit `http://localhost:8081/` → the two-door menu (Spectate / Visit)
- Click **Spectate** → the existing launcher with the WebGL canvas embedded
- The bare WebGL canvas alone is at `http://localhost:8080/`

You should see the wizard standing at his desk in the centre of the tower
within ~30 seconds, then Ada and Ren wander in shortly after (they wait
for `/bridge/wizard/online` to flip true before connecting).

## Verifying the rendering loop

The bridge-plugin subscribes to `/api/events/stream` and animates as
events arrive. Easy ways to trigger animations from outside:

- **Treasury alert** — emit a synthetic `op.treasury_alert` to the runtime
  log directly (or just wait for the operational loop to detect a low
  runway). Treasurer rings the belfry bell and a red column rises above
  the treasury chest.

- **Credit tick** — the credit loop ticks every 60 s for every active
  loan. With at least one active loan in the registry, you'll see torch-
  color flickers at the pledge altar (green=ok, yellow=watch, red=
  freeze_request). The cooler signals are silent; freeze_request adds
  a low chime.

- **Calibration proposal** — the model loop only emits proposals when the
  replay error exceeds 200 bps, so on a fresh deploy this stays silent.
  To force one for demo: append a synthetic `loop.calibration_proposal`
  event into the runtime's event log and watch the verifier altar glow
  blue.

- **Origination** — gold particle burst at the wizard's desk + a level-up
  sound. Easiest to trigger by running the existing `pnpm smoke`
  entrypoint while the watchable stack is connected (the smoke run
  emits real events to the same log).

## What's running where

```
host:8787  ── runtime (VANTA core)
                │  SSE /api/events/stream
                │  HTTP /api/state, /api/markets/*, /bridge/wizard/*, /bridge/town/*
                ↓
host:25565 ── paper container
                │  bridge-plugin (Kotlin) ─ subscribes to runtime
                │  Bukkit world: tower + landmarks
                ↑
host (no port)  npcs container
                │  Wizard.js, Population.js (Ada, Ren) via mineflayer
                ↑
host:8080  ── viewer container ── WebGL canvas (CameraBot)
host:8081  ── viewer container ── menu + launcher + chat panel
```

## Troubleshooting

**Paper container fails to start: "no such file vendor/paper/paper-1.21.4.jar"**
The jar isn't in the build context. Run the curl from the
[Prerequisites](#prerequisites) section.

**Plugin fails to load: "Java 21 required"**
The plugin's gradle build pins JDK 21; the runtime image (eclipse-temurin
21-jre) provides it. If you see this on host (not in docker), make sure
`JAVA_HOME` points at a Java 21 install.

**Viewer canvas is black**
prismarine-viewer needs the `canvas` package's native deps (cairo, pango,
libjpeg). The Dockerfile.viewer pre-installs these via apt; if you're
running viewer outside docker, install them manually:
```sh
brew install cairo pango libjpeg librsvg pixman
pnpm --filter vanta-viewer install
```

**Bots don't show up**
They wait for `/bridge/wizard/online` to return `{online: true}`. That
endpoint is registered only when `WATCHABLE_ENABLED=1` on the runtime.
Curl-check from the host:
```sh
curl http://localhost:8787/bridge/wizard/online
```
If this returns 404, the runtime didn't pick up `WATCHABLE_ENABLED=1`.

**Wizard doesn't speak**
The wizard's `/bridge/wizard/think` calls the runtime's inference client.
That's gated on `INFERENCE_BACKEND` having credentials:
- `eigen` — needs `KMS_SERVER_URL` + `KMS_PUBLIC_KEY` (auto-injected
  inside EigenCompute; absent locally)
- `vercel` — needs `VERCEL_AI_GATEWAY_KEY`
Without either, the bridge route falls back to a deterministic stub line
("the wizard nods, eyes on his ledger.") so the visible layer stays
moving even when inference is down.

**On macOS Docker Desktop, `host.docker.internal:8787` is unreachable from
containers**
Should be auto-wired by Docker Desktop. If not, the compose file already
includes `extra_hosts: ["host.docker.internal:host-gateway"]` for Linux
hosts. On macOS, restart Docker Desktop.

## What's intentionally NOT in v0.1

- **Visit mode** — the second door on the menu shows a "v0.2 coming soon"
  page. Avatar mint via x402, first-person controls, in-world deposit /
  pledge actions land in v0.2.
- **Voiced NPCs** — the viewer ships with the ElevenLabs TTS code from
  v1, but the API key is unset by default. v0.3 wires it.
- **Per-loan vault rendering** — credit-loop events animate as a generic
  particle burst at the pledge altar, not at a per-loan chest. v0.2 adds
  one chest per active loan plus the underwriter walking between them.
- **History hall + replayer NPC** — not built as world structures yet;
  calibration_proposal events animate at the verifier altar (re-using
  the v1 coordinate). v0.2 adds the dedicated history corridor.
- **The "joinable" market interactions** — quote / pledge / deposit calls
  via in-world signs. The runtime endpoints exist (`/api/origination`
  etc.), but they're not wired into the chat-bridge plugin in v0.1
  (ChatBridge.kt is disabled in BridgePlugin.kt).

## Coming in v0.2

Roughly three weeks of work after v0.1 lands. See the project plan at
`~/.claude/plans/vast-zooming-volcano.md` for the cadence.
