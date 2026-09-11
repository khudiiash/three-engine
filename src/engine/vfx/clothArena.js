/**
 * ══ THE CLOTH ARENA — the GPU half ═══════════════════════════════════════════
 *
 * One particle set for every cloth in the scene, one fused kernel per fixed
 * step, one submission per frame. See `clothArenaPack.js` for the layouts and
 * the reasoning, and `clothArenaModel.js` for the CPU transliteration of the
 * step kernel that the tests run — ⛔ the two must change together.
 *
 * Per frame, for the WHOLE scene:
 *   · `n` step dispatches (six at 60 fps, twelve at 30), alternating the two
 *     position buffers, each over every particle of every cloth;
 *   · one surface dispatch per cloth that is on screen, writing that cloth's
 *     own position/normal attributes.
 * Ten curtains cost ~16 dispatches a frame; the previous solver issued ~300.
 *
 * ⚠ THE GPU OWNS THE POSE. The position buffers are never uploaded after
 * creation: a cloth that joins is seeded by the kernel itself (the reset
 * flag writes its rest pose), a cloth that leaves has its cloth id cleared in
 * the static buffer, and a range is never moved while it is live. Only
 * outgrowing the capacity rebuilds the buffers, and that resets every cloth —
 * once, and deliberately.
 *
 * Storage bindings in the step kernel: the two position buffers, `prev`, the
 * statics, the springs, the primitive colliders and the collision buffer —
 * seven, inside WebGPU's guaranteed eight. Everything per cloth is a uniform
 * array row, not a buffer.
 */
import * as THREE from "three/webgpu";
import { Break, Fn, If, Loop, Return, cross, dot, float, instanceIndex, instancedArray, int, select, storage, uniform, uniformArray, vec3, vec4 } from "three/tsl";
import {
  ARENA_INITIAL_CAPACITY, ARENA_INITIAL_COLLISION_FLOATS, ARENA_INITIAL_STRIDE, ARENA_MAX_ANCHORS, ARENA_MAX_CLOTHS,
  ArenaLayout, CLOTH_LRA_RELAX, CLOTH_RELAXATION, CLOTH_STEP, PARAM_ROWS, ROW, STATIC_STRIDE, TRI_FLOATS,
  buildGridClothTopology, buildTriangleGrid, clearMemberStatic, clothReachBox, clothRestBounds, clothSteps,
  packCollision, triangleTouchesBox, writeClothParams, writeMemberStatic,
} from "./clothArenaPack.js";
import { MAX_CLOTH_ANCHORS, resolveClothAnchors } from "./clothAnchors.js";
import { resolveClothWind, sceneWind } from "./clothWind.js";
import { ParticleColliderField } from "../particleColliders.js";
import { ClothMeshColliderField } from "../clothMeshColliders.js";
import { releaseComputeNodes, releaseStorageAttributes } from "../../modules/gi/releaseCompute.js";
import { freeze } from "../freezeLedger.js";

// Dev flags persisted by `profile.clothFlag` (`__clothLegacy`, `__clothRelax`,
// `__clothLraRelax`, `__clothArenaNoContact`, ...), applied before any cloth
// is built — this module is imported by the component that builds them.
try {
  const store = JSON.parse(globalThis.localStorage?.getItem("cloth.devFlags.v1") ?? "{}");
  for (const [name, value] of Object.entries(store)) globalThis[name] ??= value;
} catch { /* no storage: a flag applies only when set live */ }

const finite = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : fallback));
/** A grid rebuilt when its cloth moved this far, in metres. */
const GRID_MOVE_TOLERANCE = .25;
/** Anchors of every cloth, resolved into one scratch set per member. */
const _anchorScratch = Array.from({ length: MAX_CLOTH_ANCHORS }, () => new THREE.Vector4());
const _inverse = new THREE.Matrix4();

/* -------------------------------------------------------------------------- */
/* The arena                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * ⛔⛔ THE ARENA MUST NOT HANG OFF THE ENGINE OBJECT. GI's teardown
 * (`GISystem` → `collectStateComputeNodes` / `collectStateStorageAttributes`)
 * walks plain objects six levels deep from its state looking for STALE compute
 * nodes and the storage buffers they bind, then evicts the nodes and — a few
 * frames later — destroys those buffers and empties their CPU arrays. An
 * arena stored as `engine.__clothArena` sits inside that walk: on the first
 * GI rebuild after boot it evicted the step kernels and doomed every arena
 * buffer, and the next dispatch recreated `arena:statics` from a zero-length
 * array ("Binding size for [Buffer "arena:statics"] is zero"). A WeakMap is
 * not enumerable, so the walk cannot reach it.
 */
const arenas = new WeakMap();

export class ClothArena {
  /** The scene's one arena, made on first use. */
  static for(engine) {
    if (!engine) throw new Error("the cloth arena needs an engine");
    let arena = arenas.get(engine);
    if (!arena) { arena = new ClothArena(engine); arenas.set(engine, arena); }
    return arena;
  }
  /** The arena an engine has, if any — for diagnostics only. */
  static of(engine) { return arenas.get(engine) ?? null; }

