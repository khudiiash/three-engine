import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { usePlayStore } from "./store/playStore.js";

let snapshot = null;

export async function play() {
  const engine = await ensureEngine();
  const { serializeScene } = await import("../engine/index.js");
  if (engine.playing) return;
  snapshot = serializeScene(engine);
  engine.setPlaying(true);
  usePlayStore.setState({ playing: true });
}

export async function stop() {
  const engine = await ensureEngine();
  const { deserializeScene } = await import("../engine/index.js");
  if (!engine.playing) return;
  engine.setPlaying(false);
  if (snapshot) {
    deserializeScene(engine, snapshot);
    snapshot = null;
  }
  commandBus.clearHistory();
  useSelectionStore.getState().clear();
  useSceneStore.getState().refresh();
  usePlayStore.setState({ playing: false });
}

export async function toggle() {
  const engine = await ensureEngine();
  if (engine.playing) await stop();
  else await play();
}
