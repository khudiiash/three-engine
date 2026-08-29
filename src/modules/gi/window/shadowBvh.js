// §19 STAGE 5.5b — EXACT TRIANGLE SHADOW RAYS FOR THE DIRECT TERM
//
// ⭐⭐⭐ THE ONE-SENTENCE VERSION: a direct-light shadow ray is traced against
// the SCENE'S ACTUAL TRIANGLES through a worker-built BVH, because a ray that
// STARTS ON A SURFACE cannot be traced against a voxelization OF THAT SURFACE —
// it begins inside the occluder and reports "black" no matter where it is
// pointed.
//
// ══ THE BUG THIS EXISTS TO DELETE ═══════════════════════════════════════════
//
// The user, twice: "still getting self occlusion from the emitters", with a
// screenshot of the Cornell tall box — an EMITTER MESH — rendered entirely
// black. Every shadow ray leaving that box starts inside the box's own dilated
// level-0 voxels. `traceWindow` skips a fixed slab (`v0 * 0.5`) to escape them,
// which works for a wall thicker than a cell and fails for exactly two things:
//
//   · a surface whose own voxel is SHARED with its neighbours (the box's
//     corner cells contain the box, so the escape distance is not one cell but
//     the box's own extent along the ray);
//   · a THIN PANEL, whose two faces occupy ONE cell — the front face's ray is
//     blocked by the back face's bits, at every angle, forever.
//
// No slab size fixes both: too small and the surface shadows itself, too large
// and contact shadows are gone. The failure is REPRESENTATIONAL. A voxel says
// "something is somewhere in this 0.25 m cube"; a shadow ray from a point on a
// surface needs to know whether anything is between HERE and THERE, and "here"
// is inside the cube. The old path never had this bug because it never asked a
// voxel: `createGiEmitterShadowPass` and the §18.16 sun arm both traced an
// ANY-HIT RAY AGAINST TRIANGLES (`src/modules/gi/bvh/bvhScene.js`). This file
// is that capability, rebuilt on GI2's terms.
//
// ══ WHAT WAS ACTUALLY WRONG WITH THE OLD ONE (and is not repeated here) ═════
//
// §19's verdict was that the old BVH was a BOOT AND MEMORY problem, not a ray
// problem. Specifically `buildBvhScene` ran `new MeshBVH(geometry)` ON THE MAIN
// THREAD, per mesh, at scene open — three-mesh-bvh needs a real
// `BufferGeometry`, so it cannot leave the main thread — and it kept a full
// index + position + uv copy per mesh behind a 128-mesh / 150 k-triangle cap
// that silently dropped most of Bistro.
//
// So the rays come back and the build does not:
//
//   · THE BUILD IS IN A WORKER, over the triangle soup that
//     `triangleSoup.worker.js` ALREADY PRODUCES. No three.js, no geometry
//     objects, no main-thread stall, no per-mesh cap — one BVH over one soup.
//   · THE TRIANGLES ARE REORDERED INTO LEAF ORDER, so there is no index
//     buffer: two storage buffers total (`nodes`, `tris`). That matters
//     directly — the RC kernels sit at 6-7 of the 8 guaranteed storage
//     bindings, and a third buffer here would not fit.
//   · IT IS NOT AWAITED. First light is served by the voxel arm exactly as
//     today; when the BVH lands the direct term SWAPS to the exact arm and
//     nothing else rebuilds. A late BVH costs a few frames of soft shadow, not
//     a stall.
//
// ══ THE NODE LAYOUT IS A CONTRACT ═══════════════════════════════════════════
//
// 8 floats per node, and `shadowBvh.worker.js` writes exactly this:
//
//   [0..2] aabb min          [4..6] aabb max
//   [3]    interior: RIGHT child index   leaf: first triangle
//   [7]    interior: -1.0                leaf: triangle count (>= 1)
//
// The left child of an interior node is always `i + 1`, so one float carries
// the whole topology. `[7] < 0` is the interior test — a sign bit, not a mask,
// because the alternative (packing a count and a flag into one f32's bits)
// would need a bitcast, and a WGSL const-NaN bitcast is a trap this repository
// has already paid for once.
//
// Indices are stored as float VALUES, not bit patterns: f32 is exact on
// integers to 2^24 = 16.7 M, which bounds both the node count and the triangle
// count. The worker refuses to build past that rather than folding silently.
import * as THREE from "three/webgpu";
import { attributeArray, float, select, uniform, wgslFn } from "three/tsl";