  constructor(engine) {
    this.engine = engine;
    this.members = new Set();
    // `__clothArenaInitial = { capacity, stride, collision }` shrinks the first
    // allocation so a smoke can exercise the rebuild path on a small scene.
    const initial = globalThis.__clothArenaInitial ?? {};
    this.capacity = Math.max(64, Math.floor(initial.capacity) || ARENA_INITIAL_CAPACITY);
    this.stride = Math.max(4, Math.floor(initial.stride) || ARENA_INITIAL_STRIDE);
    this.collisionCapacity = Math.max(4096, Math.floor(initial.collision) || ARENA_INITIAL_COLLISION_FLOATS);
    this.generation = 0;
    this.rebuilds = 0;
    this.rowFree = Array.from({ length: ARENA_MAX_CLOTHS }, (_, i) => ARENA_MAX_CLOTHS - 1 - i);
    this.rows = new Float32Array(ARENA_MAX_CLOTHS * PARAM_ROWS * 4);
    this.paramRows = Array.from({ length: ARENA_MAX_CLOTHS * PARAM_ROWS }, () => new THREE.Vector4());
    this.params = uniformArray(this.paramRows, "vec4");
    this.anchorRows = Array.from({ length: ARENA_MAX_ANCHORS }, () => new THREE.Vector4(0, 0, 0, -1));
    this.anchors = uniformArray(this.anchorRows, "vec4");
    this.anchorCount = uniform(0, "int");
    this.simTimeUniform = uniform(0);
    // ⚠ A UNIFORM, NOT A LITERAL. A constant trip count invites the driver to
    // unroll the spring loop (32 copies of its body), and the arena's first
    // live compile took 25 s of main thread. A uniform bound cannot be unrolled.
    this.strideUniform = uniform(this.stride, "int");
    this.accumulator = 0;
    this.simTime = 0;
    /** 0: `posA` holds the current pose; 1: `posB` does. */
    this.parity = 0;
    this.collisionDirty = true;
    this.renderer = null;
    this.stats = { members: 0, particles: 0, capacity: this.capacity, stride: this.stride, steps: 0, dispatches: 0, surfaces: 0, collisionFloats: 0, triangles: 0, frame: 0, stepHz: 1 / CLOTH_STEP };
    this.colliderField = engine.particleColliders ??= new ParticleColliderField(engine);
    this.colliderField.addUser();
    this.meshColliderField = engine.clothMeshColliders ??= new ClothMeshColliderField(engine);
    this.#allocate();
    this.frameCallback = () => this.#frame();
    this.unsubscribe = engine.onPreRender(this.frameCallback);
  }

  /* ── buffers and kernels ─────────────────────────────────────────────── */

