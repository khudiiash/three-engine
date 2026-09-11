import assert from "node:assert/strict";
import test from "node:test";
import { DepthTexture, DirectionalLight, Object3D, PerspectiveCamera, Vector3 } from "three/webgpu";
import * as TSL from "three/tsl";
import { lensflare } from "three/addons/tsl/display/LensflareNode.js";
import { radialBlur } from "three/addons/tsl/display/radialBlur.js";
import { compilePostGraph, PP_NODE_TYPES } from "../src/modules/postprocessing/postGraph.js";
import { volumetricFog, cloudNoiseTexture } from "../src/modules/postprocessing/volumetricFog.js";

/**
 * VOLUMETRIC FOG / LENS FLARE / RADIAL BLUR — the three post nodes ported from
 * three's WebGPU examples (2026-09-09).
 *
 * Run with `node --test tests/post-volumetric-fog.test.mjs`.
 *
 * What this can and cannot see: `compilePostGraph` builds a NODE GRAPH; the
 * WGSL is only generated later, by a real renderer. So these assertions are
 * about the CPU-side contract — what the builder hands the effect, what it
 * refuses, whether the animation clock is wired — which is exactly the layer
 * where the God Rays outage lived (`blendNode.sample is not a function`: an
 * input of the wrong shape, accepted silently, throwing at shader build and
 * taking the whole chain down with it).
 */

const CAMERA = new PerspectiveCamera(50, 1, 0.1, 1000);

/** Stands in for the scene pass's colour texture node. */
function fakeColorNode() {
  return TSL.vec4(0.25, 0.5, 0.75, 1);
}

/**
 * Stands in for the scene pass's DEPTH texture node: the thing that matters
 * about it is that it is samplable at an arbitrary uv, because the JBU guide
 * reads 25 shifted taps of it.
 */
function fakeDepthTextureNode() {
  const node = TSL.float(0.5);
  node.sample = () => TSL.vec4(0.5);
  return node;
}

