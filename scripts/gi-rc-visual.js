import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
import "/src/modules/index.js";

// Live visual repro for the reported view-dependent stripes: a large open
// floor viewed at a grazing angle (the editor condition), high resolution,
// with a bright sky so indirect light is visible. Renders continuously and
// flags a screenshot after GI warms up. ?debug=<view> forwards to the GI
// component (e.g. gi-only, cascade-0, voxels) so the raw GI can be isolated.

const params = new URLSearchParams(location.search);
// Default to the puppeteer viewport so the whole frame is captured.
const W = Number(params.get("w") || 800);
const H = Number(params.get("h") || 600);
const debugView = params.get("debug") || "off";
const quality = params.get("quality") || "balanced";

// Diagnostic: render ONLY the bounced term (no sky) to see whether the gather
// picks up any bounced radiance at all.
if (params.has("bounceOnly")) globalThis.__RC_DEBUG_BOUNCE_ONLY = true;

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(W, H);
// Bright sky so the floor receives a strong ambient, matching the editor.
engine.scene.background = new THREE.Color(0xbfe0ff);
engine.scene.environment = null;

const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
// Low, grazing across a long floor — matches the game's character-mounted
// camera height and angle, which is what exposes the outer-cascade floor
// straddle banding.
camera.position.set(0, 1.0, 4);
camera.lookAt(0, 0.5, -8);
engine.camera = camera;
engine.scene.add(camera);

const mat = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
const addBox = (size, position, color = 0xdcdcdc) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat(color));
  mesh.position.set(...position);
  engine.scene.add(mesh);
  return mesh;
};
// A 216 m single-quad plane floor at y=-2.7, matching the game's "Plane"
// entity — thin, single-sided, far larger than the dense cascades, so the
// coarse outer cascades' probe lattice straddles it.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(216, 216), mat(0xcfcfcf));
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, -2.7, 0);
engine.scene.add(floor);
addBox([14, 8, 0.4], [0, 1, -13]);
addBox([0.4, 8, 14], [-7, 1, -6], 0xff2020);
addBox([0.4, 8, 14], [7, 1, -6], 0x20c020);
addBox([2.5, 5, 2.5], [-2.5, -0.2, -7]);
addBox([2.5, 2.5, 2.5], [2.5, -1.45, -4]);
if (params.has("enclosed")) {
  // Seal the room: inside an enclosure `exterior` must collapse to ~0 so the
  // sky term drops out and bounced colour bleed dominates. If bleed is still
  // absent here, the gather's bounce path is broken rather than sky-swamped.
  addBox([14, 0.4, 14], [0, 5, -6]); // ceiling
  addBox([14, 8, 0.4], [0, 1, 1]); // front wall
  camera.position.set(0, 0.5, -5);
  camera.lookAt(0, 0.5, -12);
}

const sun = engine.createEntity({ name: "Sun" });
sun.addComponent("light", { kind: "directional", color: "#fff4df", intensity: 3, castShadow: false });
sun.object3D.rotation.set(-0.9, -0.6, 0);
const lamp = engine.createEntity({ name: "Lamp" });
lamp.addComponent("light", { kind: "point", color: "#ffe6c0", intensity: 16, distance: 26, decay: 2, castShadow: false });
lamp.object3D.position.set(0, 5, -5);

const handle = await enableEngineModule(engine, "gi");
const gi = engine.createEntity({ name: "GI" });
const giProps = { quality, debugView };
// giResScale isolates the screen-space reconstruction: 0.5 = half-res GI +
// bilateral upsample (the suspect), 1.0 = full-res, no upsample.
if (params.has("giResScale")) {
  giProps.quality = "custom";
  giProps.giResScale = Number(params.get("giResScale"));
  giProps.voxelRes = 64;
  giProps.cascadeCount = 5;
  giProps.c0Spacing = 0.5;
  giProps.c0Directions = 24;
  giProps.intervalScale = 0.75;
}
gi.addComponent("global-illumination", giProps);

