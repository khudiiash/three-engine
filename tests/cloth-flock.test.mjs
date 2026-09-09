import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeClothTopologies, uniformScaleOf, flockKey } from '../src/engine/vfx/clothFlock.js';
import { SPRING_END, SPRING_THICKNESS } from '../src/engine/vfx/clothMeshTopology.js';

/**
 * A two-particle cloth: particle 0 pinned, particle 1 hanging, one spring each
 * way, packed at stride 2 with a sentinel tail.
 */
function fixture({ stride = 2, lra = true } = {}) {
  const count = 2;
  const rest = Float32Array.from([0, 1, 0, 1, 0, 0, 0, 0]);
  const springs = new Float32Array(count * stride * 4).fill(0);
  springs[0] = 1; springs[1] = 1; springs[2] = 0; springs[3] = SPRING_END;      // 0 -> 1, len 1
  for (let s = 1; s < stride; s++) springs[s * 4] = SPRING_END;
  const b = stride * 4;
  springs[b] = 0; springs[b + 1] = 1; springs[b + 2] = 0; springs[b + 3] = SPRING_THICKNESS;
  for (let s = 1; s < stride; s++) springs[b + s * 4] = SPRING_END;
  return {
    count, stride, rest, springs,
    lra: lra ? Float32Array.from([0, 1, 0, 0, 0, 1, 0, 1]) : null,
    contactRadius: Float32Array.from([0.01, 0.01]),
    shellThickness: 0.02,
  };
}

test('neighbour indices are rebased so a member never reaches into another cloth', () => {
  const t = fixture();
  const { topology, ranges } = mergeClothTopologies([{ topology: t }, { topology: t }]);
  assert.equal(topology.count, 4);
  assert.deepEqual(ranges.map((r) => r.base), [0, 2]);

  // Cloth 0 keeps 0/1; cloth 1 must point at 2/3 and NOTHING at 0/1.
  assert.equal(topology.springs[0], 1);
  const second = 2 * topology.stride * 4;
  assert.equal(topology.springs[second], 3, 'particle 2 springs to particle 3, not particle 1');
  assert.equal(topology.springs[second + topology.stride * 4], 2);
  for (let v = 2; v < 4; v++) {
    for (let s = 0; s < topology.stride; s++) {
      const n = topology.springs[(v * topology.stride + s) * 4];
      if (n === SPRING_END) continue;
      assert.ok(n >= 2, `particle ${v} slot ${s} reaches back into cloth 0`);
    }
  }
});

test('every unused slot carries the sentinel, including a member packed at a smaller stride', () => {
  const narrow = fixture({ stride: 2 });
  const wide = fixture({ stride: 5 });
  const { topology } = mergeClothTopologies([{ topology: wide }, { topology: narrow }]);
  assert.equal(topology.stride, 5, 'the flock takes the widest stride');
  // ⛔ A zero-filled slot reads as a spring to particle 0 with rest length 0.
  for (let v = 0; v < topology.count; v++) {
    for (let s = 0; s < topology.stride; s++) {
      const o = (v * topology.stride + s) * 4;
      const n = topology.springs[o];
      assert.ok(n === SPRING_END || n >= 0, `particle ${v} slot ${s} is neither a spring nor the sentinel`);
      if (n === SPRING_END) continue;
      assert.ok(topology.springs[o + 1] > 0, `particle ${v} slot ${s} is a live spring of rest length 0`);
    }
  }
  // The narrow member's own springs survived the re-pack at the wider stride.
  const base = wide.count;
  assert.equal(topology.springs[(base * topology.stride) * 4], base + 1);
});

test('a member matrix moves its rest pose and scales every length with it', () => {
  const t = fixture();
  // Column-major: uniform scale 2, translated by (10, 0, 0).
  const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1];
  const { topology, ranges } = mergeClothTopologies([{ topology: t }, { topology: t, matrix: m }]);
  assert.equal(ranges[1].scale, 2);

  assert.equal(topology.rest[2 * 4], 10, 'the member is placed by its matrix');
  assert.equal(topology.rest[2 * 4 + 1], 2);
  assert.equal(topology.rest[2 * 4 + 3], 1, 'and the pin flag is not treated as a length');

  const second = 2 * topology.stride * 4;
  assert.equal(topology.springs[second + 1], 2, 'a rest length IS a length and scales');
  assert.equal(topology.lra[2 * 4 + 3], 0, 'a zero fabric run stays zero');
  assert.equal(topology.lra[3 * 4 + 3], 2, 'and a real one scales');
  assert.equal(topology.lra[3 * 4], 10, 'the pin the run measures from moves too');
  assert.ok(Math.abs(topology.contactRadius[2] - 0.02) < 1e-7, 'a contact radius is a length too');
});