/**
 * ⛔ RETIRED IN §19 STAGE 6.2 — KEPT ONLY SO A STALE IMPORT FAILS LOUDLY
 * RATHER THAN SILENTLY RE-TRUNCATING THE TREE.
 *
 * 5.5b capped the BVH at 2 M triangles because it MATERIALIZED A COPY of them
 * at 36 B/tri, and 2.83 M of those is 102 MB. The cap was therefore a LIGHT
 * LEAK: it kept a PREFIX and dropped 828 k of Bistro's triangles, and not one
 * of them cast an exact shadow.
 *
 * 6.2 deleted the copy — the tree indexes the soup's own already-resident
 * `instancedArray`, at 4 B/tri — so the memory reason for a cap no
 * longer exists and the tree is COMPLETE. The only ceiling left is the f32
 * exact-integer range (16.7 M triangles), which the worker folds in itself.
 *
 * `Infinity` rather than a deletion, because a bare number here would
 * quietly cap the tree again the moment someone re-passed it.
 */
export const SHADOW_BVH_TRI_CAP = Infinity;

/** Triangles per leaf. 8 measured better than 4 (fewer nodes) and than 16. */
export const SHADOW_BVH_LEAF = 8;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * ══ THE ANY-HIT TRAVERSAL ══════════════════════════════════════════════════
 *
 * Hand-written WGSL for the same reason `bvhScene.js` gives: the stack loop is
 * the expensive part and TSL has no local-array `var`, so a stackless rewrite
 * would either re-descend from the root (much slower) or need parent pointers
 * (a third buffer we do not have a binding for).
 *
 * ⭐ ANY-HIT, NOT CLOSEST-HIT — and that is the whole performance argument for
 * doing this at all. The moment a triangle is hit inside `(1e-4, maxT)` the
 * function RETURNS; there is no `bestT` to shrink, no sorted descent, no
 * ordered child push. A shadow ray in a closed room exits on its first leaf
 * and the traversal never sees the rest of the scene. Closest-hit against the
 * same tree is several times this cost, which is why the hit-shading arm keeps
 * its own path and this one is not shared with it.
 *
 * `rd` MUST be normalized: `maxT` is metres and the returned `t` is compared
 * against it directly.
 *
 * `1e-4` is the near cutoff INSIDE the triangle test, and it is a second line
 * of defence only — the real self-hit rejection is the caller's normal offset
 * (see `anyHitFrom` below), because a ray leaving a surface at a grazing angle
 * can travel far more than 0.1 mm before clearing its own triangle's plane.
 *
 * Returns 1.0 when occluded, 0.0 when clear — the same polarity as
 * `traceWindow(...).hit`, so a call site swaps one expression for another and
 * nothing downstream changes sign.
 */
