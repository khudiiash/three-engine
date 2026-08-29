// Extended emissive surfaces use the existing four analytic seats spatially.
// CPU-only: geometry classification, partition, energy and allocation policy.
import * as THREE from "three/webgpu";
import {
  allocateEmitterSurfaceSeats,
  emitterSurfaceSeatGroups,
  emitterSurfaceSeatSource,
  sampleThinBoxEmitterSurface,
} from "../src/modules/gi/emitterSeats.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A tessellated 8 m x 40 cm cafe sign. Tessellation is intentional: a single
// two-triangle quad already has an exact analytic OBB and cannot be localised by
// assigning whole triangles to segments.
const sign = new THREE.PlaneGeometry(8, 0.4, 32, 2);
const source = emitterSurfaceSeatSource(sign);
check("an elongated sheet is admitted for spatial seats", !!source,
  source ? `${source.parts.length} atomic parts, normal dominance ${source.normalDominance.toFixed(3)}` : "refused");
check("the geometry analysis is cached", emitterSurfaceSeatSource(sign) === source);

// Imported meshes may expose positions through an interleaved attribute. The
// seat analysis must honor stride/offset rather than indexing `.array` as xyz.
const interleavedData = new Float32Array(sign.attributes.position.count * 5);
for (let i = 0; i < sign.attributes.position.count; i++) {
  interleavedData[i * 5] = 123; // non-position prefix catches raw i*3 reads
  interleavedData[i * 5 + 1] = sign.attributes.position.getX(i);
  interleavedData[i * 5 + 2] = sign.attributes.position.getY(i);
  interleavedData[i * 5 + 3] = sign.attributes.position.getZ(i);
  interleavedData[i * 5 + 4] = -456;
}
const interleavedSign = new THREE.BufferGeometry();
const interleaved = new THREE.InterleavedBuffer(interleavedData, 5);
interleavedSign.setAttribute("position", new THREE.InterleavedBufferAttribute(interleaved, 3, 1));
interleavedSign.setIndex(sign.index.clone());
const interleavedSource = emitterSurfaceSeatSource(interleavedSign);
check("interleaved position stride/offset preserves the surface partition",
  !!interleavedSource && Math.abs(interleavedSource.localArea - source.localArea) < 1e-6,
  interleavedSource ? `area ${interleavedSource.localArea.toFixed(4)}` : "refused");

if (source) {
  const groups = emitterSurfaceSeatGroups(source, 4);
  const ids = groups.flatMap((g) => g.partIds);
  const unique = new Set(ids);
  const area = groups.reduce((sum, g) => sum + g.areaFraction, 0);
  const centres = groups.map((g) => (g.localMin[0] + g.localMax[0]) * 0.5);
  const widths = groups.map((g) => g.localMax[0] - g.localMin[0]);
  check("four seats partition every atomic part exactly once",
    groups.length === 4 && ids.length === source.parts.length && unique.size === source.parts.length,
    `${groups.length} groups over ${unique.size}/${source.parts.length} parts`);
  check("surface-seat area fractions conserve emitted power", Math.abs(area - 1) < 1e-12,
    `sum ${area.toPrecision(12)}`);
  check("seat centres span the long sign instead of collapsing to its centre",
    Math.max(...centres) - Math.min(...centres) > 5 && Math.max(...widths) < 3,
    `centres ${centres.map((v) => v.toFixed(2)).join("/")}, max width ${Math.max(...widths).toFixed(2)}m`);

  // The fitted rectangle model emits pi * crossSection * (L * fill), where
  // fill=area/crossSection. Summed groups must recover pi * authored area * L.
  const authoredL = 17;
  let modelPower = 0;
  for (const g of groups) {
    const hx = (g.localMax[0] - g.localMin[0]) * 0.5;
    const hy = (g.localMax[1] - g.localMin[1]) * 0.5;
    const hz = Math.max((g.localMax[2] - g.localMin[2]) * 0.5, 0.005);
    const crossSection = 4 * Math.max(hx * hy, hy * hz, hz * hx);
    const trueArea = source.localArea * g.areaFraction;
    const fill = Math.min(1, trueArea / crossSection);
    modelPower += Math.PI * crossSection * authoredL * fill;
  }
  const truePower = Math.PI * source.localArea * authoredL;
  check("the segmented analytic model conserves sign power",
    Math.abs(modelPower - truePower) < truePower * 1e-6,
    `${modelPower.toFixed(6)} vs ${truePower.toFixed(6)}`);
}

