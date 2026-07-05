// Headless smoke test of the full UI runtime: engine + components + UiSystem
// layout pass with a stubbed renderer (no WebGPU, no DOM).
// Run: node scripts/test-ui-system.mjs
import * as THREE from "three/webgpu";
import { Engine, getUiSystem, serializeScene, deserializeScene } from "../src/engine/index.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}
function near(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

const engine = new Engine();
// Stub just enough renderer for the layout pass (render() stays guarded off
// by rendererReady=false).
engine.renderer = {
  getSize: (v) => v.set(1920, 1080),
  getPixelRatio: () => 2,
  domElement: null,
  shadowMap: {}, // applySettingsToScene touches these on scene clear
  toneMapping: 0,
  toneMappingExposure: 1,
};

// --- Build a UI: screen (fit 1280x720) > panel (centered 400x300) with a
// mask > stretched image child; plus a scroll view with a tall layout list.
const screenEntity = engine.createEntity({ name: "Screen" });
const screen = screenEntity.addComponent("uiscreen", {
  referenceWidth: 1280,
  referenceHeight: 720,
  scaleMode: "fit",
});

const panel = engine.createEntity({ name: "Panel", parent: screenEntity });
panel.addComponent("uielement", { size: [400, 300] });
panel.addComponent("uiimage", { color: "#1c1d22", cornerRadius: 12 });
panel.addComponent("uimask");

const inner = engine.createEntity({ name: "Inner", parent: panel });
inner.addComponent("uielement", {
  anchorMin: [0, 0],
  anchorMax: [1, 1],
  pos: [10, 10],
  size: [10, 10],
  opacity: 0.5,
});
inner.addComponent("uiimage", { color: "#ff0000" });

const scrollView = engine.createEntity({ name: "Scroll", parent: screenEntity });
scrollView.addComponent("uielement", {
  anchorMin: [0, 0],
  anchorMax: [0, 0],
  pivot: [0, 0],
  pos: [20, 20],
  size: [200, 300],
});
const scroll = scrollView.addComponent("uiscroll");
const content = engine.createEntity({ name: "Content", parent: scrollView });
content.addComponent("uielement", {
  anchorMin: [0, 0],
  anchorMax: [1, 0],
  pivot: [0.5, 0],
  size: [0, 300],
});
content.addComponent("uilayout", { gap: 10, padding: 0, fitContent: true });
for (let i = 0; i < 10; i++) {
  const row = engine.createEntity({ name: `Row${i}`, parent: content });
  row.addComponent("uielement", { size: [0, 50] });
  row.addComponent("uiimage", {});
  row.addComponent("uibutton", {});
}

const system = getUiSystem(engine);
system.update(); // layout pass 1 (measures scroll content)
system.update(); // pass 2 (clamped scroll applied)

// --- Screen scaling: 1920x1080 with fit(1280x720) → scale 1.5, UI space 1280x720.
check("screen scale", near(screen.scale, 1.5), `got ${screen.scale}`);
check("screen ui size", near(screen.uiWidth, 1280) && near(screen.uiHeight, 720));
check("k = scale × dpr", near(screen.k, 3), `got ${screen.k}`);

// --- Panel rect: centered 400x300 in 1280x720.
const panelEl = panel.getComponent("uielement");
check(
  "panel rect centered",
  near(panelEl.rect.x, 440) && near(panelEl.rect.y, 210) && near(panelEl.rect.w, 400) && near(panelEl.rect.h, 300),
  JSON.stringify(panelEl.rect),
);
check(
  "panel object3D position (pivot at center, y-down → -y)",
  near(panel.object3D.position.x, 640) && near(panel.object3D.position.y, -360),
  `${panel.object3D.position.x}, ${panel.object3D.position.y}`,
);

// --- Inner: stretched with 10px insets, clipped by the panel mask.
const innerEl = inner.getComponent("uielement");
check(
  "inner stretched rect",
  near(innerEl.rect.x, 450) && near(innerEl.rect.y, 220) && near(innerEl.rect.w, 380) && near(innerEl.rect.h, 280),
  JSON.stringify(innerEl.rect),
);
check("inner clipped by panel mask", innerEl.clipRect && near(innerEl.clipRect.x, 440), JSON.stringify(innerEl.clipRect));
check("inner worldAlpha", near(innerEl.worldAlpha, 0.5));

// --- Image mesh wiring.
const innerImage = inner.getComponent("uiimage");
check("image mesh scaled to rect", near(innerImage.mesh.scale.x, 380) && near(innerImage.mesh.scale.y, 280));
check("image mesh on UI layer", innerImage.mesh.layers.mask === 1 << 30, `mask ${innerImage.mesh.layers.mask}`);
const u = innerImage.mesh.material.userData.uiUniforms;
check("clip uniform in physical px", near(u.clip.value.x, 440 * 3), `got ${u.clip.value.x}`);
check("alpha uniform", near(u.alpha.value, 0.5));

// --- Layout container: 10 rows × 50 + 9 gaps × 10 = 590 content height.
const layoutComp = content.getComponent("uilayout");
check("layout contentMain", near(layoutComp.contentMain, 590), `got ${layoutComp.contentMain}`);
check("scroll content measured", near(scroll.contentH, 590), `got ${scroll.contentH}`);

// --- Scrolling: request beyond range → clamped to content - viewport.
scroll.scrollTo(null, 10000);
system.update();
check("scroll clamped", near(scroll.scrollY, 290), `got ${scroll.scrollY}`);
const row0El = content.children[0].getComponent("uielement");
check("rows shifted by scroll", near(row0El.rect.y, 20 - 290), `got ${row0El.rect.y}`);
check("rows clipped to scroll rect", row0El.clipRect && near(row0El.clipRect.y, 20), JSON.stringify(row0El.clipRect));

// --- Buttons: tint state machine.
const btn = content.children[0].getComponent("uibutton");
const img = content.children[0].getComponent("uiimage");
btn.setState("pressed");
check("pressed tint applied", img.tint.getHexString() === "c2c2c2", img.tint.getHexString());
btn.setState("normal");
check("normal tint restored", img.tint.getHexString() === "ffffff");
let clicked = 0;
engine.on("ui-click", () => clicked++);
btn.click();
check("ui-click event", clicked === 1);

// --- Serialization round-trip.
const json = serializeScene(engine);
deserializeScene(engine, JSON.parse(JSON.stringify(json)));
const screen2 = [...engine.entities.values()].find((e) => e.getComponent("uiscreen"));
check("round-trip keeps screen", !!screen2);
const panel2 = screen2.children.find((e) => e.name === "Panel");
check("round-trip keeps panel props", panel2?.getComponent("uielement")?.props.size[0] === 400);
system.update();
check("relayout after deserialize", near(panel2.getComponent("uielement").rect.w, 400));

// --- Highlight API doesn't explode headless.
system.setHighlight(panel2.id);
system.update();
check("highlight mesh built", !!system.highlightMesh);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll UI system tests passed.");
