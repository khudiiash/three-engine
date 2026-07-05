import { registerComponent } from "./components/registry.js";
import { MeshComponent } from "./components/MeshComponent.js";
import { LightComponent } from "./components/LightComponent.js";
import { CameraComponent } from "./components/CameraComponent.js";
import { ModelComponent } from "./components/ModelComponent.js";
import { ScriptComponent } from "./components/ScriptComponent.js";
import { ParticleComponent } from "./components/ParticleComponent.js";
import { AnimationComponent } from "./components/AnimationComponent.js";
import { InstancerComponent } from "./components/InstancerComponent.js";
import { UiScreenComponent } from "./components/ui/UiScreenComponent.js";
import { UiElementComponent } from "./components/ui/UiElementComponent.js";
import { UiImageComponent } from "./components/ui/UiImageComponent.js";
import { UiTextComponent } from "./components/ui/UiTextComponent.js";
import { UiButtonComponent } from "./components/ui/UiButtonComponent.js";
import { UiLayoutComponent } from "./components/ui/UiLayoutComponent.js";
import { UiScrollComponent } from "./components/ui/UiScrollComponent.js";
import { UiMaskComponent } from "./components/ui/UiMaskComponent.js";

registerComponent(MeshComponent);
registerComponent(LightComponent);
registerComponent(CameraComponent);
registerComponent(ModelComponent);
registerComponent(ScriptComponent);
registerComponent(ParticleComponent);
registerComponent(AnimationComponent);
registerComponent(InstancerComponent);
registerComponent(UiScreenComponent);
registerComponent(UiElementComponent);
registerComponent(UiImageComponent);
registerComponent(UiTextComponent);
registerComponent(UiButtonComponent);
registerComponent(UiLayoutComponent);
registerComponent(UiScrollComponent);
registerComponent(UiMaskComponent);

export { Engine } from "./Engine.js";
export { Entity } from "./Entity.js";
export { Component } from "./components/Component.js";
export { registerComponent, unregisterComponent, getComponentClass, getComponentTypes, createComponent } from "./components/registry.js";
export {
  registerModuleDefinition,
  getModuleDefinition,
  getModuleDefinitions,
  enableEngineModule,
  disableEngineModule,
  applyEngineModules,
} from "./modules.js";
export { serializeScene, deserializeScene, serializeEntity, instantiateEntity } from "./serialize.js";
export { setAssetResolver, resolveAssetUrl, setScriptLoader, loadScriptModule, setAssetMetaLoader, loadAssetMeta } from "./assetResolver.js";
export { SCENE_SETTINGS_DEFAULTS, TONE_MAPPINGS } from "./sceneSettings.js";
export { EDITOR_LAYER } from "./editorLayers.js";
export { UI_LAYER, getUiSystem } from "./ui/UiSystem.js";
export { ANCHOR_PRESETS, applyAnchorPreset } from "./ui/layout.js";
export {
  InputManager,
  ActionMap,
  InputAction,
  Binding,
  Composite,
  KeyboardDevice,
  MouseDevice,
  GamepadDevice,
  TouchDevice,
  VirtualJoysticks,
  DEFAULT_PLAYER_MAP,
  DEFAULT_UI_MAP,
  createDefaultMaps,
} from "./input/index.js";
