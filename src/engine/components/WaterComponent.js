import { WaterPhysics, WATER_PHYSICS_DEFAULTS, queryWaterSurface } from "../vfx/waterPhysics.js";
import { installWaterMedium } from "../vfx/waterMedium.js";
import { installWaterCausticLight, removeWaterCausticLight } from "../vfx/waterCaustics.js";
import { waterSlotPool } from "../vfx/waterSlots.js";
import { GridSimulationComponent, gridSchema } from "../vfx/GridSimulationComponent.js";
import { simulationNodeTypes, simulationNodeDefaults, setSimulationGraphProp } from "../vfx/simulationGraph.js";
import { SEA_STATES, SEA_STATE_FIELDS } from "../vfx/waterSpectrumCPU.js";

/** GPU water VOLUME. The wave heightfield is its lid; the body below it is real
 * — it displaces rigid bodies, absorbs the light that crosses it and refracts
 * the sun onto whatever is underneath. Rendering deforms on the GPU; picking
 * uses the rest surface. */
export class WaterComponent extends GridSimulationComponent {
  static type = "water";
  static label = "Water";
  static tags = ["water", "simulation", "webgpu"];
  static defaults = { asset: "", graph: null, ...WATER_PHYSICS_DEFAULTS,
    ...simulationNodeDefaults("water", "grid"), ...simulationNodeDefaults("water", "water"),
    ...simulationNodeDefaults("water", "material"), ...simulationNodeDefaults("water", "output"),
  };
  // ⛔ WHAT IS NOT HERE, AND WHY. `waterDepth` is the SOURCE MESH's own height —
  // a Box of water is the box you drew, so a field for it is a second, lying
  // copy of a number the transform gizmo already owns. `waterDensity`,
  // `fluidDrag`, `angularDrag` and `wakeStrength` are water, not art direction
  // (see `WATER_CONSTANTS`). `damping` is the solver's numerical loss and now
  // also sets its viscosity, so an author moving it moves two things neither of
  // which they asked about. And the crest-foam pair was DEAD: it is implemented
  // only in the generated material, and every water in practice uses an
  // authored one — the foam you can see comes from `builtin:Water.mat`'s own
  // node. Removing a control that does nothing is not a loss of a feature.
  // ⚠ `foam` AND `foamThreshold` ARE BACK, because they now do something. They
  // were removed as dead controls, which they were — implemented only in the
  // generated material while every water uses an authored one — and the fix for
  // a dead control is to make it work, not to hide it. See `waterFoam.js`.
  // `resolution` is DERIVED for water — cells at a fixed size in world metres
  // (`waterAutoResolution`), because a grid count that ignored the box's size
  // is why "make it larger, and it does not work" (user, 2026-09-06).
  static hidden = ["waterDepth", "waterDensity", "fluidDrag", "angularDrag", "wakeStrength", "damping", "resolution"];
  static schema = [gridSchema[0],
    { key:"buoyancy",label:"Physics interaction",type:"boolean" },
    // ⛔ THE MATERIAL GROUP WAS MISSING, so `color`, `deepColor`, `roughness`,
    // `style`, `transmission`, the foam pair and — once it existed —
    // `saturation` were live props with no field anywhere in the editor. They
    // are the water's whole appearance, and the answer to "turn saturation up"
    // was a control that did not exist ("can't see those on the component",
    // user 2026-09-05). `width`/`height` come from the source mesh and
    // `waterDepth` already has its own row above, so those three are dropped.
    ...["grid", "water", "material"].flatMap((type) => simulationNodeTypes("water")[type].params
      .filter((field) => !["width", "height"].includes(field.key) && !WaterComponent.hidden.includes(field.key))),
  ].map((field) => Object.hasOwn(WATER_PHYSICS_DEFAULTS,field.key) || field.key === "asset" || field.key === "fitToPlane" ? field : { ...field, showIf: (props) => !props.asset });

  onAttach() {
    // THE SLOT POOL EXISTS BEFORE THE SOLVER DOES. `super.onAttach` builds the
    // simulation, and that build claims a slot — the pool has to be there.
    waterSlotPool(this.entity.engine);
    super.onAttach();
    this.waterPhysics = new WaterPhysics(this);
    (this.entity.engine.waterSurfaces ??= new Set()).add(this);
    // Both of these are per-SCENE, not per-surface — one `scene.fogNode` and
    // one caustic light serve every material — and installing either recompiles
    // materials, so they arrive with the first water surface and leave with the
    // last rather than once per pool.
    installWaterMedium(this.entity.engine);
    installWaterCausticLight(this.entity.engine);
  }
  onDetach() {
    const engine = this.entity.engine;
    engine.waterSurfaces?.delete(this);
    this.waterPhysics = null;
    super.onDetach();
    if (!engine.waterSurfaces?.size) { engine._waterMedium?.dispose(); removeWaterCausticLight(engine); }
  }
  applyBuoyancy(physics, dt) { this.waterPhysics?.step(physics, dt); }
  /**
   * ── `seaState`: A POOL AND AN OCEAN ARE ONE CLICK APART ──────────────────
   *
   * A preset writes the wave fields (`SEA_STATES`) and nothing else; the
   * fields stay editable, and editing one turns the preset back to `custom`
   * so the dropdown never claims a state the water is not in.
   */
  onPropChanged(key) {
    const state = this.props.seaState;
    const write = (k, v) => { this.props[k] = v; if (this.props.graph && !this.props.asset) this.props.graph = setSimulationGraphProp("water", this.props.graph, k, v); };
    if (key === "seaState" && state && state !== "custom") {
      const preset = SEA_STATES[state];
      if (preset) for (const [k, v] of Object.entries(preset)) write(k, v);
    } else if (SEA_STATE_FIELDS.includes(key) && state && state !== "custom" && key in (SEA_STATES[state] ?? {}) && SEA_STATES[state][key] !== this.props[key]) {
      write("seaState", "custom");
    }
    super.onPropChanged(key);
  }
  /** What the underwater medium and the GI caustic term read: the live volume,
   *  or null while this surface is not contributing anything. */
  mediumVolume() {
    if (!this.enabled || !this.graphEnabled || !this.simulation?.mesh.visible) return null;
    return this.waterSlot ?? null;
  }
  getSurfaceHeight(x, z) {
    if(!this.simulation)return null;
    return queryWaterSurface(this.simulation.mesh,this.resolvedProps,this.simulation.uniforms?.simTime?.value??0,{x,y:0,z},this.simulation.seaSample??null)?.height??null;
  }
}
