import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createHash } from "node:crypto";
import { createFoliagePrototype, FOLIAGE_SPECIES } from "../src/modules/foliage/foliageGeometry.js";
import { getTreeMotion, growTreeSkeleton, TREE_GROWTH_LIMITS } from "../src/modules/foliage/treeGrowth.js";

for (const species of Object.keys(FOLIAGE_SPECIES)) {
  test(`${species}: deterministic usable geometry with decreasing LOD costs`, () => {
    const geometries = [0, 1, 2].map(lod => createFoliagePrototype({ species, seed: 37 }, lod));
    try {
      const counts = geometries.map(g => g.index.count / 3);
      assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `${species} triangle counts: ${counts}`);
      assert.ok(counts[0] <= 12000, "prototype geometry has a fixed practical budget");
      assert.ok(counts[1] <= 2000, "middle LOD is bounded for large-area use");
      const duplicate = createFoliagePrototype({ species, seed: 37 });
      const variant = createFoliagePrototype({ species, seed: 38 });
      assert.deepEqual(geometries[0].attributes.position.array, duplicate.attributes.position.array);
      assert.notDeepEqual(geometries[0].attributes.position.array, variant.attributes.position.array);
      duplicate.dispose(); variant.dispose();
      for (const geometry of geometries) {
        const n = geometry.attributes.position.count;
        for (const name of ["position", "normal", "color", "uv"]) {
          assert.equal(geometry.attributes[name].count, n, `${name} covers every vertex`);
          assert.ok(geometry.attributes[name].array.every(Number.isFinite), `${name} is finite`);
        }
        assert.ok(geometry.index.array.every(i => i >= 0 && i < n));
        const wind = geometry.attributes.foliageWind ?? geometry.attributes.treeBranchAxis;
        assert.equal(wind.count, n);
        for (let i = 0; i < n; i++) {
          const weight = wind.itemSize === 1 ? wind.getX(i) : wind.getW(i);
          assert.ok(weight >= 0 && weight <= 1);
        }
        assert.ok(geometry.boundingSphere.radius > 0);
        assert.ok(geometry.boundingBox.min.y > -0.02, "prototype is anchored at the ground");
        assert.ok(geometry.boundingBox.max.y > FOLIAGE_SPECIES[species].height * 0.5);
        assert.equal(geometry.groups.length, 0, "one material and draw per LOD batch");
        if (species === "pine") {
          let foliageTop = 0;
          const { position, color } = geometry.attributes;
          for (let i = 0; i < position.count; i++) if (color.getY(i) > color.getX(i)) foliageTop = Math.max(foliageTop, position.getY(i));
          assert.ok(foliageTop >= FOLIAGE_SPECIES.pine.height * 0.98, "needle sprays cover the leader, without an exposed bare top");
        }
      }
      if (species !== "grass" && species !== "wildflowers") {
        const near = geometries[0].boundingBox.getSize(new THREE.Vector3());
        const far = geometries[2].boundingBox.getSize(new THREE.Vector3());
        for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(near[axis] - far[axis]) / near[axis] < 0.25, `${axis} crown silhouette survives LOD`);
      }
    } finally { geometries.forEach(g => g.dispose()); }
  });
}

test("grass dimensions scale root/tip positions independently without changing topology", () => {
  const base = createFoliagePrototype({ species: "grass", seed: 99, height: 1, width: 1 });
  const scaled = createFoliagePrototype({ species: "grass", seed: 99, height: 2, width: 3 });
  assert.equal(base.attributes.position.count, scaled.attributes.position.count);
  for (let i = 0; i < base.attributes.position.array.length; i++) {
    const t = base.attributes.foliageBlade.getW(Math.floor(i / 3));
    if (t > 0 && t < 1) continue; // Intermediate points refit the physical arc.
    const factor = i % 3 === 1 ? 2 : 3;
    assert.ok(Math.abs(base.attributes.position.array[i] * factor - scaled.attributes.position.array[i]) < 1e-6);
  }
  base.dispose(); scaled.dispose();
});