const bvhAnyHitFn = wgslFn(/* wgsl */ `

	fn gi2BvhAnyHit(
		ro: vec3f,
		rd: vec3f,
		maxT: f32,
		nodes: ptr<storage, array<f32>, read>,
		triIdx: ptr<storage, array<u32>, read>,
		tris: ptr<storage, array<f32>, read>
	) -> f32 {

		var stack: array<u32, 64>;
		var sp: i32 = 0;
		stack[0] = 0u;

		// ⭐⭐ FINITE PSEUDO-INFINITY, NOT 1/0 — AND THIS IS THE CORNELL BUG.
		//
		// A ray straight down a wall (dy = 0) gives invDir.y = Inf, and a node
		// whose slab plane the origin lies EXACTLY on then computes 0 * Inf = NaN.
		// Every comparison against NaN is false, so tmax < entry is false, the
		// node is accepted, and its children are accepted, and the traversal
		// returns whatever the first triangle says — or the node is dropped,
		// depending on which side of the min/max the NaN lands. Either way the
		// answer is data-dependent nonsense, and it happens ONLY on axis-aligned
		// rays against axis-aligned geometry: a Cornell box, a corridor, a room.
		// The generated random-ray test cannot see it; the 600 axis-aligned rays
		// in scratchpad/bvh-check.mjs exist for exactly this.
		//
		// 1e-20 keeps every reciprocal finite in f32 (1e20 * a 100 m extent is
		// 1e22, well inside f32's 3.4e38) so the products stay numbers and the
		// slab test keeps its ordinary meaning.
		let safeDir = vec3f(
			// ⚠ NOT sign(rd.x) * 1e-20: WGSL's sign(0.0) IS 0.0, so a sign-based
			// nudge is still exactly zero on the one input this guard exists for.
			select( select( -1e-20, 1e-20, rd.x >= 0.0 ), rd.x, abs( rd.x ) > 1e-20 ),
			select( select( -1e-20, 1e-20, rd.y >= 0.0 ), rd.y, abs( rd.y ) > 1e-20 ),
			select( select( -1e-20, 1e-20, rd.z >= 0.0 ), rd.z, abs( rd.z ) > 1e-20 )
		);
		let invDir = vec3f( 1.0 ) / safeDir;

		// The iteration guard is NOT defensive programming, it is a
		// DEVICE-LOSS guard. A GPU loop whose exit condition depends on data
		// (a NaN bound, a node index that outran the buffer) does not throw —
		// it hangs the submit and the browser kills the adapter, which in this
		// engine reads as the "device lost" the play/stop ledger already knows
		// too well. 4096 is far past any legitimate traversal of a 2 M-triangle
		// tree (depth ~40, and an any-hit ray exits at its first blocker), so
		// hitting it means corrupt data, and the answer it then gives —
		// "unoccluded" — is the one that fails visibly rather than silently.
		var guard: u32 = 0u;

		loop {

			if ( sp < 0 || guard > 4096u ) { break; }
			guard = guard + 1u;

			let ni = stack[ sp ];
			sp = sp - 1;

			let nb = ni * 8u;
			let bmin = vec3f( nodes[ nb ], nodes[ nb + 1u ], nodes[ nb + 2u ] );
			let bmax = vec3f( nodes[ nb + 4u ], nodes[ nb + 5u ], nodes[ nb + 6u ] );

			let t0 = ( bmin - ro ) * invDir;
			let t1 = ( bmax - ro ) * invDir;
			let tsmall = min( t0, t1 );
			let tbig = max( t0, t1 );
			let tmin = max( max( tsmall.x, tsmall.y ), tsmall.z );
			let tmax = min( min( tbig.x, tbig.y ), tbig.z );
			let entry = max( tmin, 0.0 );

			if ( tmax < entry || entry > maxT ) { continue; }

			let count = nodes[ nb + 7u ];

			if ( count < 0.0 ) {

				// Interior. NO ordered descent: an any-hit ray has no nearest
				// to find, so the front-to-back push that pays for itself in a
				// closest-hit traversal is pure instruction count here.
				let right = u32( nodes[ nb + 3u ] );
				if ( sp < 62 ) {
					sp = sp + 1;
					stack[ sp ] = ni + 1u;
					sp = sp + 1;
					stack[ sp ] = right;
				}

			} else {

				let first = u32( nodes[ nb + 3u ] );
				let n = u32( count );
				for ( var i: u32 = 0u; i < n; i = i + 1u ) {

					// ⭐ §19 6.2 — THE INDIRECTION. tris is the SOUP'S OWN
					// buffer, in the soup's order, so a leaf's contiguous run
					// addresses triIdx and THAT addresses the triangle. One
					// extra u32 load per candidate buys back 32 B/tri of VRAM —
					// and with it the 828 k triangles the 5.5b cap silently dropped.
					let o = triIdx[ first + i ] * 9u;
					let a = vec3f( tris[ o ], tris[ o + 1u ], tris[ o + 2u ] );
					let b = vec3f( tris[ o + 3u ], tris[ o + 4u ], tris[ o + 5u ] );
					let c = vec3f( tris[ o + 6u ], tris[ o + 7u ], tris[ o + 8u ] );

					// Möller-Trumbore, DOUBLE SIDED (no det-sign cull): GI2's
					// soup carries a lamp shade and a curtain whose winding is
					// whatever the author left it, and a shadow ray that
					// passes through backfaces would light rooms through their
					// own walls. The old path's bvhMeshIntersectTriMT is
					// double sided for the same reason.
					let e1 = b - a;
					let e2 = c - a;
					let h = cross( rd, e2 );
					let det = dot( e1, h );
					if ( abs( det ) < 1e-9 ) { continue; }

					let inv = 1.0 / det;
					let s = ro - a;
					let u = dot( s, h ) * inv;
					if ( u < -1e-5 || u > 1.00001 ) { continue; }

					let q = cross( s, e1 );
					let v = dot( rd, q ) * inv;
					if ( v < -1e-5 || u + v > 1.00001 ) { continue; }

					let t = dot( e2, q ) * inv;
					if ( t > 1e-4 && t < maxT ) { return 1.0; }

				}

			}

		}

		return 0.0;

	}

` );