// Tiny bulbs have isotropic normal covariance and must remain on the existing
// one-seat equivalent-body consolidation path, not consume all four seats.
function bulbString(count = 24) {
  const chunks = [];
  let floats = 0;
  for (let i = 0; i < count; i++) {
    const g = new THREE.SphereGeometry(0.025, 8, 6).toNonIndexed();
    g.translate(i * 0.35, (i % 2) * 0.8, (i % 3) * 0.55);
    chunks.push(g.attributes.position.array);
    floats += g.attributes.position.array.length;
  }
  const positions = new Float32Array(floats);
  let at = 0;
  for (const chunk of chunks) { positions.set(chunk, at); at += chunk.length; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}
const bulbs = bulbString();
check("a string of tiny bulbs is not classified as an extended surface",
  emitterSurfaceSeatSource(bulbs) === null);

// Visibility rays for a transformed sign must land on its actual face.
const angle = Math.PI * 0.37;
const axes = [
  [Math.cos(angle), 0, -Math.sin(angle)],
  [0, 1, 0],
  [Math.sin(angle), 0, Math.cos(angle)],
];
const center = [4.25, 2.1, -3.5];
const half = [4, 0.2, 0.01];
const receiver = [center[0] + axes[2][0] * 3, center[1], center[2] + axes[2][2] * 3];
const localOf = (p, axis) => (p[0] - center[0]) * axes[axis][0]
  + (p[1] - center[1]) * axes[axis][1]
  + (p[2] - center[2]) * axes[axis][2];
const targets = [[0, 0], [1, 0], [0, 1], [1, 1], [0.23, 0.81]].map((jitter) =>
  sampleThinBoxEmitterSurface({ center, axes, half, receiver, jitter }));
check("thin-box shadow samples stay on the transformed emitter face",
  targets.every((p) => p
    && Math.abs(localOf(p, 2) - half[2]) < 1e-10
    && Math.abs(localOf(p, 0)) <= half[0] * 0.951
    && Math.abs(localOf(p, 1)) <= half[1] * 0.951));
check("shadow samples span the broad source instead of collapsing to one point",
  Math.max(...targets.map((p) => localOf(p, 0)))
    - Math.min(...targets.map((p) => localOf(p, 0))) > half[0] * 1.8);
const delta = [7, -2, 5];
const shifted = sampleThinBoxEmitterSurface({
  center: center.map((v, i) => v + delta[i]), axes, half,
  receiver: receiver.map((v, i) => v + delta[i]), jitter: [0.23, 0.81],
});
check("the same shadow sample follows an emitter transform without flicker",
  shifted.every((v, i) => Math.abs(v - targets[4][i] - delta[i]) < 1e-10));
check("volumetric boxes keep their existing estimator",
  sampleThinBoxEmitterSurface({ center, axes, half: [1, 1, 1], receiver, jitter: [0.5, 0.5] }) === null);

if (source) {
  const signMesh = { name: "sign" };
  const lampMesh = { name: "lamp" };
  const signCand = { mesh: signMesh };
  const lampCand = { mesh: lampMesh };
  const sourceOf = (mesh) => mesh === signMesh ? source : null;
  const scoreOf = (cand) => cand === signCand ? 100 : 10;
  const lone = allocateEmitterSurfaceSeats([signCand], { capacity: 4, sourceOf, scoreOf });
  check("a lone extended sign may use all four existing slots", lone.get(signMesh) === 4);
  const competing = allocateEmitterSurfaceSeats([signCand, lampCand], { capacity: 4, sourceOf, scoreOf });
  check("with a competing lamp the sign is capped at two seats",
    competing.get(signMesh) === 2 && competing.get(lampMesh) === 1,
    `sign ${competing.get(signMesh)}, lamp ${competing.get(lampMesh)}`);
  const others = [0, 1, 2].map((i) => ({ mesh: { name: `lamp${i}` } }));
  const full = allocateEmitterSurfaceSeats([signCand, ...others], { capacity: 4, sourceOf, scoreOf });
  check("with four occupied seats a strong sign segment displaces the weakest analytic bonus",
    full.get(signMesh) === 2
      && full.selectedCandidates.length === 3
      && [...full.values()].reduce((a, b) => a + b, 0) === 4,
    `sign ${full.get(signMesh)}, retained ${full.selectedCandidates.map((c) => c.mesh.name).join("/")}`);
  const weakScore = (cand) => cand === signCand ? 15 : 10;
  const weak = allocateEmitterSurfaceSeats([signCand, ...others], {
    capacity: 4, sourceOf, scoreOf: weakScore,
  });
  check("a weak marginal segment cannot evict a stronger distinct emitter",
    weak.get(signMesh) === 1 && weak.selectedCandidates.length === 4);
  const repeat = allocateEmitterSurfaceSeats([signCand, ...others], { capacity: 4, sourceOf, scoreOf });
  check("full-budget displacement is deterministic",
    repeat.get(signMesh) === full.get(signMesh)
      && repeat.selectedCandidates.map((c) => c.mesh.name).join("/")
        === full.selectedCandidates.map((c) => c.mesh.name).join("/"));
}

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