engine.start();
const started = performance.now();
let shot = false;
const poll = () => {
  const ready = handle.system?._deferredReady?.value === 1;
  const warm = handle.system.volumes?.every((v) => v.warmupQueue.length === 0);
  // Every volume must have published radiance, not just volume 0 — the outer
  // cascades trace the outer clipmaps, so an unconverged outer volume reads
  // back as "hit, but black".
  const radiant = handle.system.volumes?.every((v) => v.hasRadiance);
  if (!shot && ready && warm && radiant && performance.now() - started > 6000) {
    shot = true;
    // Give a couple of frames for the first fully-warm GI to resolve, then
    // measure the resolved GI: is there real bounce, or only flat sky?
    setTimeout(async () => {
      try {
        const v0 = handle.system.volumes[0];
        const { min, voxelSize, dims } = v0.grid;
        const idx = (wx, wy, wz) => {
          const x = Math.floor((wx - min.x) / voxelSize);
          const y = Math.floor((wy - min.y) / voxelSize);
          const z = Math.floor((wz - min.z) / voxelSize);
          if (x < 0 || y < 0 || z < 0 || x >= dims.x || y >= dims.y || z >= dims.z) return -1;
          return x + y * dims.x + z * dims.x * dims.y;
        };
        const [radianceArr, albedoArr] = await Promise.all([
          engine.renderer.getArrayBufferAsync(v0.buffers.radiance),
          engine.renderer.getArrayBufferAsync(v0.buffers.voxAlbedo),
        ]);
        const radF = new Float32Array(radianceArr);
        const albU = new Uint32Array(albedoArr);
        const dumpAt = (label, wx, wy, wz) => {
          const i = idx(wx, wy, wz);
          if (i < 0) { console.log(`RC-VOXEL ${label} OUT OF BOUNDS`); return; }
          const albedo = albU[i];
          console.log(
            `RC-VOXEL ${label} idx=${i} radiance=(${radF[i * 4].toFixed(3)},${radF[i * 4 + 1].toFixed(3)},${radF[i * 4 + 2].toFixed(3)}) ` +
            `albedoWord=0x${albedo.toString(16)} occupied=${(albedo >>> 24) > 0}`,
          );
        };
        console.log(`RC-GRID min=(${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) voxelSize=${voxelSize.toFixed(3)} dims=${dims.x}x${dims.y}x${dims.z}`);
        for (let wx = -6.5; wx >= -8.5; wx -= 0.3) {
          const i = idx(wx, -2.6, 0);
          if (i < 0) { console.log(`RC-FLOOR x=${wx.toFixed(1)} OUT OF BOUNDS`); continue; }
          const albedo = albU[i];
          const occ = (albedo >>> 24) > 0;
          console.log(
            `RC-FLOOR x=${wx.toFixed(1)} idx=${i} occupied=${occ} albedoWord=0x${albedo.toString(16)} ` +
            `radiance=(${radF[i * 4].toFixed(3)},${radF[i * 4 + 1].toFixed(3)},${radF[i * 4 + 2].toFixed(3)})`,
          );
        }
      } catch (err) {
        console.log(`RC-VOXEL dump failed: ${err.message}`);
      }
      try {
        const d = handle.system._deferred;
        const data = await engine.renderer.backend.copyTextureToBuffer(
          d.giTexture, 0, 0, d.width, d.height, 0,
        );
        const half = (h) => {
          const s = (h & 0x8000) >> 15;
          const e = (h & 0x7c00) >> 10;
          const f = h & 0x03ff;
          if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
          if (e === 0x1f) return NaN;
          return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
        };
        const isHalf = data.constructor === Uint16Array;
        const v = (x) => (isHalf ? half(x) : x);
        // WebGPU pads copyTextureToBuffer rows to a 256-byte multiple. Tight
        // i+=4 indexing silently drifts one row at a time whenever
        // d.width*bytesPerChannel*4 isn't already a multiple of 256 — reading
        // padding as pixels and shifting every subsequent row's samples.
        // (Same bug independently found and fixed in gi-game-repro.js this
        // session — this script had it too and it was never caught because
        // "redBleed=0" reads as a plausible failure on its own.)
        const rowTexels = Math.round(data.length / 4 / d.height);
        let red = 0; let green = 0; let n = 0;
        let sr = 0; let sg = 0; let sb = 0;
        for (let y = 0; y < d.height; y++) {
          for (let x = 0; x < d.width; x++) {
            const i = (y * rowTexels + x) * 4;
            const r = v(data[i]); const g = v(data[i + 1]); const b = v(data[i + 2]);
            sr += r; sg += g; sb += b; n++;
            if (r + g + b < 0.02) continue;
            if (r > g * 1.1 && r > b * 1.1) red++;
            if (g > r * 1.1 && g > b * 1.1) green++;
          }
        }
        console.log(
          `RC-GI mean=(${(sr / n).toFixed(3)},${(sg / n).toFixed(3)},${(sb / n).toFixed(3)}) ` +
          `redBleed=${red} greenBleed=${green} texels=${n} rowTexels=${rowTexels} width=${d.width}`,
        );
        // Merged-atlas alpha: alpha=1 means the ray HIT (occluded), alpha=0
        // means it escaped to sky. Inside a sealed room most rays must be
        // hits; if they read as escapes, `exterior` stays 1 and sky floods.
        const rc = handle.system._radianceCascades;
        for (const ci of [0, 1, 2]) {
          const c = rc.cascades[ci];
          if (!c) continue;
          const a = await engine.renderer.backend.copyTextureToBuffer(
            c.mergedTexture, 0, 0, c.layout.atlasWidth, c.layout.atlasHeight, 0,
          );
          const ah = a.constructor === Uint16Array;
          const av = (x) => (ah ? half(x) : x);
          let hit = 0; let escape = 0; let rgbE = 0; let tot = 0;
          for (let i = 0; i + 3 < a.length; i += 4) {
            const al = av(a[i + 3]); tot++;
            if (al > 0.5) hit++; else escape++;
            if (av(a[i]) || av(a[i + 1]) || av(a[i + 2])) rgbE++;
          }
          console.log(
            `RC-C${ci} hitAlpha=${hit} escaped=${escape} rgbEnergy=${rgbE} total=${tot}`,
          );
        }
      } catch (err) {
        console.log(`RC-GI readback failed: ${err}`);
      }
      document.documentElement.dataset.shot = `rc-visual-${debugView}`;
      document.documentElement.dataset.done = "true";
    }, 300);
  }
  if (performance.now() - started > 60000) {
    document.documentElement.dataset.done = "true";
    return;
  }
  requestAnimationFrame(poll);
};
requestAnimationFrame(poll);
