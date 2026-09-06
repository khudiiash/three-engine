import { Object3D, Vector3 } from 'three/webgpu';
import {
  cameraViewMatrix, float, materialColor, mix, modelNormalMatrix, normalLocal, normalView, positionLocal,
  positionViewDirection, reflector, screenUV, transformDirection, transformNormalToView, uniform, vec2, vec3,
} from 'three/tsl';
import { waterFoamNode, waterSubsurfaceNode } from './waterFoam.js';
import { seaShadingSlopeNode } from './waterSpectrum.js';

const _eye = new Vector3(), _origin = new Vector3(), _up = new Vector3();
/** Recursion guard: a mirror must not render itself. */
let reflecting = false;

/**
 * ══ THE WATER SURFACE'S OWN LOOK ═══════════════════════════════════════════
 *
 * The planar mirror, foam, fine-scale normals and subsurface scattering — all
 * in one place because they land on the same handful of material slots and
 * three has exactly one of each. Two modules assigning `emissiveNode` would
 * silently clobber each other.
 *
 * ⛔⛔ **THE MIRROR WAS DELETED ONCE AND THAT WAS WRONG.** The scene appeared to
 * carry two reflections, one correct and one badly broken, and the broken one
 * was blamed on this. It was not: the ghosts were three's screen-space
 * TRANSMISSION, sampling the opaque scene at a refracted screen offset that
 * reached pixels of objects ABOVE the water (see `builtinMaterials.js`, where
 * `thickness` is now zero). This mirror was the CORRECT one all along —
 * measured at 1.5 px against the analytic mirror image, five separate times.
 * Deleting it left the water with no reflection whatever, because the traced
 * path cannot reach it either (`giLight.js`'s `giWater` early return, which is
 * load-bearing for a texture budget): "we had 2 reflections previously, one was
 * correct, and another one was broken. You killed both" (user, 2026-09-06).
 *
 * ⚠ The lesson is not about water. **A diagnosis offered by the person seeing
 * the bug is a hypothesis, not evidence.** "It is the water's own reflection"
 * fitted the symptom perfectly and was wrong, and acting on it deleted a
 * working subsystem instead of the faulty one standing next to it.
 */
