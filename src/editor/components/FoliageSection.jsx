import { useEffect, useState } from "react";
import { NumberField } from "../fields/NumberField.jsx";
import { EntityField } from "../fields/EntityField.jsx";
import { Select } from "../fields/Select.jsx";
import { Leaf } from "../icons/index.jsx";
import { commandBus } from "../commands/CommandBus.js";
import { BatchCommand } from "../commands/entityCommands.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { engine } from "../engineInstance.js";
import { useSceneStore } from "../store/sceneStore.js";
import { createFoliage } from "../foliageAuthoring.js";
import { FOLIAGE_CHOICES, foliagePreset, isFoliageSurface } from "../foliagePresets.js";

function Row({ label, title, children }) {
  return <div className="field-row" title={title}><span className="field-label">{label}</span>{children}</div>;
}

/** The same one-click flow for terrain, primitive meshes and imported models. */
export function FoliageSurfaceSection({ entityId, terrain = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async (species) => {
    setBusy(true);
    setError("");
    try { await createFoliage({ species, surfaceId: entityId, parentId: entityId }); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <div data-foliage-surface={entityId}>
    <div className="inspector-subheader"><Leaf size={13} /> Procedural Foliage</div>
    <div className="camera-follow-row">
      <button className="toolbar-btn" disabled={busy} onClick={() => add("oak")}>Trees</button>
      <button className="toolbar-btn" disabled={busy} onClick={() => add("grass")}>Grass</button>
      <button className="toolbar-btn" disabled={busy} onClick={() => add("wildflowers")}>Flowers</button>
    </div>
    <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
      {busy ? "Creating foliage…" : terrain
        ? "Cover this terrain with a procedural layer. Foliage follows sculpted heights; each layer has its own density and slope range."
        : "Scatter over this surface. Adjust density, species and wind on the new foliage layer."}
    </div>
    {error && <div className="inspector-hint" role="alert">{error}</div>}
  </div>;
}

export function FoliageSection({ entityId, props }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => refresh((value) => value + 1), 800);
    return () => clearInterval(timer);
  }, [entityId]);
  const component = engine.getEntity(entityId)?.getComponent("foliage");
  const stats = component?.stats;
  const scatter = props.distribution === "scatter";
  const commit = (key, value) => commandBus.execute(new SetComponentPropCommand(entityId, "foliage", key, value));
  const patch = (values, label) => commandBus.execute(new BatchCommand(
    Object.entries(values).map(([key, value]) => new SetComponentPropCommand(entityId, "foliage", key, value)), label));
  const number = (key, label, min, max, step = 0.1, title) => <Row label={label} title={title}>
    <NumberField value={props[key]} min={min} max={max} step={step} onCommit={(value) => commit(key, value)} />
  </Row>;
  const toggle = (key, label, title) => <Row label={label} title={title}>
    <input type="checkbox" checked={!!props[key]} onChange={(event) => commit(key, event.target.checked)} aria-label={label} />
  </Row>;
  const range = (lo, hi, label, min, max, step = 0.1, title) => <Row label={label} title={title}>
    <div className="terrain-range">
      <NumberField value={props[lo]} min={min} max={max} step={step} onCommit={(value) => patch({ [lo]: value, [hi]: Math.max(value, props[hi]) }, `Set ${label}`)} />
      <span className="terrain-range-sep">–</span>
      <NumberField value={props[hi]} min={min} max={max} step={step} onCommit={(value) => patch({ [lo]: Math.min(props[lo], value), [hi]: value }, `Set ${label}`)} />
    </div>
  </Row>;
  const colors = [["leafColor", "Foliage color"], ["barkColor", "Bark color"], ["flowerColor", "Flower color"]];
  return <div data-foliage-section={entityId}>
    <Row label="Species">
      <Select value={props.species} onChange={(event) => patch(foliagePreset(event.target.value), "Apply foliage preset")}>
        {FOLIAGE_CHOICES.map(({ species, label }) => <option key={species} value={species}>{label}</option>)}
      </Select>
    </Row>
    <Row label="Placement">
      <Select value={props.distribution} onChange={(event) => commit("distribution", event.target.value)}>
        <option value="single">Single plant</option><option value="scatter">Scatter on surface</option>
      </Select>
    </Row>
    {scatter && <>
      <Row label="Surface" title="Pick a Mesh, Model, Terrain, or a group. You can also drag its hierarchy row here.">
        <EntityField value={props.surface ?? ""} onCommit={(value) => commit("surface", value)} descriptor={{
          emptyLabel: "Own mesh / parent surface",
          filter: (entity) => isFoliageSurface(entity, (id) => useSceneStore.getState().entities[id]),
        }} />
      </Row>
      {number("density", "Plants / m²", 0, undefined, 0.01, "Coverage per square metre of surface area, capped by the instance limit.")}
      {number("maxInstances", "Plant limit", 0, 100000, 100, "Hard limit for this foliage layer. Increase for larger areas.")}
    </>}
    {number("seed", "Seed", 0, undefined, 1)}
    <button className="toolbar-btn wide" onClick={() => commit("seed", ((props.seed ?? 1) + 1) >>> 0)}>New variation</button>

    <details open>
      <summary className="inspector-subheader">Plant shape</summary>
      {number("height", "Height", 0.05, undefined, 0.05)}
      {number("width", "Width", 0.02, undefined, 0.05)}
      {colors.filter(([key]) => key === "leafColor" || (key === "flowerColor" ? props.species === "wildflowers" : !["grass", "wildflowers"].includes(props.species))).map(([key, label]) =>
        <Row key={key} label={label}><input className="color-field" type="color" value={props[key]} onChange={(event) => commit(key, event.target.value)} aria-label={label} /></Row>)}
    </details>
    {scatter && <details>
      <summary className="inspector-subheader">Placement variation</summary>
      {range("minScale", "maxScale", "Scale", 0.05, undefined, 0.05)}
      {number("minSpacing", "Spacing", 0, undefined, 0.1, "Minimum distance between plants, in metres.")}
      {range("minSlope", "maxSlope", "Slope °", 0, 180, 1, "Measured from world up. Raise the upper limit to cover walls or undersides.")}
      {range("minAltitude", "maxAltitude", "Altitude", undefined, undefined, 1, "World-space height range, in metres.")}
      {toggle("alignToNormal", "Follow normal", "Orient plants along the surface normal; turn off to keep trees upright.")}
    </details>}
    <details>
      <summary className="inspector-subheader">Wind and interaction</summary>
      {toggle("wind", "Wind")}
      {props.wind && <>
        {number("windStrength", "Wind response", 0, 2, 0.01, "How strongly this foliage responds to the Scene wind force.")}
        {number("windGustStrength", "Gust response", 0, 2, 0.05, "How strongly this foliage responds to the Scene wind gusts.")}
        {number("windScale", "Gust size", 0.5, undefined, 0.5, "World-space size of the gust pattern in metres; larger values move wider patches together.")}
        {number("windTurbulence", "Turbulence", 0, 1, 0.05, "Fine motion at leaf and blade tips, layered over the shared gust pattern.")}
        <div className="inspector-hint">Direction, force and gust frequency follow Scene → Wind.</div>
      </>}
      {toggle("interaction", "Collider bending", "Bend foliage around nearby enabled scene colliders.")}
      {props.interaction && <>
        {number("interactionStrength", "Bend strength", 0, 2, 0.05)}
        {number("interactionRadius", "Extra reach", 0, 10, 0.1)}
        <div className="inspector-hint">Nearby colliders bend plants visually. Add a collider to a solid trunk when characters should stop against it.</div>
      </>}
    </details>
    <details>
      <summary className="inspector-subheader">Distance and performance</summary>
      {number("lodNear", "Detail distance", 1, undefined, 1)}
      {number("lodFar", "Impostor distance", 2, undefined, 1)}
      {number("maxDistance", "Draw distance", 3, undefined, 1)}
      {number("chunkSize", "Cell size", 4, 128, 1, "Smaller cells select detail more precisely; larger cells reduce CPU bookkeeping. Plant size also limits the effective cell size.")}
      {toggle("castShadow", "Cast shadows")}
      {toggle("receiveShadow", "Receive shadows")}
      <div className="inspector-hint">Detail reduces automatically with distance. Use shorter draw distances for grass and flowers, and longer distances for trees.</div>
    </details>
    {stats && <div className="inspector-hint" role="status" style={{ margin: "6px 2px" }}>
      {Number(stats.instances ?? 0).toLocaleString()} plants · {stats.chunks ?? 0} cells · {stats.drawCalls ?? 0} draws
      {stats.status && <div>{stats.status}</div>}
    </div>}
    {component?.error && <div className="inspector-hint" role="alert">{component.error}</div>}
  </div>;
}
