import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three/webgpu";
import Attributes from "three/src/renderers/common/Attributes.js";
import Geometries from "three/src/renderers/common/Geometries.js";
import Info from "three/src/renderers/common/Info.js";
import { UiTextComponent } from "../src/engine/components/ui/UiTextComponent.js";
import { createUiSdfTextMaterial } from "../src/engine/ui/uiMaterial.js";
import { layoutGlyphs } from "../src/engine/ui/sdfFont.js";

// Font metrics only are synthetic. Glyph layout, component updates and Three's
// attribute allocation/disposal managers are the actual production code.
const font = {
  ascent: 0.8, descent: 0.2,
  advance: ch => ch === " " ? 0.3 : 0.4 + (ch.charCodeAt(0) % 5) * 0.03,
  glyph(ch) {
    if (ch === " ") return null;
    const u0 = (ch.charCodeAt(0) % 16) / 16;
    return { x: 0, top: 0.8, w: this.advance(ch), h: 1,
      u0, v0: 0.25, u1: u0 + 1 / 16, v1: 0.75 };
  },
};

// Restore just the old allocation policy, leaving its glyph math identical.
// This control must reproduce the exact 480 B vertex + 144 B index growth
// seen at every six-glyph FPS label update in the player soak capture.
const source = readFileSync(new URL("../src/engine/components/ui/UiTextComponent.js", import.meta.url), "utf8");
const begin = source.indexOf("  #buildGlyphs(");
const end = source.indexOf("\n  onUiLayout(", begin);
assert.ok(begin >= 0 && end > begin);
const productionGlyphs = source.slice(begin, end);
const legacyGlyphs = productionGlyphs
  .replace(/    \/\/ Replacing attributes[\s\S]*?    const ox =/, `    const positions = new Float32Array(count * 4 * 3);
    const uvs = new Float32Array(count * 4 * 2);
    const indices = new Uint32Array(count * 6);
    const ox =`)
  .replace("if (!reuse) indices.set", "indices.set")
  .replace(/    if \(reuse\) \{[\s\S]*?\n    \}/, `    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));`);
assert.notEqual(legacyGlyphs, productionGlyphs);
const Legacy = new Function("THREE", "layoutGlyphs", `return class {
  ${legacyGlyphs}
  layout(w, h, spec) { this.#buildGlyphs(w, h, spec); }
};`)(THREE, layoutGlyphs);

function fixture({ legacy = false } = {}) {
  const component = legacy ? new Legacy() : new UiTextComponent();
  component.props = { ...UiTextComponent.defaults, wrap: false };
  component.font = font;
  component.mode = "sdf";
  component.geometry = new THREE.BufferGeometry();
  component.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  component.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(0), 2));
  component.mesh = new THREE.Mesh(component.geometry, createUiSdfTextMaterial(new THREE.Texture()));
  component.entity = { object3D: new THREE.Object3D() };
  component.entity.object3D.add(component.mesh);

  const live = new Map(), created = [], destroyed = [], writes = [];
  const allocate = attribute => {
    assert.ok(!live.has(attribute));
    live.set(attribute, attribute.array.slice());
    created.push(attribute);
  };
  const backend = {
    createAttribute: allocate, createIndexAttribute: allocate,
    updateAttribute(attribute) {
      const buffer = live.get(attribute);
      assert.ok(buffer, "updates target an allocated buffer");
      assert.equal(buffer.byteLength, attribute.array.byteLength, "GPU buffers cannot resize in place");
      buffer.set(attribute.array);
      writes.push(attribute);
    },
    destroyAttribute(attribute) {
      assert.ok(live.delete(attribute), "each allocated buffer is released exactly once");
      destroyed.push(attribute);
    },
  };
  const info = new Info();
  const attributes = new Attributes(backend, info);
  const geometries = new Geometries(attributes, info);
  const renderObjects = new WeakMap();
  function render() {
    const geometry = component.mesh.geometry;
    let object = renderObjects.get(geometry);
    if (!object) {
      object = { geometry, material: { wireframe: false },
        getAttributes: () => Object.values(geometry.attributes) };
      renderObjects.set(geometry, object);
    }
    info.render.calls++;
    geometries.updateForRender(object);
  }
  function update(text, { w = 240, h = 50, pivot = [0.5, 0.5], ...style } = {}) {
    Object.assign(component.props, style, { text });
    const spec = { pivot };
    if (legacy) component.layout(w, h, spec);
    else {
      // onUiLayout only needs document as its headless guard here; the SDF
      // atlas is already supplied, so no browser or GPU operation is invoked.
      const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
      Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
      try {
        component.onUiLayout({ rect: { w, h }, clipRect: { x: 0, y: 0, w, h },
          alpha: 1, k: 1, order: 0, spec });
      } finally {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else delete globalThis.document;
      }
    }
    render();
  }
  function snapshot() {
    const geometry = component.geometry;
    return {
      position: Array.from(live.get(geometry.getAttribute("position"))),
      uv: Array.from(live.get(geometry.getAttribute("uv"))),
      index: Array.from(live.get(geometry.index)),
      drawRange: { ...geometry.drawRange },
      box: [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()],
      sphere: [geometry.boundingSphere.center.toArray(), geometry.boundingSphere.radius],
    };
  }
  function dispose() {
    if (legacy) component.geometry.dispose();
    else component.onDetach();
  }
  return { component, info, live, created, destroyed, writes, update, render, snapshot, dispose };
}

