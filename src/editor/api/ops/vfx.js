import * as THREE from "three/webgpu";
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { commandBus } from "../../commands/CommandBus.js";
import { SetComponentPropCommand } from "../../commands/componentCommands.js";
import { DEFAULT_PARTICLE_GRAPH, legacyPropsToGraph, P_NODE_TYPES } from "../../../engine/particleGraph.js";
import { VFX_MODULES, addVfxModule } from "../../vfxStack.js";
import { createSimulationGraph } from "../../../engine/vfx/simulationGraph.js";
import { createVfxAsset } from "../../../engine/vfx/vfxAsset.js";
import { readVfxDocument, writeVfxDocument, vfxDocumentPath } from "../../vfxAssets.js";
import { invoke } from "../../assetOps.js";
import { useProjectStore } from "../../store/projectStore.js";
import { normalizeEffectTimeline, createEffectPreset, EFFECT_KINDS } from "../../../engine/vfx/effectTimeline.js";
import { classifyClothIsland } from "../../../engine/vfx/clothHealth.js";
import { PARTICLE_COLLIDER_STRIDE, PARTICLE_COLLIDER_TYPE_SPHERE } from "../../../engine/particleColliders.js";

defineOp({
  name: "vfx.cloth.status", readOnly: true,
  description: "Inspect a live cloth simulation and the scene colliders it can use. Reports missing plane, the triangle AND primitive collision fields, and GPU position bounds, without changing the scene. `primitiveColliders` names every box/sphere the solver actually feels, with the box it uses rather than the shape you can see — a convex collider is fitted as an ORIENTED BOX around its whole mesh, so a long thin one becomes a slab through the scene. Read `overlapsCloth` and `fill` together: an overlapping box with a low `fill` is an invisible wall sitting inside the cloth.",
  params: { entityId: { type: "string", required: true }, readPositions: { type: "boolean", default: false } },
  async run({entityId, readPositions}) {
    const c = requireComponent(entityId, "cloth"), sim = c.simulation;
    const result = { entityId, enabled: c.enabled, error: c.surfaceError ?? null, notes: c.surfaceNotes ?? [],
      analysis: c.clothAnalysis ? { ok: c.clothAnalysis.ok, particles: c.clothAnalysis.count ?? 0, islands: c.clothAnalysis.islandCount ?? 0,
        springs: { structural: c.clothAnalysis.structural ?? 0, bend: c.clothAnalysis.dihedral ?? 0, thickness: c.clothAnalysis.thickness ?? 0 },
        pinned: c.clothAnalysis.pinnedCount ?? 0 } : null,
      simulated: !!sim, sceneCollision: c.resolvedProps?.sceneCollision !== false,
      primitiveCount: c.colliderField?.countUniform?.value ?? 0,
      triangleCount: c.meshColliderField?.triangleCount ?? 0,
      triangleCollisionAvailable: !!c.meshColliderField,
      triangleColliders: c.meshColliderField?.diagnostics ?? [],
      primitiveColliders: describePrimitiveColliders(c),
      collisionError: c.meshColliderField?.error ?? null,
      colliders: [...engine.entities.values()].flatMap((entity) => { const collider=entity.getComponent("collider"); return collider ? [{id:entity.id,name:entity.name,shape:collider.props.shape,enabled:collider.enabled,sensor:!!collider.props.isSensor}] : []; }),
    };
    // The same finding the Inspector shows, from the same computation on the
    // component — see `engulfingColliderNotes`. Two implementations of one
    // diagnostic is two things to get out of step.
    result.engulfedBy = c.engulfedBy ?? [];
    if (readPositions) result.live = await readClothPositions(c, sim);
    return result;
  },
});

