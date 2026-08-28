// GI2 — THE VOLUME DEBUG VIEWS (§19 audits §AB)
//
// `occupancy`, `sdf` and `src-probes` are the three GI debug views that never
// sampled a screen texture: they showed the SRC occupancy pyramid, the SRC
// distance oracle and the SRC probe gizmos, all built by `srcDebugViews.js`
// from a `createSrcVolume` bundle. Under `GI2_PATH` there is no such bundle —
// `state.gizmos.sdfView` / `occView` are null and `state.screen.srcProbes` has
// no probe population — so all three modes were a SILENT NO-OP: the switch
// moved, the console said nothing, the frame did not change.
//
// This file is their GI2 replacement, and it is deliberately ONE mesh with one
// material and a mode uniform rather than three meshes: the three views differ
// only in how they colour the SAME camera ray, and three materials would be
// three pipelines to compile for a developer instrument.
//
// ══ WHY A FRAGMENT SHADER AND NOT A COMPUTE PASS ════════════════════════════
//
// `traceWindow` is a `sharedFn` over ONE storage buffer (`win.buffer`) plus
// uniforms — no atomics, no workgroup memory. three's WGSL builder emits
// `var<storage, read>` for any storage buffer bound outside the compute stage
// (`WGSLNodeBuilder.getNodeAccess`), and WebGPU allows read-only storage in a
// fragment shader, so the trace runs unchanged in a fullscreen quad. A compute
// pass would have needed its own rgba8 storage texture — one more thing sized
// to the viewport, and therefore one more thing to re-create and REBIND on
// every resize, which is the failure class this module logs most often.
//
// ══ EVERY BINDING HERE OUTLIVES A RESIZE, ON PURPOSE ════════════════════════
//
// ⭐⭐ THE GATHER IS REBUILT BY `gi2System.setSize`, AND ITS STORAGE BUFFERS DIE
// WITH IT. A debug view that bound `gather.buffers.probeMeta` (the obvious way
// to draw probe anchors) would hold a destroyed buffer after one viewport drag
// — a storage-buffer node cannot be repointed the way a `texture()` node can,
// so the repair would be a material rebuild, i.e. a pipeline compile, per hop.
//
// So this material binds exactly two things that can change:
//   · `win.buffer` — created once per GI2 system, SURVIVES a resize;
//   · `irrU`, a `texture()` node repointed per frame at
//     `gi2.textures.irradiance` (the same contract `_giIrradianceNode` has).
// plus its own uniforms and its own palette `uniformArray`, which is COPIED
// from the gather's rather than shared with it.
//
// The consequence for the probe view: it shows the probe TILE lattice and what
// each tile resolved to, not the probe ANCHOR inside the tile (that lives in
// `probeMeta`). Said out loud in the console line the view prints, because a
// debug view that quietly shows less than its name promises is exactly the
// "can the instrument see its subject" failure this module keeps paying for.
//
// `three/webgpu`, not `three` — `MeshBasicNodeMaterial` only exists on the
// WebGPU entry point and throws "is not a constructor" at RENDER time off the
// base build.
import * as THREE from "three/webgpu";
import {
  Fn, If, bitAnd, cameraPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, exp, float,
  floor, min, positionGeometry, screenUV, select, shiftRight, texture, uint, uniform, uniformArray,
  varying, vec2, vec3, vec4,
} from "three/tsl";
import { LEVEL_WORDS, PAL_OFF } from "./windowStore.js";

/** Mode codes on the material's `mode` uniform. 0 hides the mesh. */
export const GI2_VIEW = { OFF: 0, OCCUPANCY: 1, SDF: 2, PROBES: 3 };

/** The three modes this view serves, in the order the inspector lists them. */
export const GI2_VOLUME_VIEWS = ["occupancy", "sdf", "src-probes"];

/** Mode name → code, so no caller hard-codes a number. */
export const gi2ViewCode = (mode) => (
  mode === "occupancy" ? GI2_VIEW.OCCUPANCY
    : mode === "sdf" ? GI2_VIEW.SDF
      : mode === "src-probes" ? GI2_VIEW.PROBES
        : GI2_VIEW.OFF
);

