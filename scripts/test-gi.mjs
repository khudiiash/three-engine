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
  computeAutoClipmapLayout,
} from "../src/modules/gi/index.js";
import {
  createGINodes,
  computeMipLevels,
  GIProbeVolumeLight,
  GIProbeVolumeLightNode,
  MIP_GAP,
  MAX_LOCAL_LIGHTS,
} from "../src/modules/gi/giCompute.js";
import { uniform, texture, vec2, vec3 } from "three/tsl";
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

  // Virtual Geometry keeps a worst-case index-buffer capacity and publishes
  // only the current cluster cut through drawRange. GI must consume that cut,
  // not the zero-filled tail or full-resolution capacity.
  const cutScene = new THREE.Scene();
  const cutGeometry = new THREE.BoxGeometry(2, 2, 2);
  cutGeometry.setDrawRange(0, 6); // two of the box's twelve triangles
  cutScene.add(new THREE.Mesh(cutGeometry, new THREE.MeshStandardMaterial()));
  cutScene.updateMatrixWorld(true);
  const cutResult = voxelizeScene(cutScene, grid);
  assert.equal(cutResult.tris, 2, "voxelizer respects active drawRange / virtual-geometry cut");
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
  const mixedEditorLayer = mk();
  mixedEditorLayer.layers.enable(31);
  assert.ok(!isVoxelizableMesh(mixedEditorLayer), "editor layer excluded even when layer 0 is also enabled");

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
  const editorScene = new THREE.Scene();
  const editorRoot = new THREE.Group();
  editorRoot.userData.editorOnly = true;
  editorRoot.add(mk());
  editorScene.add(editorRoot);
  editorScene.updateMatrixWorld(true);
  assert.equal(
    voxelizeScene(editorScene, gridV).meshes,
    0,
    "editor-only root prunes untagged gizmo descendants",
  );
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