/**
 * ⭐⭐⭐ WHICH PRIMITIVES CAN THIS CLOTH FEEL, AND IS ONE OF THEM INSIDE IT?
 *
 * `primitiveCount` was a NUMBER and nothing else, so "the hem is blocked by
 * some invisible collider" (user, 2026-09-09) could only be chased by
 * disabling colliders one at a time and looking — five rounds of it. The
 * triangle colliders had names from the start; these did not.
 *
 * ⚠ AND THE DANGEROUS ONE IS A CONVEX HULL. `writeParticleCollider` fits every
 * convex collider as an ORIENTED BOX around the whole mesh, which is right for
 * a crate and catastrophic for a long thin one: Sponza's 21.8 m decorative
 * ledge becomes a solid slab through the entire arcade from 0.64 m to 2.12 m
 * up — exactly where the curtains hang, invisible because the thing you can
 * see is a moulding and the thing the cloth feels is its bounding box.
 *
 * So each row reports the box the SOLVER actually uses, whether it overlaps
 * this cloth's own rest bounds, and `fill` — how much of that box the collider
 * mesh really occupies. A low `fill` on an overlapping box is the shape of
 * this bug.
 */
function describePrimitiveColliders(component) {
  const field = component.colliderField;
  const count = field?.countUniform?.value ?? 0;
  if (!field || !count) return [];
  const data = field.data;
  const byRow = new Map();
  for (const [id, row] of field.entityIndices ?? []) byRow.set(row, id);

  const mesh = component.simulation?.mesh;
  const source = mesh?.geometry?.userData?.__clothSourceBox;
  const clothBox = source && mesh ? source.clone().applyMatrix4(mesh.matrixWorld) : null;

  const rows = [];
  for (let i = 0; i < count; i++) {
    const b = i * PARTICLE_COLLIDER_STRIDE;
    const centre = [data[b + 1], data[b + 2], data[b + 3]];
    const axes = [[data[b + 4], data[b + 5], data[b + 6]], [data[b + 8], data[b + 9], data[b + 10]], [data[b + 12], data[b + 13], data[b + 14]]];
    const half = [data[b + 7], data[b + 11], data[b + 15]];
    // The oriented box's conservative world AABB: the axes are unit vectors,
    // so each world component grows by |axis| * halfExtent summed over axes.
    const extent = [0, 1, 2].map((k) => Math.abs(axes[0][k]) * half[0] + Math.abs(axes[1][k]) * half[1] + Math.abs(axes[2][k]) * half[2]);
    const min = centre.map((v, k) => v - extent[k]);
    const max = centre.map((v, k) => v + extent[k]);
    // `rowEntities` names EVERY row; `entityIndices` only holds an islanded
    // collider's first, so without it the urns after the first read "(unknown)".
    const id = field.rowEntities?.[i] ?? byRow.get(i) ?? null;
    const entity = id ? engine.entities.get(id) : null;
    const collider = entity?.getComponent?.("collider");
    const overlaps = clothBox
      ? min[0] <= clothBox.max.x && max[0] >= clothBox.min.x
        && min[1] <= clothBox.max.y && max[1] >= clothBox.min.y
        && min[2] <= clothBox.max.z && max[2] >= clothBox.min.z
      : null;
    // How much of the fitted box the collider's own geometry occupies. A
    // convex hull fitted to a long thin mesh is mostly air.
    let fill = null;
    if (entity?.object3D) {
      const own = new THREE.Box3().setFromObject(entity.object3D);
      if (!own.isEmpty()) {
        const size = own.getSize(new THREE.Vector3());
        const boxVolume = 8 * half[0] * half[1] * half[2];
        if (boxVolume > 1e-9) fill = +Math.min(1, (size.x * size.y * size.z) / boxVolume).toFixed(3);
      }
    }
    rows.push({
      entityId: id, name: entity?.name ?? "(unknown)",
      shape: collider?.props?.shape ?? "?",
      type: data[b] === PARTICLE_COLLIDER_TYPE_SPHERE ? "sphere" : "box",
      centre: centre.map((v) => +v.toFixed(3)),
      size: extent.map((v) => +(v * 2).toFixed(3)),
      min: min.map((v) => +v.toFixed(3)), max: max.map((v) => +v.toFixed(3)),
      overlapsCloth: overlaps, fill,
    });
  }
  return rows.sort((a, b) => (b.overlapsCloth === true) - (a.overlapsCloth === true));
}

