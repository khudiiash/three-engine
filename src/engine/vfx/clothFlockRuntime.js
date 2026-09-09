import * as THREE from "three/webgpu";
import { mergeClothTopologies, flockKey } from "./clothFlock.js";
import { createGridSimulation } from "./gridSimulation.js";
import { clothComputeBatch } from "./computeBatch.js";

/**
 * ⭐⭐⭐ ONE SOLVER FOR EVERY CLOTH THAT SHARES A CONFIGURATION.
 *
 * See `clothFlock.js` for the measurement that forced this: the solver's cost
 * tracks the number of cloths ON SCREEN rather than the number of particles,
 * because ~117 us of every dispatch is launch overhead and ten curtains issue
 * ten times as many dispatches for the same work.
 *
 * The flock owns a headless `createGridSimulation` over the CONCATENATION of
 * its members' particles. Each member keeps its own entity, its own geometry,
 * its own material and its own surface kernel — it simply stops solving, and
 * reads the shared particle set at the offset where its own particles begin.
 *
 * ⚠ THE FLOCK SOLVES IN WORLD SPACE. Members have different entity transforms
 * and one particle set can only have one space, so each member's world matrix
 * is baked into its rest pose here and undone per vertex in its surface kernel
 * (`simulationInverse`). A member whose transform MOVES therefore invalidates
 * the flock and forces a rebuild — cheap, because curtains do not move, and
 * correct if one ever does.
 *
 * ⚠ ELIGIBILITY IS DELIBERATELY NARROW. A cloth joins only when nothing about
 * it needs to be per-member inside a shared kernel: it must be a mesh cloth,
 * carry no entity anchors (`pinEntities` walks one cloth's anchor rows), and
 * have no collider of its own to skip (`collisionSkip` is a single uniform).
 * Anything else keeps its own solver and costs what it always did.
 */

// Dev flags persisted by `profile.clothFlag`, applied before any cloth is built
// (this module is imported by the component that builds them).
try {
  const store = JSON.parse(globalThis.localStorage?.getItem("cloth.devFlags.v1") ?? "{}");
  for (const [name, value] of Object.entries(store)) globalThis[name] ??= value;
} catch { /* no storage: the flag applies only when set live */ }

/** Below two members a flock is pure overhead. */
const MIN_MEMBERS = 2;

/**
 * ⛔ OFF BY DEFAULT, 2026-09-09. The flock builds, merges and re-binds
 * correctly, and it does make cloth cost ~0 — but only because a storage
 * binding somewhere in the shared solver comes out ZERO-SIZED, which
 * invalidates the command buffer every cloth kernel was encoded into, and then
 * NOTHING simulates. That failure looks exactly like success from the outside:
 * `profile.frameCensus` reads 120 fps with cloth priced at 0.00 ms.
 *
 * Until that binding is found, cloths keep their own solvers. Turn it on with
 * `profile.clothFlag __clothFlock true` and watch the console for
 * "Binding size for [Buffer] is zero".
 */
const FLOCK_ENABLED = () => globalThis.__clothFlock === true;

function eligible(component) {
  if (!FLOCK_ENABLED()) return false;
  const props = component.resolvedProps ?? component.props ?? {};
  if (!component.planeSource?.topology) return false;           // grid cloth, not mesh cloth
  if (Array.isArray(props.anchors) && props.anchors.length) return false;
  if (component.entity?.getComponent?.("collider")?.enabled) return false;
  return true;
}

function worldMatrixOf(component) {
  const object = component.entity?.object3D;
  if (!object) return null;
  object.updateWorldMatrix(true, false);
  return object.matrixWorld.elements;
}

/**
 * The flock's own render side, which nothing ever draws.
 *
 * ⛔ IT CANNOT BE A STUB. The solver's mesh-cloth path reads the source
 * geometry's position, normal, uv and index to build the render mesh, and a
 * one-vertex placeholder gives the device zero-sized storage bindings —
 * "Binding size for [Buffer] is zero", which invalidates the command buffer
 * that ALL the cloth kernels were encoded into. The whole scene's cloth then
 * silently stops, and a frame census reads a beautiful 120 fps with nothing
 * simulating at all. That is the worst possible failure mode: it looks like
 * the win.
 *
 * So the flock borrows its first member's render tables verbatim. They are
 * never dispatched (`solverFirst` skips the surface kernel) and never added to
 * the scene; they exist only so every buffer the code path touches is real.
 */
function headlessRender(members, merged) {
  const first = members[0].planeSource;
  return {
    geometry: first.geometry,
    topology: {
      ...merged,
      simIndex: first.topology.simIndex,
      shellOffset: first.topology.shellOffset,
      renderCount: first.topology.renderCount,
    },
  };
}

class ClothFlock {
  constructor(engine, key) {
    this.engine = engine;
    this.key = key;
    this.members = new Set();
    this.solver = null;
    this.ranges = [];
    this.built = null;
    this.dirty = true;
    this.failed = false;
    /** Bumped by every successful build; a member re-binds when it changes. */
    this.generation = 0;
  }

  /** The shared particle set a member binds its surface kernel to. */
  handleFor(component) {
    // ⚠ AGAINST THE LIST THE MERGE ACTUALLY USED, not the membership set: an
    // ineligible member would shift every index after it and hand a cloth
    // another cloth's particles.
    const index = this.built ? this.built.indexOf(component) : -1;
    const range = index < 0 ? null : this.ranges[index];
    const particles = this.solver?.particles;
    if (!range || !particles) return null;
    return { positions: particles.positions, springs: particles.springs, stride: particles.stride, base: range.base };
  }