/**
 * ⭐⭐⭐ A PERSISTENT SLOT, NOT A BUFFER — AND THIS IS THE MEMORY LAW, NOT A
 * STYLE CHOICE.
 *
 * The first cut of 5.5b did the obvious thing: build the gather on the voxel
 * arm, and REBUILD it when the worker's tree landed. The gather's own receipts
 * say why that cannot work. A gather rebuild re-creates
 * `textures.irradiance`/`glossy`, and every material in the scene is still
 * bound to the destroyed ones — which is exactly what `retireGather`,
 * `takeRetired` and `GISystem#rebindStaleGiTextures` exist to repair. That
 * repair runs ONLY on the resize path. A rebuild fired from anywhere else
 * hands the materials a corpse, and the measured symptom is precise and
 * bizarre: the gate's API readback of `_gi2.textures.irradiance` is LIT while
 * the frame renders nothing but the emitters, because the readback reads the
 * live texture and the materials read the dead one.
 *
 * So this stage does not rebuild anything. The buffers are created ONCE, at
 * the size a placeholder needs, and the worker's tree is swapped into them
 * later by replacing the BufferAttribute behind the SAME node:
 *
 *   · WGSL `array<f32>` in a storage binding is RUNTIME-SIZED. A bigger
 *     attribute needs no new shader and no new pipeline — only a new bind
 *     group, which three mints from the attribute's `version`.
 *   · The kernel therefore never changes, so no texture is ever re-created,
 *     so no material is ever stale. The failure mode above is not repaired,
 *     it is made unreachable.
 *   · Selecting the arm is a UNIFORM, and it gates a real runtime branch. It
 *     is uniform across every invocation, so a warp takes one side or the
 *     other and the untaken trace costs nothing — this is not the `mix` of
 *     two traced results it might look like, which would pay for both forever.
 *
 * ⚠ THE PLACEHOLDER MUST BE A REJECTING NODE, NOT A ZERO ONE. An all-zero node
 * is the box [0,0,0]..[0,0,0], which a ray through the origin HITS; it is a
 * leaf with 0 triangles so it reports no occlusion, but it costs a traversal
 * and, worse, it is a shape that answers "unoccluded" for a reason that would
 * survive a real bug. min > max can never be entered by any ray at all.
 */