/**
 * ⛔ THE PARAMETER THAT DID NOTHING.
 *
 * `readPositions` and this op's description ("...and GPU position bounds")
 * shipped before the code that reads them, so three consecutive calls asking
 * for bounds returned a result with no bounds in it and no error either — the
 * exact shape of [[probe-blind-statistics]]: a null from an instrument that
 * cannot see its subject.
 *
 * ⭐ AND IT REPORTS PER ISLAND, NOT PER ENTITY. A mesh cloth's entity holds
 * every disconnected piece of one mesh — the Sponza curtains are 3 and 4
 * pieces inside two entities. The user sees CURTAINS ("green cloths both
 * working, while red and blue are not"), so an entity-wide box averages the
 * broken piece together with its healthy neighbours and reports nothing. The
 * island index is already computed by `analyseClothMesh`; this just groups by
 * it and puts each island's live box beside its REST box, in the same local
 * space, so "collapsed", "exploded" and "fine" are told apart by arithmetic
 * rather than by looking.
 */
/**
 * ⛔ A BOUNDING BOX CANNOT TELL BLOWING FROM CRUMPLED.
 *
 * `gather` reads the island's axis-aligned extent against its rest extent, and
 * a curtain SWINGING OUT in the wind loses vertical extent without being
 * gathered at all: 2.26 m of fabric hanging at 30° measures 1.9 m tall and
 * scores 0.84 while every thread in it is exactly its rest length. The box is
 * a function of POSE as much as of damage.
 *
 * Spring strain is not. Each structural spring has an authored rest length,
 * and how far the live distance sits from it is the same number however the
 * cloth is oriented: near zero for an intact cloth in any pose, large for one
 * that is stretched, crushed or turned inside out. When the two disagree, this
 * is the one that is measuring the cloth rather than the camera angle.
 *
 * Structural springs only — a bend spring is MEANT to be far from rest, that
 * is what makes a fold.
 */
function strainOf(analysis, data, v, group) {
  const { offsets, neighbours, restLength, weight, successor } = analysis ?? {};
  if (!offsets || !neighbours || !restLength || !weight) return;
  if (group.springs === undefined) {
    group.springs = 0; group.strainSum = 0; group.worst = null;
    group.shellSprings = 0; group.shellSum = 0; group.shellWorst = null;
  }
  for (let i = offsets[v]; i < offsets[v + 1]; i++) {
    if (weight[i] > 0.5) continue; // bend springs are supposed to be off-rest
    const rest = restLength[i];
    if (!(rest > 1e-6)) continue;
    const u = neighbours[i];
    const live = Math.hypot(
      data[v * 4] - data[u * 4],
      data[v * 4 + 1] - data[u * 4 + 1],
      data[v * 4 + 2] - data[u * 4 + 2],
    );
    if (!Number.isFinite(live)) continue;
    const strain = Math.abs(live - rest) / rest;
    // ⚠ THICKNESS SPRINGS ALSO CARRY WEIGHT 0, so a plain `weight` filter
    // reports them as structural. They are a different failure: a stretched
    // THICKNESS spring means the SHELL has been pulled open (or turned inside
    // out), while a stretched STRUCTURAL spring means the sheet itself is
    // tearing. Conflating them says "the cloth is torn" for a shell problem
    // and sends the next fix to the wrong place. The `-2` successor is the
    // marker; see SPRING_THICKNESS.
    if (successor && successor[i] === -2) {
      group.shellSprings++;
      group.shellSum += strain;
      if (group.shellWorst == null || strain > group.shellWorst) group.shellWorst = strain;
      continue;
    }
    group.springs++;
    group.strainSum += strain;
    if (group.worst == null || strain > group.worst) group.worst = strain;
  }
}

/**
 * Per-island motion between the two most recent readbacks. See the note in
 * `readClothPositions`: the useful figure is COHERENCE, not speed.
 */
/**
 * ⭐⭐⭐ WHERE ON THE CLOTH, NOT JUST HOW MUCH.
 *
 * ⛔ Every reading before this one averaged over a whole piece, and a curtain
 * whose bottom third has concertina'd into sharp pleats while the rest hangs
 * smooth scores a perfectly healthy 0.016 mean strain — which is exactly what
 * happened, on a curtain the user could see was wrong in a screenshot. A local
 * defect is invisible to a global statistic; that has now been the shape of
 * the miss three times running (the diagonal, the maximum, the whole-piece
 * mean), so the fix is resolution, not another threshold.
 *
 * The cloth is sliced into horizontal bands by REST height — the band a
 * particle belongs to never changes, however far it moves — and each band
 * reports how tall it still is against how tall it was authored:
 *
 *     squash = live vertical extent / rest vertical extent
 *
 * 1.0 is hanging as modelled. Below ~0.8 that band of fabric is compressed
 * into itself, which is what "squashed" looks like from the outside.
 */