export function installWaterSurfaceLook({ engine, mesh, material, simulation = null, slot = null }) {
  const target = new Object3D(); target.rotation.x = -Math.PI / 2; mesh.add(target);
  const gain = uniform(1), distortion = uniform(.02);
  // ⚠ EVERY SLOT THIS TOUCHES IS CAPTURED, and every rebuild starts from the
  // capture rather than from what it built last time — `build()` re-runs on
  // each GI compile wave, and composing onto its own output would stack foam on
  // foam until the water was a white sheet.
  const previous = {
    emissiveNode: material.emissiveNode, colorNode: material.colorNode,
    roughnessNode: material.roughnessNode, normalNode: material.normalNode,
    transmissionNode: material.transmissionNode, transmission: material.transmission,
    thicknessNode: material.thicknessNode,
    giWater: material.userData.giWater,
  };
  let node = null, disposed = false, rearms = 0;

  /** Is the eye on the +Y side of the water's own surface plane? Scale-free. */
  const eyeAbove = (camera) => {
    if (!camera) return true;
    mesh.updateWorldMatrix(true, false);
    mesh.getWorldPosition(_origin);
    _up.set(0, 1, 0).transformDirection(mesh.matrixWorld).normalize();
    return camera.getWorldPosition(_eye).sub(_origin).dot(_up) >= 0;
  };

  const update = () => {
    const gi = engine?.modules?.get('gi')?.system?.component;
    const setting = gi?.enabled !== false ? gi?.props?.reflections : undefined;
    gain.value = setting === false || setting === 0 ? 0 : 1;
  };

  const build = () => {
    const u = simulation?.uniforms ?? null;
    node?.dispose();
    // ── ONE MIRROR PER RENDER, NOT ONE PER FRAME ─────────────────────────
    //
    // `bounces: false` updates once per FRAME — for whichever render draws the
    // water first, which in this engine can be a GI probe capture or a second
    // viewport. Measured with a decoy camera rendered immediately before the
    // measured one: 80.8 px of error against 1.5 px. Per-render gives every
    // camera its own target, and `reflecting` is the recursion guard that
    // `bounces: false` was really buying.
    node = reflector({ target, resolutionScale: .5, generateMipmaps: true, bounces: true });
    const base = node._reflectorBaseNode ?? node;
    // three sizes the mirror from the DRAWING BUFFER while the shader samples
    // it with `screenUV`, which normalizes by the current render target. Those
    // agree only when the frame goes straight to the canvas.
    const resize = base._updateResolution.bind(base);
    base._updateResolution = (renderTarget, renderer) => {
      const current = renderer.getRenderTarget();
      if (!current) return resize(renderTarget, renderer);
      renderTarget.setSize(Math.max(1, Math.round(current.width * base.resolutionScale)),
        Math.max(1, Math.round(current.height * base.resolutionScale)));
    };
    const original = base.updateBefore.bind(base);
    base.updateBefore = (frame) => {
      update();
      if (disposed || gain.value === 0 || engine?.renderSuspended) return;
      if (reflecting) return false;
      reflecting = true;
      // ── A MIRROR MUST NOT REFLECT ITSELF, AND ITS RAY TRAVELS IN AIR ────
      //
      // The virtual camera sits below the surface looking up, so the water body
      // is the first thing it sees; and the reflected ray never crosses water,
      // so leaving the medium armed fogs the whole reflection as though it were
      // being viewed from underneath. Both are the same one-frame suspension.
      //
      // three also refuses to render a reflector the camera is behind and
      // CLEARS its target — right for a floor mirror, catastrophic for water,
      // where a surface seen from just under the waterline is the most
      // reflective thing in the scene. Rotating the target by π mirrors about
      // the same plane with its normal turned around, and the oblique clip then
      // keeps the half the eye is actually in.
      const above = eyeAbove(frame.camera);
      target.rotation.x = above ? -Math.PI / 2 : Math.PI / 2;
      target.updateMatrixWorld(true);
      base.forceUpdate = true;
      const body = mesh.visible;
      const slots = engine?.waterSlots?.slots ?? [];
      const armed = slots.map((s) => s.uniforms.active.value);
      const nested = globalThis.__giNestedRender;
      globalThis.__giNestedRender = true;
      mesh.visible = false;
      for (const s of slots) s.uniforms.active.value = 0;
      try { return original(frame); } finally {
        reflecting = false;
        mesh.visible = body;
        for (let i = 0; i < slots.length; i++) slots[i].uniforms.active.value = armed[i];
        globalThis.__giNestedRender = nested;
      }
    };

    // ── DETAIL NORMALS FIRST: THEY CHANGE EVERY TERM BELOW ───────────────
    //
    // A 128² grid over ten metres cannot hold a wave finer than ~20 cm, and
    // real water is full of structure well under that. Geometry cannot get
    // there and a NORMAL can — which then feeds the Fresnel, the mirror's
    // distortion and the specular glitter at once, because all three read the
    // shading normal. This is "add those smaller details onto normal map".
    if (u && simulation?.spectrum) {
      // ── THE SEA'S SLOPE, PER PIXEL, FROM THE DERIVATIVE CASCADES ─────────
      //
      // The mesh normal carries only the ripple field (gridSimulation's
      // surface kernel); the sea is added here from the same derivative maps
      // the caustic lens reads, with their hardware mip chains — real waves
      // at every scale the spectrum holds, where the value-noise "detail
      // normal" used to be. Babylon's distance fade drops each cascade as its
      // texels fall under a pixel. Composed in LOCAL space against the
      // interpolated geometric normal and taken to view space from there, so
      // no tangent frame has to be guessed on an anisotropically scaled box.
      //
      // ⚠ AND STYLIZED WATER HAS ALMOST NONE OF IT. Sub-pixel glitter is the
      // single strongest cue that a surface is photographic; a cel-shaded pond
      // reads as cel-shaded largely by not having it.
      const world = vec2(positionLocal.x.mul(u.waveScale.x), positionLocal.z.mul(u.waveScale.z));
      const slope = seaShadingSlopeNode(simulation.spectrum, world, u.surfaceDetail, u.seaLod).mul(mix(float(1), float(.12), u.stylized));
      const local = vec2(slope.x.mul(u.waveScale.x).div(u.waveScale.y), slope.y.mul(u.waveScale.z).div(u.waveScale.y));
      const perturbed = normalLocal.add(vec3(local.x.negate().mul(normalLocal.y), 0, local.y.negate().mul(normalLocal.y))).normalize();
      material.normalNode = transformNormalToView(perturbed);
    }
    const fresnel = float(1).sub(normalView.dot(positionViewDirection).abs()).clamp(0, 1).pow(5).mul(.97963).add(.02037);
    // ⚠ FROM THE CAPTURE, NOT FROM THE MATERIAL — this function writes
    // `roughnessNode`, and reading the live slot would feed each rebuild its
    // own previous output and blur the mirror a little further every time.
    // The WATER's roughness, not the material's — see `gridSimulation`'s
    // update. An authored graph pins its own value and the component's control
    // would otherwise do nothing at all.
    const roughness = u ? u.roughness : (previous.roughnessNode ?? float(material.roughness ?? .12));
    // The distortion belongs in ONE space: the wave normal against the same
    // surface's flat normal, both viewed from the camera, so it vanishes to
    // zero on flat water instead of drifting with where the camera points.
    const flatNormalView = transformDirection(cameraViewMatrix, modelNormalMatrix.mul(vec3(0, 1, 0)).normalize()).normalize();
    const uv = screenUV.flipX().add(normalView.sub(flatNormalView).xy.mul(distortion)).clamp(.001, .999);
    const reflected = node.sample(uv).level(float(roughness).clamp(0, 1).mul(6)).rgb.mul(fresnel).mul(gain);

    let emissive = vec3(previous.emissiveNode ?? 0);
    if (u) {
      // Foam is WHITE, ROUGH AND OPAQUE — a material, not a glow, and not a
      // mirror either.
      const soft = waterFoamNode(u, engine?.scenePass?.getTexture?.("depth") ?? null).toVar();
      // ── ⛔ `style` EXISTED ONLY IN A MATERIAL NOBODY USES ─────────────────
      //
      // The banding and the hard foam edge that make "stylized" stylized were
      // written into the GENERATED water material, and every water in practice
      // wears an authored one (`builtin:Water.mat`), so the dropdown moved
      // nothing: a property sweep scored it at a BIT-IDENTICAL zero. Same shape
      // as colour, saturation, foam, roughness, caustic intensity and
      // transmission before it — which is why there is now a test that sets
      // every control to both ends of its range and measures the frame.
      //
      // Two things separate a stylized surface from a realistic one, and both
      // belong here, where the authored material is actually composed: the
      // colour steps instead of graduating, and the foam has an EDGE instead of
      // a falloff. Nothing else changes, so the dropdown is a look and not a
      // second water.
      const foam = mix(soft, soft.smoothstep(.28, .34), u.stylized).toVar();
      const baseColor = vec3(previous.colorNode ?? materialColor).toVar();
      const banded = baseColor.mul(4).add(.5).floor().div(4);
      material.colorNode = mix(mix(baseColor, banded, u.stylized), vec3(1), foam);
      material.roughnessNode = mix(float(roughness), float(.85), foam);
      // ── ⛔ THE DIAL WAS BAKED INTO THE GRAPH AT BUILD TIME ────────────────
      //
      // This read `previous.transmission` — the AUTHORED material's value,
      // captured once — and compiled it in as a constant. `gridSimulation`
      // dutifully wrote `material.transmission` on every prop change, and a
      // `transmissionNode` overrides that property completely, so the slider
      // moved a number three had stopped reading: "refraction does not change
      // anything when changing, and does not seem to be working" (user,
      // 2026-09-06). The water's own uniform is the live one, and using it also
      // makes the control work on an AUTHORED material, which is every water in
      // practice — the fifth control to have had exactly this shape.
      const through = u.transmission;
      material.transmissionNode = mix(float(through), float(0), foam);
      // Refraction needs a THICKNESS: with zero, three's transmission is a
      // perfectly clear window and the surface bends nothing at all. See
      // `waterCaustics.js`'s `updateWaterSlot` for why this is a uniform in
      // world metres divided by the mesh's own scale rather than the volume
      // depth it used to be — the depth put the exit point metres away and
      // sampled the shore, which is the ghost that got the mirror blamed.
      material.thicknessNode = u.refraction;
      emissive = emissive.add(reflected.mul(foam.oneMinus()));
      if (slot) emissive = emissive.add(waterSubsurfaceNode(u, slot).mul(foam.oneMinus()));
    } else {
      emissive = emissive.add(reflected);
    }
    material.emissiveNode = emissive;
    material.userData.giWater = true;
    material.needsUpdate = true;
    reportBindings();
  };

  /**
   * ── A RECEIPT FOR THE ONE LIMIT NO HARNESS CAN SEE ────────────────────
   *
   * The water's fragment stage binds the medium's slot arrays, the depth
   * texture, the mirror, the transmission target, the sea's derivatives —
   * and, only in the editor, the shadow maps, the environment and GI. The
   * portable limit is sixteen and the harness counts nine; the editor
   * reported seventeen ("The number of sampled textures (17) in the Fragment
   * stage exceeds the maximum per-stage limit (16)", 2026-09-06). So the
   * compiled shader is asked, once per build, and the census goes to the
   * console where `console_read` can see it — by TYPE, since the declarations
   * are anonymous, which is enough to say what the editor adds.
   */
  let reportTimer = null;
  const reportBindings = () => {
    const renderer = engine?.renderer;
    if (!renderer?.debug?.getShaderAsync || !engine?.scene || !engine?.camera) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(async () => {
      if (disposed) return;
      // The water's own two, then every other material in the scene: the
      // medium (`scene.fogNode`) and the caustic light compile into ALL of
      // them, so a material that was one binding under the limit before the
      // water arrived is the one that fails after — and three names the
      // pipeline, not the material.
      const seen = new Set();
      const census = [["water lid", mesh], ["water body", mesh.children?.find?.((c) => c.userData?.vfxSimulation === "water")]];
      engine.scene.traverse((o) => {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!o.isMesh || !m || o === mesh || o.parent === mesh || seen.has(m.uuid) || seen.size > 12) return;
        if (!m.isNodeMaterial || m.userData?.engineOwned) return;
        seen.add(m.uuid);
        census.push([`${o.name || o.type} / ${m.name || m.type}`, o]);
      });
      for (const [label, object] of census) {
        if (!object) continue;
        try {
          const { fragmentShader } = await renderer.debug.getShaderAsync(engine.scene, engine.camera, object);
          const kinds = {};
          for (const m of fragmentShader.matchAll(/@binding\(\s*\d+\s*\)\s*@group\(\s*\d+\s*\)\s*var\s+\w+\s*:\s*(texture_[\w]+)/g)) {
            if (m[1].startsWith("texture_storage")) continue;
            kinds[m[1]] = (kinds[m[1]] ?? 0) + 1;
          }
          const total = Object.values(kinds).reduce((a, b) => a + b, 0);
          console.log(`[water] ${label}: fragment binds ${total} sampled textures (portable limit 16): ${
            Object.entries(kinds).map(([k, n]) => `${n}× ${k}`).join(", ")}${total > 16 ? " ⛔ OVER THE LIMIT" : ""}`);
        } catch (error) { console.log(`[water] ${label}: binding census failed: ${error?.message ?? error}`); }
      }
    }, 3000);
  };

  const onWave = () => { if (!disposed && ++rearms <= 8) queueMicrotask(() => { if (!disposed) build(); }); };
  engine?.on?.('gi-compile-wave-done', onWave);
  // The scene pass is (re)created after the water more often than not.
  const onPass = () => { if (!disposed) queueMicrotask(() => { if (!disposed) build(); }); };
  engine?.on?.('scene-pass-changed', onPass);
  build(); update();
  return {
    update, gain, distortion,
    get node() { return node; },
    get base() { return node?._reflectorBaseNode ?? null; },
    dispose() {
      if (disposed) return; disposed = true;
      clearTimeout(reportTimer);
      engine?.off?.('gi-compile-wave-done', onWave);
      engine?.off?.('scene-pass-changed', onPass);
      node?.dispose(); target.removeFromParent();
      material.emissiveNode = previous.emissiveNode; material.colorNode = previous.colorNode;
      material.roughnessNode = previous.roughnessNode; material.normalNode = previous.normalNode;
      material.transmissionNode = previous.transmissionNode; material.thicknessNode = previous.thicknessNode;
      if (previous.giWater === undefined) delete material.userData.giWater;
      else material.userData.giWater = previous.giWater;
      material.needsUpdate = true;
    },
  };
}