  #allocate() {
    const cap = this.capacity, stride = this.stride;
    this.arrays = {
      statics: new Float32Array(cap * STATIC_STRIDE * 4),
      springs: new Float32Array(cap * stride * 4).fill(-1),
      collision: new Float32Array(this.collisionCapacity),
      rest: new Float32Array(cap * 4),
    };
    for (let v = 0; v < cap; v++) this.arrays.statics[v * STATIC_STRIDE * 4 + 8] = -1;
    const named = (node, name) => { node.value.name = `arena:${name}`; return node; };
    // ⚠ The position buffers are created from the REST copy, so a renderer
    // that has to recreate them (a device loss, a play/stop rebuild) shows a
    // cloth at rest rather than at the origin until the reset lands.
    this.posA = named(instancedArray(this.arrays.rest, "vec4"), "posA");
    this.posB = named(instancedArray(this.arrays.rest, "vec4"), "posB");
    this.prev = named(instancedArray(this.arrays.rest, "vec4"), "prev");
    this.staticsNode = named(instancedArray(this.arrays.statics, "vec4"), "statics");
    this.springsNode = named(instancedArray(this.arrays.springs, "vec4"), "springs");
    this.collisionNode = named(instancedArray(this.arrays.collision, "float"), "collision");
    this.layout = new ArenaLayout(cap);
    this.strideUniform.value = stride;
    this.stepAB = this.#stepKernel(this.posA, this.posB);
    this.stepBA = this.#stepKernel(this.posB, this.posA);
    this.parity = 0;
    this.generation++;
  }

  /**
   * ⛔ CHEAP-AND-BROKEN LOOKS EXACTLY LIKE CHEAP-AND-WORKING. A zero-sized
   * storage binding fails the whole command buffer and the frame counter reads
   * a beautiful 120 fps with nothing simulating (the flock died of this, twice).
   * So every buffer the queue will bind is checked before the submission: the
   * CPU twin's length and, where the backend already holds one, the GPU
   * buffer's size. Any zero is reported once with the generation it belongs to.
   */
  #audit(renderer, queue) {
    const backend = renderer.backend;
    const rows = { statics: this.staticsNode.value, springs: this.springsNode.value, collision: this.collisionNode.value, posA: this.posA.value, posB: this.posB.value, prev: this.prev.value };
    for (const m of this.members) if (m.id >= 0) { rows[`simIndex@${m.id}`] = m.simIndexNode.value; if (m.offsetNode) rows[`shellOffset@${m.id}`] = m.offsetNode.value; }
    const bad = [];
    for (const [name, attr] of Object.entries(rows)) {
      const cpu = attr?.array?.byteLength ?? -1;
      let gpu = null;
      try { if (backend?.has?.(attr) === true) gpu = backend.get(attr)?.buffer?.size ?? null; } catch { gpu = "?"; }
      if (cpu <= 0 || gpu === 0) bad.push(`${name}: cpu ${cpu} B, gpu ${gpu}`);
    }
    if (bad.length) {
      // Something outside this file destroyed or emptied an arena buffer (a
      // foreign release sweep). Dispatching would invalidate the whole
      // submission and every cloth would silently stop; rebuilding resets
      // every cloth once and keeps them alive, and says so.
      console.error(`[cloth] arena generation ${this.generation} has an EMPTY buffer before dispatch — ${bad.join("; ")} (queue ${queue.length}, members ${this.members.size}, capacity ${this.capacity}, stride ${this.stride}); rebuilding`);
      this.#rebuild();
      return false;
    }
    return true;
  }

  #release() {
    const renderer = this.engine.renderer;
    const kernels = [this.stepAB, this.stepBA];
    for (const m of this.members) { kernels.push(m.surfaceA, m.surfaceB); m.surfaceA = m.surfaceB = null; }
    releaseComputeNodes(renderer, kernels.filter(Boolean));
    releaseStorageAttributes(renderer, [this.posA, this.posB, this.prev, this.staticsNode, this.springsNode, this.collisionNode].map((n) => n.value));
  }

  /**
   * Outgrown: new buffers of the requested size, every member re-packed
   * into them, every cloth reset. Rare, and it costs a pipeline compile.
   */
  #rebuild({ capacity = this.capacity, stride = this.stride, collision = this.collisionCapacity } = {}) {
    const span = freeze.begin("cloth:arena rebuild");
    try {
      this.#release();
      this.capacity = capacity; this.stride = stride; this.collisionCapacity = collision;
      this.#allocate();
      this.rebuilds++;
      if (globalThis.__clothArenaLog) console.warn(`[cloth] arena rebuild #${this.rebuilds} → capacity ${capacity}, stride ${stride}, collision ${collision}, members ${this.members.size}`);
      const members = [...this.members];
      for (const m of members) {
        m.base = this.layout.allocate(m.count, m);
        if (m.base < 0) throw new Error(`cloth arena rebuild could not place ${m.count} particles in ${capacity}`);
        this.#writeStatic(m);
        m.resetPending = true;
        m.initialized = false;
      }
      this.collisionDirty = true;
      this.stats.capacity = capacity; this.stats.stride = stride;
    } finally { freeze.end(span); }
  }

  #writeStatic(m) {
    writeMemberStatic({ statics: this.arrays.statics, springs: this.arrays.springs, stride: this.stride }, m.topology, m.base, m.id);
    for (let v = 0; v < m.count; v++) {
      const r = (m.base + v) * 4, s = (m.base + v) * STATIC_STRIDE * 4;
      this.arrays.rest[r] = this.arrays.statics[s]; this.arrays.rest[r + 1] = this.arrays.statics[s + 1]; this.arrays.rest[r + 2] = this.arrays.statics[s + 2]; this.arrays.rest[r + 3] = 0;
    }
    this.#upload(this.staticsNode.value, m.base * STATIC_STRIDE * 4, m.count * STATIC_STRIDE * 4);
    this.#upload(this.springsNode.value, m.base * this.stride * 4, m.count * this.stride * 4);
  }

  /** Upload one slice of a static buffer (three honours update ranges). */
  #upload(attribute, start, count) {
    attribute.addUpdateRange(start, count);
    attribute.needsUpdate = true;
  }

  /** The step: Verlet, one Jacobi pass, the fabric cap, contact — `clothArenaModel.js` in TSL. */
  #stepKernel(read, write) {
    const { stride } = this;
    const params = this.params, statics = this.staticsNode, springs = this.springsNode, prev = this.prev, collision = this.collisionNode, strideUniform = this.strideUniform;
    const colliders = this.colliderField.buffer, primitiveCount = this.colliderField.countUniform;
    const anchors = this.anchors, anchorCount = this.anchorCount, simTime = this.simTimeUniform;
    const stepSq = float(CLOTH_STEP * CLOTH_STEP);
    return Fn(() => {
      const i = instanceIndex.toInt();
      const meta = statics.element(i.mul(STATIC_STRIDE).add(2));
      const id = meta.x.toInt();
      If(id.lessThan(0), () => { Return(); });
      const row = (k) => params.element(id.mul(PARAM_ROWS).add(k));
      const state = row(ROW.STATE);
      const rest = statics.element(i.mul(STATIC_STRIDE));
      const lra = statics.element(i.mul(STATIC_STRIDE).add(1));
      const p = read.element(i).xyz.toVar();
      const q = prev.element(i).xyz.toVar();
      const out = vec3(p).toVar(), outPrev = vec3(p).toVar();
      If(state.x.greaterThan(.5).or(rest.w.greaterThan(.5)), () => {
        out.assign(rest.xyz); outPrev.assign(rest.xyz);
      }).ElseIf(state.y.greaterThan(.5), () => {
        const w0 = row(ROW.WORLD), w1 = row(ROW.WORLD + 1), w2 = row(ROW.WORLD + 2), w3 = row(ROW.WORLD + 3);
        const i0 = row(ROW.INVERSE), i1 = row(ROW.INVERSE + 1), i2 = row(ROW.INVERSE + 2), i3 = row(ROW.INVERSE + 3);
        const toWorld = (v) => w0.xyz.mul(v.x).add(w1.xyz.mul(v.y)).add(w2.xyz.mul(v.z)).add(w3.xyz);
        const toLocal = (v) => i0.xyz.mul(v.x).add(i1.xyz.mul(v.y)).add(i2.xyz.mul(v.z)).add(i3.xyz);
        const dirToLocal = (v) => i0.xyz.mul(v.x).add(i1.xyz.mul(v.y)).add(i2.xyz.mul(v.z));
        const forces = row(ROW.FORCES), windRow = row(ROW.WIND), contact = row(ROW.CONTACT), skip = row(ROW.SKIP);
        const g = forces.x, damp = forces.y, stiffness = forces.z, bend = forces.w;
        const wind = windRow.xyz, gust = windRow.w, gustFreq = contact.x, shear = contact.y, radiusAuthored = contact.z, friction = contact.w;
        // ── Verlet ──────────────────────────────────────────────────────────
        const speed = wind.length();
        const wp = toWorld(p);
        const gustAmp = simTime.mul(gustFreq).mul(Math.PI * 2).add(wp.x.mul(.8)).add(wp.y.mul(.6)).sin().mul(gust.add(speed.mul(.35)))
          .add(simTime.mul(.731).add(wp.y.mul(1.4)).sin().mul(speed).mul(.15));
        const heading = wind.div(speed.max(1e-4));
        const accel = dirToLocal(vec3(0, g.negate(), 0).add(wind).add(heading.mul(gustAmp)));
        const next = p.add(p.sub(q).mul(damp)).add(accel.mul(stepSq)).toVar();
        // ── one Jacobi pass over the springs, from the READ buffer ──────────
        const corr = vec3(0).toVar(), total = float(0).toVar();
        const sbase = i.mul(strideUniform);
        Loop({ start: 0, end: strideUniform, name: "j" }, ({ j }) => {
          const s = springs.element(sbase.add(j));
          If(s.x.lessThan(0), () => { Break(); });
          const other = read.element(s.x.toInt()).xyz;
          const d = other.sub(p);
          const len = d.length().max(1e-5);
          const w = select(s.z.lessThan(.5), float(1), select(s.z.lessThan(1.5), bend, shear));
          corr.addAssign(d.mul(len.sub(s.y).div(len).mul(w).mul(.5)));
          total.addAssign(w);
        });
        next.addAssign(corr.mul(stiffness.mul(state.z).div(total.max(1e-4))));
        // ── the fabric-length cap ───────────────────────────────────────────
        const lraRelax = skip.w;
        If(lra.w.greaterThan(0).and(lraRelax.greaterThan(0)), () => {
          const away = next.sub(lra.xyz);
          const far = away.length();
          If(far.greaterThan(lra.w), () => {
            const capped = lra.xyz.add(away.mul(lra.w.div(far.max(1e-6))));
            next.addAssign(capped.sub(next).mul(lraRelax));
          });
        });
        // ── contact, in world space ─────────────────────────────────────────
        const radiusCap = meta.y;
        const radius = select(radiusCap.greaterThan(0), radiusAuthored.min(radiusCap), radiusAuthored).toVar();
        const pw = toWorld(p).toVar(), nw = toWorld(next).toVar();
        const vel = nw.sub(pw).toVar();
        const touched = float(0).toVar();
        const resolve = (normal, push) => {
          nw.addAssign(normal.mul(push));
          const nv = dot(vel, normal);
          If(nv.lessThan(0), () => { vel.subAssign(normal.mul(nv)); });
          touched.assign(1);
        };
        If(skip.z.greaterThan(.5), () => {
          const skipPrimitive = skip.x.toInt(), skipMesh = skip.y.toInt();
          Loop({ start: 0, end: primitiveCount, name: "k" }, ({ k }) => {
            If(k.notEqual(skipPrimitive), () => {
              const base = k.mul(4);
              const a = colliders.element(base), b = colliders.element(base.add(1)), c = colliders.element(base.add(2)), d = colliders.element(base.add(3));
              const centre = a.yzw;
              If(a.x.lessThan(.5), () => {
                const extent = vec3(b.w, c.w, d.w), rel = nw.sub(centre);
                const local = vec3(dot(rel, b.xyz), dot(rel, c.xyz), dot(rel, d.xyz));
                const clamped = local.clamp(extent.negate(), extent);
                const closest = centre.add(b.xyz.mul(clamped.x)).add(c.xyz.mul(clamped.y)).add(d.xyz.mul(clamped.z));
                const delta = nw.sub(closest), distance = delta.length();
                If(distance.greaterThan(1e-5), () => {
                  If(distance.lessThan(radius), () => resolve(delta.div(distance), radius.sub(distance)));
                }).Else(() => {
                  const penetration = extent.sub(local.abs());
                  If(penetration.x.lessThanEqual(penetration.y).and(penetration.x.lessThanEqual(penetration.z)), () => {
                    resolve(b.xyz.mul(select(local.x.greaterThanEqual(0), float(1), float(-1))), penetration.x.add(radius));
                  }).ElseIf(penetration.y.lessThanEqual(penetration.z), () => {
                    resolve(c.xyz.mul(select(local.y.greaterThanEqual(0), float(1), float(-1))), penetration.y.add(radius));
                  }).Else(() => resolve(d.xyz.mul(select(local.z.greaterThanEqual(0), float(1), float(-1))), penetration.z.add(radius)));
                });
              }).Else(() => {
                const delta = nw.sub(centre), distance = delta.length(), reach = b.w.add(radius);
                If(distance.lessThan(reach), () => {
                  const normal = select(distance.greaterThan(1e-5), delta.div(distance.max(1e-5)), vec3(0, 1, 0));
                  resolve(normal, reach.sub(distance));
                });
              });
            });
          });
          const origin = row(ROW.GRID_ORIGIN), dims = row(ROW.GRID_DIMS);
          const cell = origin.w;
          If(cell.greaterThan(0), () => {
            const rel = nw.sub(origin.xyz).div(cell).floor();
            const cx = rel.x.toInt(), cy = rel.y.toInt(), cz = rel.z.toInt();
            const dx = dims.x.toInt(), dy = dims.y.toInt(), dz = dims.z.toInt();
            If(cx.greaterThanEqual(0).and(cy.greaterThanEqual(0)).and(cz.greaterThanEqual(0)).and(cx.lessThan(dx)).and(cy.lessThan(dy)).and(cz.lessThan(dz)), () => {
              const cbase = dims.w.toInt().add(cx).add(cy.mul(dx)).add(cz.mul(dx).mul(dy));
              const start = collision.element(cbase).toInt().toVar(), end = collision.element(cbase.add(1)).toInt().toVar();
              Loop({ start, end, type: "int", condition: "<", name: "m" }, ({ m }) => {
                const t = collision.element(m).toInt().mul(TRI_FLOATS);
                const owner = collision.element(t.add(3)).toInt();
                If(owner.notEqual(skipMesh), () => {
                  triangleContact({ collision, t, from: pw, point: nw, radius, resolve });
                });
              });
            });
          });
        });
        If(touched.greaterThan(.5), () => { vel.mulAssign(friction.oneMinus()); });
        out.assign(toLocal(nw));
        outPrev.assign(toLocal(nw.sub(vel)));
      });
      Loop({ start: 0, end: anchorCount, name: "a" }, ({ a }) => {
        const anchor = anchors.element(a);
        If(anchor.w.toInt().equal(i), () => { out.assign(anchor.xyz); outPrev.assign(anchor.xyz); });
      });
      write.element(i).assign(vec4(out, 0));
      prev.element(i).assign(vec4(outPrev, 0));
    })().compute(this.capacity).setName("cloth arena step");
  }

  /** One cloth's render vertices from the arena's current positions. */
  #surfaceKernel(m, positions) {
    const springs = this.springsNode, strideUniform = this.strideUniform;
    const { simIndexNode, offsetNode, output, normals, base, renderCount } = m;
    return Fn(() => {
      const v = instanceIndex.toInt();
      const particle = simIndexNode.element(v).toInt().add(int(base));
      const p = positions.element(particle).xyz.toVar();
      const sbase = particle.mul(strideUniform);
      const normal = vec3(0).toVar();
      Loop({ start: 0, end: strideUniform, name: "j" }, ({ j }) => {
        const s = springs.element(sbase.add(j));
        If(s.x.lessThan(0), () => { Break(); });
        // `w < 0` is a boundary edge, a dihedral or a thickness spring: none
        // closes a triangle around this vertex.
        If(s.x.greaterThanEqual(0).and(s.w.greaterThanEqual(0)), () => {
          const a = positions.element(s.x.toInt()).xyz.sub(p);
          const b = positions.element(s.w.toInt()).xyz.sub(p);
          normal.addAssign(cross(a, b));
        });
      });
      const len = normal.length();
      const unit = select(len.greaterThan(1e-9), normal.div(len.max(1e-9)), vec3(0, 0, 1));
      if (offsetNode) {
        // A shell: both faces rebuilt off the simulated mid-surface, the back
        // face's normal flipped (the offset's sign is which side it is on).
        const shell = offsetNode.element(v);
        normals.element(v).assign(unit.mul(select(shell.lessThan(0), float(-1), float(1))));
        output.element(v).assign(p.add(unit.mul(shell)));
      } else {
        normals.element(v).assign(unit);
        output.element(v).assign(p);
      }
    })().compute(renderCount).setName("cloth arena surface");
  }

  /* ── membership ──────────────────────────────────────────────────────── */

  /**
   * Add a cloth. `spec.topology` is a packed topology (`packClothTopology`),
   * `spec.geometry` the render geometry already built for it, `spec.mesh` the
   * mesh that draws it. Returns the member.
   */
  add(component, spec) {
    const m = {
      component, topology: spec.topology, analysis: spec.analysis ?? null, geometry: spec.geometry, mesh: spec.mesh,
      output: spec.output, normals: spec.normals, entityId: spec.entityId ?? component?.entity?.id ?? null,
      count: spec.topology.count, renderCount: spec.topology.renderCount,
      simIndexNode: instancedArray(spec.topology.simIndex, "float"),
      offsetNode: spec.topology.shellOffset ? instancedArray(spec.topology.shellOffset, "float") : null,
      props: spec.props ?? {}, resolution: spec.resolution ?? 32,
      bounds: clothRestBounds(spec.topology),
      base: -1, id: -1, surfaceA: null, surfaceB: null,
      resetPending: true, initialized: false, ticked: false, inView: true, enabled: false,
      grid: null, gridData: null, gridRevision: -1, gridBox: null, reachBox: null,
      world: new Float32Array(16), inverse: new Float32Array(16), error: null,
    };
    m.simIndexNode.value.name = "arena:simIndex";
    if (m.offsetNode) m.offsetNode.value.name = "arena:shellOffset";
    if (!this.rowFree.length) {
      m.error = `the scene has more than ${ARENA_MAX_CLOTHS} cloths; this one is not simulated`;
      this.members.add(m);
      return m;
    }
    m.id = this.rowFree.pop();
    // Room: grow the capacity and/or the stride first, which re-packs everyone.
    let capacity = this.capacity, stride = this.stride, grow = false;
    while (this.layout.used + m.count > capacity) { capacity *= 2; grow = true; }
    if (spec.topology.stride > stride) { stride = Math.max(spec.topology.stride, stride * 2); grow = true; }
    if (grow) { this.members.add(m); this.#rebuild({ capacity, stride }); return m; }
    m.base = this.layout.allocate(m.count, m);
    if (m.base < 0) {
      // Fragmented: no free run fits. Growing re-packs everyone contiguously.
      this.members.add(m);
      this.#rebuild({ capacity: capacity * 2 });
      return m;
    }
    this.members.add(m);
    this.#writeStatic(m);
    this.collisionDirty = true;
    if (component && this.frameCallback.__owner == null) this.frameCallback.__owner = component;
    return m;
  }

  remove(m) {
    if (!this.members.has(m)) return;
    this.members.delete(m);
    if (m.base >= 0) {
      this.layout.release(m);
      clearMemberStatic({ statics: this.arrays.statics }, m.base, m.count);
      this.#upload(this.staticsNode.value, m.base * STATIC_STRIDE * 4, m.count * STATIC_STRIDE * 4);
    }
    if (m.id >= 0) { this.rowFree.push(m.id); this.rows.fill(0, m.id * PARAM_ROWS * 4, (m.id + 1) * PARAM_ROWS * 4); }
    if (m.usesMeshField) { this.meshColliderField.removeUser(m.component); m.usesMeshField = false; }
    const renderer = this.engine.renderer;
    releaseComputeNodes(renderer, [m.surfaceA, m.surfaceB].filter(Boolean));
    releaseStorageAttributes(renderer, [m.simIndexNode.value, m.offsetNode?.value].filter(Boolean));
    m.surfaceA = m.surfaceB = null;
    this.collisionDirty = true;
    if (this.frameCallback.__owner === m.component) this.frameCallback.__owner = this.members.values().next().value?.component ?? this.frameCallback.__owner;
  }

  /** The buffer holding the current pose (for readbacks and surfaces). */
  get currentPositions() { return this.parity === 0 ? this.posA : this.posB; }

  /* ── the frame ───────────────────────────────────────────────────────── */

  #frame() {
    const engine = this.engine, renderer = engine.renderer;
    if (!this.members.size || !renderer?.isWebGPURenderer) return;
    if (engine.simulationSuspended === true) return;
    if (this.renderer !== renderer) {
      // A new renderer recreates the buffers from their CPU arrays, which
      // hold rest poses; every cloth is reset so `prev` agrees.
      this.renderer = renderer;
      for (const m of this.members) { m.resetPending = true; m.initialized = false; }
    }
    const span = freeze.begin("cloth:arena");
    try {
      this.colliderField.refresh();
      this.meshColliderField.refresh();
      const revision = this.meshColliderField.revision;
      let anyEnabled = false;
      for (const m of this.members) {
        if (m.id < 0) continue;
        m.enabled = m.ticked;
        if (m.enabled) anyEnabled = true;
        this.#updateTransform(m, revision);
      }
      if (this.collisionDirty) this.#packCollision();
      const noContact = globalThis.__clothArenaNoContact === true;
      const relaxOverride = Number(globalThis.__clothRelax), lraOverride = Number(globalThis.__clothLraRelax);
      for (const m of this.members) {
        if (m.id < 0) continue;
        const props = m.props;
        const wind = resolveClothWind(props, sceneWind(engine));
        const fabric = props.fabric === "silk" ? .35 : props.fabric === "canvas" ? 1.5 : 1;
        const sceneCollision = props.sceneCollision !== false && !noContact;
        if (sceneCollision !== m.usesMeshField) {
          // The field culls colliders by its users' reach; only colliding cloths count.
          if (sceneCollision) this.meshColliderField.addUser(m.component); else this.meshColliderField.removeUser(m.component);
          m.usesMeshField = sceneCollision;
        }
        writeClothParams(this.rows, m.id, {
          world: m.world, inverse: m.inverse,
          gravity: props.gravity, damping: props.damping, stiffness: props.stiffness,
          bend: Math.min(1, finite(props.bend, .1, 0, 1) * fabric), shear: props.shear,
          wind: wind.vector, gust: wind.gust, gustFrequency: wind.gustFrequency,
          collisionRadius: props.collisionRadius, friction: props.friction,
          skipPrimitive: this.colliderField.entityIndices?.get(m.entityId) ?? -1,
          skipMesh: this.meshColliderField.entityIndices?.get(m.entityId) ?? -1,
          sceneCollision, lraRelax: Number.isFinite(lraOverride) ? lraOverride : CLOTH_LRA_RELAX,
          grid: m.grid, reset: m.resetPending, enabled: m.enabled,
          relaxation: Number.isFinite(relaxOverride) ? relaxOverride : CLOTH_RELAXATION,
        });
        const base = m.id * PARAM_ROWS;
        for (let r = 0; r < PARAM_ROWS; r++) this.paramRows[base + r].fromArray(this.rows, (base + r) * 4);
      }
      this.#updateAnchors();
      const { count, accumulator } = clothSteps(this.accumulator, engine.deltaTime ?? 0);
      this.accumulator = accumulator;
      const queue = [];
      if (anyEnabled && count > 0) {
        this.simTimeUniform.value = this.simTime;
        for (let s = 0; s < count; s++) { queue.push(this.parity === 0 ? this.stepAB : this.stepBA); this.parity ^= 1; }
        this.simTime += count * CLOTH_STEP;
        for (const m of this.members) if (m.id >= 0 && m.resetPending) { m.resetPending = false; m.initialized = true; }
      }
      let surfaces = 0;
      const current = this.currentPositions;
      for (const m of this.members) {
        if (m.id < 0 || !m.initialized || !m.ticked || !m.inView) continue;
        const kernel = this.parity === 0 ? (m.surfaceA ??= this.#surfaceKernel(m, this.posA)) : (m.surfaceB ??= this.#surfaceKernel(m, this.posB));
        queue.push(kernel); surfaces++;
      }
      void current;
      if (this.poisoned) {
        // Last frame's submission failed validation (see #submit): every bind
        // group of this generation is invalid for good, so rebuild — once.
        this.poisoned = false;
        this.#rebuild();
        queue.length = 0;
      }
      if (queue.length && globalThis.__clothArenaAudit !== false && !this.#audit(renderer, queue)) {
        // Rebuilt: the queue named the old kernels. Skip this frame's dispatch;
        // every member is reset and solves again from the next frame.
        queue.length = 0;
      }
      if (queue.length) this.#submit(renderer, queue);
      const s = this.stats;
      s.members = this.members.size; s.particles = this.layout.used; s.steps = anyEnabled ? count : 0; s.dispatches = queue.length; s.surfaces = surfaces;
      s.frame = renderer.info?.frame ?? s.frame + 1; s.stepHz = 1 / CLOTH_STEP;
      for (const m of this.members) m.ticked = false;
    } finally { freeze.end(span); }
  }

  /**
   * The one submission a frame, inside a validation error scope: a failed
   * bind group or command buffer is reported ONCE with the generation it
   * belongs to and poisons the arena, which rebuilds next frame. Without this
   * a zero-sized binding fails every submission silently forever — the flock's
   * death, which a frame counter cannot tell from success.
   */
  #submit(renderer, queue) {
    const device = renderer.backend?.device;
    if (!device?.pushErrorScope) { renderer.compute(queue); return; }
    if (globalThis.__clothArenaLog) this.#watchAttributes(renderer);
    const generation = this.generation;
    device.pushErrorScope("validation");
    try { renderer.compute(queue); } finally {
      device.popErrorScope().then((error) => {
        if (!error || generation !== this.generation || this.poisoned) return;
        this.poisoned = true;
        this.poisonings = (this.poisonings ?? 0) + 1;
        const reason = String(error.message ?? error).split(/\r?\n/)[0];
        console.error(`[cloth] arena generation ${generation} failed validation (${this.poisonings}x): ${reason} — members ${this.members.size}, capacity ${this.capacity}, stride ${this.stride}; rebuilding next frame`);
      }).catch(() => {});
    }
  }

  /** Dev: name every arena attribute three binds while its array is empty, and who asked. */
  #watchAttributes(renderer) {
    const attributes = renderer._attributes;
    if (!attributes || attributes.__clothWatched) return;
    attributes.__clothWatched = true;
    const original = attributes.update.bind(attributes);
    const arena = this;
    attributes.update = function watched(attribute, type) {
      if (attribute?.name?.startsWith?.("arena:") && !(attribute.array?.byteLength > 0)) {
        const mine = [arena.posA, arena.posB, arena.prev, arena.staticsNode, arena.springsNode, arena.collisionNode].some((n) => n.value === attribute);
        console.error(`[cloth] three is binding ${attribute.name} with an EMPTY array (${mine ? "CURRENT generation " + arena.generation : "a STALE generation"}, type ${type})`, new Error().stack);
      }
      return original(attribute, type);
    };
  }

  #updateTransform(m, revision) {
    const mesh = m.mesh;
    mesh.updateWorldMatrix(true, false);
    m.world.set(mesh.matrixWorld.elements);
    m.inverse.set(_inverse.copy(mesh.matrixWorld).invert().elements);
    const box = clothReachBox(m.bounds, m.world);
    m.reachBox = box;
    // The culling sphere the collider field and the frustum gate read.
    const sphere = m.geometry.boundingSphere;
    if (sphere) sphere.radius = Math.max(sphere.radius, box.radius);
    const moved = !m.gridBox || Math.max(
      Math.abs(m.gridBox.min[0] - box.min[0]), Math.abs(m.gridBox.min[1] - box.min[1]), Math.abs(m.gridBox.min[2] - box.min[2]),
      Math.abs(m.gridBox.max[0] - box.max[0]), Math.abs(m.gridBox.max[1] - box.max[1]), Math.abs(m.gridBox.max[2] - box.max[2])) > GRID_MOVE_TOLERANCE;
    if (moved || m.gridRevision !== revision) this.collisionDirty = true;
  }

  /** Every member's triangle grid, and the one buffer they all live in. */
  #packCollision() {
    const span = freeze.begin("cloth:arena grids");
    try {
      const field = this.meshColliderField;
      const triangles = field.triangles ?? [];
      const revision = field.revision;
      const members = [...this.members].filter((m) => m.id >= 0);
      const grids = members.map((m) => {
        m.gridRevision = revision;
        m.gridBox = m.reachBox;
        if (m.props.sceneCollision === false || !triangles.length || !m.reachBox) { m.gridData = null; return null; }
        const radius = finite(m.props.collisionRadius, .03, .001, 1);
        const candidates = [];
        for (let t = 0; t < triangles.length; t++) if (triangleTouchesBox(triangles[t].vertices, m.reachBox, radius)) candidates.push(t);
        m.gridData = buildTriangleGrid(triangles, candidates, m.reachBox, radius);
        return m.gridData;
      });
      let packed = packCollision(triangles, grids, this.arrays.collision);
      if (!packed) {
        let collision = this.collisionCapacity;
        const need = triangles.length * TRI_FLOATS + grids.reduce((sum, g) => sum + (g ? g.cells.length + g.items.length : 0), 0);
        while (collision < need) collision *= 2;
        // A bigger buffer is a new binding, so the kernels are rebuilt.
        this.#rebuild({ collision });
        packed = packCollision(triangles, grids, this.arrays.collision);
      }
      members.forEach((m, k) => {
        const g = grids[k];
        m.grid = g && packed ? { origin: g.origin, cell: g.cell, dims: g.dims, cellBase: packed.bases[k].cellBase, triangles: g.triangles, cells: g.cells.length - 1, items: g.items.length } : null;
      });
      this.collisionNode.value.clearUpdateRanges?.();
      this.collisionNode.value.needsUpdate = true;
      this.stats.collisionFloats = packed?.total ?? 0;
      this.stats.triangles = triangles.length;
      this.collisionDirty = false;
    } finally { freeze.end(span); }
  }

  #updateAnchors() {
    let count = 0;
    for (const m of this.members) {
      if (m.id < 0 || !Array.isArray(m.props.anchors) || !m.props.anchors.length) continue;
      _inverse.fromArray(m.inverse);
      const n = resolveClothAnchors(m.props.anchors, this.engine, _inverse, m.resolution, _anchorScratch);
      for (let k = 0; k < n && count < ARENA_MAX_ANCHORS; k++) {
        const a = _anchorScratch[k];
        const index = Math.min(m.count - 1, Math.max(0, Math.round(a.w)));
        this.anchorRows[count++].set(a.x, a.y, a.z, m.base + index);
      }
    }
    for (let k = count; k < ARENA_MAX_ANCHORS; k++) this.anchorRows[k].set(0, 0, 0, -1);
    this.anchorCount.value = count;
  }

  /** What `vfx.cloth.status` reports, for one member or the whole arena. */
  describe(m = null) {
    const out = { ...this.stats, capacity: this.capacity, stride: this.stride, generation: this.generation, rebuilds: this.rebuilds, accumulator: this.accumulator, simTime: this.simTime,
      collisionCapacity: this.collisionCapacity, maxCloths: ARENA_MAX_CLOTHS, anchors: this.anchorCount.value };
    if (m) {
      out.member = { base: m.base, count: m.count, renderCount: m.renderCount, id: m.id, initialized: m.initialized, inView: m.inView, error: m.error,
        grid: m.grid ? { triangles: m.grid.triangles, cells: m.grid.cells, items: m.grid.items, cell: +m.grid.cell.toFixed(3), dims: m.grid.dims } : null,
        reach: m.reachBox ? { min: m.reachBox.min.map((v) => +v.toFixed(2)), max: m.reachBox.max.map((v) => +v.toFixed(2)), fabric: +m.reachBox.fabric.toFixed(3) } : null };
    }
    return out;
  }

  dispose() {
    this.unsubscribe?.();
    for (const m of [...this.members]) this.remove(m);
    this.#release();
    this.colliderField.removeUser();
    if (arenas.get(this.engine) === this) arenas.delete(this.engine);
  }
}

