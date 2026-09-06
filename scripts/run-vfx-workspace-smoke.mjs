import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-vfx-workspace-"));
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
  assert.deepEqual(await page.evaluate(() => __panelNames), ["Particles", "VFX"]);
  await page.evaluate(()=>__openPanel("hierarchy"));
  await page.waitForSelector(".hierarchy-panel .panel-toolbar .toolbar-btn");
  for (const [kind, label] of [["particles","Particles"],["cloth","Cloth"],["water","Water"],["vfx","VFX"]]) {
    await page.evaluate(async () => { const {useSelectionStore}=await __importLive("/src/editor/store/selectionStore.js");useSelectionStore.getState().select([]); });
    await page.click(".hierarchy-panel .panel-toolbar .toolbar-btn");
    await page.waitForFunction((label)=>[...document.querySelectorAll(".hierarchy-panel .component-item-label")].some((e)=>e.textContent===label),{},label);
    const item = await page.evaluateHandle((label) => [...document.querySelectorAll(".hierarchy-panel .component-item")].find((b) => b.querySelector(".component-item-label")?.textContent === label), label);
    assert.ok(item.asElement(), `Hierarchy Create ${label}`); await item.asElement().click();
    await page.waitForFunction((kind) => [...__vfxEngine.entities.values()].some((e) => e.getComponent(kind)), {timeout:30000}, kind);
    await page.evaluate((kind) => { globalThis.__ids ??= {}; __ids[kind]=[...__vfxEngine.entities.values()].find((e)=>e.getComponent(kind)).id; }, kind);
    check(`Hierarchy creates ${label} with its own module`, await page.evaluate(async(kind)=>{const {useModulesStore}=await __importLive("/src/editor/modules.js");return useModulesStore.getState().enabled.includes(kind);},kind));
  }
  check("Cloth owns a plane and Water owns its surface",await page.evaluate(()=> !!__vfxEngine.getEntity(__ids.cloth).getComponent("mesh") && !!__vfxEngine.getEntity(__ids.water).getComponent("water").simulation));
  await page.evaluate(async()=>{
    const empty=__vfxEngine.createEntity({name:'Cloth requires plane smoke'});empty.addComponent('cloth');globalThis.__invalidCloth=empty.id;
    const {useSelectionStore}=await __importLive('/src/editor/store/selectionStore.js');useSelectionStore.getState().select(empty.id);__openPanel('inspector');
  });
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="status"]')].some((e)=>/cloth requires a plane mesh/i.test(e.textContent)));
  check("Cloth on an empty entity explains its required plane",await page.evaluate(()=>!__vfxEngine.getEntity(__invalidCloth).getComponent('cloth').simulation));
  await page.evaluate(async()=>{const{useSelectionStore}=await __importLive('/src/editor/store/selectionStore.js');useSelectionStore.getState().select([]);await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));__vfxEngine.destroyEntity(__vfxEngine.getEntity(__invalidCloth));});
  const clothContracts = await page.evaluate(async()=>{
    const THREE = await __importLive('/node_modules/.vite/deps/three_webgpu.js');
    const e=__vfxEngine.createEntity({name:'Plane material and collision contract'});
    e.object3D.position.set(20,2,0);
    const source=e.addComponent('mesh',{geometry:'plane'});
    await new Promise((resolve)=>requestAnimationFrame(resolve));
    source.mesh.geometry=new THREE.PlaneGeometry(1,1,7,7);
    const authored=new THREE.MeshStandardNodeMaterial({color:'#ff2200',side:THREE.DoubleSide});
    source.mesh.material=authored; let disposals=0;authored.addEventListener('dispose',()=>disposals++);
    const cloth=e.addComponent('cloth',{resolution:8,pinning:'none',wind:0,gust:0,sceneCollision:true,collisionRadius:.03});
    await new Promise((resolve)=>requestAnimationFrame(resolve));
    if(!cloth.simulation) throw new Error('Plane cloth failed to attach');
    const identity=cloth.simulation.mesh.material===authored;
    authored.color.set('#0088ff');
    const recolored=cloth.simulation.mesh.material.color.getHexString()==='0088ff';
    const replacement=new THREE.MeshStandardNodeMaterial({color:'#00ff44',side:THREE.DoubleSide});
    replacement.addEventListener('dispose',()=>disposals++);source.mesh.material=replacement;
    await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const replaced=cloth.simulation.mesh.material===replacement;
    const planeUvs=source.mesh.geometry.getAttribute('uv').array, clothUvs=cloth.simulation.mesh.geometry.getAttribute('uv').array;
    const uvs=planeUvs.length===clothUvs.length&&planeUvs.every((v,i)=>Math.abs(v-clothUvs[i])<1e-6);
    cloth.setEnabledOverride(false);
    const floor=__vfxEngine.createEntity({name:'Real cloth collider'});floor.object3D.position.set(20,-.5,0);floor.addComponent('collider',{shape:'box',size:[10,1,10]});
    const sim=cloth.simulation,renderer=__vfxEngine.renderer;
    const runFall=async()=>{sim.restart();for(let i=0;i<300;i++)sim.tick(renderer,1/120);const data=new Float32Array(await renderer.getArrayBufferAsync(sim.positions.value));sim.mesh.updateWorldMatrix(true,false);let min=Infinity;for(let i=0;i<sim.count;i++)min=Math.min(min,new THREE.Vector3(data[i*4],data[i*4+1],data[i*4+2]).applyMatrix4(sim.mesh.matrixWorld).y);return min;};
    const contact=await runFall();floor.object3D.position.x=40;const missed=await runFall();floor.object3D.position.x=20;const movedContact=await runFall();
    e.removeComponent('cloth');
    const retained=disposals===0&&source.mesh.visible&&source.mesh.material===replacement;
    __vfxEngine.destroyEntity(floor);__vfxEngine.destroyEntity(e);authored.dispose();replacement.dispose();
    return {identity,recolored,replaced,uvs,retained,contact,missed,movedContact};
  });
  check("Cloth borrows and tracks the plane's authored material",clothContracts.identity&&clothContracts.recolored&&clothContracts.replaced);
  check("Cloth keeps plane UV orientation and never disposes its material on detach",clothContracts.uvs&&clothContracts.retained);
  check("Cloth hits real scene colliders and responds to moved colliders",clothContracts.contact>=.025&&clothContracts.contact<.1&&clothContracts.missed < -1&&clothContracts.movedContact>=.025&&clothContracts.movedContact<.1);
  await page.evaluate(async()=>{
    const {useSelectionStore}=await __importLive("/src/editor/store/selectionStore.js");
    const p=__vfxEngine.getEntity(__ids.particles).getComponent("particles");
    p.setProp("graph",{nodes:[{id:"sys",type:"system",props:{capacity:32},position:{x:400,y:30}},{id:"value",type:"float",props:{value:.7},position:{x:50,y:40}}],edges:[]});
    useSelectionStore.getState().select(__ids.particles);__openPanel("particles");
  });
  await page.waitForSelector(`${node("sys")} .react-flow__handle[data-handleid="size"]`);
  check("Particles editor has no simulation tabs",!(await page.$(".vfx-kind-tabs")));
  const sizeInput=await page.evaluateHandle((selector)=>document.querySelector(`${selector} .react-flow__handle[data-handleid="size"]`).parentElement.querySelector("input"),node("sys"));
  await sizeInput.asElement().click();await page.keyboard.down("Control");await page.keyboard.press("KeyA");await page.keyboard.up("Control");await page.keyboard.type("0.4");await page.keyboard.press("Enter");await apply();
  await page.waitForFunction(()=>__vfxEngine.getEntity(__ids.particles).getComponent("particles").props.graph.nodes[0].props.__input_size===.4);
  check("Editing a socket number applies a particle constant",true);
  const from=await page.$(`${node("value")} .react-flow__handle.source`), to=await page.$(`${node("sys")} .react-flow__handle[data-handleid="size"]`);
  const a=await from.boundingBox(),b=await to.boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:12});await page.mouse.up();await apply();
  await page.waitForFunction(()=>__vfxEngine.getEntity(__ids.particles).getComponent("particles").props.graph.edges.some((e)=>e.targetHandle==="size"));
  check("Wiring a socket hides its constant while preserving the saved value",await page.$eval(`${node("sys")} .react-flow__handle[data-handleid="size"]`,(handle)=>!handle.parentElement.querySelector("input")));
  await page.evaluate(async()=>{const {useSelectionStore}=await __importLive("/src/editor/store/selectionStore.js");useSelectionStore.getState().select(__ids.vfx);__openPanel("vfx");});
  await page.waitForSelector("[data-vfx-timeline]");
  await page.select('[aria-label="Add effect element"]','ring');
  await page.waitForSelector('.effect-properties');
  const setNumber=async(selector,value)=>{await page.click(selector);await page.keyboard.down("Control");await page.keyboard.press("KeyA");await page.keyboard.up("Control");await page.keyboard.type(String(value));await page.keyboard.press("Tab");};
  await setNumber('[aria-label="Element start"]',.25);
  await setNumber('[aria-label="Element duration"]',1.5);
  await page.click('[title="Add key at playhead"]');
  await setNumber('[aria-label="Key 0 value"]',2);
  const selectedElement = await page.evaluate(()=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.at(-1).id);
  const clip = await page.$(`.effect-clip[data-element-id="${selectedElement}"]`);
  const clipBox = await clip.boundingBox();
  await page.mouse.move(clipBox.x + 15, clipBox.y + 12); await page.mouse.down(); await page.mouse.move(clipBox.x + 65, clipBox.y + 12,{steps:8}); await page.mouse.up();
  await page.waitForFunction((id)=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.find((e)=>e.id===id).start>.25,{},selectedElement);
  await page.mouse.move(1200,400); await page.keyboard.down("Control");await page.keyboard.press("KeyZ");await page.keyboard.up("Control");
  await page.waitForFunction((id)=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.find((e)=>e.id===id).start===.25,{},selectedElement);
  check("One clip drag is one keyboard undo",true);
  const resize = await page.$(`.effect-clip[data-element-id="${selectedElement}"] .effect-clip-resize`), resizeBox = await resize.boundingBox();
  await page.mouse.move(resizeBox.x+4,resizeBox.y+12);await page.mouse.down();await page.mouse.move(resizeBox.x+44,resizeBox.y+12,{steps:8});await page.mouse.up();
  await page.waitForFunction((id)=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.find((e)=>e.id===id).duration>1.5,{},selectedElement);
  await page.mouse.move(1200,400);await page.keyboard.down("Control");await page.keyboard.press("KeyZ");await page.keyboard.up("Control");
  await page.waitForFunction((id)=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.find((e)=>e.id===id).duration===1.5,{},selectedElement);
  check("One clip resize is one keyboard undo",true);
  check("Timeline element timing and keys reach runtime",await page.evaluate(()=>{const e=__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.at(-1);return e.kind==="ring"&&e.start===.25&&e.duration===1.5&&e.keys.scale[0].value===2;}));
  await page.click('[title="Play VFX"]');
  await page.waitForFunction(()=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").time>.1);
  await page.click('[title="Pause or resume VFX"]');
  const paused=await page.evaluate(()=>{const c=__vfxEngine.getEntity(__ids.vfx).getComponent("vfx");return {time:c.time,state:c.state};});
  assert.equal(paused.state,'paused');
  await page.waitForFunction((time)=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").time===time,{},paused.time);
  check("Timeline plays and pauses the live effect",true);
  await page.click('[title="Duplicate element"]');
  const count=await page.evaluate(()=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.length);
  await page.mouse.move(1200,400);await page.keyboard.down("Control");await page.keyboard.press("KeyZ");await page.keyboard.up("Control");
  await page.waitForFunction((count)=>__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").document.elements.length===count-1,{},count);
  check("Keyboard undo removes a duplicated timeline element",true);
  const visible = await page.evaluate(async()=>{
    const c=__vfxEngine.getEntity(__ids.vfx).getComponent("vfx");c.seek(.2);
    const visible=[...c.elements.values()].filter((e)=>e.active&&e.group.visible);
    const {serializeScene}=await __importLive("/src/engine/index.js");
    const json=JSON.stringify(serializeScene(__vfxEngine));
    return {mesh:visible.some((e)=>e.object?.isMesh),light:visible.some((e)=>e.object?.isPointLight&&e.object.intensity>0),serialized:json.includes('"timeline"')&&json.includes('"shockwave"'),root:c.root.visible};
  });
  check("Timeline evaluation shows real meshes and light in the viewport",visible.mesh&&visible.light&&visible.root);
  check("Scene serialization retains the authored timeline",visible.serialized);
  await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(root,"vfx-workspace.png")});
  await page.click('[title="Stop VFX"]');
  check("Stopping hides the generated effect",await page.evaluate(()=>!__vfxEngine.getEntity(__ids.vfx).getComponent("vfx").root.visible));
  check("No page or WebGPU validation errors",errors.length===0);
  console.log(`VFX-WORKSPACE PASS\nArtifacts: ${root}`);
} catch(error) { console.error(error,errors);await page.screenshot({path:path.join(root,"failure.png")}).catch(()=>{});console.error(`Artifacts: ${root}`);process.exitCode=1; } finally { await browser.close(); }
