import { GridSimulationComponent, gridSchema } from "../vfx/GridSimulationComponent.js";
import { simulationNodeTypes, simulationNodeDefaults } from "../vfx/simulationGraph.js";

/** Deforms this entity's Plane Mesh; its material and dimensions belong to Mesh. */
export class ClothComponent extends GridSimulationComponent {
  static type = "cloth";
  static label = "Cloth";
  static tags = ["cloth", "simulation", "webgpu"];
  static defaults = { asset: "", graph: null, resolution: 32, anchors: [], ...simulationNodeDefaults("cloth", "cloth") };
  static schema = [gridSchema[0], simulationNodeTypes("cloth").grid.params[0], ...simulationNodeTypes("cloth").cloth.params,
    {key:"anchors",label:"Entity anchors",type:"clothAnchors"}]
    .map((field) => field.key === "asset" || field.key === "anchors" ? field : { ...field, showIf: (props) => !props.asset });
}