test("600 FPS label updates reuse three GPU buffers and upload changed glyphs", () => {
  const f = fixture();
  f.update("FPS: 80");
  const geometry = f.component.geometry;
  const original = f.snapshot();
  for (let i = 0; i < 600; i++) f.update(`FPS: ${10 + i % 90}`);
  assert.equal(f.component.geometry, geometry);
  assert.equal(f.created.length, 3);
  assert.equal(f.live.size, 3);
  assert.equal(f.info.memory.attributes, 2);
  assert.equal(f.info.memory.attributesSize, 480);
  assert.equal(f.info.memory.indexAttributes, 1);
  assert.equal(f.info.memory.indexAttributesSize, 144);
  assert.equal(f.writes.length, 1200, "two versioned vertex uploads per changed label");
  assert.ok(f.writes.every(attribute => attribute !== geometry.index), "quad topology never reuploads");
  assert.notDeepEqual(f.snapshot().uv, original.uv, "new digits reached the simulated GPU buffer");
  const before = f.writes.length;
  for (let i = 0; i < 10; i++) f.render();
  f.update(f.component.props.text);
  assert.equal(f.writes.length, before, "unchanged layout and extra render passes do not upload");
  f.dispose();
  assert.equal(f.live.size, 0);
  assert.equal(f.info.memory.total, 0);
});

test("length changes release all old buffers before replacement and detach releases the last set", () => {
  const f = fixture();
  for (const text of ["FPS: 80", "FPS: 120", "FPS: 9", "", "FPS: 60", "longer status message"]) {
    const previous = f.component.geometry;
    let disposedWhileAttached = false;
    previous.addEventListener("dispose", () => {
      disposedWhileAttached = f.component.geometry === previous && f.component.mesh.geometry === previous;
    });
    f.update(text);
    assert.notEqual(f.component.geometry, previous);
    assert.equal(disposedWhileAttached, true, "Three sees the old attributes when disposal fires");
    assert.equal(f.live.size, 3);
    assert.equal(f.info.memory.geometries, 1);
    assert.equal(f.info.memory.attributes, 2);
    assert.equal(f.info.memory.indexAttributes, 1);
    assert.equal(f.component.geometry.drawRange.count, text.replaceAll(" ", "").length * 6);
  }
  f.dispose();
  assert.equal(f.live.size, 0);
  assert.equal(f.destroyed.length, f.created.length);
  assert.equal(f.info.memory.total, 0);
  assert.equal(f.info.memory.geometries, 0);
  f.dispose();
  assert.equal(f.destroyed.length, f.created.length, "repeated detach is harmless");
});

test("positions, UVs, winding, draw range and bounds match the original for text and layout changes", () => {
  const f = fixture(), original = fixture({ legacy: true });
  for (const [text, layout] of [
    ["FPS: 80", {}], ["FPS: 91", {}],
    ["FPS: 91", { w: 310, h: 80, pivot: [0.1, 0.9], align: "right", valign: "bottom" }],
    ["FPS: 120", { fontSize: 30, align: "left", valign: "top" }],
    ["two lines\nhere", { wrap: true, w: 50, lineHeight: 1.5 }], ["", {}],
  ]) {
    f.update(text, layout);
    original.update(text, layout);
    assert.deepEqual(f.snapshot(), original.snapshot(), `unchanged visible geometry: ${JSON.stringify(text)}`);
  }
  f.dispose();
  original.dispose();
});

test("negative control reproduces the player's exact leaked attribute sizes", () => {
  const f = fixture({ legacy: true });
  for (let i = 0; i < 81; i++) f.update(`FPS: ${10 + i}`);
  assert.equal(f.info.memory.geometries, 1);
  assert.equal(f.info.memory.attributes, 162);
  assert.equal(f.info.memory.indexAttributes, 81);
  assert.equal(f.info.memory.attributesSize, 81 * 480);
  assert.equal(f.info.memory.indexAttributesSize, 81 * 144);
  f.dispose();
  assert.equal(f.live.size, 80 * 3, "final geometry disposal cannot reach replaced attributes");
});