const STRAIN_BANDS = 5;

function bandOf(analysis, v, liveY, group) {
  const rest = analysis?.rest;
  if (!rest) return;
  if (!group.bands) {
    group.bands = Array.from({ length: STRAIN_BANDS }, () => ({
      lo: Infinity, hi: -Infinity, restLo: Infinity, restHi: -Infinity, n: 0,
    }));
    // The piece's own rest height, so bands are its fifths and not the scene's.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < rest.length / 3; i++) {
      const y = rest[i * 3 + 1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    group.restLoY = lo;
    group.restSpanY = hi - lo;
  }
  if (!(group.restSpanY > 1e-6)) return;
  const t = (rest[v * 3 + 1] - group.restLoY) / group.restSpanY;
  const band = group.bands[Math.min(STRAIN_BANDS - 1, Math.max(0, Math.floor(t * STRAIN_BANDS)))];
  band.n++;
  if (liveY < band.lo) band.lo = liveY;
  if (liveY > band.hi) band.hi = liveY;
  const ry = rest[v * 3 + 1];
  if (ry < band.restLo) band.restLo = ry;
  if (ry > band.restHi) band.restHi = ry;
}

/** Bands bottom-first, so the report reads the way the cloth hangs. */
function bandReport(group) {
  if (!group.bands) return null;
  return group.bands.map((band, i) => {
    const restSpan = band.restHi - band.restLo;
    const liveSpan = band.hi - band.lo;
    return {
      band: i,
      where: `${Math.round((i / STRAIN_BANDS) * 100)}-${Math.round(((i + 1) / STRAIN_BANDS) * 100)}% up`,
      particles: band.n,
      squash: band.n && restSpan > 1e-6 ? Math.round((liveSpan / restSpan) * 100) / 100 : null,
    };
  });
}

function motionOf(g) {
  if (!g.movedCount) return {};
  const mean = g.moved / g.movedCount;
  const net = Math.hypot(g.netX, g.netY, g.netZ) / g.movedCount;
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    movedMm: round(mean * 1000),
    maxMovedMm: round((g.maxMoved ?? 0) * 1000),
    // Guarded: a cloth that did not move at all has no direction to agree on,
    // and reporting 0 there would read as maximum disagreement.
    coherence: mean > 1e-7 ? Math.round((net / mean) * 100) / 100 : null,
  };
}

