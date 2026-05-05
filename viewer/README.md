# VANTA browser spectator

§1.6 of the visible-layer plan: open a URL in your browser, walk
around inside the VANTA Minecraft town, no Java client install
needed.

A headless [mineflayer](https://github.com/PrismarineJS/mineflayer)
bot joins our PaperMC server over the standard Java protocol
(offline-mode), and
[prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer)
renders the chunks the bot can see to a WebGL canvas served at
`http://localhost:8080`.

## Run

The full stack starts together:

```bash
docker compose up -d
```

Once `paper` finishes booting (look for `Done (NN.NNNs)! For help,
type "help"` in `docker compose logs paper`), the viewer connects
its camera bot and serves the WebGL UI on
[http://localhost:8080](http://localhost:8080).

## Standalone (without Docker)

```bash
cd viewer
npm install
PAPER_HOST=127.0.0.1 PAPER_PORT=25565 npm start
```

## What's missing (TODO)

- Multi-user: one bot per browser tab. Today every visitor shares
  one camera bot's view.
- Free-fly: visitors are pinned to the bot's position. Adding
  per-tab control needs the prismarine-web-client websocket proxy.
- Public access: tunnel the WebGL endpoint via cloudflared/playit
  so anyone on the internet can join (paper §1.6 closing milestone).
