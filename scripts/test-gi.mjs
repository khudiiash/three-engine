// Headless test of the GI module: grid math, CPU voxelization (occupancy,
// albedo/normal packing, mesh filtering), probe direction sets, TSL node
// graph construction, and the component/system activation lifecycle.
// The GPU compute passes themselves need a WebGPU device, so this verifies
// everything up to (and including) node-graph construction.
// Run: node scripts/test-gi.mjs
globalThis.document ??= { body: {} };

import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Engine, enableEngineModule, getComponentClass, registerBuiltInComponents } from "../src/engine/index.js";
import {
  computeGrid,
  voxelizeScene,
  voxelizeRegion,
  voxelizeRegionAsync,
  shiftGrid,
  isVoxelizableMesh,
  voxelIndex,
  fibonacciDirections,
  octaTexelDirections,
  RAYS_PER_PROBE,
  OCTA_RES,
} from "../src/modules/gi/index.js";
import {
  createGINodes,
  computeMipLevels,
  GIProbeVolumeLight,
  GIProbeVolumeLightNode,
  MIP_GAP,
} from "../src/modules/gi/giCompute.js";
import { uniform } from "three/tsl";
import "../src/modules/index.js";

registerBuiltInComponents();

// -- grid math: cubic voxels, proportional dims, centered min --
{
  const grid = computeGrid(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 4, 8), 16);
  assert.equal(grid.voxelSize, 0.5, "voxel size from largest axis / res");
  assert.deepEqual(grid.dims, { x: 16, y: 8, z: 16 }, "smaller axes get proportionally fewer voxels");
  assert.equal(grid.count, 16 * 8 * 16);
  assert.equal(grid.min.x, -4, "grid centered");
  assert.equal(grid.min.y, -2);
  console.log("[1] OK: computeGrid");
}

// -- voxelizer: a red box marks surface voxels with packed albedo + normals --
{
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0xff0000 }),
  );
  scene.add(box);
  scene.updateMatrixWorld(true);
  const grid = computeGrid(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 8, 8), 16);
  const result = voxelizeScene(scene, grid);
  assert.ok(result.occupied > 0, "box produced occupied voxels");
  assert.equal(result.meshes, 1);
  assert.equal(result.tris, 12);

  // Every occupied voxel: albedo red, alpha byte set, normal unpacks to ~unit.
  let checked = 0;
  for (let i = 0; i < result.albedo.length; i++) {
    if (result.albedo[i] === 0) continue;
    assert.equal(result.albedo[i] & 0xff, 255, "red channel");
    assert.equal((result.albedo[i] >>> 8) & 0xff, 0, "green channel");
    assert.ok(result.albedo[i] >>> 24 > 0, "occupancy byte set");
    const n = result.normal[i];
    const nx = ((n & 0xff) / 255) * 2 - 1;
    const ny = (((n >>> 8) & 0xff) / 255) * 2 - 1;
    const nz = (((n >>> 16) & 0xff) / 255) * 2 - 1;
    const len = Math.hypot(nx, ny, nz);
    assert.ok(len > 0.9 && len < 1.1, `normal ~unit length (got ${len})`);
    checked++;
  }
  assert.equal(checked, result.occupied, "occupied count matches non-zero albedo entries");

  // A voxel on the box's top face exists and its normal points up.
  const vs = grid.voxelSize;
  // The face plane y=1.0 sits exactly on a voxel boundary; floor() puts its
  // sample points in the row above the boundary.
  const topY = Math.floor((1 - grid.min.y) / vs);
  const cx = Math.floor((0 - grid.min.x) / vs);
  const cz = Math.floor((0 - grid.min.z) / vs);
  const ti = voxelIndex(cx, topY, cz, grid.dims);
  assert.ok(result.albedo[ti] !== 0, "top-face voxel occupied");
  const tn = result.normal[ti];
  assert.ok((((tn >>> 8) & 0xff) / 255) * 2 - 1 > 0.7, "top-face normal points +Y");

  // A voxel well inside empty air stays empty.
  const airIdx = voxelIndex(1, 1, 1, grid.dims);
  assert.equal(result.albedo[airIdx], 0, "air voxel empty");
  assert.ok(result.emissive.every((v) => v === 0), "non-emissive material → zero emissive voxels");

  // Emissive material: packed at 1/8 scale with intensity folded in.
  const glowScene = new THREE.Scene();
  glowScene.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x00ff00, emissiveIntensity: 4 }),
    ),
  );
  glowScene.updateMatrixWorld(true);
  const glow = voxelizeScene(glowScene, grid);
  let glowChecked = 0;
  for (let i = 0; i < glow.albedo.length; i++) {
    if (glow.albedo[i] === 0) continue;
    assert.equal(glow.emissive[i] & 0xff, 0, "emissive red 0");
    assert.equal((glow.emissive[i] >>> 8) & 0xff, Math.round((4 / 8) * 255), "emissive green = intensity/scale");
    glowChecked++;
  }
  assert.ok(glowChecked > 0, "emissive voxels present");

  // Engine shader graphs represent emission as a TSL expression, not as a
  // Color directly on emissiveNode. This is the shape used by Emission and
  // Principled BSDF nodes: uniform color * uniform strength. emissiveNode is
  // an override, so the scalar material emissiveIntensity must not be applied
  // to it a second time.
  const graphMaterial = new THREE.MeshPhysicalNodeMaterial();
  graphMaterial.emissiveNode = uniform(new THREE.Color(1, 0.25, 0)).mul(uniform(4));
  graphMaterial.emissiveIntensity = 3;
  const graphScene = new THREE.Scene();
  graphScene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), graphMaterial));
  graphScene.updateMatrixWorld(true);
  const graphGlow = voxelizeScene(graphScene, grid);
  const graphVoxel = graphGlow.emissive.find((value) => value !== 0);
  assert.ok(graphVoxel, "graph-authored emissive expression produced emissive voxels");
  assert.equal(graphVoxel & 0xff, Math.round((4 / 8) * 255), "graph emissive red includes strength once");
  assert.equal((graphVoxel >>> 8) & 0xff, Math.round((1 / 8) * 255), "graph emissive green includes strength once");
  console.log("[2] OK: voxelizeScene (occupancy, packing, normals, emissive)");
}