async function readClothPositions(component, simulation) {
  const renderer = engine.renderer, analysis = component.clothAnalysis;
  if (!simulation?.positions?.value) return { error: "this cloth has no GPU simulation yet" };
  if (!renderer?.getArrayBufferAsync) return { error: "the renderer cannot read buffers back" };
  const data = new Float32Array(await renderer.getArrayBufferAsync(simulation.positions.value));
  const count = Math.min(simulation.count ?? 0, data.length >> 2);
  if (!count) return { error: "the simulation buffer is empty" };

  // ⭐⭐⭐ "FIGHTING THEMSELVES" IS A STATEMENT ABOUT MOTION, AND EVERY
  // INSTRUMENT SO FAR MEASURED SHAPE.
  //
  // Bounds, strain and the verdicts all describe a single frozen frame, so a
  // cloth that is the right size and in the right place scores perfectly while
  // buzzing. That is exactly the user's report, and exactly what a whole
  // session of "the numbers say it improved" kept missing.
  //
  // COHERENCE is the discriminator, not speed. A curtain in wind moves a lot
  // and moves TOGETHER: its particles share a direction, so the mean of the
  // displacement vectors is nearly as long as the mean of their lengths.
  // A cloth fighting itself moves just as far with its particles pulling
  // against each other, so the vectors cancel and the ratio collapses.
  //
  //     coherence = |mean displacement| / mean |displacement|
  //
  //     1.0  every particle moving the same way — wind, a swing, a settle
  //     0.0  pure disagreement — jitter, buzz, springs sawing at each other
  //
  // The previous snapshot lives on the COMPONENT, so two successive calls to
  // this op measure the interval between them.
  const previous = component.__clothMotionSnapshot;
  const snapshot = data.slice();
  component.__clothMotionSnapshot = snapshot;
  const comparable = previous?.length === snapshot.length;

  const island = analysis?.island, rest = analysis?.rest;
  const groups = new Map();
  let nonFinite = 0;
  for (let i = 0; i < count; i++) {
    const x = data[i * 4], y = data[i * 4 + 1], z = data[i * 4 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nonFinite++; continue; }
    const key = island ? island[i] : 0;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { particles: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity],
      restLo: [Infinity, Infinity, Infinity], restHi: [-Infinity, -Infinity, -Infinity] });
    g.particles++;
    const p = [x, y, z];
    strainOf(analysis, data, i, g);
    bandOf(analysis, i, y, g);
    if (comparable) {
      const dx = x - previous[i * 4], dy = y - previous[i * 4 + 1], dz = z - previous[i * 4 + 2];
      const d = Math.hypot(dx, dy, dz);
      if (Number.isFinite(d)) {
        g.moved = (g.moved ?? 0) + d;
        g.netX = (g.netX ?? 0) + dx; g.netY = (g.netY ?? 0) + dy; g.netZ = (g.netZ ?? 0) + dz;
        g.movedCount = (g.movedCount ?? 0) + 1;
        if (d > (g.maxMoved ?? 0)) g.maxMoved = d;
      }
    }
    for (let k = 0; k < 3; k++) { if (p[k] < g.lo[k]) g.lo[k] = p[k]; if (p[k] > g.hi[k]) g.hi[k] = p[k]; }
    if (rest) for (let k = 0; k < 3; k++) {
      const r = rest[i * 3 + k];
      if (r < g.restLo[k]) g.restLo[k] = r;
      if (r > g.restHi[k]) g.restHi[k] = r;
    }
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  const islands = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([id, g]) => {
    const span = g.hi.map((h, k) => h - g.lo[k]), restSpan = g.restHi.map((h, k) => h - g.restLo[k]);
    // The rest pose is the only honest reference, and the two axes have to be
    // read separately — see `clothHealth.js` for the diagonal that hid an
    // eighteen-fold blow-out inside an ordinary-looking 2.37.
    const strain = g.springs ? g.strainSum / g.springs : null;
    return { island: id, particles: g.particles,
      span: span.map(round), restSpan: restSpan.map(round), centre: g.lo.map((l, k) => round((l + g.hi[k]) / 2)),
      ...classifyClothIsland(span, restSpan, { mean: strain, worst: g.worst ?? null }, motionOf(g)),
      // ⭐ THE POSE-INDEPENDENT READING, and the one to trust when it
      // disagrees with the box. See `strainOf`.
      strain: strain == null ? null : Math.round(strain * 1000) / 1000,
      worstStrain: g.worst == null ? null : Math.round(g.worst * 100) / 100,
      shellStrain: g.shellSprings ? Math.round((g.shellSum / g.shellSprings) * 1000) / 1000 : null,
      worstShell: g.shellWorst == null ? null : Math.round(g.shellWorst * 100) / 100,
      ...motionOf(g),
      bands: bandReport(g) };
  });
  return { particles: count, nonFinite, islands };
}