export function createShadowBvhSlot() {
  const nodes = new Float32Array(8);
  nodes[0] = 1; nodes[1] = 1; nodes[2] = 1;    // min
  nodes[4] = -1; nodes[5] = -1; nodes[6] = -1; // max < min: unenterable
  nodes[3] = 0; nodes[7] = 0;                  // a leaf holding nothing
  const tris = new Float32Array(9);
  // A single index, pointing at that placeholder triangle. Never traversed: the
  // placeholder node's box is unenterable, so the loop below it never runs.
  const triIdx = new Uint32Array(1);

  // `.toReadOnly()` so the emitted `var<storage, ...>` access mode matches the
  // `read` annotation on the WGSL ptr parameters — a mismatch is a pipeline
  // creation error, not a wrong picture.
  //
  // Flat "float", NEVER a vec3/vec4 element type: a `vec3<f32>` storage array
  // has a 16-byte stride in WGSL and would read these tightly-packed
  // 12-byte-stride arrays off by a growing offset. Same trap `bvhScene.js`
  // documents for its own position buffer.
  const nodesBuffer = attributeArray(nodes, "float").toReadOnly();
  const triIdxBuffer = attributeArray(triIdx, "uint").toReadOnly();
  // ⭐⭐⭐ §19 6.2 — THIS ONE IS BORROWED, NOT OWNED. After fill it points at
  // the SOUP'S OWN `instancedArray` — the identical world-space triangle buffer
  // the voxelizer and `windowDynamic` already keep resident for the life of the
  // window. Binding it costs ZERO new VRAM; materializing a leaf-ordered copy of
  // it cost 102 MB on Bistro and forced the cap that was leaking light.
  //
  // Sharing one `StorageBufferAttribute` across two nodes is safe because three
  // keys the GPUBuffer off the attribute, so both nodes resolve to one buffer.
  // This node is `.toReadOnly()` and the soup's is not; the ACCESS MODE lives on
  // the node, not the buffer, so the two declarations coexist.
  const trisBuffer = attributeArray(tris, "float").toReadOnly();

  /**
   * 0 until the worker's tree is in the buffers, 1 after. Read by `rcDirect`'s
   * `If`/`Else`, so the frames before the swap trace the voxels exactly as
   * 5.4d shipped and the frames after trace triangles — with no pass, kernel,
   * texture or material touched at the moment it flips.
   */
  const readyU = uniform(0);

  const state = { nodeCount: 0, triCount: 0, bytes: 0, stats: null };
  /**
   * ⭐⭐⭐ §19 6.12 — THE KERNELS THAT BIND THIS SLOT, AND WHY THEY ARE LISTED.
   *
   * `fill()` swaps `.value` on three storage nodes. Three's `Bindings._update`
   * compares `binding.attribute` per dispatch and re-mints the bind group when
   * it changes — on paper. MEASURED (Cornell, 08-29): a kernel compiled before
   * `fill()` kept reading the PLACEHOLDER — `nodes[3]` read 0 in rcDirect's own
   * raw pass while a kernel built after the fill, and a CPU readback of the very
   * same attribute, both read 22 (node 0's right child). `readyU` had flipped, so
   * the exact branch ran a traversal into an unenterable box and every shadow
   * ray came back "clear": the "emissives still do not cast shadows" report.
   *
   * So every kernel that binds the slot registers here, and `fill()` bumps its
   * `version` (`needsUpdate = true`). Three then re-derives that kernel's
   * bindings from the CURRENT attributes on its next dispatch; the WGSL is
   * byte-identical, so the pipeline cache serves the compiled pipeline and no
   * pass, texture or material is rebuilt — the 5.5b design, made true.
   */
  const kernels = new Set();

  // ⭐⭐ §19 6.8 — THE SLOT OUTLIVES EVERY GENERATION; ITS BUFFERS MUST NOT.
  // The slot lives on the per-scene store (one kernel, forever — see the
  // header), but a quality / ao / reflections flip tears the gi2System
  // GENERATION down, and GISystem's teardown contract is "nothing survives":
  // every attribute the old generation published or its orphaned kernels
  // bound is retired — the borrowed soup `tris` (its owner's `dispose()`
  // zeroes it), and the tree's own nodes/triIdx (harvested off the old
  // `rcDirect` kernel). The next generation reused the slot with `ready`
  // still 1, `kickShadowBvh` returned early, and the kernel bound attributes
  // whose arrays were empty:
  //   "Binding size for [Buffer (unlabeled)] is zero ... entries[7]
  //    ReadOnlyStorage" — on every frame, until the device was unusable.
  // Publishing the slot's buffers as survivors does not help — the old
  // generation's getter is exactly what the teardown dooms ("used in submit
  // while destroyed" instead). So the slot keeps the CPU ARRAYS (the
  // placeholders and, once built, the tree) and MINTS FRESH ATTRIBUTES per
  // generation: `retarget()` below is the per-generation re-seat, `fill` and
  // `retarget` refuse an empty soup outright.
  let forTris = null;
  let treeNodes = null;
  let treeIdx = null;
  const mint = (array) => {
    const attr = new THREE.StorageBufferAttribute(array, 1);
    attr.version++;
    return attr;
  };
  const reset = () => {
    nodesBuffer.value = mint(nodes);
    triIdxBuffer.value = mint(triIdx);
    trisBuffer.value = mint(tris);
    readyU.value = 0;
    for (const k of kernels) k.needsUpdate = true;
    forTris = null; treeNodes = null; treeIdx = null;
    state.nodeCount = 0; state.triCount = 0; state.bytes = 0; state.stats = null;
  };
  /**
   * `1.0` when ANYTHING lies in `(origin, origin + dir*maxT)`, else `0.0`.
   * Raw: the caller owns the origin offset.
   */
  const anyHit = (origin, dir, maxT) => bvhAnyHitFn(origin, dir, maxT, nodesBuffer, triIdxBuffer, trisBuffer);

  /**
   * ⭐⭐ THE SELF-HIT EPSILON, AND WHY IT IS ALONG THE NORMAL.
   *
   * The shading point came out of the gbuffer, so it is ON a triangle of this
   * very BVH. Pushing along the RAY DIRECTION does not help: at a grazing
   * angle the ray hugs its own plane and a `dir * eps` step is still within
   * the triangle's numerical thickness for a long way. Pushing along the
   * NORMAL leaves the plane at unit rate regardless of the ray's angle, so one
   * small constant covers every direction. This is the offset the old
   * `createGiEmitterShadowPass` used and the reason it never self-shadowed a
   * wall.
   *
   * There is deliberately NO voxel slab to skip: that is the entire point of
   * this file. `SELF_EPS` is millimetres, so a contact shadow survives — the
   * voxel arm could not resolve anything under 0.25 m.
   */
  const SELF_EPS = 2e-3;
  const anyHitFrom = (P, dir, maxT, normal) => (
    normal
      ? anyHit(P.add(normal.mul(SELF_EPS)), dir, maxT)
      : anyHit(P, dir, maxT)
  );

  return {
    anyHit,
    anyHitFrom,
    readyU,
    selfEps: SELF_EPS,
    get ready() { return readyU.value !== 0; },
    get nodeCount() { return state.nodeCount; },
    get triCount() { return state.triCount; },
    get bytes() { return state.bytes; },
    get mb() { return state.bytes / (1024 * 1024); },
    get stats() { return state.stats; },
    /** The CURRENT bound arrays (placeholder until `fill`) — for the CPU mirror probe. */
    get nodes() { return nodesBuffer.value?.array ?? null; },
    get nodesAttr() { return nodesBuffer.value; },
    /** The storage NODES themselves — a kernel-side content receipt (`nodesNode.element(3)`). */
    get nodesNode() { return nodesBuffer; },
    get trisNode() { return trisBuffer; },
    get triIdxAttr() { return triIdxBuffer.value; },
    get trisAttr() { return trisBuffer.value; },
    get triIdx() { return triIdxBuffer.value?.array ?? null; },
    get tris() { return trisBuffer.value?.array ?? null; },
    /**
     * Swaps the worker's tree in. REBIND ONLY — a new `StorageBufferAttribute`
     * behind the same node, so three mints a new bind group and reuses the
     * pipeline. Nothing above this call is rebuilt, which is the whole design.
     *
     * ⚠ `version++` IS LOAD-BEARING. Three's generation check is what tells the
     * backend a cached bind group is stale; a fresh attribute whose version
     * still reads 0 can be silently ignored and the placeholder kept forever —
     * the same mechanism `gi2TextureGeneration` exists for on the texture side,
     * where the gather measured 212 destroyed-texture errors without it.
     */
    fill(bvh, soupTris) {
      if (!bvh || !(bvh.nodeCount > 0) || !(bvh.triCount > 0)) return false;
      // ⭐ 6.2 — WITHOUT THE SOUP THERE ARE NO TRIANGLES TO TEST. The tree is
      // now nothing but indices into the caller's buffer, so filling the nodes
      // while leaving `tris` on the 1-triangle placeholder would traverse a real
      // tree into garbage and report shadows that are not there. Refuse instead:
      // `readyU` stays 0 and the voxel arm keeps serving a picture that is merely
      // soft rather than wrong.
      if (!soupTris) return false;
      // §19 6.8 — a soup whose generation has already been retired reads as an
      // empty array; binding it is the zero-size bind group, not a soft frame.
      if (!(soupTris.array?.length > 0)) return false;
      nodesBuffer.value = mint(bvh.nodes);
      triIdxBuffer.value = mint(bvh.triIdx);
      trisBuffer.value = soupTris;
      forTris = soupTris.array;
      treeNodes = bvh.nodes;
      treeIdx = bvh.triIdx;
      state.nodeCount = bvh.nodeCount;
      state.triCount = bvh.triCount;
      // The soup is NOT counted: it was already resident before this stage
      // existed and is not freed if the arm turns off. Counting it here would
      // book 102 MB of someone else's memory against the BVH and make the
      // stage look like a regression it is the opposite of.
      state.bytes = bvh.nodes.byteLength + bvh.triIdx.byteLength;
      state.stats = bvh.stats ?? null;
      readyU.value = 1;
      for (const k of kernels) k.needsUpdate = true;
      return true;
    },
    /**
     * §19 6.8 — a NEW GENERATION's soup upload. Same triangle array as the
     * resident tree permutes → fresh attributes for the tree (the old ones
     * were retired with the generation that bound them) and `tris` re-seated
     * on the new upload. A different array → the tree indexes triangles that
     * no longer exist in that order: back to fresh placeholders, `ready` 0, so
     * the caller's `kickShadowBvh` builds a tree for THIS soup. Returns true
     * when the tree survived.
     */
    retarget(soupTris) {
      if (readyU.value !== 0 && treeNodes && treeIdx &&
        soupTris?.array && soupTris.array.length > 0 && soupTris.array === forTris) {
        nodesBuffer.value = mint(treeNodes);
        triIdxBuffer.value = mint(treeIdx);
        trisBuffer.value = soupTris;
        for (const k of kernels) k.needsUpdate = true;
        return true;
      }
      reset();
      return false;
    },
    reset,
    /** Register a compute node that binds this slot (see `kernels` above). */
    attach(node) { if (node) kernels.add(node); },
    detach(node) { kernels.delete(node); },
    detachAll() { kernels.clear(); },
  };
}