// -- automatic camera clipmaps: projection coverage without size props --
{
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const layouts = computeAutoClipmapLayout(camera);
  assert.equal(layouts.length, 3, "editor far range is capped to three useful GI cascades");
  assert.ok(layouts[0].reach <= 12, "inner cascade keeps fine near-camera detail");
  assert.ok(layouts.at(-1).reach >= 128, "outer cascade reaches the useful GI range");
  assert.ok(
    layouts.every((layout) => layout.forwardOffset === 0),
    "clipmaps stay camera-position centered so view rotation cannot recenter them",
  );
  for (let i = 1; i < layouts.length; i++) {
    assert.equal(layouts[i].scale, layouts[i - 1].scale * 4, "clipmap scale grows 4x");
    assert.equal(layouts[i].reach, layouts[i - 1].reach * 4, "coverage grows 4x");
  }
  assert.ok(layouts.every((l) => l.size.x === l.size.y && l.size.y === l.size.z), "rotation-independent cube coverage");
  console.log("[4b] OK: automatic camera clipmap layout");
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

  // One huge triangle used to monopolize a frame because the async worker
  // yielded only between triangles. Confirm the inner lattice loop lets the
  // event loop run before the job completes.
  const hugeScene = new THREE.Scene();
  const hugeGeometry = new THREE.BufferGeometry();
  hugeGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-256, 0, -256, 256, 0, -256, -256, 0, 256],
      3,
    ),
  );
  hugeScene.add(new THREE.Mesh(hugeGeometry, new THREE.MeshStandardMaterial()));
  hugeScene.updateMatrixWorld(true);
  const hugeGrid = computeGrid(
    new THREE.Vector3(),
    new THREE.Vector3(512, 1, 512),
    512,
  );
  const hugeTarget = {
    albedo: new Uint32Array(hugeGrid.count),
    normal: new Uint32Array(hugeGrid.count),
    emissive: new Uint32Array(hugeGrid.count),
  };
  let eventLoopProgressed = false;
  setTimeout(() => {
    eventLoopProgressed = true;
  }, 0);
  await voxelizeRegionAsync(
    hugeScene,
    hugeGrid,
    hugeTarget,
    {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: hugeGrid.dims.x,
      y1: hugeGrid.dims.y,
      z1: hugeGrid.dims.z,
    },
    { timeSliceMs: 1 },
  );
  assert.ok(eventLoopProgressed, "large-triangle raster yields inside its lattice loop");

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
  assert.equal(
    mip.levels[2].bufOffset,
    32 * 16 * 32 * 6,
    "levels ≥ 1 store six anisotropic direction bins back to back",
  );
  assert.equal(mip.levels[1].count, 32 * 16 * 32, "per-level texel count");
  assert.equal(mip.levels[0].bins, 1, "level 0 is isotropic");
  assert.equal(mip.levels[1].bins, 6, "levels ≥ 1 are anisotropic");
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
  // Mirror GISystem's packed probeData layout (one storage buffer holds rays,
  // irradiance, visibility moments, shift scratch, and direction tables).
  const probeLayout = (() => {
    const texelCount = probeCount * OCTA_RES * OCTA_RES;
    const rays = 0;
    const irradiance = rays + probesPerFrame * RAYS_PER_PROBE;
    const visibility = irradiance + texelCount;
    const irradianceScratch = visibility + texelCount;
    const visibilityScratch = irradianceScratch + texelCount;
    const rayDirs = visibilityScratch + texelCount;
    const texelDirs = rayDirs + RAYS_PER_PROBE;
    return {
      rays,
      irradiance,
      visibility,
      irradianceScratch,
      visibilityScratch,
      rayDirs,
      texelDirs,
      total: texelDirs + OCTA_RES * OCTA_RES,
    };
  })();
  const probeArray = new Float32Array(probeLayout.total * 4);
  probeArray.set(fibonacciDirections(RAYS_PER_PROBE), probeLayout.rayDirs * 4);
  probeArray.set(octaTexelDirections(), probeLayout.texelDirs * 4);
  const buffers = {
    voxAlbedo: sba(new Uint32Array(512), 1),
    voxNormal: sba(new Uint32Array(512), 1),
    voxEmissive: sba(new Uint32Array(512), 1),
    voxDirect: sba(new Uint32Array(512), 1),
    voxDirectStaging: sba(new Uint32Array(512), 1),
    voxEmissiveDirect: sba(new Uint32Array(512), 1),
    voxEmissiveDirectStaging: sba(new Uint32Array(512), 1),
    radiance: sba(new Float32Array(512 * 4), 4),
    mips: sba(new Float32Array(Math.max(1, mip.mipTexelCount) * 4), 4),
    probeData: sba(probeArray, 4),
    lightData: sba(new Float32Array(MAX_LOCAL_LIGHTS * 5 * 4), 4),
  };
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
    buffers,
    probeLayout,
    atlas,
    radianceAtlas,
  });
  assert.ok(nodes.injectNode?.isNode, "inject (combine) compute node built");
  assert.ok(nodes.injectDirectNode?.isNode, "cached direct-sun compute node built");
  assert.ok(nodes.publishDirectNode?.isNode, "atomic direct-cache publish node built");
  assert.ok(
    nodes.blendEmissiveDirectNode?.isNode,
    "temporal emissive receiver-cache blend node built",
  );
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

  const rayNodes = createGINodes({
    dims,
    counts,
    probesPerFrame,
    tilesPerRow,
    atlasW: atlas.image.width,
    atlasH: atlas.image.height,
    mip,
    coneSteps: 10,
    reflections: false,
    buffers: {
      ...buffers,
      rayData: sba(new Float32Array(64 * 4), 4),
    },
    probeLayout,
    rayTracing: true,
    rayDataCapacity: 64,
    atlas,
    radianceAtlas,
  });
  assert.ok(rayNodes.traceNode?.isNode, "triangle/voxel A/B probe trace graph built");
  assert.ok(rayNodes.uniforms.rayTracingEnabled, "triangle trace A/B uniform exposed");
  assert.ok(rayNodes.uniforms.rayTlasNodeCount, "triangle trace TLAS uniforms exposed");

  // Deferred screen-space pass builds against the volume list headlessly.
  const { createDeferredGI, createDeferredGISampler } = await import("../src/modules/gi/giDeferred.js");
  const deferred = createDeferredGI({ width: 320, height: 200, volumes: [{ nodes }] });
  assert.equal(deferred.width, 160, "half-res width");
  assert.equal(deferred.height, 100, "half-res height");
  assert.ok(deferred.passNode?.isNode, "deferred GI compute pass built");
  assert.ok(deferred.resolveNode?.isNode, "deterministic spatial resolve pass built");
  assert.ok(deferred.giTexture?.isTexture, "GI output texture created");
  assert.ok(deferred.rawTexture?.isTexture, "raw GI texture created");
  assert.ok(deferred.normalMaterial?.isMaterial, "prepass normal material created");
  assert.ok(
    nodes.probeDiffuseFn && nodes.coneDiffuseFn && nodes.edgeFadeFn,
    "world-probe final gather plus cone/fade detail Fns exposed",
  );
  const deferredSampler = createDeferredGISampler({
    giTextureNode: texture(deferred.giTexture),
    depthTextureNode: texture(deferred.gbuffer.depthTexture),
    normalTextureNode: texture(deferred.gbuffer.texture),
    uniforms: deferred.uniforms,
  });
  assert.ok(
    deferredSampler(vec3(0), vec3(0, 1, 0), vec2(0.5)).isNode,
    "edge-aware deferred reconstruction node built",
  );

  // Live JFA SDF + material-space distance-field sun-shadow graph. This
  // catches JS-level construction errors; WGSL validity is runtime-only.
  const { createSDFNodes } = await import("../src/modules/gi/sdfField.js");
  const { createSunShadowNode } = await import("../src/modules/gi/dfShadows.js");
  const shadowDims = { x: 8, y: 8, z: 8 };
  const shadowCount = 8 * 8 * 8;
  const shadowBuffers = {
    voxAlbedo: sba(new Uint32Array(shadowCount), 1),
    sdfSeedA: sba(new Float32Array(shadowCount * 4), 4),
    sdfSeedB: sba(new Float32Array(shadowCount * 4), 4),
  };
  const sdfTexture = new THREE.Storage3DTexture(8, 8, 8);
  sdfTexture.type = THREE.HalfFloatType;
  const sdfNodes = createSDFNodes({
    dims: shadowDims,
    buffers: shadowBuffers,
    sdfTexture,
  });
  assert.ok(sdfNodes.seedNode?.isNode, "JFA seed pass built");
  assert.ok(sdfNodes.jumpNodes.length >= 2, "JFA jump sequence built");
  for (const pass of sdfNodes.jumpNodes) assert.ok(pass?.isNode);
  assert.ok(sdfNodes.publishNode?.isNode, "SDF publish pass built");
  const shadowVolume = {
    grid: { dims: shadowDims, count: shadowCount },
    nodes: {
      uniforms: {
        gridMin: uniform(new THREE.Vector3(-2, -2, -2)),
        voxelSize: uniform(0.5),
      },
    },
    buffers: shadowBuffers,
    sdfTexture,
  };
  const sunShadow = createSunShadowNode({
    volumes: [shadowVolume, shadowVolume],
    readyUniform: uniform(0),
  });
  assert.ok(sunShadow.node?.isNode, "material-space DF sun-shadow node built");
  assert.ok(sunShadow.uniforms.sunDirToLight.value.isVector3, "sun direction uniform exposed");
  assert.ok(sunShadow.uniforms.softness && sunShadow.uniforms.maxDistance, "softness/range uniforms exposed");
  sdfTexture.dispose();
  deferred.dispose();

  const light = new GIProbeVolumeLight();
  assert.ok(light.isLight && light.isGIProbeVolumeLight, "GI light is a scene light");
  const lightNode = new GIProbeVolumeLightNode(light);
  assert.ok(lightNode.isAnalyticLightNode, "light node extends AnalyticLightNode");
  console.log("[7] OK: TSL node graph + light node construction");
}

