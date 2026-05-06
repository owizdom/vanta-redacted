/**
 * Procedural pixelated textures for the Minecraft-style scene.
 *
 * Drawn into a 32×32 canvas with a small noise pattern, then exposed
 * as a Three.js `CanvasTexture` with `NearestFilter` so the pixels
 * stay crisp. No external asset download needed — keeps the demo
 * self-contained and CC-clean.
 *
 * For richer art: drop in CC0 textures from
 *   - https://kenney.nl/assets/voxel-pack
 *   - https://kenney.nl/assets/textures-blocks
 * (just import the PNG and pass it through `THREE.TextureLoader`).
 */

import * as THREE from "three";

const TEX_SIZE = 32;

function makeTex(draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  // NEAREST mag → crisp pixels up close; NearestMipmapNearest min →
  // crisp pixels at distance with no shimmering between mip levels.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Deterministic 8-bit noise — stable across reloads. */
function noiseAt(x: number, y: number, seed: number): number {
  const h = ((x * 374761393) ^ (y * 668265263) ^ (seed * 2147483647)) >>> 0;
  return ((h * 1103515245 + 12345) >>> 16) & 0xff;
}

/** Vary a base RGB by a small amount per-pixel using deterministic noise. */
function shade(base: [number, number, number], variance: number, n: number): string {
  const [r, g, b] = base;
  const delta = ((n / 255) * 2 - 1) * variance;
  const cl = (v: number): number => Math.max(0, Math.min(255, Math.round(v + delta)));
  return `rgb(${String(cl(r))}, ${String(cl(g))}, ${String(cl(b))})`;
}

export function grassTexture(): THREE.Texture {
  return makeTex((ctx) => {
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 7);
        ctx.fillStyle = shade([86, 137, 50], 28, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // sprinkle a few bright tufts
    for (let i = 0; i < 20; ++i) {
      const n = noiseAt(i * 13, 31, 11);
      const x = (n * 7) % TEX_SIZE;
      const y = (n * 11) % TEX_SIZE;
      ctx.fillStyle = shade([130, 180, 60], 0, 200);
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

export function stoneTexture(): THREE.Texture {
  return makeTex((ctx) => {
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 3);
        ctx.fillStyle = shade([155, 155, 162], 22, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // crack lines
    ctx.fillStyle = "#7e7e85";
    for (let i = 0; i < TEX_SIZE; ++i) {
      ctx.fillRect((i * 3) % TEX_SIZE, (i * 5) % TEX_SIZE, 1, 1);
    }
  });
}

export function blackstoneTexture(): THREE.Texture {
  return makeTex((ctx) => {
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 4);
        ctx.fillStyle = shade([38, 38, 46], 18, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });
}

export function woolTexture(rgbHex: string): THREE.Texture {
  // Parse "#rrggbb" → triple
  const r = parseInt(rgbHex.slice(1, 3), 16);
  const g = parseInt(rgbHex.slice(3, 5), 16);
  const b = parseInt(rgbHex.slice(5, 7), 16);
  return makeTex((ctx) => {
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 13);
        ctx.fillStyle = shade([r, g, b], 22, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // weave pattern — every 4th row a slightly darker line
    ctx.fillStyle = `rgba(0,0,0,0.18)`;
    for (let y = 0; y < TEX_SIZE; y += 4) {
      ctx.fillRect(0, y, TEX_SIZE, 1);
    }
  });
}

export function plankTexture(): THREE.Texture {
  return makeTex((ctx) => {
    // base wood tone
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 19);
        ctx.fillStyle = shade([158, 110, 60], 16, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // plank seams every 8 rows
    ctx.fillStyle = "#5a3a1c";
    for (let y = 7; y < TEX_SIZE; y += 8) {
      ctx.fillRect(0, y, TEX_SIZE, 1);
    }
  });
}

export function chestTexture(): THREE.Texture {
  return makeTex((ctx) => {
    // body wood
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 21);
        ctx.fillStyle = shade([138, 90, 40], 16, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // metal bands
    ctx.fillStyle = "#3a2a18";
    ctx.fillRect(0, 6, TEX_SIZE, 1);
    ctx.fillRect(0, 25, TEX_SIZE, 1);
    // lock
    ctx.fillStyle = "#d4af37";
    ctx.fillRect(14, 13, 4, 6);
    ctx.fillStyle = "#3a2a18";
    ctx.fillRect(15, 14, 2, 4);
  });
}

export function lanternTexture(): THREE.Texture {
  return makeTex((ctx) => {
    // outer iron frame
    for (let y = 0; y < TEX_SIZE; ++y) {
      for (let x = 0; x < TEX_SIZE; ++x) {
        const n = noiseAt(x, y, 31);
        ctx.fillStyle = shade([90, 90, 100], 14, n);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // glow centre
    const cx = TEX_SIZE / 2;
    const cy = TEX_SIZE / 2;
    const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, 10);
    grad.addColorStop(0, "#fff5b8");
    grad.addColorStop(1, "rgba(255,245,184,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - 10, cy - 10, 20, 20);
  });
}
