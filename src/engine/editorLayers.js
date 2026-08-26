/**
 * Dedicated Three.js layer for objects that must only appear in the editor
 * view (camera model, gizmo, grid, selection box, frustum helper).
 *
 * The editor orbit camera leaves all layers enabled, so it sees this layer.
 * Play-mode cameras and the camera-preview camera must `layers.disable()` it
 * so the editor-only content doesn't leak into the game or the PIP render.
 *
 * Picking still works on layer-31 objects because the picking raycaster
 * tests all layers by default (see ViewportPanel.jsx `setupPicking`).
 */
export const EDITOR_LAYER = 31;

/**
 * Layer for runtime debug drawing (`engine.debug`).
 *
 * Deliberately NOT `EDITOR_LAYER`: debug draw is a gameplay-debugging tool, so
 * it has to be visible in Play mode and the Game view, which are exactly the
 * views that disable the editor layer. Giving it a layer of its own also means
 * a camera can switch all of it off at once — and keeps it out of any pass that
 * renders a filtered layer set.
 *
 * Cameras start with only layer 0 enabled, so every camera that should show
 * debug drawing enables this explicitly (`CameraComponent` and the editor's
 * orbit camera both do).
 */
export const DEBUG_LAYER = 30;

/**
 * Layer for objects large enough to be worth drawing into the occlusion
 * culling depth pass (`culling/OcclusionSystem.js`).
 *
 * A layer rather than a list, because the point is for the pass to SKIP the
 * rest of the scene without walking it: `camera.layers.set(OCCLUDER_LAYER)`
 * makes three's projection step reject everything else at the object level.
 *
 * It is an ADDITIONAL bit, never a replacement — an occluder still has layer 0
 * enabled and renders normally. The one thing to know about it is that
 * `mesh.layers.mask` is part of the static batching key, so the tag is written
 * on a dirty flag and not per frame; flipping it every frame would rebuild
 * every batch in the scene, every frame.
 */
export const OCCLUDER_LAYER = 29;

/**
 * Layer for meshes whose material sits in GI's MIRROR roughness bucket
 * (`giRoughnessBucketOf` 0 or 3 — see `src/modules/gi/giLight.js`).
 *
 * Exists so the exact-reflection BVH prepass can be SPARSE. That pass used to
 * fire one BVH ray for every gbuffer pixel, whether or not any reflective
 * surface was on screen; tagging the mirror meshes lets a second, tiny gbuffer
 * render mark exactly the pixels that will ever consume a reflection, and the
 * compute pass skips the rest (`giScreen.js` `createGiBvhReflect`).
 *
 * Same rules as `OCCLUDER_LAYER`, and for the same reason: it is an ADDITIONAL
 * bit (the mesh keeps layer 0 and renders normally), and `mesh.layers.mask` is
 * part of the static batching key — so GISystem writes it only when a
 * material's bucket actually changes, never per frame.
 */
export const GI_MIRROR_LAYER = 28;

/**
 * Layer for UI meshes (`components/ui/*`).
 *
 * UI used to share bit 30 with {@link DEBUG_LAYER}, which was a real bug rather
 * than a tidy coincidence: every game camera and the editor camera enable the
 * debug layer, so UI quads were already being drawn by the main scene pass —
 * while `UiSystem` ALSO drew them in a second full `renderer.render()` of its
 * own. That second pass roughly doubled frame time (see
 * `scripts/run-ui-perf.mjs`) to produce pixels the main pass had already
 * produced. It also meant UI leaked into every consumer that treats "not the
 * editor layer" as "part of the world": GI voxelization and the occlusion
 * depth pass both swallowed HUD quads sitting at pixel-scale world
 * coordinates.
 *
 * UI now renders in the main pass and nowhere else. A camera that should show
 * UI enables this bit explicitly (`CameraComponent`, the editor orbit camera);
 * every auxiliary pass leaves it off, which is what keeps a HUD out of shadow
 * maps, GI, occlusion and reflections.
 */
export const UI_LAYER = 27;