/* -------------------------------------------------------------------------- */
/* Contact against one packed triangle (TSL)                                   */
/* -------------------------------------------------------------------------- */

const insideTriangle = (p, a, ab, ac) => {
  const ap = p.sub(a), aa = dot(ab, ab), bb = dot(ac, ac), mixed = dot(ab, ac);
  const inverse = aa.mul(bb).sub(mixed.mul(mixed)).max(1e-12).reciprocal();
  const u = bb.mul(dot(ap, ab)).sub(mixed.mul(dot(ap, ac))).mul(inverse);
  const v = aa.mul(dot(ap, ac)).sub(mixed.mul(dot(ap, ab))).mul(inverse);
  return u.greaterThanEqual(-1e-5).and(v.greaterThanEqual(-1e-5)).and(u.add(v).lessThanEqual(1.00001));
};

function triangleContact({ collision, t, from, point, radius, resolve }) {
  const a = vec3(collision.element(t), collision.element(t.add(1)), collision.element(t.add(2)));
  const b = vec3(collision.element(t.add(4)), collision.element(t.add(5)), collision.element(t.add(6)));
  const c = vec3(collision.element(t.add(8)), collision.element(t.add(9)), collision.element(t.add(10)));
  const ab = b.sub(a), ac = c.sub(a);
  const raw = cross(ab, ac);
  const length = raw.length();
  If(length.greaterThan(1e-12), () => {
    const n = raw.div(length);
    const d0 = dot(from.sub(a), n), d1 = dot(point.sub(a), n);
    const handled = float(0).toVar();
    // A crossing inside the triangle: back to the side it came from, however fast.
    If(d0.mul(d1).lessThan(0), () => {
      const tt = d0.div(d0.sub(d1));
      const hit = from.add(point.sub(from).mul(tt));
      If(insideTriangle(hit, a, ab, ac), () => {
        const side = select(d0.greaterThanEqual(0), float(1), float(-1));
        resolve(n.mul(side), radius.sub(d1.mul(side)));
        handled.assign(1);
      });
    });
    // Otherwise proximity: pushed away from the nearest point, to the side it is on.
    If(handled.lessThan(.5), () => {
      const projected = point.sub(n.mul(d1));
      const best = vec3(projected).toVar();
      If(insideTriangle(projected, a, ab, ac).not(), () => {
        const bestDistance = float(1e30).toVar();
        for (const [start, finish] of [[a, b], [b, c], [c, a]]) {
          const edge = finish.sub(start);
          const s = dot(point.sub(start), edge).div(dot(edge, edge).max(1e-9)).clamp(0, 1);
          const q = start.add(edge.mul(s));
          const dist = dot(point.sub(q), point.sub(q));
          If(dist.lessThan(bestDistance), () => { bestDistance.assign(dist); best.assign(q); });
        }
      });
      const delta = point.sub(best), distance = delta.length();
      If(distance.lessThan(radius), () => {
        const normal = select(distance.greaterThan(1e-6), delta.div(distance.max(1e-6)), n.mul(select(d1.greaterThanEqual(0), float(1), float(-1))));
        resolve(normal, radius.sub(distance));
      });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* A member as the component sees it                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a cloth member's render geometry and mesh and join the arena. The
 * returned object is what `GridSimulationComponent` stores as `simulation`
 * and what `vfx.cloth.status` reads: the same surface the old solver had.
 *
 * `plane` is `findPlane()`'s answer: a mesh cloth carries `topology` and the
 * author's `geometry`; a plane carries `width`/`height` and gets a lattice.
 */
export function createClothMember(component, { plane, props, material }) {
  const engine = component.entity.engine;
  const arena = ClothArena.for(engine);
  if (!material) throw new Error("Cloth requires the existing plane material.");
  let topology, analysis, render = null, resolution = Math.round(finite(props.resolution, 32, 4, 512));
  if (plane.topology) {
    topology = plane.topology;
    analysis = plane.analysis ?? null;
  } else {
    const built = buildGridClothTopology({ resolution, width: plane.width, height: plane.height, pinning: props.pinning ?? "top" });
    topology = built.topology; analysis = built.analysis; render = built.render; resolution = built.render.resolution;
  }
  const total = topology.renderCount;
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.StorageBufferAttribute(total, 3);
  const normalAttribute = new THREE.StorageBufferAttribute(total, 3);
  positionAttribute.name = "arena:positionAttribute"; normalAttribute.name = "arena:normalAttribute";
  const uv = new Float32Array(total * 2);
  const indices = [];
  const source = plane.geometry;
  if (render) {
    // The lattice: rest positions, +z normals, the plane's own UV layout.
    for (let v = 0; v < total; v++) {
      positionAttribute.setXYZ(v, render.positions[v * 3], render.positions[v * 3 + 1], render.positions[v * 3 + 2]);
      normalAttribute.setXYZ(v, 0, 0, 1);
      uv[v * 2] = render.uv[v * 2]; uv[v * 2 + 1] = render.uv[v * 2 + 1];
    }
    for (let i = 0; i < render.indices.length; i++) indices.push(render.indices[i]);
  } else {
    // The author's own triangles, UVs and seams; only the positions go live.
    const srcPos = source.getAttribute("position"), srcNrm = source.getAttribute("normal"), srcUv = source.getAttribute("uv");
    for (let v = 0; v < total; v++) {
      positionAttribute.setXYZ(v, srcPos.getX(v), srcPos.getY(v), srcPos.getZ(v));
      if (srcNrm) normalAttribute.setXYZ(v, srcNrm.getX(v), srcNrm.getY(v), srcNrm.getZ(v)); else normalAttribute.setXYZ(v, 0, 0, 1);
      uv[v * 2] = srcUv ? srcUv.getX(v) : 0; uv[v * 2 + 1] = srcUv ? srcUv.getY(v) : 0;
    }
    const srcIndex = source.getIndex();
    if (srcIndex) for (let i = 0; i < srcIndex.count; i++) indices.push(srcIndex.getX(i));
    else for (let i = 0; i < total; i++) indices.push(i);
  }
  geometry.setIndex(indices);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("normal", normalAttribute);
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (render && Array.isArray(material) && source?.groups?.length) {
    // A multi-material plane keeps its authored regions at the new resolution.
    const sx = source.parameters?.widthSegments ?? 1, sy = source.parameters?.heightSegments ?? 1;
    let runStart = 0, previousMaterial = null;
    for (let i = 0; i < indices.length; i += 3) {
      let px = 0, py = 0;
      for (let j = 0; j < 3; j++) { px += uv[indices[i + j] * 2] * sx / 3; py += (1 - uv[indices[i + j] * 2 + 1]) * sy / 3; }
      const cx = Math.min(sx - 1, Math.floor(px)), cy = Math.min(sy - 1, Math.floor(py));
      const sourceIndex = (cy * sx + cx) * 6 + (px - cx + py - cy > 1 ? 3 : 0);
      const slot = source.groups.find((group) => sourceIndex >= group.start && sourceIndex < group.start + group.count)?.materialIndex ?? 0;
      if (previousMaterial !== null && slot !== previousMaterial) { geometry.addGroup(runStart, i - runStart, previousMaterial); runStart = i; }
      previousMaterial = slot;
    }
    geometry.addGroup(runStart, indices.length - runStart, previousMaterial ?? 0);
  }
  // Bounds: the rest box for diagnostics, a reach sphere for culling and the
  // collider field (grown per frame from the reach box).
  geometry.computeBoundingBox();
  geometry.userData.__clothSourceBox = geometry.boundingBox.clone();
  const centre = geometry.boundingBox.getCenter(new THREE.Vector3());
  const bounds = clothRestBounds(topology);
  const half = geometry.boundingBox.getSize(new THREE.Vector3()).length() / 2;
  geometry.boundingSphere = new THREE.Sphere(centre, half + Math.max(bounds.fabric, half) + .3);
  geometry.boundingBox.setFromCenterAndSize(centre, new THREE.Vector3(1, 1, 1).multiplyScalar(geometry.boundingSphere.radius * 2));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Cloth";
  mesh.userData.vfxSimulation = "cloth";
  mesh.userData.noBatch = true; mesh.userData.noMerge = true;
  mesh.frustumCulled = false; mesh.castShadow = props.castShadow !== false; mesh.receiveShadow = props.receiveShadow !== false;
  // GI samples a deformed lattice on its own grid; a mesh cloth has none.
  if (render) mesh.userData.giGpuGrid = { positionAttribute, resolution };

  const member = arena.add(component, {
    topology, analysis, geometry, mesh, entityId: component.entity?.id ?? null, props, resolution,
    output: storage(positionAttribute, "vec3", total), normals: storage(normalAttribute, "vec3", total),
  });
  const simulation = {
    arena, member, mesh, geometry, count: topology.count, resolution, vertexCount: total, kernels: {},
    get positions() { return arena.currentPositions; },
    get solved() { return { positions: arena.currentPositions, base: member.base, count: member.count, flocked: false }; },
    get error() { return member.error; },
    /** Called from the component's tick: this cloth is live this frame, and whether anyone can see it. */
    tick(renderer, dt, inView = true) { member.ticked = true; member.inView = inView !== false; },
    update(p) {
      member.props = p;
      mesh.castShadow = p.castShadow !== false; mesh.receiveShadow = p.receiveShadow !== false;
    },
    restart() { member.resetPending = true; },
    dispose() {
      arena.remove(member);
      mesh.removeFromParent();
      releaseStorageAttributes(engine.renderer, [positionAttribute, normalAttribute]);
      geometry.dispose();
    },
  };
  return simulation;
}
