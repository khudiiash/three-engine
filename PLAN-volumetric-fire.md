# Plan: Volumetric effects (Blender-style volume pin)

Volumetric rendering (fire, smoke, fog, clouds) is **a material**, not a
component. There is no `VolumeComponent`. To create a fire you:

1. Create / open a `.mat` asset.
2. Open the shader graph for that material.
3. Drop a `Principled Volume` (or `Volume Scatter` + `Volume Absorption`)
   node and wire its output into `Material Output`'s new `Volume` socket.
4. Assign the `.mat` to a `MeshComponent`. The mesh is automatically snapped
   to a unit box (volumes are evaluated in `[-0.5, 0.5]³` local space) —
   `MeshComponent.#loadSharedMaterial` warns and switches the geometry if
   it isn't already a box.

Editing the graph or the material's color/density/emission params updates
the volume live (TSL uniforms for scalar/color values, recompile when the
graph topology changes).

## Why no component?

The earlier `VolumeComponent` + dedicated `VolumePanel` was too much surface
for what is essentially "an additional render pass on a box". Three.js's
`VolumeNodeMaterial` accepts a `scatteringNode` — a `Fn({positionRay}) →
vec4` — and handles raymarching, lighting, and shadows internally. Treating
the volume as a material slot (the same way the engine already handles
surface BSDFs via `MeshPhysicalNodeMaterial`) keeps it consistent with how
Blender and the rest of the engine think about it.

## What's actually new

- `src/engine/tslGraph.js` — three new volume shader nodes:
  - `Volume Scatter` — Henyey-Greenstein-style scatter with a color, density
    and anisotropy. Hardcoded 32 march steps.
  - `Volume Absorption` — color × exp(-optical depth) over a unit box.
    Hardcoded 32 march steps.
  - `Principled Volume` — composite scatter + emission + blackbody. Wires
    `color` / `colorAttribute` / `density` / `absorptionColor` /
    `emissionColor` / `emissionStrength` / `blackbodyIntensity` /
    `blackbodyTint` / `temperature` / `anisotropy`. Hardcoded 48 march
    steps.
  - `Material Output` now has a `Volume` socket (Blender parity) alongside
    the existing Surface sockets. Wiring any volume node into it
    populates `mutations.scatteringNode`. The user may wire Surface only,
    Volume only, or both.

- `src/engine/materialAsset.js` — inspects which sockets are wired:
  - **Volume wired** (with or without Surface) → instantiates
    `THREE.VolumeNodeMaterial` and assigns `material.scatteringNode` from
    the compiled graph. The Surface mutations are dropped because
    `VolumeNodeMaterial` doesn't use them — the box becomes a container
    for the raymarch and its faces aren't drawn as a surface. If a user
    wires both sockets, volume wins per the engine's "volume is a
    container, geometry is not rendered" rule.
  - **Surface only** (the typical case) → `MeshPhysicalNodeMaterial` with
    the surface `*Node` mutations applied, exactly as before.
  - The class is swapped in place if the user edits the .mat from one
    kind to the other, so editing updates live. `isVolumeMaterial(path)`
    lets other code check the current kind.

- `src/engine/components/MeshComponent.js` — when a volume `.mat` is
  assigned, the mesh's geometry is forced to `BoxGeometry(1, 1, 1)` (with
  a console warning) so `RaymarchingBox`'s `positionRay` maps to a usable
  UVW. Entity scale still shapes the volume; you make a fire tall by
  scaling the entity on Y. The box's faces are not rendered as a surface
  — `VolumeNodeMaterial`'s `scatteringNode` returns the volume colour per
  fragment, so what the user sees is the raymarched result, not the
  box's hull.

## What was deleted

- `src/engine/volumeGraph.js` — entire dedicated volume node graph
  (registry, compile, signature, presets, noise baking).
- `src/editor/volumePresets.js` — hardcoded graph presets.
- `src/editor/panels/VolumePanel.jsx` — the dedicated editor panel.
- `src/scripts/test-volume-graph.mjs` — its headless test.
- `src/engine/components/VolumeComponent.js` — the runtime component.
  Volumes now render through `MeshComponent` + `VolumeNodeMaterial`.
- `src/engine/index.js` — `VolumeComponent` registration removed.
- `src/editor/EditorShell.jsx` — `volume` panel lazy import + spec entry
  removed.
- `src/editor/panels/InspectorPanel.jsx` — "Open Volume Editor" button
  removed.
- `src/editor/panels/MaterialPanel.jsx` — kept mesh-only; volumes don't
  need their own panel because they share the material editor.

## Future work

- Procedural noise wiring: feeding `Noise Texture` or `Fractal Noise` into
  `Principled Volume.colorAttribute` produces gradient-driven density
  variations (e.g. layered smoke). The existing shader-graph noise nodes
  already produce the right TSL type for the `colorAttribute` port.
- Step count: currently hardcoded per node. Promoting it to a runtime
  tunable requires unrolling with a JS constant — currently means
  changing the literal and recompiling.
- Light-scattering phase: full Henyey-Greenstein phase (the math, not just
  the simple scatter) is a small follow-up — wire `anisotropy` into a
  proper `henyeyGreenstein(cosTheta, g)` TSL helper inside the scatter.