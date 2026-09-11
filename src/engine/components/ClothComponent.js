import { GridSimulationComponent, gridSchema } from "../vfx/GridSimulationComponent.js";
import { simulationNodeTypes, simulationNodeDefaults } from "../vfx/simulationGraph.js";

/** Deforms this entity's Plane Mesh; its material and dimensions belong to Mesh. */
export class ClothComponent extends GridSimulationComponent {
  static type = "cloth";
  // ⭐ A CLOTH NOBODY CAN SEE DOES NOT NEED SIMULATING. The tick has always
  // been gated on `isInView()`, but `_inView` is only ever resolved for
  // components in `engine.viewOnlyComponents`, and cloth never joined it — so
  // the gate read `null !== false` and every cloth in the scene ran every
  // frame. See `viewGatedBy` in Component.js.
  //
  // ⚠ The trade is real and deliberate: a curtain behind you does not react to
  // something walking through it, and resumes from where it stood when you
  // look back. Its culling sphere is TWICE the cloth's own radius, so it keeps
  // simulating well past the edge of the screen.
  static viewGated = true;
  static label = "Cloth";
  static tags = ["cloth", "simulation", "webgpu"];
  static defaults = { asset: "", graph: null, resolution: 32, anchors: [], ...simulationNodeDefaults("cloth", "cloth") };
  static schema = [gridSchema[0], simulationNodeTypes("cloth").grid.params[0], ...simulationNodeTypes("cloth").cloth.params,
    {key:"anchors",label:"Entity anchors",type:"clothAnchors"}]
    .map((field) => {
      if (field.key === "asset" || field.key === "anchors") return field;
      // The wind fields belong to the SCENE unless this cloth opts out, so
      // showing them while they do nothing would be a lie the inspector tells.
      if (["wind", "gust", "gustFrequency"].includes(field.key)) {
        return { ...field, showIf: (props) => !props.asset && props.windSource === "custom" };
      }
      return { ...field, showIf: (props) => !props.asset };
    })
    .concat([{ key: "runInEditor", label: "Run In Editor", type: "boolean" }]);
}