/**
 * Per-face shading for the occupancy view — the "voxel world" look.
 *
 * `traceWindow` returns the face the ray ENTERED the hit voxel through (bit
 * order +X, −X, +Y, −Y, +Z, −Z). ⚠ That is the BLOCKING answer, not the
 * attribution one: with permissive face bits a grazing ray legitimately enters
 * a wall through ±Y (§19 3.9's note in `windowTrace.js`). It is still the right
 * thing to shade by HERE — this view exists to show what the DDA sees, and the
 * DDA sees exactly this face. The gather's `dominantFace` answers a different
 * question and stays with the gather.
 *
 * Bright from above, dark from below, two tones per horizontal axis: the only
 * reason a flat grey palette reads as GEOMETRY rather than as fog.
 */
const FACE_SHADE = [0.80, 0.66, 1.00, 0.42, 0.92, 0.58];

/**
 * The level that resolved a hit, as a hue. A fixed five-entry ramp (the deepest
 * tier has 5 levels) so the same level is the same colour on every tier — a
 * per-tier ramp would make two screenshots incomparable.
 */
const LEVEL_HUE = [
  [0.45, 0.72, 1.00], // L0 — the finest window
  [0.45, 1.00, 0.72], // L1
  [0.95, 0.95, 0.45], // L2
  [1.00, 0.66, 0.35], // L3
  [1.00, 0.42, 0.42], // L4 — the coarsest, and where a hand-off failure shows
];

/**
 * Builds the GI2 volume debug mesh.
 *
 * @param {object} deps
 * @param {object} deps.win     the window (`createGiWindow`) — outlives resizes
 * @param {object} deps.trace   `createWindowTrace` bundle
 * @param {number} [deps.palEntries]  palette class count (the gather's `PAL_ENTRIES`)
 * @param {number} [deps.tile]  screen-probe tile size in px (the gather's `T`)
 * @param {?{cascades:number, cells:number, spacings:number[]}} [deps.world]
 *   the world-probe lattice's SHAPE (never its buffers) — `gather.world`'s
 *   `cascades`/`cells`/`spacings`, all plain numbers baked at build time. Null
 *   when the build runs screen probes.
 */
