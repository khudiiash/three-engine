import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
import "/src/modules/index.js";

// Minimal baseline matching the user's reduced scene exactly:
//   - a 10x10 plane (scale 10, rotated -90 on X) at the origin
//   - a 1x1x1 box in the centre
//   - one directional light
// Everything fits inside cascade 0, so anything wrong here is fundamental.

const params = new URLSearchParams(location.search);
const W = Number(params.get("w") || 800);
const H = Number(params.get("h") || 600);
const debugView = params.get("debug") || "off";
const camX = Number(params.get("cx") ?? 4);
const camY = Number(params.get("cy") ?? 3);
const camZ = Number(params.get("cz") ?? 6);

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(W, H);
engine.scene.background = new THREE.Color(0x87b7dc);

const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
camera.position.set(camX, camY, camZ);
camera.lookAt(0, 0.5, 0);
engine.camera = camera;
engine.scene.add(camera);

const standard = (color = 0xffffff) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });

const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), standard(0xcccccc));
plane.scale.set(10, 10, 10);
plane.rotation.set(-Math.PI / 2, 0, 0);
engine.scene.add(plane);

const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), standard(0xffffff));
box.position.set(0, 0.5, 0);
engine.scene.add(box);

const sun = engine.createEntity({ name: "Light" });
sun.addComponent("light", {
  kind: "directional", color: "#ffffff", intensity: 4, castShadow: false,
});
sun.object3D.rotation.set(0.62, -2.55, -2.75);

const handle = await enableEngineModule(engine, "gi");
const gi = engine.createEntity({ name: "GI" });
gi.addComponent("global-illumination", {
  quality: "balanced",
  giResScale: 0.5,
  voxelRes: 64,
  cascadeCount: 5,
  c0Spacing: 0.5,
  c0Directions: 24,
  intervalScale: 0.75,
  intensity: 1,
  aoStrength: 0,
  skyColor: "#87b7dc",
  skyIntensity: 1,
  replaceAmbient: true,
  debugView,
});

const half = (h) => {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return NaN;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
};

