import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-water-authoring-"));
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new", userDataDir: path.join(root, "profile"),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
page.on("console", (message) => {
  if (message.type() === "error" || /GPUValidationError|validation error|exceeds the maximum|VFX.*failed|Particle graph failed/i.test(message.text())) errors.push(`${message.text()} ${message.location().url ?? ""}`);
});
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${name}`); };
const node = (id) => `.vfx-panel .react-flow__node[data-id="${id}"]`;
async function field(id, label) {
  const handle = await page.evaluateHandle((selector, label) => [...document.querySelectorAll(`${selector} .shader-node-row.field`)]
    .find((row) => row.querySelector(".param-label")?.textContent === label)?.querySelector("input"), node(id), label);
  assert.ok(handle.asElement(), `${id} has field ${label}`);
  return handle.asElement();
}
async function editNumber(id, label, value) {
  const input = await field(id, label);
  await input.click();
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.type(String(value)); await page.keyboard.press("Enter");
}
async function button(text) {
  const handle = await page.evaluateHandle((text) => [...document.querySelectorAll(".vfx-panel button")].find((b) => b.textContent.trim().startsWith(text)), text);
  assert.ok(handle.asElement(), `button ${text} exists`);
  await handle.asElement().click();
}
async function apply() { await button("Apply"); }
async function undo(redo = false) {
  const pane = await page.$(".vfx-panel .react-flow__pane");
  const bounds = await pane.boundingBox();
  await page.mouse.move(bounds.x + 12, bounds.y + 12);
  await page.keyboard.down("Control");
  if (redo) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (redo) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}
try {
  await page.setViewport({ width: 1600, height: 1000 });
  await installTauriShim(page, { writableRoot: root });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const icon = document.createElement("link"); icon.rel = "icon"; icon.href = "data:,"; document.head.append(icon);
    }, { once: true });
    globalThis.__vfxMouseEvents = [];
    for (const type of ["click", "dblclick"]) document.addEventListener(type, (event) => __vfxMouseEvents.push({ type, target: event.target.outerHTML?.slice(0, 400), x: event.clientX, y: event.clientY }), true);
    globalThis.__importLive = (p) => {
      const prefix = location.origin + p;
      const resources = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
      return import(resources.find((n) => n.includes("?")) ?? resources[0] ?? p);
    };
  });
  await page.goto(process.argv[2] ?? "http://localhost:5307/", { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Skip the project"))?.click());
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await page.evaluate(async () => {
    const { engine } = await __importLive("/src/editor/engineInstance.js");
    const { callOp } = await __importLive("/src/editor/api/registry.js");
    const { openPanel, PANEL_SPECS } = await __importLive("/src/editor/EditorShell.jsx");
    globalThis.__vfxEngine = engine; globalThis.__vfxCall = callOp; globalThis.__openPanel = openPanel;
    globalThis.__panelNames = [PANEL_SPECS.particles.title, PANEL_SPECS.vfx.title];
  });
  await page.evaluate(async(root)=>{const{useProjectStore}=await __importLive('/src/editor/store/projectStore.js');useProjectStore.setState({rootPath:root,currentPath:root});},root);
  await page.evaluate(()=>__openPanel('hierarchy'));
  await page.waitForSelector('.hierarchy-panel .panel-toolbar .toolbar-btn');await page.click('.hierarchy-panel .panel-toolbar .toolbar-btn');
  await page.waitForFunction(()=>[...document.querySelectorAll('.component-item-label')].some(e=>e.textContent==='Water'));
  await (await page.evaluateHandle(()=>[...document.querySelectorAll('.hierarchy-panel .component-item')].find(e=>e.querySelector('.component-item-label')?.textContent==='Water'))).asElement().click();
  await page.waitForFunction(()=>[...__vfxEngine.entities.values()].some(e=>e.getComponent('water')?.planeSource),{timeout:30000});
  const created=await page.evaluate(()=>{const e=[...__vfxEngine.entities.values()].find(e=>e.getComponent('water'));globalThis.__waterEntity=e;const m=e.getComponent('mesh'),w=e.getComponent('water');
    return {geometry:m.props.geometry,material:m.props.material,sourceHidden:!m.mesh.visible,cloned:w.simulation.mesh.material!==m.mesh.material,rotation:e.object3D.rotation.x,
      box:!!w.planeSource?.box,depth:w.resolvedProps.waterDepth,width:w.resolvedProps.width,height:w.resolvedProps.height,
      slot:!!w.waterSlot,medium:!!__vfxEngine.scene.fogNode,skirt:w.simulation.vertexCount>w.simulation.count};});
  // WATER IS A VOLUME NOW: Create > Water makes a BOX, and the box IS the body
  // of water — X/Z are the footprint, Y is the depth, and no -90° rotation is
  // needed because a box is already Y-up. A Plane still works and still means
  // "surface plus waterDepth below it"; it is simply no longer what you get.
  check('Create Water owns a box VOLUME, named material and per-instance surface',
    created.geometry==='box'&&created.material==='builtin:Water.mat'&&created.sourceHidden&&created.cloned&&Math.abs(created.rotation)<1e-6);
  check('The box is the water volume — footprint and depth come from its geometry',
    created.box&&created.depth===1&&created.width===1&&created.height===1);
  check('And it renders as a body, lights through a slot and installs the medium',
    created.skirt&&created.slot&&created.medium);
  await page.evaluate(()=>__openPanel('inspector'));await page.waitForSelector('[data-water-material-edit]');await page.click('[data-water-material-edit]');
  await page.waitForSelector('.react-flow__node[data-id="water"]');
  const input=await page.evaluateHandle(()=>[...document.querySelectorAll('.react-flow__node[data-id="water"] .shader-node-row')].find(row=>row.textContent.toLowerCase().includes('roughness'))?.querySelector('input'));
  assert.ok(input.asElement(),'Water roughness socket editable');await input.asElement().click();await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type('0.23');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>__waterEntity.getComponent('mesh').props.material!=='builtin:Water.mat',{timeout:15000});
  const fork=await page.evaluate(()=>__waterEntity.getComponent('mesh').props.material);
  const def=JSON.parse(fs.readFileSync(fork,'utf8'));
  check('First Water material edit forks editable project asset retaining transmission pipeline',def.shaderGraph.nodes.find(n=>n.id==='water').props.roughness===.23&&def.pipeline.transparent===true);
  check('Built-in Water remains unchanged',await page.evaluate(async()=>{const{getMaterialDef}=await __importLive('/src/engine/materialAsset.js');return getMaterialDef('builtin:Water.mat').shaderGraph.nodes.find(n=>n.id==='water').props.roughness===.12;}));
  await page.evaluate(async()=>{const{commandBus}=await __importLive('/src/editor/commands/CommandBus.js');commandBus.undo();});
  await page.waitForFunction(()=>__waterEntity.getComponent('mesh').props.material==='builtin:Water.mat');
  check('Undo restores built-in Water assignment',true);
  await page.screenshot({path:path.join(root,'water-authoring.png')});check('No editor/GPU errors',errors.length===0);
  console.log(`WATER-AUTHORING PASS\nArtifacts: ${root}`);
} catch(error){console.error(error,errors);await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.error(`Artifacts: ${root}`);process.exitCode=1;}finally{await browser.close();}