test("rooted grass stays fixed while blade tips carry wind deformation", () => {
  const geometry = createFoliagePrototype({ species: "grass", height: 1 });
  const { position, foliageWind } = geometry.attributes;
  let roots = 0, tips = 0;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) === 0) { assert.equal(foliageWind.getX(i), 0); roots++; }
    if (position.getY(i) > 0.7) { assert.ok(foliageWind.getX(i) > 0.7); tips++; }
  }
  assert.ok(roots > 20 && tips > 10);
  geometry.dispose();
});

test("tree trunk normals point outward and authored colors reach actual vertices", () => {
  const geometry = createFoliagePrototype({ species: "pine", leafColor: "#00ff00", barkColor: "#ff0000" });
  const { position, normal, color } = geometry.attributes;
  // The pine's first vertices are its circular trunk rings; inverted winding
  // makes a sunlit stem shade as if its entire surface faced inward.
  for (let i = 0; i < 8; i++) assert.ok(position.getX(i) * normal.getX(i) + position.getZ(i) * normal.getZ(i) > 0);
  assert.equal(color.getX(0), 1); assert.equal(color.getY(0), 0);
  assert.ok(Array.from({ length: color.count }, (_, i) => color.getY(i)).some(value => value > 0.5));
  geometry.dispose();
});

test("invalid dimensions and LOD cannot produce NaN or unbounded geometry", () => {
  const geometry = createFoliagePrototype({ species: "unknown", height: Infinity, width: -8, seed: NaN }, Infinity);
  assert.equal(geometry.userData.foliage.species, "oak");
  assert.ok(geometry.attributes.position.array.every(Number.isFinite));
  assert.ok(geometry.index.count <= 36000);
  geometry.dispose();
});