console.log(`RC-RENDERER reversedDepthBuffer=${engine.renderer.reversedDepthBuffer} logarithmicDepthBuffer=${engine.renderer.logarithmicDepthBuffer}`);
engine.start();
const started = performance.now();
let shot = false;
const poll = () => {
  const sys = handle.system;
  const ready = sys?._deferredReady?.value === 1;
  const warm = sys.volumes?.every((v) => v.warmupQueue.length === 0);
  const radiant = sys.volumes?.every((v) => v.hasRadiance);
  if (!shot && ready && warm && radiant && performance.now() - started > 6000) {
    shot = true;
    setTimeout(async () => {
      try {
        // Voxel occupancy: did the single-sided plane and the box voxelize?
        const v0 = sys.volumes[0];
        console.log(
          `RC-VOX dims=${v0.grid.dims.x}x${v0.grid.dims.y}x${v0.grid.dims.z} ` +
          `voxelSize=${v0.grid.voxelSize.toFixed(3)} ` +
          `center=(${v0.center.x.toFixed(2)},${v0.center.y.toFixed(2)},${v0.center.z.toFixed(2)})`,
        );
        for (let ci = 0; ci < sys.volumes.length; ci++) {
          const v = sys.volumes[ci];
          let occ = 0;
          for (let i = 0; i < v.buffers.voxStaticAlbedo.array.length; i++) {
            if (v.buffers.voxStaticAlbedo.array[i] !== 0) occ++;
          }
          console.log(
            `RC-STATIC cascade${ci} liveOccupied=${occ} center=(${v.center.x.toFixed(2)},${v.center.y.toFixed(2)},${v.center.z.toFixed(2)}) voxelReady=${v.voxelReady}`,
          );
        }
        const rc = sys._radianceCascades;
        for (const ci of [0, 1]) {
          const c = rc.cascades[ci];
          if (!c) continue;
          for (const [label, tex] of [
            ["merged", c.mergedTexture], ["vis", c.visibilityTexture],
          ]) {
            const a = await engine.renderer.backend.copyTextureToBuffer(
              tex, 0, 0, c.layout.atlasWidth, c.layout.atlasHeight, 0,
            );
            const ah = a.constructor === Uint16Array;
            const av = (x) => (ah ? half(x) : x);
            let hit = 0; let rgb = 0; let tot = 0; let sx = 0;
            for (let i = 0; i + 3 < a.length; i += 4) {
              tot++;
              sx += av(a[i]);
              if (av(a[i + 3]) > 0.5) hit++;
              if (av(a[i]) || av(a[i + 1]) || av(a[i + 2])) rgb++;
            }
            console.log(
              `RC-C${ci}-${label} hitA=${hit} rgb=${rgb} meanX=${(sx / tot).toFixed(3)} total=${tot}`,
            );
          }
        }
        // ---- Layer bisect -------------------------------------------------
        // Find the black pixels in the FINAL GI, then look at the very same
        // pixels in every upstream stage. Whichever stage first reads zero is
        // where the bug lives.
        const d = sys._deferred;
        const grab = async (tex, w2, h2, label = "") => {
          try {
            const a = await engine.renderer.backend.copyTextureToBuffer(tex, 0, 0, w2, h2, 0);
            const isH = a.constructor === Uint16Array;
            return { a, v: (x) => (isH ? half(x) : x) };
          } catch (e) {
            console.log(`RC-GRAB-FAIL ${label}: ${e.message}`);
            return null;
          }
        };
        const W2 = d.width; const H2 = d.height;
        {
          // Verify the readback layout BEFORE trusting any per-pixel indexing.
          // WebGPU pads copyTextureToBuffer rows to a 256-byte multiple; if the
          // returned buffer is padded, tight p*4 indexing drifts per row and
          // reads padding as "black pixels with garbage normals".
          const probe = await grab(d.giTexture, W2, H2);
          const packedTexels = W2 * H2;
          const gotTexels = probe ? probe.a.length / 4 : 0;
          const bytesPerRow = W2 * 8;
          console.log(
            `RC-LAYOUT w=${W2} h=${H2} packedTexels=${packedTexels} ` +
            `gotTexels=${gotTexels} ratio=${(gotTexels / packedTexels).toFixed(4)} ` +
            `bytesPerRow=${bytesPerRow} aligned256=${bytesPerRow % 256 === 0} ` +
            `paddedRowTexels=${Math.ceil(bytesPerRow / 256) * 256 / 8}`,
          );
        }
        const giB = await grab(d.giTexture, W2, H2, "giTexture");
        const rawB = await grab(d.rawTexture, W2, H2, "rawTexture");
        const nrmB = await grab(d.gbuffer.texture, W2, H2, "gbuffer.texture");
        const posB = await grab(d.gbuffer.textures[1], W2, H2, "gbuffer.textures[1]");

        // Stride-aware indexing: rows are padded to a 256-byte multiple, so the
        // buffer is wider than the texture. Indexing tightly reads padding.
        // worldPositionTexture is FloatType (16B/px) while gi/raw/normal are
        // HalfFloatType (8B/px) — different row byte counts pad to different
        // texel strides, so each buffer needs its OWN stride, not giB's.
        const rowTexels = Math.round(giB.a.length / 4 / H2);
        const at = (x, y) => (y * rowTexels + x) * 4;
        const strideOf = (b) => Math.round(b.a.length / 4 / H2);
        const atIn = (b, x, y) => (y * strideOf(b) + x) * 4;
        const luma = (b, i) => b.v(b.a[i]) + b.v(b.a[i + 1]) + b.v(b.a[i + 2]);
        let sr = 0; let sg = 0; let sb = 0; let n = 0; let mn = 1e9; let mx = -1e9;
        const black = [];
        for (let y = 0; y < H2; y++) {
          for (let x = 0; x < W2; x++) {
            const i = at(x, y);
            const r = giB.v(giB.a[i]); const gg = giB.v(giB.a[i + 1]); const b = giB.v(giB.a[i + 2]);
            sr += r; sg += gg; sb += b; n++;
            const l = r + gg + b;
            mn = Math.min(mn, l); mx = Math.max(mx, l);
            if (l < 1e-4) black.push(y * W2 + x);
          }
        }
        console.log(
          `RC-GI mean=(${(sr / n).toFixed(3)},${(sg / n).toFixed(3)},${(sb / n).toFixed(3)}) ` +
          `lumaMin=${mn.toFixed(3)} lumaMax=${mx.toFixed(3)} blackPixels=${black.length}/${n}`,
        );
        if (black.length) {
          let rawBlack = 0; let posZero = 0; let nrmZero = 0; let nrmDegenerate = 0;
          const samples = [];
          for (const p of black) {
            const px0 = p % W2; const py0 = (p / W2) | 0;
            const i = at(px0, py0);
            if (rawB && luma(rawB, i) < 1e-4) rawBlack++;
            if (posB) {
              const pi = atIn(posB, px0, py0);
              const px = posB.v(posB.a[pi]); const py = posB.v(posB.a[pi + 1]); const pz = posB.v(posB.a[pi + 2]);
              if (px === 0 && py === 0 && pz === 0) posZero++;
            }
            if (nrmB) {
              const nx = nrmB.v(nrmB.a[i]) * 2 - 1;
              const ny = nrmB.v(nrmB.a[i + 1]) * 2 - 1;
              const nz = nrmB.v(nrmB.a[i + 2]) * 2 - 1;
              const len = Math.hypot(nx, ny, nz);
              if (len < 1e-3) nrmZero++;
              if (len < 0.9 || len > 1.1) nrmDegenerate++;
              if (samples.length < 4) {
                const pi = atIn(posB, px0, py0);
                samples.push(
                  `px${px0},${py0} N=(${nx.toFixed(2)},${ny.toFixed(2)},${nz.toFixed(2)})|${len.toFixed(2)}` +
                  (posB ? ` P=(${posB.v(posB.a[pi]).toFixed(2)},${posB.v(posB.a[pi + 1]).toFixed(2)},${posB.v(posB.a[pi + 2]).toFixed(2)})` : ""),
                );
              }
            }
          }
          console.log(
            `RC-TRACE rawAlsoBlack=${rawBlack}/${black.length} ` +
            `posZero=${posZero} normalZero=${nrmZero} normalNotUnit=${nrmDegenerate}`,
          );
          for (const s of samples) console.log(`RC-SAMPLE ${s}`);
        }
      } catch (err) {
        console.log(`RC diag failed: ${err}`);
      }
      document.documentElement.dataset.shot = `min-${debugView}-${camX}_${camY}_${camZ}`;
      document.documentElement.dataset.done = "true";
    }, 300);
  }
  if (performance.now() - started > 90000) {
    document.documentElement.dataset.done = "true";
    return;
  }
  requestAnimationFrame(poll);
};
requestAnimationFrame(poll);