export function createGi2DebugView({ win, trace, palEntries = 64, tile = 16, world = null }) {
  const { levels, voxel0, buffer } = win;
  // The longest ray that can stay inside the window: the top level's extent
  // along its diagonal. Derived from the tier's own geometry, never authored in
  // metres — the rule this module keeps re-learning (a constant in world units
  // gets retracted).
  const spanWorld = win.levelExtent(levels - 1) * Math.sqrt(3);
  // The distance ramp's knee. Level 0's extent is what the finest window can
  // resolve, so one L0 extent is the natural unit for "near".
  const rampWorld = win.levelExtent(0);

  const modeU = uniform(0, "uint");
  const tileU = uniform(tile);
  // The resolve's pixel size. A uniform rather than `irrU.size()` because the
  // probe grid must be expressible even before the first irradiance texture is
  // bound, and because the caller already knows the number.
  const sizeU = uniform(new THREE.Vector2(1, 1));
  // OUR OWN palette table. The gather's is rebuilt with the gather; a copy costs
  // `palEntries` vec4 uniforms and makes this material immortal. `uniformArray`
  // has `updateType = RENDER`, so mutating the vectors in place is the update.
  const palette = Array.from({ length: palEntries }, () => new THREE.Vector4(0.5, 0.5, 0.5, 0));
  const palU = uniformArray(palette, "vec4");
  // Repointed per frame at `gi2.textures.irradiance` — see the header. Seeded
  // with a 1x1 mid-grey so the material is valid before the first frame.
  const seed = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  seed.needsUpdate = true;
  const irrU = texture(seed);

  // ── THE WORLD LATTICE, AS A SHAPE ONLY ──────────────────────────────────
  //
  // ⚠ AND `__gi2WorldProbes` IS THE DEFAULT ON THIS BRANCH (see gatherProbes'
  // `WORLD_PROBES`), so the screen-probe tile lattice is the RARE arm, not the
  // common one. A probe view that only knew about screen probes would report
  // "no source" on every default boot — which is precisely the silent no-op
  // this file exists to end.
  //
  // Cascade COUNT, cell count per axis and per-cascade SPACING are tier
  // constants and are baked in; only the per-cascade ORIGIN moves, and it is a
  // vec3 uniform of integer CELL coordinates — the same convention
  // `worldProbes.setCamera` writes. ⛔ Nothing here binds `wpInfo` / `wpOct`:
  // those are the gather's storage buffers and die with it.
  const NC = Math.max(0, Math.min(4, world?.cascades ?? 0));
  const WCELLS = world?.cells ?? 32;
  const WSPACING = Array.from({ length: NC }, (_, c) => world?.spacings?.[c] ?? 0.5);
  const worldOnU = uniform(0);
  const worldOriginU = Array.from({ length: Math.max(1, NC) }, () => uniform(new THREE.Vector3()));

  const material = new THREE.MeshBasicNodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = false;
  // ⚠ NOT `toneMapped = false`. On the WebGPU node path `material.toneMapped`
  // is inert (three reads it only in the WebGL programs), and the frame's tone
  // mapping + output transfer are applied to whatever this quad writes. Every
  // branch below therefore writes in the SAME space the frame does: the palette
  // albedo is a linear reflectance and the ramps are linear greys.

  // Clip-space passthrough — `PlaneGeometry(2, 2)` has xy in [-1, 1] and z = 0,
  // so this covers the frame wherever the mesh sits in the world. Identical to
  // `#buildDebugView`'s quad and for the identical reason: a mesh parented to
  // the camera is NOT traversed by `renderer.render(scene, camera)`.
  material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 0, 1);

  // ── THE RAY ─────────────────────────────────────────────────────────────
  //
  // The quad's own geometry IS the NDC: `PlaneGeometry(2, 2)` puts xy in
  // [-1, 1] and the vertex node above passes them through untouched, so a
  // varying of `positionGeometry.xy` is the pixel's NDC exactly — no
  // `screenUV` and therefore no question about which way its v runs (the
  // screen-Y sign error that made GTAO read a flat unoccluded floor at 0.55).
  //
  // Clip w is 1 at every vertex of this quad, so the interpolation is LINEAR
  // and the interpolated NDC is exact rather than an approximation that drifts
  // at the corners. The two matrix multiplies stay in the FRAGMENT stage: they
  // are `renderGroup` uniforms either way, and keeping the varying down to two
  // floats of pure geometry is what makes it immune to a camera swap.
  const ndcXY = varying(vec2(positionGeometry.x, positionGeometry.y), "gi2DebugNdc");

  /** The palette class byte of a window voxel — mirrors `gatherProbes.palIndexAt`. */
  const palIndexAt = (levelF, voxF) => {
    const vi = voxF.toUint().toVar();
    const wAddr = levelF.toUint().mul(uint(LEVEL_WORDS)).add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)));
    const shiftBits = bitAnd(vi, uint(3)).mul(uint(8));
    return min(bitAnd(shiftRight(buffer.element(wAddr), shiftBits), uint(255)), uint(palEntries - 1));
  };

  /**
   * A runtime index into a fixed JS table, as a select chain. Three to five
   * compares, no scratch memory — a vec3 cannot be indexed by a runtime value
   * in WGSL, which is the same constraint `windowTrace`'s `stepOf` works around.
   */
  const pick = (indexNode, table, make) => {
    let node = make(table[table.length - 1]);
    for (let i = table.length - 2; i >= 0; i--) node = select(indexNode.equal(uint(i)), make(table[i]), node);
    return node;
  };

  material.fragmentNode = Fn(() => {
    // ⚠ ONE `out` AND ONE `return`. A `return` inside an `If` body is a JS
    // return from the callback — TSL discards it, and the shader falls through
    // to whatever follows. Every branch below therefore ASSIGNS.
    const out = vec3(0, 0, 0).toVar();

    If(modeU.equal(uint(GI2_VIEW.PROBES)).and(worldOnU.lessThan(0.5)), () => {
      // ── THE SCREEN-PROBE TILE LATTICE ────────────────────────────────────
      //
      // No trace, no window read: this one is about the RESOLVE's structure,
      // and `screenUV` plus the tile size is all of it. Each tile is filled
      // with the irradiance the resolve produced at the tile's own CENTRE — so
      // every tile is flat, which is what makes the lattice visible at all (the
      // resolved image is smooth by construction and shows no grid).
      const dims = vec2(sizeU).toVar();
      const px = screenUV.mul(dims).toVar();
      const t = float(tileU).max(1).toVar();
      const cell = floor(px.div(t)).toVar();
      const centre = cell.add(0.5).mul(t).toVar();
      // E → the diffuse the frame builds with a white albedo (`giLight` adds
      // `irradiance / π` to the material's radiance). The SAME factor the
      // `indirect` term view applies, so the two views are comparable.
      const tileColor = irrU.sample(centre.div(dims)).rgb.div(Math.PI).toVar();
      // The lattice itself: a one-pixel darker line on the tile's two low
      // edges. Cheap, exact, and it survives any tile size.
      const local = px.sub(cell.mul(t)).toVar();
      const onGrid = local.x.lessThan(1).or(local.y.lessThan(1));
      // The tile CENTRE, marked — where the tile's ray budget is spent. ⚠ NOT
      // the probe's anchor, which lives in `probeMeta`; see the header.
      const dc = px.sub(centre).abs().toVar();
      const onCentre = dc.x.lessThan(1.5).and(dc.y.lessThan(1.5));
      out.assign(select(onCentre, vec3(1, 0.2, 0.9), select(onGrid, tileColor.mul(0.25), tileColor)));
    }).Else(() => {
      // ── THE WINDOW, TRACED FROM THE CAMERA ──────────────────────────────
      const farView = cameraProjectionMatrixInverse.mul(vec4(ndcXY.x, ndcXY.y, 1, 1)).toVar();
      const farWorld = cameraWorldMatrix.mul(vec4(farView.xyz.div(farView.w), 1)).xyz.toVar();
      const dir = farWorld.sub(cameraPosition).normalize().toVar();
      // ⭐⭐ THE ORIGIN ESCAPES ALONG THE RAY, AND IT IS NOT AN OPTIMISATION.
      //
      // MEASURED on Bistro at the street pose: `sdf` came back ONE COLOUR on
      // 100 % of the frame and `occupancy` came back TWO — every ray reporting a
      // level-0 hit at t ≈ 0. The camera was standing inside a voxel. The
      // voxelization is CONSERVATIVE (a cell is occupied if a triangle merely
      // touches it), so at 0.25 m cells any camera within a quarter of a metre
      // of a wall, a kerb or the ground is inside the occupied set — which is
      // most eye-level poses in a street — and the view then renders that one
      // voxel's palette over the whole screen. A debug view that goes blank
      // whenever the camera is near a surface is not usable.
      //
      // The trace already owns the fix: passing a normal turns on `ORIGIN_ESCAPE`
      // (`windowTrace.js`), which walks the origin out of occupied cells up to
      // three whole cells. The normal to walk along is the RAY's own direction —
      // for a camera there is no surface normal, and forward is the only
      // direction that cannot hide something the frame was going to show.
      //
      // ⚠ THE PRICE, stated: geometry within ~1 cell of the eye is not drawn,
      // and `t` is measured from the biased origin (so the distance ramp reads
      // up to one cell short). Both are invisible at any normal pose, and both
      // are strictly better than a monochrome frame.
      const r = trace.traceWindow(cameraPosition, dir, float(spanWorld), dir, float(1));
      const hit = r.hit.toVar();
      const tHit = r.t.toVar();
      const faceId = r.faceId.toVar();
      const level = r.level.toVar();
      const voxel = r.voxelIdx.toVar();
      If(hit.greaterThan(0.5), () => {
        If(modeU.equal(uint(GI2_VIEW.OCCUPANCY)), () => {
          // ── THE VOXEL WORLD THE RAYS SEE ────────────────────────────────
          //
          // Palette albedo, face-shaded. The ONE view that answers "is the
          // geometry the GI traces the geometry I placed, and is it the COLOUR
          // I gave it" — a class that clustered wrong, a mover the dynamic
          // layer never wrote, a façade the voxelizer dilated shut, all read
          // directly off it.
          const cls = palIndexAt(level.toFloat(), voxel.toFloat()).toVar();
          const alb = palU.element(cls).xyz.toVar();
          // ⚠ `palEntries - 1` IS THE RESERVED "no surface" CLASS and its
          // albedo is black, which would render a real, occupied voxel as a
          // hole. It is reachable for an honest reason: the trace reports the
          // STATIC level of a hit, and a voxel written only by the dynamic
          // layer carries no static palette byte. Mid-grey rather than black,
          // so a mover reads as geometry with an unknown material instead of
          // as missing geometry.
          const known = alb.x.add(alb.y).add(alb.z).greaterThan(1e-4);
          const base = select(known, alb, vec3(0.45, 0.45, 0.48)).toVar();
          const shade = pick(faceId, FACE_SHADE, (v) => float(v)).toVar();
          out.assign(base.mul(shade));
        }).ElseIf(modeU.equal(uint(GI2_VIEW.SDF)), () => {
          // ── DISTANCE, AND THE LEVEL THAT ANSWERED ───────────────────────
          //
          // The GI2 window has no signed distance field; what the mode named
          // "sdf" is really asking is "how far does a ray get, and which window
          // answered" — the hand-off this design lives or dies on. A ray that
          // resolves on L3 where the scene is 4 m away is a window that failed
          // to keep up with the camera.
          //
          // Brightness is the distance ramp (near = bright), hue is the level.
          // `1 − exp(−t / L0extent)` rather than `t / span`: the span is 256 m
          // on the desktop tier and a street scene lives in the first 20 of it,
          // so a linear ramp would compress the picture into its first tenth.
          const norm = float(1).sub(exp(tHit.div(float(rampWorld)).negate())).clamp(0, 1).toVar();
          const grey = float(1).sub(norm).mul(0.85).add(0.15).toVar();
          const hue = pick(level, LEVEL_HUE, (c) => vec3(c[0], c[1], c[2])).toVar();
          out.assign(hue.mul(grey));
        });
        if (NC > 0) {
          // ── THE WORLD-PROBE LATTICE, ON THE SURFACES IT LIGHTS ──────────
          //
          // `__gi2WorldProbes` is the DEFAULT on this branch, so this — not the
          // screen tile grid — is what "src-probes" usually shows. There is no
          // screen tile to draw a grid in; the lattice is a 3D clipmap in WORLD
          // space, so the readable projection of it is its cell frame drawn on
          // the geometry the camera can see, over the light those probes
          // produced at that pixel.
          //
          // ⚠ WHAT THIS IS NOT: a readback of each probe's SH DC. That lives in
          // `wpInfo`, a storage buffer of the GATHER — bound here it would be
          // destroyed by the next resize (see the header). The irradiance
          // texture is the same energy one interpolation later, it is
          // repointable, and it is what the frame actually consumed.
          If(modeU.equal(uint(GI2_VIEW.PROBES)), () => {
            const P = cameraPosition.add(dir.mul(tHit)).toVar();
            // Which cascade owns this point — FINEST first, exactly as the
            // resolve picks. `origin` is in integer CELL coordinates, the
            // convention `worldProbes.setCamera` writes.
            const casc = float(-1).toVar();
            const gCell = vec3(0, 0, 0).toVar();
            for (let c = NC - 1; c >= 0; c--) {
              const g = P.div(float(WSPACING[c])).toVar();
              const rel = g.floor().sub(worldOriginU[c]).toVar();
              const inside = rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0))
                .and(rel.z.greaterThanEqual(0)).and(rel.x.lessThan(WCELLS))
                .and(rel.y.lessThan(WCELLS)).and(rel.z.lessThan(WCELLS));
              casc.assign(select(inside, float(c), casc));
              gCell.assign(select(inside, g, gCell));
            }
            // The light those probes produced here, at a white albedo — the
            // same E/π every other view in this file shows.
            const lit = irrU.sample(screenUV).rgb.div(Math.PI).toVar();
            let hueNode = vec3(LEVEL_HUE[0][0], LEVEL_HUE[0][1], LEVEL_HUE[0][2]);
            for (let c = NC - 1; c >= 1; c--) {
              hueNode = select(casc.equal(float(c)), vec3(LEVEL_HUE[c][0], LEVEL_HUE[c][1], LEVEL_HUE[c][2]), hueNode);
            }
            const hue = hueNode.toVar();
            const base = gCell.floor().toVar();
            const frac = gCell.sub(base).toVar();
            // The cell FRAME: a thin band at every cell face. Read as a
            // wireframe box lattice lying on the geometry.
            const near = frac.min(frac.oneMinus()).toVar();
            const onEdge = near.x.min(near.y).min(near.z).lessThan(0.03);
            // A 3D checker so cells are countable even on a flat wall where
            // only one face of the frame is visible.
            const sum = base.x.add(base.y).add(base.z).toVar();
            const parity = sum.mul(0.5).sub(sum.mul(0.5).floor()).mul(2).toVar();
            const body = lit.mul(parity.mul(0.25).add(0.75)).toVar();
            // ⚠ A HIT OUTSIDE EVERY LATTICE gets no world probe at all — the
            // one failure this view exists to make visible. Flagged, not shaded.
            // A HUE FLOOR ON THE BODY, so the lattice is readable where the
            // light is not: an unlit corner would otherwise be black, and a
            // lattice you cannot see in the dark is exactly no use when the
            // question is "why is this corner black".
            const shown = body.mul(0.8).add(hue.mul(0.05)).toVar();
            out.assign(select(
              casc.lessThan(0),
              vec3(0.45, 0.0, 0.25),
              select(onEdge, hue.mul(0.9), shown),
            ));
          });
        }
      });
    });
    // A MISS IS BLACK, not a dark sky tint. The receipt behind these views
    // counts non-black texels; a 0.02 "sky" would be counted as content and
    // inflate the very number the gate reads.
    return vec4(out, 1);
  })();

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  // Level with the SRC volume boxes it replaces (9999), below the term overlay
  // (10000). Only one of the three is ever visible, so the order is a label.
  mesh.renderOrder = 9999;
  mesh.name = "gi2DebugVolumeView";
  mesh.userData.__giDebug = true;

  return {
    mesh,
    material,
    /** @param {number} code one of `GI2_VIEW` */
    setMode(code) {
      if (modeU.value !== code) modeU.value = code;
    },
    /**
     * Copy the gather's palette in — the gather's OWN array of
     * `THREE.Vector4(albedo.rgb, emissiveMean)`. A copy, not a shared binding:
     * see the header.
     */
    setPalette(source) {
      if (!source?.length) return;
      const n = Math.min(source.length, palette.length);
      for (let i = 0; i < n; i++) palette[i].copy(source[i]);
    },
    /** Repoint the probe view's colour source. Safe to call every frame. */
    setIrradiance(tex) {
      if (tex && irrU.value !== tex) irrU.value = tex;
    },
    /** The resolve's pixel size, which the probe grid is measured in. */
    setSize(width, height) {
      if (sizeU.value.x !== width || sizeU.value.y !== height) sizeU.value.set(width, height);
    },
    setTile(px) {
      if (px > 0 && tileU.value !== px) tileU.value = px;
    },
    /**
     * The world lattice's live per-cascade ORIGIN, in integer cell coordinates
     * — `worldProbes.origins[c].value`, COPIED. Passing `null` (or a build with
     * no lattice) puts the probe view back on the screen tile grid.
     *
     * ⚠ COPIED, not shared. Those uniform nodes belong to the gather and are
     * replaced with it; holding them would leave this material reading a
     * lattice that stopped following the camera at the last resize.
     */
    setWorldOrigins(origins) {
      const on = NC > 0 && !!origins?.length;
      if (worldOnU.value !== (on ? 1 : 0)) worldOnU.value = on ? 1 : 0;
      if (!on) return;
      for (let c = 0; c < NC && c < origins.length; c++) {
        const v = origins[c]?.value ?? origins[c];
        if (v) worldOriginU[c].value.set(v.x ?? v[0] ?? 0, v.y ?? v[1] ?? 0, v.z ?? v[2] ?? 0);
      }
    },
    /** Whether this material was built with a world lattice at all. */
    get worldCascades() { return NC; },
    get worldSpacings() { return WSPACING.slice(); },
    get worldCells() { return WCELLS; },
    get span() { return spanWorld; },
    get ramp() { return rampWorld; },
    get levels() { return levels; },
    get voxel0() { return voxel0; },
    dispose() {
      geometry.dispose();
      material.dispose();
      seed.dispose();
    },
  };
}
