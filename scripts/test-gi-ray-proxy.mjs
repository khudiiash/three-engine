globalThis.document ??= { body: {} };

const assert = (await import("node:assert/strict")).default;
const THREE = await import("three/webgpu");
const {
  TriangleRayScene,
  buildRayProxyAsset,
  hashRayProxySource,
  RAY_PROXY_MAX_TRIANGLES,
} = await import("../src/modules/gi/rayProxy.js");
const {
  buildClusterDAG,
  getCoarsestClusterIndices,
} = await import("../src/modules/virtual-geometry/clusterBuilder.js");

const close = (actual, expected, epsilon = 1e-4, message = "") =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message} expected ${expected}, got ${actual}`,
  );

console.log("[1] threaded BLAS/TLAS rays match brute force");
{
  const scene = new THREE.Scene();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardMaterial(),
  );
  floor.rotation.x = -Math.PI / 2;
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardMaterial(),
  );
  wall.position.x = 5;
  wall.rotation.y = -Math.PI / 2;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 1),
    new THREE.MeshStandardMaterial(),
  );
  box.position.set(-2, 1, 1);
  box.rotation.y = 0.43;
  box.scale.set(1.5, 1, 0.7);
  scene.add(floor, wall, box);
  scene.updateMatrixWorld(true);

  const rays = new TriangleRayScene();
  const built = await rays.rebuild(scene);
  assert.equal(built.instances, 3);

  const down = rays.traceRay(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
  );
  assert.ok(down);
  close(down.distance, 1, 1e-4, "down ray");

  const toWall = rays.traceRay(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0),
  );
  assert.ok(toWall);
  close(toWall.distance, 5, 1e-4, "wall ray");

  let seed = 912367;
  const random = () => {
    seed = Math.imul(seed, 1664525) + 1013904223;
    return (seed >>> 0) / 4294967296;
  };
  for (let index = 0; index < 300; index++) {
    const origin = new THREE.Vector3(
      (random() - 0.5) * 16,
      random() * 8 + 0.1,
      (random() - 0.5) * 16,
    );
    const direction = new THREE.Vector3(
      random() - 0.5,
      random() - 0.5,
      random() - 0.5,
    ).normalize();
    const threaded = rays.traceRay(origin, direction);
    const brute = rays.traceRayBruteForce(origin, direction);
    assert.equal(!!threaded, !!brute, `ray ${index} hit/miss mismatch`);
    if (threaded) close(threaded.distance, brute.distance, 1e-4, `ray ${index}`);
  }

  const packed = rays.packGPUData();
  assert.equal(packed.data.length, packed.layout.totalVec4s * 4);
  assert.equal(packed.layout.instances.stride, 5);
}

console.log("[2] rigid movers update through TLAS refit");
{
  const scene = new THREE.Scene();
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  cube.position.set(2, 0, 0);
  cube.rotation.y = 0.35;
  cube.scale.set(2, 1, 0.5);
  scene.add(cube);
  scene.updateMatrixWorld(true);

  const rays = new TriangleRayScene();
  await rays.rebuild(scene);
  const first = rays.traceRay(
    new THREE.Vector3(2, 4, 0),
    new THREE.Vector3(0, -1, 0),
  );
  assert.ok(first);
  close(first.distance, 3.5, 1e-4, "initial mover ray");

  cube.position.x = 6;
  scene.updateMatrixWorld(true);
  assert.equal(rays.refit(), true);
  assert.equal(
    rays.traceRay(
      new THREE.Vector3(2, 4, 0),
      new THREE.Vector3(0, -1, 0),
    ),
    null,
    "old position must be empty after refit",
  );
  const moved = rays.traceRay(
    new THREE.Vector3(6, 4, 0),
    new THREE.Vector3(0, -1, 0),
  );
  assert.ok(moved);
  close(moved.distance, 3.5, 1e-4, "moved ray");
}

console.log("[3] topology-preserving meshopt proxy and asset cache");
{
  const dense = new THREE.PlaneGeometry(20, 20, 64, 64);
  const positions = new Float32Array(dense.getAttribute("position").array);
  const indices = new Uint32Array(dense.index.array);
  const proxy = await buildRayProxyAsset({ positions, indices });
  assert.equal(proxy.sourceHash, hashRayProxySource(positions, indices));
  assert.ok(proxy.triangles > 0);
  assert.ok(proxy.triangles <= RAY_PROXY_MAX_TRIANGLES);
  assert.ok(proxy.triangles < indices.length / 3);

  dense.userData.giRayProxy = proxy;
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(dense, new THREE.MeshStandardMaterial()));
  scene.updateMatrixWorld(true);
  const rays = new TriangleRayScene();
  await rays.rebuild(scene);
  assert.equal(rays.stats.sources["asset-cache"], 1);
}

console.log("[4] Virtual Geometry coarsest roots form a complete proxy cut");
{
  const geometry = new THREE.SphereGeometry(2, 64, 32);
  const positions = new Float32Array(geometry.getAttribute("position").array);
  const normals = new Float32Array(geometry.getAttribute("normal").array);
  const uvs = new Float32Array(geometry.getAttribute("uv").array);
  const indices = new Uint32Array(geometry.index.array);
  const dag = await buildClusterDAG({ positions, normals, uvs, indices });
  const coarsest = getCoarsestClusterIndices(dag);
  assert.ok(coarsest.length > 0);
  assert.equal(coarsest.length % 3, 0);
  assert.ok(coarsest.length <= indices.length);
}

console.log("GI_RAY_PROXY_TESTS_OK");