test("tree foliage uses small masked compound-leaf cards, never giant opaque diamonds or solid crowns", () => {
  // The first screenshot exposed solid green balls inside the leaf clouds.
  // A near card has two folded quads, showing eighteen small leaf silhouettes
  // via the foliagePart material contract. It must not be a single giant leaf.
  for (const species of ["oak", "birch"]) for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species, leafColor: "#00ff00", barkColor: "#ff0000" }, lod);
    const { position, color } = geometry.attributes;
    const meta = geometry.userData.foliage.tree;
    assert.equal(meta.leavesPerCard, 18);
    assert.ok(meta.leafLengthMeters <= (species === "oak" ? 0.11 : 0.085));
    assert.ok(meta.maximumLeafLengthMeters <= (species === "oak" ? 0.125 : 0.095));
    assert.equal(geometry.attributes.treeLeafAxis.count, position.count);
    const edges = new Map(), neighbors = [];
    const vertexKey = i => `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
    for (let i = 0; i < geometry.index.count; i += 3) {
      const indices = [0, 1, 2].map(offset => geometry.index.getX(i + offset));
      if (!indices.every(index => color.getY(index) > 0 && color.getX(index) === 0)) continue;
      const triangle = neighbors.length; neighbors.push([]);
      for (let edge = 0; edge < 3; edge++) {
        const key = [vertexKey(indices[edge]), vertexKey(indices[(edge + 1) % 3])].sort().join("|");
        const existing = edges.get(key);
        if (existing !== undefined) { neighbors[triangle].push(existing); neighbors[existing].push(triangle); }
        else edges.set(key, triangle);
      }
    }
    const seen = new Set();
    let fragments = 0;
    for (let i = 0; i < neighbors.length; i++) {
      if (seen.has(i)) continue;
      const stack = [i]; let count = 0;
      while (stack.length) {
        const triangle = stack.pop();
        if (seen.has(triangle)) continue;
        seen.add(triangle); count++; stack.push(...neighbors[triangle]);
      }
      assert.equal(count, lod === 0 ? 4 : 2, `${species} LOD${lod} fragment is a folded/flat alpha card`); fragments++;
    }
    assert.ok(fragments > 100);
    geometry.dispose();
  }
});

test("growth is deterministic, spatially searched, bounded and shared across LOD generation", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const props = { species, ...FOLIAGE_SPECIES[species], seed: 53 };
    const skeleton = growTreeSkeleton(props), again = growTreeSkeleton(props);
    assert.equal(skeleton, again, "material/LOD callers reuse one skeleton");
    assert.ok(skeleton.stats.nodes <= TREE_GROWTH_LIMITS.nodes);
    assert.ok(skeleton.stats.iterations <= TREE_GROWTH_LIMITS.iterations);
    assert.equal(skeleton.stats.attractionPoints, TREE_GROWTH_LIMITS.attractionPoints);
    assert.ok(skeleton.stats.consumedAttractors > 100, "branches actually colonize the attraction field");
    assert.ok(skeleton.stats.distanceTests > 0 && skeleton.stats.distanceTests < 4000000, "bounded spatial lookup, not an unbounded recursive model");
    assert.ok(skeleton.nodes.filter(n => n.children.length > 1).length > 30, "crown is a branched skeleton, not disconnected radial sticks");
    for (const node of skeleton.nodes.slice(1)) {
      assert.ok(node.parent >= 0 && node.parent < node.id, "one acyclic rooted topology");
      const parent = skeleton.nodes[node.parent];
      assert.ok(parent.children.includes(node.id));
      assert.ok(parent.radius >= node.radius, "supporting pipe cannot be narrower than its branch");
      assert.ok(node.position.distanceTo(parent.position) > 1e-5);
    }
    const changed = growTreeSkeleton({ ...props, seed: 54 });
    assert.notDeepEqual(skeleton.nodes.map(n => n.position.toArray()), changed.nodes.map(n => n.position.toArray()));
    for (const lod of [0, 1, 2]) {
      const geometry = createFoliagePrototype(props, lod);
      assert.equal(geometry.userData.foliage.tree.nodes, skeleton.stats.nodes);
      assert.equal(geometry.userData.foliage.tree.skeletonSeed, 53);
      geometry.dispose();
    }
  }
});

test("species skeletons preserve oak forks, birch drooping limbs and pine apical whorls", () => {
  const oak = growTreeSkeleton({ species: "oak", height: 8, width: 6, seed: 41 });
  const fork = oak.nodes.find(n => n.scaffold && n.order === 0 && n.children.filter(id => oak.nodes[id].scaffold).length >= 2);
  assert.ok(fork.position.y < 8 * 0.45, "oak divides below its spreading crown");
  const birch = growTreeSkeleton({ species: "birch", height: 9, width: 4, seed: 41 });
  const drooping = birch.nodes.filter(n => n.scaffold && n.order === 1 && !n.children.some(id => birch.nodes[id].scaffold) && n.position.y < birch.nodes[n.parent].position.y);
  assert.ok(drooping.length >= 8, "birch scaffold has hanging distal branches");
  const pine = growTreeSkeleton({ species: "pine", height: 10, width: 4, seed: 41 });
  assert.ok(pine.nodes.some(n => n.scaffold && n.order === 0 && n.position.y === 10), "pine retains its apical leader");
  assert.ok(pine.nodes.filter(n => n.scaffold && n.order === 0 && n.children.filter(id => pine.nodes[id].scaffold && pine.nodes[id].order === 1).length >= 4).length >= 8, "lateral boughs emerge in whorls");
});

test("tree motion follows cached limbs and leaf attachments without altering accepted shapes", () => {
  const expected = {
    oak: ["10a5f178bf589c8a2f5f66306bbdbd36414f0e40d331e392ee57248a7b4d936a", "721aa5705b771ce44df0a60ccfc914c95459ea55b4eda1f152a5f9f6a021637e", "6c2ee094878220f81e9b8ae062ba3d8f21f1a261e15c53a8e3d6ecc36cb9ddbf"],
    birch: ["38de2dbbfcb39d0d2f5ff541d4fb972ff04087729101a60aa5a38d2890d69ceb", "94e93f186f6f9aa655a268c19c7d58cbac62109f5cd87054588ac2b7305d3c54", "a95e5169d7106e627da1f765e8451188075fc95f20907708ee69a8a605a7bcd3"],
    pine: ["91a31a5e526432b76cacee0f13746f3ea655d9a2840b8955a0f31ba3ea1f7819", "df7e4509322849460669904cdb8488a770b78992799b2e0a5f275d7495ca88d1", "b154ecabe1ecb3a4ff988173f6a77f638885fdfae615182acafccb31851c9a53"],
  };
  for (const species of ["oak", "birch", "pine"]) {
    const options = { ...FOLIAGE_SPECIES[species], species, seed: 37 }, skeleton = growTreeSkeleton(options), motion = getTreeMotion(skeleton);
    assert.equal(getTreeMotion(skeleton), motion, "no repeated hierarchy work when building another LOD");
    assert.ok(motion.limbs.length >= 4);
    for (const node of skeleton.nodes) {
      const m = motion.nodes[node.id];
      assert.ok(m.flex >= 0 && m.flex <= 1);
      assert.ok(Math.abs(m.axis.length() - 1) < 1e-6);
      if (m.limb < 0) assert.equal(m.flex, 0, "trunk has no secondary limb rotation");
      else {
        assert.ok(m.pivot.distanceTo(skeleton.nodes[skeleton.nodes[m.limb].parent].renderPosition) < 1e-9, "pivot is a real supporting joint");
        const parent = motion.nodes[node.parent];
        if (m.limb === parent.limb) {
          assert.equal(m.axis, parent.axis); assert.equal(m.pivot, parent.pivot);
          assert.ok(m.flex >= parent.flex, "limb flexibility increases continuously away from its attachment");
        }
      }
    }
    const nearCards = new Map();
    for (const lod of [0, 1, 2]) {
      const geometry = createFoliagePrototype(options, lod), attrs = geometry.attributes, n = attrs.position.count;
      const packed = [attrs.treeBranch, attrs.treeBranchAxis, attrs.treeLeaf, attrs.treeLeafAxis];
      assert.ok(packed.every(a => a.isInterleavedBufferAttribute && a.data === packed[0].data && a.count === n));
      assert.ok(packed[0].data.array.every(Number.isFinite));
      assert.equal(Object.keys(attrs).length + 8, 16, "both matrix attribute inputs fit portable WebGPU");
      assert.equal(new Set(Object.values(attrs).map(a => a.data ?? a)).size + 2, 7, "both matrix buffers fit portable WebGPU");
      const hash = createHash("sha256");
      for (const key of ["position", "color", "uv", "foliageWind", "normal", "foliagePart"]) {
        const array = key === "foliageWind" ? Float32Array.from({ length: n }, (_, i) => attrs.treeBranchAxis.getW(i)) : key === "foliagePart" ? Float32Array.from({ length: n }, (_, i) => attrs.treeLeafAxis.getW(i)) : attrs[key].array;
        hash.update(key); hash.update(Buffer.from(array.buffer));
      }
      hash.update(Buffer.from(geometry.index.array.buffer));
      assert.equal(hash.digest("hex"), expected[species][lod], "positions, normals, colors, UVs, wind weights and topology remain exact");
      const cardVertices = lod === 0 && species !== "pine" ? 6 : 4;
      for (let i = 0; i < n;) {
        if (attrs.treeLeafAxis.getW(i) === 0) { i++; continue; }
        const values = packed.map(a => [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)]);
        const key = values[2].join(",");
        for (let j = 1; j < cardVertices; j++) for (const a of packed) {
          for (const field of ["getX", "getY", "getZ"]) assert.equal(a[field](i + j), a[field](i), "card shares one pivot, axis and branch transform");
        }
        if (lod === 0) nearCards.set(key, [...values[0], ...values[1].slice(0, 3), ...values[3]]);
        else assert.deepEqual([...values[0], ...values[1].slice(0, 3), ...values[3]], nearCards.get(key), "retained LOD cards keep their branch and flutter phase");
        i += cardVertices;
      }
      geometry.dispose();
    }
  }
});

test("meadow motion metadata shares one portable buffer and pins roots", () => {
  for (const species of ["grass", "wildflowers"]) for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species, seed: 37 }, lod);
    const { position, foliageBlade, foliageCurve } = geometry.attributes;
    assert.equal(foliageBlade.count, position.count); assert.equal(foliageBlade.itemSize, 4);
    assert.equal(foliageCurve.data, foliageBlade.data);
    assert.ok(foliageBlade.array.every(Number.isFinite));
    assert.equal(Object.keys(geometry.attributes).length + 8, 15);
    assert.equal(new Set(Object.values(geometry.attributes).map(a => a.data ?? a)).size + 2, 8);
    let roots = 0, tips = 0;
    for (let i = 0; i < position.count; i++) {
      assert.ok(foliageBlade.getZ(i) > 0);
      if (position.getY(i) === 0) { assert.equal(foliageBlade.getW(i), 0); roots++; }
      if (foliageBlade.getW(i) > 0.99) tips++;
    }
    assert.ok(roots > 2 && tips > 2);
    geometry.dispose();
  }
});

test("grass rest arcs retain accepted roots/tips, widths, colors and topology", () => {
  const expected = ["a4bae33ca85a4f3ecd72c5a3ca4e0ae1c41df2e28be2f802964283d7c6e18796", "4adea9eb6a32f00296485effbdbeef1f8a2713da65ef67d6b42412a647d0f19a", "42d20f7ea02aef37385ece0d362e41edb9e20a9a45fc33b4256c80f66fe5a3b5"];
  for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species: "grass", seed: 37 }, lod), hash = createHash("sha256");
    const { position, foliageBlade: blade, foliageCurve: curve } = geometry.attributes, ends = [];
    for (const key of ["color", "uv"]) { hash.update(key); hash.update(Buffer.from(geometry.attributes[key].array.buffer)); }
    hash.update(Buffer.from(geometry.index.array.buffer));
    for (let i = 0; i < position.count; i++) {
      const angle = curve.getZ(i), t = blade.getW(i), radius = blade.getZ(i) / angle;
      const root = new THREE.Vector3(blade.getX(i), 0, blade.getY(i)), direction = new THREE.Vector3(curve.getX(i), 0, curve.getY(i));
      const side = new THREE.Vector3(-direction.z, 0, direction.x);
      const rest = root.addScaledVector(direction, radius * (1 - Math.cos(angle * t))).addScaledVector(side, curve.getW(i));
      rest.y = radius * Math.sin(angle * t);
      const original = new THREE.Vector3().fromBufferAttribute(position, i);
      assert.ok(rest.distanceTo(original) < 1e-6, "shader rest-arc reconstruction agrees with the actual mesh");
      if (t === 0 || t === 1) ends.push(original.x, original.y, original.z);
    }
    hash.update(Buffer.from(new Float32Array(ends).buffer)); assert.equal(hash.digest("hex"), expected[lod]);
    assert.ok(geometry.userData.foliage.maxRestFitDisplacementMeters <= .04, "approved rest fit stays within four centimetres at default size");
    geometry.dispose();
  }
});

test("flowers keep accepted head geometry with rigid attachment weights and flexible stem rings", () => {
  const expected = ["fbbe739dc095d9740ccd708652bef8786e6aa22f8ce225f30afb8c6ee8eed6ff", "99018b2bdfff0b3a60f4228682bcee8516ba6c37a723b1c89f9a7f7e724aa0b7", "17f923a06823ad1028549ccb49fc0119c79cd49ed779e4fee904bb97274cbf09"];
  for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species: "wildflowers", seed: 37 }, lod), attrs = geometry.attributes, hash = createHash("sha256"), stemRings = new Set();
    for (const key of ["position", "color", "uv"]) {
      const a = attrs[key], values = [];
      for (let i = 0; i < a.count; i++) if (attrs.color.getX(i) > attrs.color.getY(i)) {
        for (let j = 0; j < a.itemSize; j++) values.push(a.array[i * a.itemSize + j]);
        assert.equal(attrs.foliageBlade.getW(i), 1, "every head vertex inherits one whole stem-tip transform");
        assert.equal(attrs.foliageCurve.getZ(i), -1);
      }
      hash.update(key); hash.update(Buffer.from(new Float32Array(values).buffer));
    }
    assert.equal(hash.digest("hex"), expected[lod]);
    for (let i = 0; i < attrs.position.count; i++) if (attrs.foliageCurve.getZ(i) === -1) {
      const t = attrs.foliageBlade.getW(i);
      if (attrs.uv.getY(i) === t) stemRings.add(t);
      assert.ok(Math.hypot(attrs.foliageCurve.getX(i), attrs.foliageCurve.getY(i)) < .2, "tilted stem axis is encoded rather than a horizontal blade direction");
    }
    assert.ok(stemRings.size >= [5, 3, 2][lod]);
    geometry.dispose();
  }
});
