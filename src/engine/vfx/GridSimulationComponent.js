import { updateWaterSlot } from "./waterCaustics.js";
import { installWaterSurfaceLook } from "./waterSurfaceLook.js";
import { Component } from "../components/Component.js";
import { createGridSimulation } from "./gridSimulation.js";
import { evaluateSimulationGraph, setSimulationGraphProp } from "./simulationGraph.js";
import { bindVfxAsset } from "./vfxAsset.js";
import { BackSide, FrontSide, Matrix4, Vector3 } from "three/webgpu";
import { waterAutoResolution } from "./waterVolume.js";
import { seaQuality } from "./waterSpectrum.js";

const _cameraWorld = new Vector3(), _waterInverse = new Matrix4();
import { ParticleColliderField } from "../particleColliders.js";
import { ClothMeshColliderField } from "../clothMeshColliders.js";

/** The source primitives water can fill (the plane is the open-water case). */
const WATER_SOLIDS = new Set(["box", "cylinder", "sphere", "cone", "capsule"]);

export const gridSchema = [
  { key: "asset", label: "VFX asset", type: "asset", exts: ["vfx"] },
  { key: "resolution", label: "Grid resolution", type: "number", min: 4, max: 512, step: 1 },
  { key: "width", label: "Width", type: "number", min: .1, max: 1000, step: .1 },
  { key: "height", label: "Height / depth", type: "number", min: .1, max: 1000, step: .1 },
  { key: "damping", label: "Velocity retention", type: "number", min: 0, max: 1, step: .001 },
  { key: "color", label: "Color", type: "color" },
  { key: "roughness", label: "Roughness", type: "number", min: 0, max: 1, step: .01 },
  { key: "castShadow", label: "Cast shadows", type: "boolean" },
  { key: "receiveShadow", label: "Receive shadows", type: "boolean" },
];
export class GridSimulationComponent extends Component {
  static resetOnStop = true;
  get effectiveGraph() { return this._vfxAssetGraph ?? this.props.graph; }
  onAttach() {
    bindVfxAsset(this, () => this.applyGraph());
    this.attachSimulation();
    this.unsubscribeTick = this.entity.engine.onUpdate(() => {
      // ── A MODAL EDITOR MODE STOPS THE SOLVER (2026-09-07) ────────────────
      // This tick dispatches the whole spectrum/FFT compute chain EVERY frame,
      // and for water it does not even check `isInView()` — the sea keeps
      // solving while the user is inside the geometry editor working on one
      // mesh. Reported as "when entering geometry editing mode, all the
      // components currently ticking in the editor viewport must be stopped:
      // they must be causing freezes and lags in the geometry editor".
      // `engine.suspendSimulation(reason)` is the seam; leaving the mode
      // resumes from where the solver stood, because nothing is torn down.
      if (this.entity.engine.simulationSuspended === true) return;
      if (["cloth", "water"].includes(this.constructor.type)) this.syncPlane();
      if (!this.enabled || !this.graphEnabled || !this.simulation?.mesh.visible || (this.constructor.type !== "water" && !this.isInView())) return;
      this.simulation.tick(this.entity.engine.renderer, this.entity.engine.deltaTime ?? 0);
      this.refreshWaterSlot();
    });
    this.unsubscribeMesh = ["cloth", "water"].includes(this.constructor.type) ? this.entity.engine.on?.("component-changed", (event) => {
      if (event?.entityId === this.entity.id && event.componentType === "mesh") this.syncPlane();
    }) : null;
  }
  /**
   * The source mesh this simulation replaces. A Plane for either kind; for
   * WATER also a BOX, and then the box IS the water volume — its X/Z are the
   * footprint and its Y is the depth, so a cube of water is exactly the cube
   * the author drew. Cloth stays plane-only: it has no volume to fill.
   */
  findPlane() {
    const component = this.entity?.getComponent?.("mesh"), mesh = component?.mesh;
    if (!mesh || component.props.geometryAsset) return null;
    const kind = component.props.geometry;
    const geometry = mesh.geometry;
    if (WATER_SOLIDS.has(kind) && this.constructor.type === "water") {
      // ── ANY SOLID PRIMITIVE IS A CONTAINER ──────────────────────────────
      //
      // The water fills it to `fill` of its height; the lid is the
      // cross-section there (waterVolume.js#waterVolumeShape). A box is the
      // kind it always was, full by default.
      geometry.computeBoundingBox();
      const size = geometry.boundingBox.getSize(new Vector3());
      if (!(size.x > 0 && size.y > 0 && size.z > 0)) return null;
      const fill = Math.min(1, Math.max(.05, Number(this.props.fill ?? 1) || 1));
      const params = geometry.parameters ?? {};
      const radius = kind === "box" ? size.x / 2 : (params.radius ?? params.radiusBottom ?? params.radiusTop ?? size.x / 2);
      return { component, mesh, geometry, box: true, shape: kind, radius, fullHeight: size.y, fill, width: size.x, height: size.z, depth: size.y * fill, center: geometry.boundingBox.getCenter(new Vector3()) };
    }
    if (kind !== "plane") return null;
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new Vector3());
    if (!(size.x > 0 && size.y > 0) || size.z > .0001) return null;
    return { component, mesh, geometry, box: false, width: size.x, height: size.y, depth: null, center: geometry.boundingBox.getCenter(new Vector3()) };
  }
  /** What the source mesh dictates about the solver, in one place: a Box source
   *  owns the depth as well as the footprint. */
  sourceProps(plane) {
    if (!plane) return {};
    const props = { width: plane.width, height: plane.height, ...(plane.depth != null ? { waterDepth: plane.depth } : null) };
    if (this.constructor.type === "water") Object.assign(props, { shapeKind: plane.shape ?? "box", shapeRadius: plane.radius ?? plane.width / 2, shapeHeight: plane.fullHeight ?? plane.depth ?? undefined,
      // A box or primitive is a CONTAINER: its waves reflect off the walls
      // (waterSpectrumCPU.js#seaSettings); a plane is open water.
      enclosed: plane.box ? 1 : 0 });
    // ── WATER'S GRID FOLLOWS ITS WORLD SIZE ──────────────────────────────
    //
    // Cells at a fixed size in METRES (`waterAutoResolution`), so a 0.5 m
    // body spans the same dozen cells in a pond and in a lake and every wake
    // floor, foam term and Nyquist fade that works in cells means the same
    // thing at every scale. `resolution` stays a saved prop for cloth; for
    // water it is derived and the field is hidden.
    if (this.constructor.type === "water") props.resolution = waterAutoResolution(this.worldFootprint(plane));
    return props;
  }
  /** World metres per local unit along the lid's two axes. */
  worldScaleOf(plane) {
    const mesh = plane?.mesh; if (!mesh) return { x: 1, z: 1 };
    mesh.updateWorldMatrix(true, false);
    const sx = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 0).length();
    const sy = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 1).length();
    const sz = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 2).length();
    return { x: sx, z: plane.box ? sz : sy };
  }
  /** The source mesh's footprint in world metres — the larger of its two
   *  horizontal extents, which is what sizes the grid. */
  worldFootprint(plane) {
    const mesh = plane?.mesh; if (!mesh) return 0;
    mesh.updateWorldMatrix(true, false);
    const sx = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 0).length();
    const sy = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 1).length();
    const sz = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 2).length();
    // A Plane is authored in XY and stood up by the +90° in `syncAppearance`,
    // so its second extent is along the entity's Y; a Box's is along Z.
    return Math.max(plane.width * sx, plane.height * (plane.box ? sz : sy));
  }
  attachSimulation() {
    this.resolveGraph();
    const cloth = this.constructor.type === "cloth";
    const plane = this.findPlane();
    this.surfaceError = cloth && !plane ? "Cloth requires a Plane Mesh on this entity." : null;
    if (cloth && !plane) { this.simulation = null; return; }
    if (plane) {
      this.planeSource = plane;
      this.sourceGeometryVersion = plane.geometry.getAttribute("position")?.version;
      this.sourceGroups = JSON.stringify(plane.geometry.groups);
      this.resolvedProps = { ...this.resolvedProps, ...this.sourceProps(plane) };
    }
    if (cloth && this.resolvedProps.sceneCollision !== false) {
      this.colliderField = this.entity.engine.particleColliders ??= new ParticleColliderField(this.entity.engine);
      this.colliderField.addUser();
      this.meshColliderField = this.entity.engine.clothMeshColliders ??= new ClothMeshColliderField(this.entity.engine);
      this.meshColliderField.addUser();
    }
    // The slot is claimed BEFORE the solver, because the solver builds the
    // kernel that writes into it. A scene past `MAX_WATER_SLOTS` surfaces gets
    // no slot: it still simulates and renders, it just does not light or fog.
    // ── UNDERWATER OFF (2026-09-07) ───────────────────────────────────────
    // "Completely disable underwater as an optimization if we don't need
    // it" (user): without a slot this water adds nothing to the medium (a
    // per-pixel fog every material pays), mints no caustic pass, slot
    // kernel or shafts; the shell is hidden and the lid refracts nothing.
    this.underwaterBuilt = this.resolvedProps.underwater !== false;
    if (this.constructor.type === "water") this.waterSlot = this.underwaterBuilt ? (this.entity.engine.waterSlots?.claim(this) ?? null) : null;
    // One sea model, sized to the tier the scene ships at.
    const quality = this.entity.engine?.project?.settings?.build?.quality ?? this.entity.engine?.projectSettings?.build?.quality ?? "high";
    // The ripple window is a size in METRES: hand the solver the box's scale.
    const worldScale = this.constructor.type === "water" && plane ? this.worldScaleOf(plane) : null;
    this.simulation = createGridSimulation(this.constructor.type, this.resolvedProps, { colliderField: this.colliderField, meshColliderField: this.meshColliderField, colliderEntityId: this.entity.id, material: plane ? this.sourceMaterial(plane.mesh.material) : undefined, sourceGeometry: plane?.geometry, anchorEngine: this.entity.engine, waterSlot: this.waterSlot, seaQuality: seaQuality(quality), worldScale });
    this.simulation.mesh.userData.entityId = this.entity.id;
    this.entity.object3D.add(this.simulation.mesh);
    // The sea's spray sprites live in the LID's frame — a child of the lid
    // mesh, whose matrix carries the fill level and a primitive's rotation
    // (a sibling of it drew the spray five metres under a +5 m lid: "sprays
    // are sitting below the surface", user, 2026-09-07).
    const spray = this.simulation.spectrum?.splashMesh;
    if (spray) { spray.userData.entityId = this.entity.id; this.simulation.mesh.add(spray); }
    this.syncAppearance();
    this.refreshWaterSlot();
  }
  sourceMaterial(material) {
    if (this.constructor.type !== "water") return material;
    const members = Array.isArray(material) ? material : [material];
    const signature = members.map(m => [m.uuid, m.version, m.color?.getHex(), m.roughness, m.metalness, m.transmission, m.opacity, m.transparent, m.side].join(":")).join("|");
    if (signature !== this.waterMaterialSignature) {
      this.waterSurfaceLook?.dispose(); this.waterSurfaceLook = null;
      this.waterMaterials?.forEach(m => m.dispose());
      // ⚠ THE WATER'S OWN SURFACES **ARE** IN THE MEDIUM, and that is what makes
      // being underwater look like anything.
      //
      // These were briefly excluded, to stop a pool's floor being tinted twice —
      // once on the body's own bottom face and again on the tiles behind it. The
      // real cause of that was the body being drawn double-sided; single-sided
      // culling (`syncWaterFacing`) removes the second layer outright, and the
      // path length does the rest: from outside, the eye reaches the lid having
      // crossed no water at all, so fogging it is exactly a no-op.
      //
      // From INSIDE it is the opposite and it is load-bearing. `setupOutput`
      // applies fog AFTER transmission is composited, so a fogged transmissive
      // wall tints everything seen through it — including `scene.background`,
      // which has no material of its own and can never be fogged directly.
      // Without this, a submerged camera looking sideways sees the skybox at
      // full clarity through 20 m of water ("don't see top of the water from
      // underwater", user 2026-09-05).
      this.waterMaterials = members.map(m => m.clone());
      this.waterMaterialSignature = signature;
    }
    return Array.isArray(material) ? this.waterMaterials : this.waterMaterials[0];
  }
  releasePlane() {
    const source = this.planeSource;
    if (!source || !this.sourceClaim) return;
    for (const [key, value] of Object.entries(this.sourceClaim.tags)) {
      if (value.present) source.mesh.userData[key] = value.value;
      else delete source.mesh.userData[key];
    }
    for (const { material, present, value } of this.sourceClaim.materials ?? []) {
      if (present) material.userData.giWater = value; else delete material.userData.giWater;
    }
    source.mesh.visible = this.sourceClaim.visible && source.component.enabled !== false && source.component.materialRenderable !== false;
    const claimedCollider = this.sourceClaim.collider;
    if (claimedCollider?.component.entity && claimedCollider.enabled) claimedCollider.component.setEnabled(true);
    this.sourceClaim = null;
  }
  syncAppearance() {
    if (!this.simulation) return;
    const source = this.planeSource;
    const active = this.enabled && this.graphEnabled && (!source || (source.component.enabled !== false && source.component.materialRenderable !== false && (this.sourceClaim ? this.sourceClaim.visible : source.mesh.visible)));
    this.simulation.mesh.visible = active;
    if (this.simulation.skirtMesh) this.simulation.skirtMesh.visible = this.resolvedProps.underwater !== false;
    this.refreshWaterSlot();
    if (!source) return;
    const mesh = this.simulation.mesh;
    mesh.material = this.sourceMaterial(source.mesh.material);
    mesh.castShadow = source.mesh.castShadow; mesh.receiveShadow = source.mesh.receiveShadow;
    source.mesh.updateMatrix();
    mesh.matrix.copy(source.mesh.matrix);
    if (this.constructor.type === "water") {
      // The solver's local origin is ON the rest surface, and the volume hangs
      // below it. A Plane is authored lying in XY, so it needs the +90° that
      // puts the grid in XZ; a BOX is already Y-up and instead needs its origin
      // lifted from the box centre to the box lid.
      // (A container filled to `fill`: the lid sits `depth` above its bottom.)
      mesh.matrix.multiply(new Matrix4().makeTranslation(source.center.x, source.center.y + (source.box ? source.depth - (source.fullHeight ?? source.depth) / 2 : 0), source.center.z));
      if (!source.box) mesh.matrix.multiply(new Matrix4().makeRotationX(Math.PI / 2));
    } else mesh.matrix.multiply(new Matrix4().makeTranslation(source.center.x, source.center.y - source.height / 2, source.center.z));
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    if (this.constructor.type === "water" && !Array.isArray(mesh.material)) {
      this.waterSurfaceLook ??= installWaterSurfaceLook({ engine: this.entity.engine, mesh, material: mesh.material,
        simulation: this.simulation, slot: this.waterSlot, getSlot: () => this.waterSlot, underwater: this.resolvedProps.underwater !== false });
      this.waterSurfaceLook.update();
    }
    if (active) {
      if (!this.sourceClaim) this.sourceClaim = { visible: source.mesh.visible, tags: Object.fromEntries(["clothHidden", "noMerge", "noBatch"].map((key) => [key, { present: Object.hasOwn(source.mesh.userData, key), value: source.mesh.userData[key] }])) };
      source.mesh.userData.clothHidden = true; source.mesh.userData.noMerge = true; source.mesh.userData.noBatch = true;
      // ── THE HIDDEN SOURCE MESH'S MATERIAL IS WATER TOO ──────────────────
      //
      // The entity's own box is never drawn once the solver replaces it, but
      // GI still walks it and compiled its authored `Water.mat` with the full
      // radiance block: seventeen sampled textures, a failed pipeline in the
      // console for a mesh nobody sees, and 35 s of the compile wave spent on
      // it ("renderPipeline_Water_147 … (17) … exceeds … (16)", 2026-09-06).
      // `giWater` takes GI's early return; restored on release.
      if (this.constructor.type === "water") {
        this.sourceClaim.materials ??= [source.mesh.material].flat().filter(Boolean).map((material) =>
          ({ material, present: Object.hasOwn(material.userData ?? {}, "giWater"), value: material.userData?.giWater }));
        for (const { material } of this.sourceClaim.materials) { (material.userData ??= {}).giWater = true; }
      }
      source.mesh.visible = false;
      if (this.constructor.type === "water") {
        const collider = this.entity.getComponent("collider");
        if (collider?.props.autoGenerated && !collider.props.autoCustomized) {
          this.sourceClaim.collider ??= { component: collider, enabled: collider.enabled };
          if (collider.enabled) collider.setEnabled(false);
        }
      }
    } else this.releasePlane();
  }
  syncPlane() {
    const component = this.entity?.getComponent?.("mesh"), mesh = component?.mesh;
    const source = this.planeSource;
    // Cheap per-frame test — `findPlane` recomputes a bounding box and must not
    // run every tick. Water accepts a Box as well as a Plane; anything else
    // (including a switch between the two, which mints a new geometry) falls
    // through to the rebuild below.
    const kind = component?.props.geometry;
    const valid = mesh && !component.props.geometryAsset && (kind === "plane" || (WATER_SOLIDS.has(kind) && this.constructor.type === "water"));
    if ((!source && valid) || (source && (!valid || mesh !== source.mesh || mesh.geometry !== source.geometry || mesh.geometry.getAttribute("position")?.version !== this.sourceGeometryVersion || JSON.stringify(mesh.geometry.groups) !== this.sourceGroups))) {
      this.detachSimulation(); this.attachSimulation();
    } else if (source && this.constructor.type === "water" && this.simulation && this.gridOutgrown(source)) {
      this.detachSimulation(); this.attachSimulation();
    } else if (this.constructor.type === "water" && this.simulation && this.underwaterBuilt !== (this.resolvedProps.underwater !== false)) {
      // The toggle mints a solver without (or with) a slot, a caustic pass
      // and a look: a rebuild, once, when it flips.
      this.detachSimulation(); this.attachSimulation();
    } else this.syncAppearance();
  }
  /**
   * Has the water been SCALED far enough that its grid no longer fits it? A
   * rebuild mints a solver, a caustic pass and a material graph, so this waits
   * for the transform to hold still for half a second and asks for a third
   * more or a third fewer cells than it has — a gizmo drag rebuilds once, at
   * the end, and a wobble of a few percent never does.
   */
  gridOutgrown(source) {
    const wanted = waterAutoResolution(this.worldFootprint(source)), have = this.simulation.resolution;
    if (wanted === have || (wanted < have * 1.33 && wanted > have * .75)) { this._gridWantedSince = null; return false; }
    const now = performance.now();
    if (this._gridWanted !== wanted) { this._gridWanted = wanted; this._gridWantedSince = now; return false; }
    return now - (this._gridWantedSince ?? now) > 500;
  }
  onDetach() {
    this._unbindVfxAsset?.(); this._unbindVfxAsset = null;
    this.unsubscribeTick?.(); this.unsubscribeTick = null;
    this.unsubscribeMesh?.(); this.unsubscribeMesh = null;
    this.detachSimulation();
  }
  detachSimulation() {
    if (this.waterSlot) { this.entity?.engine?.waterSlots?.release(this); this.waterSlot = null; }
    this.releasePlane(); this.planeSource = null;
    this.waterSurfaceLook?.dispose(); this.waterSurfaceLook = null;
    this.simulation?.dispose(this.entity?.engine?.renderer); this.simulation = null;
    this.waterMaterials?.forEach(m => m.dispose()); this.waterMaterials = null; this.waterMaterialSignature = null;
    this.colliderField?.removeUser(); this.colliderField = null;
    this.meshColliderField?.removeUser(); this.meshColliderField = null;
  }
  onPropChanged(key) {
    if (key === "asset") bindVfxAsset(this, () => this.applyGraph());
    if (key !== "graph" && key !== "asset" && key !== "anchors" && this.props.graph && !this.props.asset) this.props.graph = setSimulationGraphProp(this.constructor.type, this.props.graph, key, this.props[key]);
    this.applyGraph();
  }
  applyGraph() {
    const previous = this.resolvedProps;
    this.resolveGraph();
    if (this.planeSource) this.resolvedProps = { ...this.resolvedProps, ...this.sourceProps(this.planeSource) };
    if (!this.simulation || ["resolution", "width", "height", "sceneCollision", "fill"].some((field) => previous?.[field] !== this.resolvedProps[field])) { this.detachSimulation(); this.attachSimulation(); }
    else {
      this.simulation.update(this.resolvedProps);
      if (previous?.amplitude !== this.resolvedProps.amplitude || previous?.pinning !== this.resolvedProps.pinning) this.restart();
      this.syncAppearance();
    }
  }
  resolveGraph() {
    const resolved = this.effectiveGraph ? evaluateSimulationGraph(this.constructor.type, this.effectiveGraph) : { ...this.props, simulationEnabled: true };
    // Entity references belong to this instance, including when its solver
    // settings come from a shared asset.
    if(this.constructor.type === "cloth") resolved.anchors=this.props.anchors ?? [];
    if(this.constructor.type === "water") for(const key of ["buoyancy", "waterDensity", "fluidDrag", "angularDrag", "wakeStrength"]) if(key in this.props) resolved[key]=this.props[key];
    this.graphEnabled = resolved.simulationEnabled;
    this.resolvedProps = resolved;
    if (!this.props.asset) for (const field of this.constructor.schema) if (field.key in resolved) this.props[field.key] = resolved[field.key];
  }
  /** Publish this surface into its engine slot: the matrices, the optical
   *  constants and the sun the caustic lens is aimed at. Cheap and idempotent,
   *  so every path that changes visibility or props can just call it. */
  refreshWaterSlot() {
    if (!this.waterSlot || !this.simulation?.slotKernel) return;
    updateWaterSlot({ engine: this.entity.engine, slot: this.waterSlot, kernel: this.simulation.slotKernel,
      mesh: this.simulation.mesh, simulation: this.simulation, props: this.resolvedProps });
    this.syncWaterFacing();
  }
  /**
   * ONE WATER SURFACE PER PIXEL — AND THE LID IS NOT PART OF THAT RULE.
   *
   * A body of water is a closed hull: lid, four walls, a floor, all transparent
   * and none writing depth. Drawn double-sided they blend against each other in
   * submission order and read as a heap of hard-edged translucent quads rather
   * than as water ("looks wrong", user 2026-09-05). The hull is convex, so
   * culling to one side is an exact fix for the SHELL: from outside its front
   * faces are the near walls and floor and every ray crosses exactly one; from
   * inside its back faces are the far ones, and again exactly one.
   *
   * ⛔ **THE LID IS THE EXCEPTION, AND TREATING IT AS SHELL DELETED THE WATER.**
   * The rule above asks "is the eye inside the box?", and answers FrontSide for
   * everything when it is not — so an eye that is outside the box but BELOW the
   * waterline (standing beside a pool with the camera at knee height, looking
   * up through it) got a lid culled away entirely: "when looking on the water
   * pool from the side and below, surface disappears — not waves, not anything.
   * This is not how water works" (user, 2026-09-05). It is not, and the
   * reference agrees — it ships a whole second shader for the view from under
   * the surface (`surface-under.frag.wgsl`).
   *
   * So the lid asks a different, simpler question: is the eye ABOVE this
   * surface or below it? Above, we see its top; below, its underside. Nothing
   * about that depends on being within the footprint, and the answer is the
   * same question a viewer asks of any transparent hull.
   *
   * Both margins are hysteretic: `side` is pipeline state, so flipping it mints
   * a pipeline, and an eye bobbing on the waterline must not do that per frame.
   */
  syncWaterFacing() {
    const material = this.simulation?.mesh.material;
    const camera = this.entity?.engine?.camera;
    if (!camera || !material || Array.isArray(material)) return;
    const extent = this.simulation.extent;
    const eyeWorld = camera.getWorldPosition(_cameraWorld);
    const eyeWorldY = eyeWorld.y, eyeWorldX = eyeWorld.x, eyeWorldZ = eyeWorld.z;
    const local = eyeWorld.applyMatrix4(_waterInverse.copy(this.simulation.mesh.matrixWorld).invert());
    // The ripple window follows the eye (whole-cell steps; see gridSimulation).
    this.simulation.followCamera?.(local.x, local.z);
    // ── ABOVE OR BELOW: THE SURFACE UNDER THE EYE, NOT THE REST PLANE ────
    //
    // The sea's CPU copy (the buoyancy query) says how high the water is at
    // the eye's own XZ; the eye is above when it is above THAT, with a
    // hysteresis of a few centimetres so bobbing on the waterline does not
    // flip the lid's side (pipeline state) every frame. The old answer was a
    // band of ±1.5 × the wave height around the rest plane — on a metre of
    // swell an eye in a trough stayed "under water" and one on a crest "in
    // the air" for metres: fog painted over the far surface, total-internal-
    // reflection white on the near slopes ("depth issues under grazing
    // angles", user, 2026-09-07). Without a CPU copy yet, the band stands.
    const swell = Math.max(1e-3, (this.simulation.uniforms.waveHeight.value + this.simulation.uniforms.amplitude.value) * 1.5);
    const surface = this.getSurfaceHeight?.(eyeWorldX, eyeWorldZ);
    let above;
    if (Number.isFinite(surface)) {
      const band = Math.max(.03, swell * .04);
      above = this._waterAbove === false ? eyeWorldY > surface + band : eyeWorldY > surface - band;
    } else {
      above = this._waterAbove === false ? local.y > swell : local.y > -swell;
    }
    const margin = (this._waterInside ? .5 : -.02) * Math.max(.001, Math.min(extent.halfX, extent.halfZ) * .05);
    const inside = Math.abs(local.x) < extent.halfX + margin && Math.abs(local.z) < extent.halfZ + margin
      && local.y < margin && local.y > -extent.depth - margin;
    this._waterAbove = above; this._waterInside = inside;
    // Published for the mirror (waterSurfaceLook) and the medium (the slot).
    this.simulation.eyeBelow = !above;
    if (this.waterSlot?.uniforms?.eyeBelow) this.waterSlot.uniforms.eyeBelow.value = above ? 0 : 1;
    const lidSide = above ? FrontSide : BackSide;
    const shellSide = inside ? BackSide : FrontSide;
    for (const [target, side] of [[material, lidSide], [this.simulation.skirtMaterial, shellSide]]) {
      if (!target || target.side === side) continue;
      target.side = side;
      target.needsUpdate = true;
    }
  }
  onEnable() { this.syncAppearance(); }
  onDisable() { if (this.simulation) this.simulation.mesh.visible = false; this.refreshWaterSlot(); this.releasePlane(); }
  restart() { this.simulation?.restart(); }
}