// -- mesh filtering: skinned, engine-owned, debug and invisible meshes skipped --
{
  const mk = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  assert.ok(isVoxelizableMesh(mk()), "plain mesh voxelizable");
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  assert.ok(!isVoxelizableMesh(skinned), "skinned mesh skipped");
  const owned = mk();
  owned.userData.engineOwned = true;
  assert.ok(!isVoxelizableMesh(owned), "engine-owned mesh skipped");
  const dbg = mk();
  dbg.userData.giDebug = true;
  assert.ok(!isVoxelizableMesh(dbg), "GI debug mesh skipped");
  const hidden = mk();
  hidden.visible = false;
  assert.ok(!isVoxelizableMesh(hidden), "invisible mesh skipped");
  const editorOnly = mk();
  editorOnly.layers.set(31);
  assert.ok(!isVoxelizableMesh(editorOnly), "editor-layer-31 mesh skipped (unsigned mask compare)");

  // Meshes under an INVISIBLE parent must not voxelize — the engine hides
  // disabled entities via the root object's `visible`, children stay true.
  const sceneV = new THREE.Scene();
  const group = new THREE.Group();
  group.visible = false;
  group.add(mk());
  sceneV.add(group, mk());
  sceneV.updateMatrixWorld(true);
  const gridV = computeGrid(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 8, 8), 16);
  const resV = voxelizeScene(sceneV, gridV);
  assert.equal(resV.meshes, 1, "hidden subtree pruned from voxelization");
  console.log("[3] OK: isVoxelizableMesh filtering + hidden-subtree pruning");
}