/**
 * Layers the editor's selection outline stamps on the selected meshes for the
 * duration of its mask pass (`editor/selectionOutline.js`) — one bit for the
 * selection, one for the active object, which is drawn in a lighter colour.
 *
 * Unlike every other layer here these are TRANSIENT: the pass overwrites
 * `mesh.layers.mask` outright (so the camera sees the selection and nothing
 * else) and restores it before returning, inside one synchronous block. That
 * is not tidiness — `mesh.layers.mask` is part of the static batching key, so a
 * bit left set until the next rebuild would silently pull a selected mesh out
 * of its batch, and a bit copied onto a batch proxy (`instanced.layers.mask =
 * template.layers.mask`) would drag a thousand unselected crates into the
 * outline. Nothing outside that block should ever see these bits set.
 */
export const SELECTION_MASK_LAYER = 26;
export const SELECTION_ACTIVE_LAYER = 25;

/**
 * Layer for the postprocess editor-overlay pass's DEPTH SEED quad
 * (`PostprocessComponent`): a fullscreen quad that copies the scene pass's
 * depth into the overlay pass's depth attachment so editor helpers occlude
 * against real scene geometry inside a PP-owned frame.
 *
 * A private bit rather than EDITOR_LAYER because the quad must render ONLY in
 * that one pass — on a direct frame the editor camera sees EDITOR_LAYER, and
 * a depth-stomping fullscreen quad there would overwrite the live depth
 * buffer for everything drawn after it.
 */
export const PP_OVERLAY_SEED_LAYER = 24;

/**
 * Layer for meshes whose SURFACE MOVES INDEPENDENTLY OF THE CAMERA — skinned
 * and morph-target meshes (GISystem's collect walk tags them).
 *
 * Exists because GI's screen-space temporal filters reproject with a
 * STATIC-WORLD assumption: they take a pixel's world position, project it
 * through the PREVIOUS camera's view-projection, and read history there. That
 * is exact for static geometry under any camera motion — and wrong for a
 * surface that itself moved, because the history texel holds a DIFFERENT
 * point of that surface. The world-position guard cannot separate the two:
 * its tolerance is voxel-scale (~0.15-0.25 m) while an animated limb moves
 * only centimetres per frame, so stale radiance passes validation and blends
 * in at up to 0.9 weight — "previous frames' contours" trailing a running or
 * jumping character (worst mid-jump, where limb displacement peaks).
 *
 * Same rules as {@link GI_MIRROR_LAYER}: an ADDITIONAL bit (the mesh keeps
 * layer 0 and renders normally).
 */
export const GI_DYNAMIC_LAYER = 23;

/**
 * Layer for the depth-only proxies that stand in for the real casters in
 * SHADOW passes (`src/engine/shadowMerge.js`).
 *
 * ⚠ THE ONLY *EXCLUSIVE* LAYER IN THIS FILE. Every bit above is ADDITIVE — the
 * mesh keeps layer 0 and renders normally. A shadow proxy is the opposite: it
 * must be drawn by the shadow cameras and by NOTHING else, so it sits on this
 * bit ALONE (`layers.set`, not `layers.enable`). Its originals keep layer 0 and
 * drop out of the depth pass via `castShadow = false` instead.
 *
 * ⚠⚠ THIS BIT DOES NOT ROUTE ITSELF, AND THE DEFAULT IS THE WRONG WAY ROUND.
 * three's `ShadowNode.updateShadow` contains:
 *
 *     if ( ( shadow.camera.layers.mask & 0xFFFFFFFE ) === 0 )
 *         shadow.camera.layers.mask = camera.layers.mask;
 *
 * — a shadow camera left on layer 0 alone INHERITS THE VIEW CAMERA'S MASK.
 *
 * The COLOUR side needs nothing: no camera in this engine calls
 * `layers.enableAll()` (only raycasters do), so a view camera's mask is layer 0
 * plus a few explicitly enabled bits — `EDITOR_LAYER`, `DEBUG_LAYER`,
 * `UI_LAYER` — and never this one. Proxies are invisible to the main pass for
 * free.
 *
 * That is exactly what makes the SHADOW side mandatory: the shadow camera
 * inherits that same mask, which does NOT contain this bit, so doing nothing
 * hides the proxies from the one pass they exist for — a scene whose merged
 * half stops casting shadows entirely. Every shadow camera must therefore
 * enable this bit explicitly, which also lifts it out of the inheritance branch
 * (the mask is no longer "layer 0 alone"). Rendering {0, this} loses no real
 * caster: every other engine layer is ADDITIVE — its meshes keep layer 0.
 * ⚠ It must be re-applied, not set once: CSM disposes and rebuilds its cascade
 * placeholders whenever the cascade count or the renderer changes.
 */
