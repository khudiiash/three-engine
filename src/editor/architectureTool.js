import { engine } from "./engineInstance.js";
import { getComponentClass } from "../engine/components/registry.js";
import { disarmTerrainBrush } from "./terrainBrush.js";
import { disarmArchitecturePlacement } from "./architecturePlacementTool.js";
export { armArchitecturePlacement, getArchitecturePlacementState, subscribeArchitecturePlacement, setArchitecturePlacementSetting, disarmArchitecturePlacement } from "./architecturePlacementTool.js";
import {
  armLevelTool, disarmLevelTool, getLevelTool, getLevelToolSettings, getDrawElevation,
  setActiveLevel, setDrawElevation, setLevelToolSetting, subscribeLevelTool, LEVEL_TOOLS,
} from "./levelTool.js";

// The gesture store supplies snapping, keyboard shortcuts and draw-plane math.
// Its legacy level target is deliberately empty while Architecture owns it.
let context = null;
let error = "";
const listeners = new Set();
const notify = () => { for (const listener of listeners) listener(); };
subscribeLevelTool(() => {
  if (!getLevelTool()) context = null;
  notify();
});

export function getArchitectureDrawContext() { return context; }
export function getArchitectureToolError() { return error; }
export function setArchitectureToolError(value = "") { error = String(value); notify(); }
export function subscribeArchitectureTool(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function armArchitectureTool({ parentId = null, shape = "wall", elevation = 0, grid = 1, height = 3, thickness = .2, slabThickness = .2, stairWidth = 1.4, rise = 3, collision = true, columnSides = 4, opening = "door", material = "", role = "", color = "" } = {}) {
  if (!getComponentClass("architecturepiece")) throw new Error("Enable Architecture before drawing structures.");
  if (parentId && !engine.getEntity(parentId)) throw new Error("The target assembly no longer exists.");
  const nextShape = shape === "slab" ? "floor" : shape;
  if (!LEVEL_TOOLS.includes(nextShape)) throw new Error(`Unknown drawing shape "${shape}".`);
  if (typeof material !== "string" || typeof role !== "string") throw new Error("Material and role must be strings.");
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Color must be a six-digit hex color.");
  const numeric = { elevation, grid, height, thickness, slabThickness, stairWidth, rise, columnSides };
  for (const [key, value] of Object.entries(numeric)) if (!Number.isFinite(value)) throw new Error(`${key} must be finite.`);
  disarmArchitecturePlacement();
  disarmTerrainBrush();
  setActiveLevel(null);
  context = { parentId, material, role, color };
  error = "";
  armLevelTool(nextShape);
  const fields = {
    grid: Math.max(0, Math.min(100, grid)), wallHeight: Math.max(.01, Math.min(10000, height)),
    wallThickness: Math.max(.01, Math.min(100, thickness)), slabThickness: Math.max(.01, Math.min(100, slabThickness)),
    stairWidth: Math.max(.01, Math.min(100, stairWidth)), storeyHeight: Math.max(.01, Math.min(10000, rise)),
    rampRise: Math.max(.01, Math.min(10000, rise)), columnSides: Math.max(3, Math.min(48, Math.round(columnSides))),
    collision: collision !== false, opening: ["door", "window", "arch"].includes(opening) ? opening : "door",
  };
  for (const [key, value] of Object.entries(fields)) setLevelToolSetting(key, value);
  setDrawElevation(Math.max(-1e7, Math.min(1e7, elevation)));
  return getArchitectureToolState();
}

export function disarmArchitectureTool() {
  const wasArmed = !!context;
  context = null;
  error = "";
  disarmLevelTool();
  notify();
  return wasArmed;
}

export function setArchitectureDrawParent(parentId) {
  if (!context) return;
  if (parentId && !engine.getEntity(parentId)) throw new Error("The target assembly no longer exists.");
  context.parentId = parentId ?? null;
  notify();
}

export function validateArchitectureDrawTarget() {
  if (context?.parentId && !engine.getEntity(context.parentId)) {
    disarmArchitectureTool();
    return false;
  }
  return !!context;
}

export function getArchitectureToolState() {
  return { active: !!context, parentId: context?.parentId ?? null, shape: context ? getLevelTool() : null,
    elevation: getDrawElevation(), settings: { ...getLevelToolSettings() }, color: context?.color ?? "", error };
}

export function setArchitectureDrawShape(shape) {
  if (!context) return;
  error = "";
  armLevelTool(shape);
}

export function setArchitectureDrawSetting(key, value) {
  if (!context) return;
  error = "";
  if (key === "color") {
    if (value && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Color must be a six-digit hex color.");
    context.color = value;
    notify();
  } else if (key === "material" || key === "role") {
    if (typeof value !== "string") throw new Error(`${key} must be a string.`);
    context[key] = value;
    notify();
  } else if (key === "elevation") setDrawElevation(value);
  else if (key === "rise") {
    setLevelToolSetting("storeyHeight", value);
    setLevelToolSetting("rampRise", value);
  } else setLevelToolSetting(key, value);
}