defineOp({
  name: "vfx.timeline.get", readOnly: true,
  description: "Read the separate VFX composition timeline and its transient playback state.",
  params: { entityId: { type: "string", required: true } },
  run: ({entityId}) => { const c = requireComponent(entityId, "vfx"); return { timeline: structuredClone(c.document ?? c.props.timeline ?? createEffectPreset()), time: c.time, state: c.state, elementKinds: EFFECT_KINDS }; },
});
defineOp({
  name: "vfx.timeline.set", undoable: true,
  description: "Replace a VFX composition with validated timed elements and animation curves. One undoable edit.",
  params: { entityId: { type: "string", required: true }, timeline: { type: "object", required: true } },
  run: ({entityId,timeline}) => { requireComponent(entityId,"vfx"); const document=normalizeEffectTimeline(timeline); commandBus.execute(new SetComponentPropCommand(entityId,"vfx","timeline",document)); return {entityId,timeline:document}; },
});
defineOp({
  name: "vfx.timeline.playback",
  description: "Preview a VFX timeline: play, pause, resume, stop or seek. Seeking poses layers and resets particle simulations.",
  params: { entityId: { type: "string", required: true }, action: { type: "string", enum: ["play","pause","resume","stop","seek"], required: true }, time: { type: "number", default: 0 } },
  run: ({entityId,action,time}) => { const c=requireComponent(entityId,"vfx"); c[action](time); return {entityId,time:c.time,state:c.state}; },
});

const entityParam = { type: "string", required: true, description: "Entity with the requested simulation component." };
function document(entityId) {
  const component = engine.getEntity(entityId)?.getComponent("particles");
  if (!component) throw new Error("Add a particles component to this entity first with component.add.");
  return structuredClone(component.effectiveGraph ?? component.props.graph ?? (component.props.startColor !== undefined
    ? legacyPropsToGraph(component.props) : DEFAULT_PARTICLE_GRAPH));
}
function commit(entityId, graph, label) {
  if (engine.getEntity(entityId)?.getComponent("particles")?.props.asset) throw new Error("This effect uses a shared .vfx asset. Edit it with vfx.set(path), or clear the asset with vfx.assign.");
  commandBus.execute(new SetComponentPropCommand(entityId, "particles", "graph", graph, label));
  return { entityId, graph };
}

defineOp({
  name: "vfx.modules",
  description: "List particle graph recipes and node parameter schemas. Cloth and water have their own modules; the separate VFX composition uses vfx.timeline operations.",
  readOnly: true,
  params: {},
  run: () => ({ modules: VFX_MODULES, nodeTypes: P_NODE_TYPES, simulations: ["particles", "cloth", "water"] }),
});

defineOp({
  name: "vfx.get",
  description: "Read a particle, cloth or water graph from an entity or .vfx file, including disabled nodes and preserved connections.",
  readOnly: true,
  params: {
    entityId: { ...entityParam, required: false },
    path: { type: "string", description: "Absolute .vfx project path, instead of entityId." },
    kind: { type: "string", enum: ["particles", "cloth", "water"], default: "particles" },
  },
  async run({ entityId, path, kind }) {
    if (path) return { path, ...await readVfxDocument(path) };
    const comp = requireComponent(entityId, kind);
    const graph = comp.effectiveGraph ?? comp.props.graph ?? defaultGraph(kind, comp.props);
    return { entityId, kind, asset: comp.props.asset ?? "", graph: structuredClone(graph) };
  },
});

const kindParam = { type: "string", enum: ["particles", "cloth", "water"], default: "particles", description: "Simulation component type." };
function requireComponent(entityId, kind) {
  const comp = engine.getEntity(entityId)?.getComponent(kind);
  if (!comp) throw new Error(`Entity needs a ${kind} component. Add it with component.add first.`);
  return comp;
}
function defaultGraph(kind, props = {}) {
  return kind === "particles" ? (props.startColor !== undefined ? legacyPropsToGraph(props) : structuredClone(DEFAULT_PARTICLE_GRAPH)) : createSimulationGraph(kind, props);
}

defineOp({
  name: "vfx.create",
  description: "Create a reusable .vfx file. Refuses an existing path. Optionally seed from an entity and assign the result to a matching component.",
  params: {
    path: { type: "string", required: true, description: "Absolute project filename; .vfx is appended if missing." },
    kind: kindParam,
    graph: { type: "object", description: "Graph to store; defaults to a fresh simulation graph." },
    fromEntityId: { type: "string", description: "Copy this entity's effective graph." },
    assignTo: { type: "string", description: "Entity with a matching simulation component." },
  },
  async run({ path, kind, graph, fromEntityId, assignTo }) {
    const target = vfxDocumentPath(/\.vfx$/i.test(path) ? path : `${path}.vfx`);
    let exists = false;
    try { await invoke("stat_file", { path: target }); exists = true; } catch {}
    if (exists) throw new Error("VFX file already exists. Use vfx.set to edit it.");
    const source = fromEntityId ? requireComponent(fromEntityId, kind) : null;
    if (assignTo) requireComponent(assignTo, kind);
    const doc = createVfxAsset(kind, graph ?? source?.effectiveGraph ?? source?.props.graph ?? defaultGraph(kind, source?.props));
    await writeVfxDocument(target, doc);
    await useProjectStore.getState().refresh();
    if (assignTo) commandBus.execute(new SetComponentPropCommand(assignTo, kind, "asset", target));
    return { path: target, kind, graph: doc.graph, assignedTo: assignTo ?? null };
  },
});