// -- direction sets: unit vectors, hemispherically balanced --
{
  const dirs = fibonacciDirections(RAYS_PER_PROBE);
  assert.equal(dirs.length, RAYS_PER_PROBE * 4);
  let sum = [0, 0, 0];
  for (let i = 0; i < RAYS_PER_PROBE; i++) {
    const len = Math.hypot(dirs[i * 4], dirs[i * 4 + 1], dirs[i * 4 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-6, "fibonacci dir unit length");
    sum[0] += dirs[i * 4];
    sum[1] += dirs[i * 4 + 1];
    sum[2] += dirs[i * 4 + 2];
  }
  assert.ok(Math.hypot(...sum) / RAYS_PER_PROBE < 0.05, "fibonacci set balanced");

  const texelDirs = octaTexelDirections();
  assert.equal(texelDirs.length, OCTA_RES * OCTA_RES * 4);
  let up = 0;
  for (let i = 0; i < OCTA_RES * OCTA_RES; i++) {
    const len = Math.hypot(texelDirs[i * 4], texelDirs[i * 4 + 1], texelDirs[i * 4 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-6, "octa texel dir unit length");
    if (texelDirs[i * 4 + 2] > 0) up++;
  }
  assert.ok(up >= 24 && up <= 40, `octa texels cover both hemispheres (+z: ${up}/64)`);
  console.log("[4] OK: fibonacci + octahedral direction sets");
}

// -- clipmap scrolling: grid shift + region-limited re-voxelization --
{
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
  scene.add(box);
  scene.updateMatrixWorld(true);
  const grid = computeGrid(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 8, 8), 16);
  const full = voxelizeScene(scene, grid);

  // Shift content by +2 voxels in x: a voxel occupied at x is now at x-2.
  const shifted = full.albedo.slice();
  const scratch = new Uint32Array(shifted.length);
  shiftGrid(shifted, grid.dims, { x: 2, y: 0, z: 0 }, scratch);
  let matches = 0;
  for (let z = 0; z < grid.dims.z; z++) {
    for (let y = 0; y < grid.dims.y; y++) {
      for (let x = 0; x < grid.dims.x; x++) {
        const src = x + 2 < grid.dims.x ? full.albedo[voxelIndex(x + 2, y, z, grid.dims)] : 0;
        assert.equal(shifted[voxelIndex(x, y, z, grid.dims)], src, `shifted voxel (${x},${y},${z})`);
        if (src) matches++;
      }
    }
  }
  assert.ok(matches > 0, "shift preserved occupied voxels");

  // Region voxelize: recentered grid, slab-only rebuild reproduces the box
  // surface inside the slab and leaves the rest of the target untouched.
  const grid2 = computeGrid(new THREE.Vector3(1, 0, 0), new THREE.Vector3(8, 8, 8), 16);
  const target = { albedo: new Uint32Array(grid2.count), normal: new Uint32Array(grid2.count) };
  // Box (world x ∈ [-1,1]) starts at voxel x=4 in grid2 — region [0,6) clips it.
  const region = { x0: 0, y0: 0, z0: 0, x1: 6, y1: grid2.dims.y, z1: grid2.dims.z };
  const stats = voxelizeRegion(scene, grid2, target, region);
  const reference = voxelizeScene(scene, grid2);
  // Clipped sub-triangles sample on a different lattice than whole ones, so
  // coverage may gain the odd ε-boundary voxel — require every reference
  // voxel to be reproduced (same color) and extras to stay marginal.
  let extras = 0;
  for (let i = 0; i < grid2.count; i++) {
    const z = Math.floor(i / (grid2.dims.x * grid2.dims.y));
    const x = (i - z * grid2.dims.x * grid2.dims.y) % grid2.dims.x;
    if (x < 6) {
      if (reference.albedo[i]) assert.equal(target.albedo[i], reference.albedo[i], `region voxel ${i}`);
      else if (target.albedo[i]) extras++;
    } else {
      assert.equal(target.albedo[i], 0, `outside-region voxel ${i} untouched`);
    }
  }
  assert.ok(extras <= Math.max(8, stats.occupied * 0.15), `clip-lattice extras stay marginal (${extras})`);
  assert.ok(stats.occupied > 0, "slab found box voxels");

  // A mesh entirely outside the region is AABB-rejected.
  const farRegion = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
  const farStats = voxelizeRegion(scene, grid2, target, farRegion);
  assert.equal(farStats.meshes, 0, "out-of-region mesh rejected by AABB test");

  // Full rebuilds use the time-sliced path at runtime. It must publish the
  // exact same grid as the synchronous path, including the emissive channel.
  const asyncTarget = {
    albedo: new Uint32Array(grid2.count),
    normal: new Uint32Array(grid2.count),
    emissive: new Uint32Array(grid2.count),
  };
  const asyncStats = await voxelizeRegionAsync(
    scene,
    grid2,
    asyncTarget,
    { x0: 0, y0: 0, z0: 0, x1: grid2.dims.x, y1: grid2.dims.y, z1: grid2.dims.z },
    { timeSliceMs: 1 },
  );
  assert.deepEqual(asyncTarget.albedo, reference.albedo, "time-sliced albedo matches sync voxelization");
  assert.deepEqual(asyncTarget.normal, reference.normal, "time-sliced normals match sync voxelization");
  assert.deepEqual(asyncTarget.emissive, reference.emissive, "time-sliced emissive matches sync voxelization");
  assert.equal(asyncStats.occupied, reference.occupied);

  const cancelled = await voxelizeRegionAsync(scene, grid2, asyncTarget, region, {
    signal: { cancelled: true },
  });
  assert.equal(cancelled.cancelled, true, "time-sliced voxelization is cancellable");
  console.log("[5] OK: clipmap shift + region voxelization");
}

// -- mip pyramid layout math --
{
  const mip = computeMipLevels({ x: 64, y: 32, z: 64 });
  assert.deepEqual(mip.levels[0].dims, { x: 64, y: 32, z: 64 });
  assert.deepEqual(mip.levels[1].dims, { x: 32, y: 16, z: 32 });
  assert.equal(mip.levels[0].bufOffset, -1, "level 0 lives in the radiance buffer");
  assert.equal(mip.levels[1].bufOffset, 0, "level 1 starts the mip buffer");
  assert.equal(mip.levels[2].bufOffset, 32 * 16 * 32, "levels packed consecutively");
  const last = mip.levels[mip.levels.length - 1];
  assert.ok(Math.max(last.dims.x, last.dims.y, last.dims.z) <= 4, "coarsest level ≤ 4 voxels");
  assert.equal(mip.levels[1].atlasX, 64 + MIP_GAP, "atlas levels laid out along X with a gap");
  assert.equal(mip.atlasDims.y, 32, "atlas height = level-0 height");
  console.log("[6] OK: mip pyramid layout");
}

// -- TSL node graph construction (no GPU needed to build the graph) --
{
  const dims = { x: 8, y: 8, z: 8 };
  const counts = { x: 3, y: 2, z: 3 };
  const probeCount = 18;
  const tilesPerRow = Math.ceil(Math.sqrt(probeCount));
  const probesPerFrame = 8;
  const atlas = new THREE.StorageTexture(tilesPerRow * OCTA_RES, Math.ceil(probeCount / tilesPerRow) * OCTA_RES);
  atlas.type = THREE.HalfFloatType;
  const mip = computeMipLevels(dims);
  const radianceAtlas = new THREE.Storage3DTexture(mip.atlasDims.x, mip.atlasDims.y, mip.atlasDims.z);
  radianceAtlas.type = THREE.HalfFloatType;
  const sba = (arr, s) => new THREE.StorageBufferAttribute(arr, s);
  const nodes = createGINodes({
    dims,
    counts,
    probesPerFrame,
    tilesPerRow,
    atlasW: atlas.image.width,
    atlasH: atlas.image.height,
    mip,
    coneSteps: 10,
    reflections: true,
    buffers: {
      voxAlbedo: sba(new Uint32Array(512), 1),
      voxNormal: sba(new Uint32Array(512), 1),
      voxEmissive: sba(new Uint32Array(512), 1),
      voxDirect: sba(new Uint32Array(512), 1),
      radiance: sba(new Float32Array(512 * 4), 4),
      mips: sba(new Float32Array(Math.max(1, mip.mipTexelCount) * 4), 4),
      rays: sba(new Float32Array(probesPerFrame * RAYS_PER_PROBE * 4), 4),
      irradiance: sba(new Float32Array(probeCount * 64 * 4), 4),
      probeScratch: sba(new Float32Array(probeCount * 64 * 4), 4),
      rayDirs: sba(fibonacciDirections(RAYS_PER_PROBE), 4),
      texelDirs: sba(octaTexelDirections(), 4),
    },
    atlas,
    radianceAtlas,
  });
  assert.ok(nodes.injectNode?.isNode, "inject (combine) compute node built");
  assert.ok(nodes.injectDirectNode?.isNode, "cached direct-sun compute node built");
  assert.ok(nodes.traceNode?.isNode, "trace compute node built");
  assert.ok(nodes.integrateNode?.isNode, "integrate compute node built");
  assert.ok(nodes.probeShiftSaveNode?.isNode && nodes.probeShiftApplyNode?.isNode, "probe shift passes built");
  assert.ok(nodes.uniforms.probeShift.value.isVector3, "probe shift uniform exposed");
  assert.equal(nodes.mipPasses.length, mip.levels.length - 1, "one downsample pass per mip level");
  assert.ok(nodes.copyNode?.isNode, "single combined atlas copy pass");
  for (const pass of nodes.mipPasses) assert.ok(pass?.isNode);
  assert.equal(nodes.probeCount, probeCount);
  assert.ok(nodes.createDiffuseSampler()?.isNode, "cone-traced diffuse sampler built");
  assert.ok(nodes.createSpecularSampler()?.isNode, "cone-traced specular sampler built");
  assert.ok(nodes.createFadeNode()?.isNode, "edge fade node built (cascade blend weight)");
  assert.ok(nodes.createDebugColorNode()?.isNode, "probe debug color node built");
  assert.ok(nodes.createGIDebugColorNode()?.isNode, "GI debug color node built");
  assert.ok(nodes.uniforms.sunDir.value.isVector3, "uniforms exposed");
  assert.ok(nodes.uniforms.reflectionIntensity, "reflection intensity uniform exposed");

  // Deferred screen-space pass builds against the volume list headlessly.
  const { createDeferredGI } = await import("../src/modules/gi/giDeferred.js");
  const deferred = createDeferredGI({ width: 320, height: 200, volumes: [{ nodes }] });
  assert.equal(deferred.width, 160, "half-res width");
  assert.equal(deferred.height, 100, "half-res height");
  assert.ok(deferred.passNode?.isNode, "deferred GI compute pass built");
  assert.ok(deferred.giTexture?.isTexture, "GI output texture created");
  assert.ok(deferred.normalMaterial?.isMaterial, "prepass normal material created");
  assert.ok(nodes.coneDiffuseFn && nodes.edgeFadeFn, "raw cone/fade Fns exposed for deferred pass");
  deferred.dispose();

  const light = new GIProbeVolumeLight();
  assert.ok(light.isLight && light.isGIProbeVolumeLight, "GI light is a scene light");
  const lightNode = new GIProbeVolumeLightNode(light);
  assert.ok(lightNode.isAnalyticLightNode, "light node extends AnalyticLightNode");
  console.log("[7] OK: TSL node graph + light node construction");
}

// -- module + component lifecycle on a real engine --
{
  const engine = new Engine();
  assert.ok(!getComponentClass("global-illumination"), "GI component is module-gated");
  const handle = await enableEngineModule(engine, "gi");
  assert.ok(getComponentClass("global-illumination"), "component registered on enable");
  assert.ok(handle.system, "system created");

  const entity = engine.createEntity({ name: "GI Volume" });
  entity.addComponent("global-illumination", { sizeX: 20, sizeY: 10, sizeZ: 20 });
  const comp = entity.getComponent("global-illumination");
  assert.equal(handle.system.component, comp, "component activated the system");
  assert.ok(handle.system._rebuildQueued, "rebuild queued (runs on first rendered tick)");

  comp.setProp("voxelRes", 48);
  assert.ok(handle.system._rebuildQueued, "structural prop queues rebuild");
  comp.setProp("enabled", false);
  assert.equal(handle.system.component, null, "disable deactivates");
  comp.setProp("enabled", true);
  assert.equal(handle.system.component, comp, "re-enable reactivates");

  engine.destroyEntity(entity);
  assert.equal(handle.system.component, null, "destroy deactivates");
  await import("../src/engine/modules.js").then(({ disableEngineModule }) => disableEngineModule(engine, "gi"));
  assert.ok(!getComponentClass("global-illumination"), "component unregistered on disable");
  console.log("[8] OK: module + component lifecycle");
}

console.log("\nAll GI module tests passed.");
