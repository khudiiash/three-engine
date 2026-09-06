/** Serializable, time-addressable effect composition. Times are seconds. */
export const EFFECT_KINDS = ["sprite", "ring", "mesh", "ribbon", "light", "particles", "group"];
export const EFFECT_CHANNELS = ["x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale", "opacity", "intensity"];
const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
export function createEffectElement(kind = "sprite", id = `element-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`) {
  if (!EFFECT_KINDS.includes(kind)) throw new Error(`Unknown effect element: ${kind}`);
  return { id, kind, name: kind[0].toUpperCase() + kind.slice(1), enabled: true, parent: "", start: 0, duration: 2,
    color: "#80cfff", texture: "", geometry: "sphere", blend: "additive", lit: false,
    x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    opacity: 1, intensity: 3, roughness: .4, castShadow: false, receiveShadow: true,
    width: .15, arc: 360, billboard: true, columns: 1, rows: 1, fps: 16, keys: {} };
}
export function normalizeEffectTimeline(input = {}) {
  if (input.version != null && input.version !== 1) throw new Error("Unsupported effect timeline version");
  const ids = new Set();
  if (input.elements?.length > 256) throw new Error("An effect supports up to 256 elements");
  const elements = (Array.isArray(input.elements) ? input.elements : []).map((raw) => {
    if (typeof raw?.id !== "string" || !raw.id || ids.has(raw.id)) throw new Error("Effect element IDs must be unique");
    ids.add(raw.id);
    const e = { ...createEffectElement(raw.kind, raw.id), ...structuredClone(raw) };
    e.start = Math.max(0, finite(e.start, 0));
    e.duration = Math.max(.001, finite(e.duration, 2));
    for (const key of EFFECT_CHANNELS) e[key] = finite(e[key], ["scale", "opacity"].includes(key) ? 1 : 0);
    e.columns = Math.min(128, Math.max(1, Math.floor(finite(e.columns, 1))));
    e.rows = Math.min(128, Math.max(1, Math.floor(finite(e.rows, 1))));
    e.fps = Math.min(240, Math.max(0, finite(e.fps, 16)));
    e.width = Math.max(.001, finite(e.width, .15));
    e.arc = Math.max(1, Math.min(360, finite(e.arc, 360)));
    e.keys = {};
    for (const key of EFFECT_CHANNELS) {
      if (!Array.isArray(raw.keys?.[key])) continue;
      const samples = new Map();
      for (const k of raw.keys[key]) if (Number.isFinite(k.time) && Number.isFinite(k.value)) samples.set(Math.max(0, k.time), { time: Math.max(0, k.time), value: k.value, interpolation: ["step", "smooth"].includes(k.interpolation) ? k.interpolation : "linear" });
      e.keys[key] = [...samples.values()].sort((a, b) => a.time - b.time);
    }
    return e;
  });
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const e of elements) {
    if (e.parent && !byId.has(e.parent)) e.parent = "";
    const seen = new Set([e.id]);
    let parent = e.parent;
    while (parent) {
      if (seen.has(parent)) throw new Error("Effect parent cycle");
      seen.add(parent); parent = byId.get(parent)?.parent;
    }
  }
  return { version: 1, duration: Math.max(.01, finite(input.duration, 5)), loop: input.loop !== false, elements };
}
export function sampleEffectCurve(keys, time, fallback = 0) {
  if (!keys?.length) return fallback;
  if (time <= keys[0].time) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    if (time > keys[i].time) continue;
    const a = keys[i - 1], b = keys[i];
    let t = Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time || 1)));
    if (a.interpolation === "step") t = time === b.time ? 1 : 0;
    if (a.interpolation === "smooth") t = t * t * (3 - 2 * t);
    return a.value + (b.value - a.value) * t;
  }
  return keys[keys.length - 1].value;
}
export function evaluateEffectElement(element, time) {
  const localTime = time - element.start;
  const result = { active: element.enabled !== false && localTime >= 0 && localTime < element.duration, localTime };
  for (const key of EFFECT_CHANNELS) result[key] = sampleEffectCurve(element.keys?.[key], localTime, finite(element[key], ["scale", "opacity"].includes(key) ? 1 : 0));
  return result;
}
export function createEffectPreset(name = "Impact") {
  const ring = createEffectElement("ring", "shockwave");
  ring.name = "Expanding shockwave"; ring.duration = 1; ring.rotationX = -90;
  ring.keys = { scale: [{ time: 0, value: .1 }, { time: 1, value: 4 }], opacity: [{ time: 0, value: 1 }, { time: 1, value: 0 }] };
  const flash = createEffectElement("sprite", "flash");
  flash.duration = .4; flash.keys = { scale: [{ time: 0, value: .2 }, { time: .1, value: 2 }, { time: .4, value: .1 }], opacity: [{ time: 0, value: 1 }, { time: .4, value: 0 }] };
  const light = createEffectElement("light", "light");
  light.duration = .5; light.y = 1; light.keys = { intensity: [{ time: 0, value: 10 }, { time: .5, value: 0 }] };
  if (name === "Aura") { ring.duration = 5; ring.keys.scale = [{time:0,value:1},{time:2.5,value:1.5},{time:5,value:1}]; ring.keys.opacity = [{time:0,value:.4},{time:2.5,value:1},{time:5,value:.4}]; return normalizeEffectTimeline({duration:5,elements:[ring]}); }
  return normalizeEffectTimeline({ duration: 3, elements: [ring, flash, light] });
}