defineOp({
  name: "vfx.set",
  description: "Write a shared .vfx graph and refresh all linked instances, or edit an unlinked entity graph through undo history. Kind follows the existing file when path is given.",
  params: {
    path: { type: "string", description: "Existing .vfx path to update." },
    entityId: { type: "string", description: "Unlinked entity to update instead of a file." },
    kind: kindParam,
    graph: { type: "object", required: true },
  },
  async run({ path, entityId, kind, graph }) {
    if (path) {
      const previous = await readVfxDocument(path);
      const doc = createVfxAsset(previous.kind, graph);
      await writeVfxDocument(path, { ...previous, ...doc });
      return { path, kind: doc.kind, graph: doc.graph };
    }
    const comp = requireComponent(entityId, kind);
    if (comp.props.asset) throw new Error("This entity uses a shared .vfx. Pass its path, or clear the asset slot first.");
    const doc = createVfxAsset(kind, graph);
    commandBus.execute(new SetComponentPropCommand(entityId, kind, "graph", doc.graph));
    return { entityId, kind, graph: doc.graph };
  },
});

defineOp({
  name: "vfx.assign",
  description: "Assign a .vfx file to a matching simulation component, or clear its asset slot to restore the inline graph. Undoable; mismatched simulation kinds are rejected.",
  undoable: true,
  params: { entityId: entityParam, kind: kindParam, path: { type: "string", default: "", description: "Absolute .vfx path, or empty to clear." } },
  async run({ entityId, kind, path }) {
    requireComponent(entityId, kind);
    if (path) {
      const doc = await readVfxDocument(path);
      if (doc.kind !== kind) throw new Error(`Cannot assign ${doc.kind} VFX to ${kind}.`);
      path = vfxDocumentPath(path);
    }
    commandBus.execute(new SetComponentPropCommand(entityId, kind, "asset", path));
    return { entityId, kind, path };
  },
});

defineOp({
  name: "vfx.addModule",
  description: "Add and automatically connect a VFX graph recipe to a particle system. Use vfx.modules for module IDs and vfx.get for system node IDs. One undoable edit.",
  undoable: true,
  params: {
    entityId: entityParam,
    systemId: { type: "string", required: true, description: "Target System node ID." },
    moduleId: { type: "string", required: true, description: "Recipe ID returned by vfx.modules." },
  },
  run: ({ entityId, systemId, moduleId }) => {
    const recipe = VFX_MODULES.find((entry) => entry.id === moduleId);
    if (!recipe) throw new Error(`Unknown VFX module "${moduleId}". Use vfx.modules.`);
    const result = addVfxModule(document(entityId), systemId, recipe);
    return { ...commit(entityId, result.graph, `Add ${recipe.label}`), nodeId: result.id };
  },
});

defineOp({
  name: "vfx.setEnabled",
  description: "Enable or bypass a particle graph node without deleting its parameters or connections. One undoable edit.",
  undoable: true,
  params: {
    entityId: entityParam,
    nodeId: { type: "string", required: true, description: "Node ID from vfx.get." },
    enabled: { type: "boolean", required: true, description: "Whether this module participates in simulation." },
  },
  run: ({ entityId, nodeId, enabled }) => {
    const graph = document(entityId);
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node || !P_NODE_TYPES[node.type]) throw new Error(`Unknown VFX node "${nodeId}".`);
    node.enabled = enabled;
    return commit(entityId, graph, `${enabled ? "Enable" : "Disable"} ${node.label ?? P_NODE_TYPES[node.type].label}`);
  },
});