// -- GPU dynamic layer: triangle pool extraction + splat/copy node construction --
{
  const { DynamicVoxelPool, createDynamicVoxelNodes, VEC4S_PER_TRI, DYNAMIC_TRI_CAPACITY, DYNAMIC_TRI_PER_MESH, MAX_DYNAMIC_MESHES } =
    await import("../src/modules/gi/gpuVoxelizer.js");
  const { uniform: makeUniform } = await import("three/tsl");

  const pool = new DynamicVoxelPool();
  assert.equal(pool.count, 0, "pool starts empty");
  assert.equal(pool.sync([]), false, "empty→empty sync is a no-op");

  const red = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0x00ff00, emissiveIntensity: 4 }),
  );
  red.position.set(3, 0, 0);
  const blue = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1).toNonIndexed(),
    new THREE.MeshStandardMaterial({ color: 0x0000ff }),
  );
  assert.equal(pool.sync([red, blue]), true, "set change rebuilds");
  assert.equal(pool.count, 24, "12 indexed + 12 non-indexed triangles");
  assert.equal(pool.triCountU.value, 24, "GPU tri-count uniform tracks the pool");
  assert.equal(pool.meshes.length, 2);

  // Record layout: v0 in OBJECT space (matrix applied on GPU), mesh index in
  // v0.w, albedo in record 3, pre-scaled emissive in record 4.
  const arr = pool.triangles.array;
  assert.equal(arr[3], 0, "first mesh index 0");
  const stride = VEC4S_PER_TRI * 4;
  assert.equal(arr[12 * stride + 3], 1, "second mesh's triangles carry index 1");
  assert.equal(arr[12], 1, "albedo.r red");
  assert.equal(arr[14], 0, "albedo.b zero for red mesh");
  assert.equal(arr[17], Math.min(1, 4 / 8), "emissive green = intensity/EMISSIVE_SCALE");
  assert.equal(arr[12 * stride + 14], 1, "second mesh albedo.b blue");
  // Object-space corners of a 2×2×2 box are at ±1 regardless of the world position.
  assert.ok(Math.abs(Math.abs(arr[0]) - 1) < 1e-6, "v0 stored in object space");

  assert.equal(pool.sync([red, blue]), false, "same set + same geometry versions → no rebuild");
  red.geometry.getAttribute("position").version++;
  assert.equal(pool.sync([red, blue]), true, "geometry edit (version bump) rebuilds");

  const cutPool = new DynamicVoxelPool();
  const cutMesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial(),
  );
  cutMesh.geometry.setDrawRange(0, 6);
  cutPool.sync([cutMesh]);
  assert.equal(cutPool.count, 2, "dynamic pool respects virtual-geometry drawRange");
  cutMesh.geometry.setDrawRange(0, 12);
  cutPool.sync([cutMesh]);
  assert.equal(cutPool.count, 4, "drawRange change invalidates dynamic-pool extraction");

  // Matrices upload world transforms and refresh world AABBs.
  red.updateMatrixWorld(true);
  pool.updateMatrices();
  assert.equal(pool.matrices.array[12], 3, "world translation lands in the matrix table");
  assert.ok(Math.abs(pool.boxes[0].min.x - 2) < 1e-6, "world AABB follows the transform");
  assert.ok(Math.abs(pool.maxDims[0] - 2) < 1e-6, "largest world axis recorded (sub-voxel gating)");

  // Capacity: an oversized mesh is stride-decimated to fit its per-mesh
  // budget (never dropped — dropping made detailed movers vanish from GI
  // during motion), while small meshes stay fully represented.
  const huge = new THREE.Mesh(
    new THREE.SphereGeometry(1, 256, 256),
    new THREE.MeshStandardMaterial(),
  );
  const hugeTris = huge.geometry.index.count / 3;
  assert.ok(hugeTris > DYNAMIC_TRI_CAPACITY, "test sphere exceeds pool capacity");
  pool.sync([red, huge, blue]);
  assert.equal(pool.meshes.length, 3, "oversized mesh kept (subsampled), not dropped");
  assert.ok(pool.meshes.includes(huge), "the oversized mesh is in the pool");
  assert.ok(pool.count <= DYNAMIC_TRI_CAPACITY, "pool never exceeds capacity");
  const hugeContribution = pool.count - 24; // red + blue contribute 24
  assert.ok(
    hugeContribution > 0 && hugeContribution <= DYNAMIC_TRI_PER_MESH,
    "oversized mesh decimated into its per-mesh budget",
  );
  assert.ok(pool.meshes.length <= MAX_DYNAMIC_MESHES);

  // Per-volume compose passes build headlessly against shared pool nodes.
  const dims = { x: 8, y: 8, z: 8 };
  const sba1 = () => new THREE.StorageBufferAttribute(new Uint32Array(512), 1);
  const dynNodes = createDynamicVoxelNodes({
    dims,
    gridMin: makeUniform(new THREE.Vector3(0, 0, 0)),
    voxelSize: makeUniform(0.5),
    buffers: {
      voxAlbedo: sba1(),
      voxNormal: sba1(),
      voxEmissive: sba1(),
      voxStaticAlbedo: sba1(),
      voxStaticNormal: sba1(),
      voxStaticEmissive: sba1(),
    },
    pool,
  });
  assert.ok(dynNodes.copyNode?.isNode, "static→live copy pass built");
  assert.ok(dynNodes.splatNode?.isNode, "dynamic triangle splat pass built");
  console.log("[7b] OK: GPU dynamic layer (pool extraction + compose passes)");
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
  assert.ok(
    !comp.constructor.schema.some((field) => ["sizeX", "sizeY", "sizeZ", "followCamera"].includes(field.key)),
    "manual volume/follow fields removed from the inspector schema",
  );
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