export const SHADOW_PROXY_LAYER = 22;

/**
 * Layer for meshes whose exact reflection SURVIVES THE BLEND — §18's ladder
 * rungs SHARP and MEDIUM, i.e. a roughness FLOOR at or below 0.45.
 *
 * ⚠ NOT the same population as {@link GI_MIRROR_LAYER}, and that distinction is
 * the entire point. `GI_MIRROR_LAYER` tags every material that READS an exact
 * reflection — `giRoughnessBucketOf` buckets 0 and 3 — which on a real imported
 * scene is nearly everything (the user's Bistro: 104 of 111 materials), because
 * "has a roughness MAP" is all bucket 3 means. That set is useless as a cost
 * lever: it excludes almost nothing.
 *
 * This bit is the useful one, and it is chosen by a PROOF rather than a
 * heuristic. All three consumers of the traced reflection gate on the same
 * ramp — the exact blend, the mirror trace, and the env-on-miss term all
 * multiply by `smoothstep(0.45, 0.15, roughness)` (see giLight.js). Above 0.45
 * every one of them is exactly 0. The ladder tiers on the map's p5 FLOOR, so a
 * material tiered COARSE has *every texel* above 0.45 — the reflection it pays
 * a full BVH traversal for is multiplied out of the image at every pixel it
 * covers. On the user's Bistro that is 4.14 M of 4.65 M reflective triangles,
 * **89%**, and the prepass is the single most expensive pass in the frame.
 *
 * ⚠⚠ THIS DOES NOT REOPEN §16 R4. R4 was refuted for removing materials from
 * the reflection PATH by BUCKET, which took real light from mid-roughness
 * surfaces where the ramp is non-zero — "shadowed walls near-black". This bit
 * keeps every MEDIUM surface (0.15–0.45) in the traced set at full resolution;
 * it excludes only the rung where the contribution is provably zero per texel.
 * A material whose floor has not resolved yet tiers MEDIUM, so the default
 * while the async GPU stat is in flight is to KEEP tracing.
 *
 * Same rules as {@link GI_MIRROR_LAYER}: an ADDITIONAL bit (the mesh keeps
 * layer 0 and renders normally), and `mesh.layers.mask` is part of the static
 * batching key, so it is written only when a material's tier changes.
 */
export const GI_SHARP_LAYER = 21;

/**
 * A shadow-merge proxy that is ALSO safe to draw into GI's g-buffer prepass.
 *
 * ## Why the g-buffer wants the shadow proxies
 *
 * `renderGiGBuffer` is the frame's SECOND full scene submission — one override
 * material over every eligible mesh, writing world position + world normal at
 * half res. Measured on Bistro (2026-08-25): **317 draws / 10.96 ms of CPU
 * encoding every frame**, the single biggest item in the tick, and its
 * `floorIfMerged` is 9. It is pure draw-count cost, exactly like the shadow
 * pass — so exactly the same merge fixes it, and {@link SHADOW_PROXY_LAYER}'s
 * proxies are ALREADY that merge, already world-baked, already rebuilt on the
 * same invalidations. Building a second, near-identical proxy set for the
 * g-buffer would double the memory to solve the same problem twice.
 *
 * ## Why it is a SEPARATE bit from `SHADOW_PROXY_LAYER`
 *
 * A depth override reads no normals, so a shadow proxy is allowed to be
 * position-only — and `mergeGeometries` drops an attribute unless EVERY member
 * carries it, so a single member without normals silently produces a proxy the
 * g-buffer would shade with garbage. Eligibility is therefore a property of the
 * built proxy, not of the system, and it has to be answerable per proxy at draw
 * time. This bit IS that answer: it is set only on proxies that carry a real
 * `normal` attribute and whose members are safe to stand down.
 *
 * Members of a bearing proxy are hidden for the duration of the prepass and
 * restored immediately after (see `renderGiGBuffer`), rather than being routed
 * by layer: a mesh that is invisible to the g-buffer because someone forgot to
 * tag it is invisible to GI, which is a lighting bug, and the default for
 * anything this system has not explicitly absorbed must be "drawn".
 *
 * ⚠ ADDITIVE, and on the PROXY only — the proxy keeps `SHADOW_PROXY_LAYER`, so
 * nothing about the shadow routing changes and the main colour pass (layer 0)
 * still never sees it.
 */
export const GI_DEPTH_LAYER = 20;