test('the spring family and the thickness sentinel survive the merge', () => {
  const t = fixture();
  const { topology } = mergeClothTopologies([{ topology: t }, { topology: t }]);
  const second = (3 * topology.stride) * 4;   // cloth 1, particle 1
  assert.equal(topology.springs[second + 3], SPRING_THICKNESS,
    'a thickness spring that stops being one is a shell that collapses');
});

/**
 * ⛔⛔ The fan successor is a PARTICLE INDEX, not a slot. The surface kernel
 * closes a triangle with `positions.element(spring.w)`, and the shell rebuild
 * displaces the vertex along the normal that builds — so an unrebased successor
 * moves the geometry, not just its shading.
 */
test('the fan successor is rebased like any other particle index', () => {
  const count = 3, stride = 2;
  const rest = Float32Array.from([0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0]);
  const springs = new Float32Array(count * stride * 4).fill(SPRING_END);
  // particle 0 springs to 1, closing its fan on particle 2
  springs[0] = 1; springs[1] = 1; springs[2] = 0; springs[3] = 2;
  springs[4] = SPRING_END;
  for (let v = 1; v < count; v++) for (let s = 0; s < stride; s++) springs[(v * stride + s) * 4] = SPRING_END;
  const piece = { count, stride, rest, springs, lra: null, contactRadius: null, shellThickness: 0 };

  const { topology } = mergeClothTopologies([{ topology: piece }, { topology: piece }]);
  assert.equal(topology.springs[3], 2, 'cloth 0 is unchanged');
  const second = (count * topology.stride) * 4;
  assert.equal(topology.springs[second], count + 1, 'the neighbour is rebased');
  assert.equal(topology.springs[second + 3], count + 2,
    'and so is the successor — unrebased it closes the triangle on cloth 0');
  // The sentinels are not indices and must survive untouched.
  assert.equal(topology.springs[second + 4], SPRING_END);
});

test('a member without long-range attachments reads as no cap, not a cap to the origin', () => {
  const withLra = fixture({ lra: true });
  const without = fixture({ lra: false });
  const { topology } = mergeClothTopologies([{ topology: withLra }, { topology: without }]);
  assert.ok(topology.lra, 'the flock still carries the table for the member that has one');
  for (let v = 2; v < 4; v++) {
    assert.equal(topology.lra[v * 4 + 3], 0, 'w = 0 is the solver\'s own off switch');
  }
});

test('every particle knows which cloth it belongs to', () => {
  const t = fixture();
  const { topology } = mergeClothTopologies([{ topology: t }, { topology: t }, { topology: t }]);
  assert.deepEqual([...topology.clothOf], [0, 0, 1, 1, 2, 2]);
});

test('a non-uniform scale is refused rather than quietly stretching the fabric', () => {
  const t = fixture();
  const squashed = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(uniformScaleOf(squashed), null);
  assert.throws(() => mergeClothTopologies([{ topology: t, matrix: squashed }]), /non-uniform/);
  // A rotation is not a scale.
  const c = Math.cos(0.7), s = Math.sin(0.7);
  assert.ok(Math.abs(uniformScaleOf([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) - 1) < 1e-9);
});

test('cloths only share a solver when every uniform the solver reads matches', () => {
  const a = { stiffness: 1, bend: 0.1, wind: [0, 0, 2] };
  assert.equal(flockKey(a, { shellThickness: 0.02 }), flockKey({ ...a }, { shellThickness: 0.02 }));
  assert.notEqual(flockKey(a, { shellThickness: 0.02 }), flockKey({ ...a, bend: 0.5 }, { shellThickness: 0.02 }));
  assert.notEqual(flockKey(a, { shellThickness: 0.02 }), flockKey(a, { shellThickness: 0.03 }),
    'a different shell thickness is a different solver');
  // ⛔ But a MEASURED thickness carries float noise: nine Sponza curtains cut
  // from two shells produced nine keys, and every cloth flocked alone.
  assert.equal(flockKey(a, { shellThickness: 0.028830057 }), flockKey(a, { shellThickness: 0.028830083 }),
    'two curtains off the same shell must land in the same flock');
});