/**
 * Owns the BVH worker. Deliberately a SECOND worker rather than a second
 * message to the soup worker: the soup's `done` TRANSFERS `tris` away (that
 * transfer is what keeps the post at memcpy speed), so the soup worker no
 * longer holds the triangles by the time anyone could ask it for a BVH. Posting
 * them back would cost the same transfer either way, and a separate worker
 * additionally lets the BVH build overlap voxelization instead of queueing
 * behind the next soup rebuild.
 *
 * ⚠ The spawn form is the one `triangleSoup.js` documents at length —
 * `new Worker(new URL("./x.worker.js", import.meta.url), { type: "module" })`
 * is statically recognised by Vite in both the editor and player builds. A
 * computed URL ships a 404 in the packaged game.
 */
export function createShadowBvhBuilder(options = {}) {
  const spawn = options.workerFactory ?? (() => new Worker(
    new URL("./shadowBvh.worker.js", import.meta.url),
    { type: "module" },
  ));

  let worker = null;
  let pending = null;
  let gen = 0;
  let disposed = false;

  const api = {
    /** Wall milliseconds from post to result for the last completed build. */
    lastBuildMs: 0,
    /** Milliseconds the worker cold start cost (first build only). */
    lastSpawnMs: 0,
    /** The worker's own reported build time, excluding transfer. */
    lastWorkerMs: 0,
  };

  const ensureWorker = () => {
    if (worker) return worker;
    const t0 = now();
    worker = spawn();
    api.lastSpawnMs = now() - t0;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !pending || msg.gen !== pending.gen) return;
      const p = pending;
      if (msg.type === "done") {
        pending = null;
        api.lastBuildMs = now() - p.tPost;
        api.lastWorkerMs = msg.bvh?.stats?.buildMs ?? 0;
        msg.bvh.wallMs = api.lastBuildMs;
        p.resolve(msg.bvh);
      } else if (msg.type === "error") {
        pending = null;
        const err = new Error(`shadow bvh worker: ${msg.message}`);
        err.workerStack = msg.stack;
        p.reject(err);
      }
    };
    worker.onerror = (event) => {
      const p = pending;
      pending = null;
      p?.reject(new Error(`shadow bvh worker failed: ${event?.message ?? "unknown"}`));
    };
    return worker;
  };

  return {
    stats: api,
    /**
     * `tris` is TRANSFERRED — the caller loses it. Callers that still need the
     * soup's triangles (the voxelizer does, at least until it has consumed
     * them) pass a copy. A superseding build rejects the older promise rather
     * than resolving it stale.
     *
     * @param {{tris: Float32Array, triCount: number, triCap?: number}} input
     */
    build(input) {
      if (disposed) return Promise.reject(new Error("shadow bvh builder disposed"));
      const w = ensureWorker();
      if (pending) {
        pending.reject(new Error("shadow bvh build superseded"));
        pending = null;
      }
      const g = ++gen;
      return new Promise((resolve, reject) => {
        pending = { gen: g, resolve, reject, tPost: now() };
        w.postMessage({
          type: "build",
          gen: g,
          input: {
            tris: input.tris,
            triCount: input.triCount,
            maxLeafSize: input.maxLeafSize ?? SHADOW_BVH_LEAF,
            triCap: input.triCap ?? SHADOW_BVH_TRI_CAP,
          },
        }, [input.tris.buffer]);
      });
    },
    dispose() {
      disposed = true;
      pending?.reject(new Error("shadow bvh builder disposed"));
      pending = null;
      worker?.terminate();
      worker = null;
    },
  };
}