  build() {
    this.dispose();
    const members = [...this.members].filter(eligible);
    if (members.length < MIN_MEMBERS) return false;
    let merged;
    try {
      merged = mergeClothTopologies(members.map((component) => ({
        topology: component.planeSource.topology,
        matrix: worldMatrixOf(component),
      })));
    } catch (error) {
      // A member the merge refuses (non-uniform scale) must not take the whole
      // scene's cloth down with it: everyone keeps their own solver.
      console.warn("[cloth] flock refused:", error.message);
      return false;
    }
    const first = members[0];
    const render = headlessRender(members, merged.topology);
    this.solver = createGridSimulation("cloth", first.resolvedProps, {
      // Nothing ever draws the flock's own mesh; the members draw. A throwaway
      // material only satisfies the solver's "cloth keeps its plane's material"
      // contract, and sharing a real one would hand the scene a second mesh
      // pointing at it.
      material: new THREE.MeshBasicNodeMaterial(),
      colliderField: globalThis.__clothFlockNoColliders ? null : (first.colliderField ?? null),
      meshColliderField: globalThis.__clothFlockNoColliders ? null : (first.meshColliderField ?? null),
      colliderEntityId: null,
      sourceGeometry: render.geometry,
      topology: render.topology,
      anchorEngine: this.engine,
      solverFirst: true,
    });
    this.ranges = merged.ranges;
    this.built = members;
    this.matrices = members.map(worldMatrixOf).map((m) => (m ? [...m] : null));
    this.generation++;
    return true;
  }

  /** A member that moved invalidates the baked rest pose. */
  moved() {
    if (!this.solver) return false;      // nothing baked yet: `dirty` owns that
    const members = [...this.members].filter(eligible);
    if (!this.matrices || this.matrices.length !== members.length) return true;
    return members.some((component, i) => {
      const now = worldMatrixOf(component), was = this.matrices[i];
      if (!now || !was) return true;
      for (let e = 0; e < 16; e++) if (Math.abs(now[e] - was[e]) > 1e-6) return true;
      return false;
    });
  }

  tick(renderer, delta) {
    this.solver?.tick(renderer, delta);
  }

  dispose() {
    this.solver?.dispose?.(this.engine.renderer);
    this.solver = null;
    this.ranges = [];
    this.built = null;
    this.matrices = null;
  }
}

/**
 * The engine's flocks, keyed by solver configuration. Registration only marks
 * the group dirty; the rebuild happens once, at the next submission, so a boot
 * that attaches ten cloths one by one rebuilds once rather than ten times.
 */
export function clothFlocks(engine) {
  if (!engine) return null;
  let registry = engine.__clothFlocks;
  if (registry) return registry;
  const flocks = new Map();
  registry = engine.__clothFlocks = {
    flocks,
    /** Set while a rebuild is re-attaching members, so they do not re-enter it. */
    rebuilding: false,
    join(component) {
      if (!eligible(component)) return null;
      const key = flockKey(component.resolvedProps, component.planeSource.topology);
      let flock = flocks.get(key);
      if (!flock) flocks.set(key, flock = new ClothFlock(engine, key));
      if (!flock.members.has(component)) { flock.members.add(component); flock.dirty = true; }
      return flock.handleFor(component);
    },
    leave(component) {
      for (const flock of flocks.values()) {
        if (flock.members.delete(component)) flock.dirty = true;
      }
    },
    /** Rebuild whatever changed, then re-attach the members onto the new set. */
    settle() {
      if (registry.rebuilding) return;
      for (const [key, flock] of flocks) {
        // ⚠ A FAILED BUILD MUST NOT RETRY EVERY FRAME. Without the latch a
        // refused merge logged 960 times in one boot and re-ran the whole
        // rebuild each frame; membership changing is the only thing that can
        // make the answer different.
        if (flock.failed && !flock.dirty) continue;
        if (!flock.dirty && !flock.moved()) continue;
        flock.dirty = false;
        const built = flock.build();
        flock.failed = !built;
        console.log(`[cloth] flock ${built ? "built" : "refused"}: ${flock.members.size} member(s), ` +
          `${[...flock.members].filter(eligible).length} eligible, ${flock.solver?.count ?? 0} particles, key ${flock.key}`);
        // ⛔⛔ THE OLD PARTICLE SET IS GONE, AND THIS FRAME'S KERNELS STILL POINT
        // AT IT. Members queue their surface kernels during the frame's updates;
        // a rebuild here disposes the buffers those kernels were built against,
        // and submitting them fails the whole command buffer ("Invalid BindGroup
        // bindGroup_object ... is invalid due to a previous error"). Everything
        // queued this frame is stale by definition, so it is dropped: one frame
        // of cloth, once, when the membership changes.
        const batch = clothComputeBatch(engine);
        if (batch) { batch.kernels.length = 0; batch.head.length = 0; }
        registry.rebuilding = true;
        try {
          for (const component of flock.members) component.rejoinFlock?.(built, flock.generation);
        } finally { registry.rebuilding = false; }
        if (!flock.members.size) { flock.dispose(); flocks.delete(key); }
      }
    },
    tick(renderer, delta) {
      registry.settle();
      for (const flock of flocks.values()) flock.tick(renderer, delta);
    },
  };
  // The flock solves from inside the shared submission's `beforeFlush`, so its
  // kernels are queued no matter which preRender listener registered first.
  clothComputeBatch(engine)?.beforeFlush.add(() => {
    registry.tick(engine.renderer, engine.deltaTime ?? 0);
  });
  return registry;
}