function graphFor(type, props = {}, { depth = true } = {}) {
  const edges = [
    { source: "in", sourceHandle: "color", target: "fx", targetHandle: "color" },
    { source: "fx", sourceHandle: "out", target: "out", targetHandle: "color" },
  ];
  if (depth) {
    edges.splice(1, 0, { source: "in", sourceHandle: "depth", target: "fx", targetHandle: "depth" });
  }
  return {
    nodes: [
      { id: "in", type: "input", props: {}, position: { x: 0, y: 0 } },
      { id: "fx", type, props, position: { x: 0, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges,
  };
}

function ctx(extra = {}) {
  return {
    camera: CAMERA,
    beautyNode: fakeColorNode(),
    depthNode: fakeDepthTextureNode(),
    normalNode: null,
    velocityNode: null,
    volumetricFog,
    lensflare,
    radialBlur,
    gaussianBlur: null,
    temps: new Set(),
    ...extra,
  };
}

test("the noise field never blocks the caller", () => {
  // The generator costs 0.18–2.1 s of straight-line JS depending on size, which
  // is why it runs in a worker. Here (node, no Worker constructor) the contract
  // is that the texture comes back immediately, flat — "no fog", not a stall.
  const t0 = performance.now();
  const texture = cloudNoiseTexture(96);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 100, `cloudNoiseTexture blocked for ${elapsed.toFixed(0)} ms`);
  assert.equal(texture.image.data.length, 96 ** 3);
  // Memoised per size: a pipeline rebuild happens on every structural post
  // edit, and regenerating the field on each one would be unusable.
  assert.equal(cloudNoiseTexture(96), texture);
});

test("volumetric fog compiles and exposes both outputs", () => {
  const compiled = compilePostGraph(graphFor("volumetricFog"), ctx());
  assert.ok(compiled.output, "no output node");
  assert.notEqual(compiled.signature, "__passthrough__");

  // The raw fog factor is a real second socket, not an alias of the composite.
  const withFogSocket = graphFor("volumetricFog");
  withFogSocket.edges[withFogSocket.edges.length - 1] = {
    source: "fx",
    sourceHandle: "fog",
    target: "out",
    targetHandle: "color",
  };
  assert.ok(compilePostGraph(withFogSocket, ctx()).output);
});

test("the march is kept alive and runs offscreen at the node's resolution", () => {
  const temps = new Set();
  compilePostGraph(graphFor("volumetricFog", { resolutionScale: "0.25" }), ctx({ temps }));
  const rtt = [...temps].find((node) => node.isRTTNode);
  assert.ok(rtt, "the fog's RTT pass was not registered in the keepalive set");
  // Nothing else references the RTT once the upsample has sampled it; without
  // the keepalive it can be collected while the pipeline still renders it.
  assert.equal(rtt.getResolutionScale(), 0.25);
});

test("a depth input that cannot be sampled degrades to a passthrough", () => {
  // The God Rays shape: the JBU guide samples depth at 25 shifted uvs, so a
  // plain float there throws at TSL build time and takes the chain down. The
  // builder has to refuse it while the graph is still on the CPU.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const compiled = compilePostGraph(
      graphFor("volumetricFog"),
      ctx({ depthNode: TSL.float(0.5) }), // no `.sample`
    );
    assert.ok(compiled.output);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((w) => /Volumetric Fog: needs the Input node's Depth socket/.test(w)),
    `expected a depth-socket warning, got: ${warnings.join(" | ")}`,
  );
});

test("fog params are hot, and the clouds are driven by a registered tick", () => {
  const compiled = compilePostGraph(graphFor("volumetricFog", { density: 1.05 }), ctx());

  // Hot params write into live uniforms — a slider drag must not rebuild the
  // pipeline (which also re-mints every material sharing a program with it).
  assert.doesNotThrow(() => compiled.updateParams(graphFor("volumetricFog", { density: 2.5 })));

  // The drift is accumulated from the engine delta, not read off TSL's global
  // clock; without a registered ticker the fog is a still image.
  assert.equal(compiled.tickers.length, 1, "the fog registered no per-frame tick");
  assert.doesNotThrow(() => compiled.tickers[0](0.016));
});

test("the cloud clock advances with speed and survives a backgrounded tab", () => {
  const built = volumetricFog({
    colorNode: fakeColorNode(),
    depthNode: fakeDepthTextureNode(),
    camera: CAMERA,
    params: { cloudSpeed: 1 },
  });
  assert.equal(built.time.value, 0);

  built.tick(0.05);
  assert.ok(Math.abs(built.time.value - 0.05) < 1e-9, `clock read ${built.time.value}`);

  // A tab hidden for half a minute hands back a 30-second delta. Applied
  // straight, the clouds jump to a completely different field on the first
  // frame back; the clamp caps one frame's worth of drift.
  built.tick(30);
  assert.ok(Math.abs(built.time.value - 0.15) < 1e-9, `clock read ${built.time.value}`);

  // Speed 0 must actually freeze, not creep.
  built.setParams({ cloudSpeed: 0 });
  built.tick(0.016);
  assert.ok(Math.abs(built.time.value - 0.15) < 1e-9, "cloudSpeed 0 did not freeze the clouds");
});

test("the denoiser select takes the panel's own option strings", () => {
  // The panel stores the LABEL ("JBU" / "Gaussian" / "Off"), not a slug, so a
  // case-sensitive comparison inside the effect would send every mode down the
  // JBU branch and the dropdown would look inert.
  const calls = [];
  const recordingBlur = (node, radius) => {
    calls.push({ node, radius });
    return TSL.vec4(1);
  };
  volumetricFog({
    colorNode: fakeColorNode(),
    depthNode: fakeDepthTextureNode(),
    camera: CAMERA,
    params: { denoiser: "Gaussian" },
    gaussianBlur: recordingBlur,
  });
  assert.equal(calls.length, 1, "Gaussian mode did not reach the blur addon");
});

test("the fog reads the sun in WORLD space, not local", () => {
  // Lights are parented to their entity (`entity.object3D.add(light)`) exactly
  // like cameras are, so `light.position` is a LOCAL offset. Reading it
  // directly points the scattering phase in a direction the sun does not
  // occupy, and the fog glows on the wrong side of the sky.
  const rig = new Object3D();
  rig.position.set(100, 0, 0);
  const light = new DirectionalLight(0x4080ff, 2);
  light.position.set(0, 10, 0); // local; world is (100, 10, 0)
  rig.add(light);
  rig.updateMatrixWorld(true);

  const built = volumetricFog({
    colorNode: fakeColorNode(),
    depthNode: fakeDepthTextureNode(),
    camera: CAMERA,
    params: {},
    light,
  });

  const expected = new Vector3(100, 10, 0).normalize();
  const dir = built.sun.direction.value;
  assert.ok(
    Math.abs(dir.x - expected.x) < 1e-6 && Math.abs(dir.y - expected.y) < 1e-6,
    `sun direction ${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)} is the LOCAL offset, not world`,
  );

  // Colour carries intensity: the fog scatters radiance, not a swatch.
  assert.ok(built.sun.color.value.b > built.sun.color.value.r, "sun colour did not reach the fog");
  assert.ok(built.sun.color.value.b > 1, "light intensity was dropped");
});

test("sun shafts require a shadow map and honour the toggle", () => {
  const light = new DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  const withMap = () => {
    light.shadow.map = { depthTexture: new DepthTexture(4, 4) };
    return light;
  };
  const build = (params, l) =>
    volumetricFog({
      colorNode: fakeColorNode(),
      depthNode: fakeDepthTextureNode(),
      camera: CAMERA,
      params,
      light: l,
    });

  // No map yet (three renders shadows after the first frame) — lit uniformly
  // rather than throwing on `shadow.map.depthTexture`, which is the shape of
  // the God Rays boot-order outage.
  light.shadow.map = null;
  assert.equal(build({}, light).sun.shadowed, false);

  assert.equal(build({}, withMap()).sun.shadowed, true);
  assert.equal(build({ sunShadows: false }, withMap()).sun.shadowed, false);

  // No sun at all: ambient-only fog, no throw.
  const dark = build({}, null);
  assert.equal(dark.sun.shadowed, false);
  assert.equal(dark.sun.color.value.r, 0);
});

test("lens flare and radial blur compile from the palette defaults", () => {
  for (const type of ["lensflare", "radialBlur"]) {
    const compiled = compilePostGraph(graphFor(type, {}, { depth: false }), ctx());
    assert.ok(compiled.output, `${type} produced no output`);
    assert.notEqual(compiled.signature, "__passthrough__");
    assert.doesNotThrow(
      () => compiled.updateParams(graphFor(type, { threshold: 0.2, weight: 0.5, count: 48 }, { depth: false })),
      `${type} params are not hot`,
    );
  }
});

test("every new node type declares params the panel can render", () => {
  const RENDERABLE = new Set(["number", "color", "boolean", "select"]);
  for (const type of ["volumetricFog", "lensflare", "radialBlur"]) {
    const meta = PP_NODE_TYPES[type];
    assert.ok(meta, `${type} is missing from the registry`);
    assert.ok(meta.label && meta.category, `${type} has no label/category`);
    for (const param of meta.params) {
      assert.ok(RENDERABLE.has(param.type), `${type}.${param.key} has unrenderable type ${param.type}`);
      assert.ok(param.default !== undefined, `${type}.${param.key} has no default`);
      if (param.type === "select") assert.ok(param.options?.includes(param.default));
      // A "hot" param must survive a `updateParams` round trip without a
      // rebuild, so it must NOT appear in the structural signature.
      assert.ok(["hot", "struct"].includes(param.kind), `${type}.${param.key} has no kind`);
    }
  }
});
