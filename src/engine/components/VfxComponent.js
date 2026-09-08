import * as THREE from "three/webgpu";
import { uv, smoothstep, float, uniform } from "three/tsl";
import { Component } from "./Component.js";
import { ParticleComponent } from "./ParticleComponent.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { normalizeEffectTimeline, evaluateEffectElement, createEffectPreset } from "../vfx/effectTimeline.js";
const _parentRotation = new THREE.Quaternion(), _cameraRotation = new THREE.Quaternion();

/** A director for transient effect elements; generated objects never enter scene serialization. */
export class VfxComponent extends Component {
  static type = "vfx";
  static label = "VFX";
  static tags = ["effects", "timeline", "animation"];
  static resetOnStop = true;
  static defaults = { timeline: null, playOnStart: true, speed: 1 };
  static schema = [{ key: "playOnStart", label: "Play on start", type: "boolean" }, { key: "speed", label: "Playback speed", type: "number", min: 0, max: 10, step: .1 }];

  onAttach() {
    this.time = 0; this.state = "stopped";
    this.rebuild();
    this._off = this.entity.engine.onUpdate((dt) => {
      // Held while a modal editor mode owns the viewport (the geometry
      // editor). See Engine.suspendSimulation.
      if (this.entity.engine.simulationSuspended === true) return;
      const ownerVisible = this.ownerVisible();
      if (ownerVisible !== this._ownerVisible) { this._ownerVisible = ownerVisible; this.evaluate(this.time); }
      if (!this.enabled || !ownerVisible || this.state !== "playing") { this.alignBillboards(); return; }
      const next = this.time + Math.max(0, dt) * Math.max(0, Number(this.props.speed) || 0);
      if (next >= this.document.duration) {
        if (this.document.loop) { this.resetParticles(); this.evaluate(next % this.document.duration); }
        else { this.state = "stopped"; this.evaluate(this.document.duration); this.emit("finished", {}); }
      } else this.evaluate(next);
    });
    this._offPlay = this.entity.engine.on("play-changed", (playing) => { if (playing && this.props.playOnStart) this.play(); else this.stop(); });
    if (this.entity.engine.playing && this.props.playOnStart) this.play();
  }
  rebuild() {
    const document = normalizeEffectTimeline(this.props.timeline ?? createEffectPreset());
    this.disposeElements();
    this.document = document;
    this.assetError = null;
    this.elements = new Map();
    this.root = new THREE.Group(); this.root.name = "VFX runtime";
    this.entity.object3D.add(this.root);
    for (const element of this.document.elements) {
      const group = new THREE.Group(); group.name = element.name;
      const entry = { element, group, active: false };
      this.elements.set(element.id, entry);
      if (element.kind === "light") {
        entry.object = new THREE.PointLight(element.color, element.intensity, 20, 2);
        entry.object.castShadow = !!element.castShadow;
      } else if (element.kind === "particles") {
        const particle = new ParticleComponent({ graph: element.graph ?? null, asset: element.asset ?? "", enabled: false });
        const host = Object.create(this.entity); host.object3D = group;
        particle.entity = host; particle.onAttach(); entry.particle = particle;
      } else if (element.kind !== "group") {
        let geometry;
        if (element.kind === "ring") geometry = new THREE.RingGeometry(Math.max(.01, .5 - Math.max(.01, element.width)), .5, 64, 1, 0, THREE.MathUtils.degToRad(element.arc));
        else if (element.kind === "ribbon") {
          const points = Array.isArray(element.points) && element.points.length >= 2 ? element.points.map((p) => new THREE.Vector3(...p)) : [new THREE.Vector3(-1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(1,0,0)];
          const curve = new THREE.CatmullRomCurve3(points);
          const vertices = [], uvs = [], indices = [];
          for (let i = 0; i <= 48; i++) { const p = curve.getPoint(i/48); vertices.push(p.x,p.y,p.z-element.width/2,p.x,p.y,p.z+element.width/2); uvs.push(i/48,0,i/48,1); if(i<48){const j=i*2;indices.push(j,j+1,j+2,j+1,j+3,j+2);} }
          geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices,3)); geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2)); geometry.setIndex(indices); geometry.computeVertexNormals();
        } else if (element.kind === "mesh") geometry = element.geometry === "box" ? new THREE.BoxGeometry(1,1,1) : element.geometry === "cone" ? new THREE.ConeGeometry(.5,1,24) : new THREE.SphereGeometry(.5,24,16);
        else geometry = new THREE.PlaneGeometry(1,1);
        const material = element.lit ? new THREE.MeshStandardNodeMaterial() : new THREE.MeshBasicNodeMaterial();
        material.color.set(element.color); material.transparent = true; material.depthWrite = false; material.side = THREE.DoubleSide;
        material.blending = element.blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
        if (element.lit) { material.roughness = element.roughness; material.userData.giParticle = true; }
        if (element.kind === "sprite" && !element.texture) { entry.opacity = uniform(1); material.opacityNode = float(1).sub(smoothstep(.15, .5, uv().sub(.5).length())).mul(entry.opacity); }
        entry.object = new THREE.Mesh(geometry, material);
        entry.object.castShadow = !!element.castShadow; entry.object.receiveShadow = element.receiveShadow !== false;
        entry.object.userData.noMerge = true; entry.object.userData.noBatch = true;
        entry.object.userData.vfxSimulation = true;
        if (element.texture) this.loadTexture(entry, element.texture);
      }
      if (entry.object) { entry.object.userData.entityId = this.entity.id; group.add(entry.object); }
    }
    for (const entry of this.elements.values()) (this.elements.get(entry.element.parent)?.group ?? this.root).add(entry.group);
    this.evaluate(Math.min(this.time ?? 0, this.document.duration));
  }
  async loadTexture(entry, path) {
    try {
      const url = await resolveAssetUrl(path);
      const texture = await new THREE.TextureLoader().loadAsync(url);
      if (this.elements?.get(entry.element.id) !== entry) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace; entry.texture = texture;
      texture.repeat.set(1 / Math.max(1, Math.floor(entry.element.columns)), 1 / Math.max(1, Math.floor(entry.element.rows)));
      entry.object.material.map = texture; entry.object.material.needsUpdate = true;
      // A texture can finish after a paused scrub: show that frame immediately.
      this.evaluate(this.time);
    } catch (error) { if (this.elements?.get(entry.element.id) === entry) this.assetError = `VFX texture: ${error.message}`; }
  }
  ownerVisible() { for (let object = this.entity.object3D; object; object = object.parent) if (!object.visible) return false; return true; }
  evaluate(time) {
    this.time = Math.min(this.document.duration, Math.max(0, Number(time) || 0));
    const running = this.enabled && this.state !== "stopped" && this.ownerVisible();
    this.root.visible = running;
    const active = (e) => evaluateEffectElement(e, this.time).active && (!e.parent || active(this.elements.get(e.parent).element));
    for (const entry of this.elements.values()) {
      const e = entry.element, value = evaluateEffectElement(e, this.time);
      const visible = running && active(e);
      entry.group.visible = visible;
      entry.group.position.set(value.x,value.y,value.z);
      entry.group.rotation.set(...[value.rotationX,value.rotationY,value.rotationZ].map(THREE.MathUtils.degToRad));
      entry.group.scale.setScalar(Math.max(.0001, value.scale));
      if (entry.object?.isLight) entry.object.intensity = Math.max(0,value.intensity);
      if (entry.object?.material) entry.object.material.opacity = THREE.MathUtils.clamp(value.opacity,0,1);
      if (entry.opacity) entry.opacity.value = THREE.MathUtils.clamp(value.opacity,0,1);
      if (entry.texture) {
        const columns = Math.max(1, Math.floor(e.columns)), rows = Math.max(1, Math.floor(e.rows));
        const frame = Math.floor(Math.max(0, value.localTime) * Math.max(0, e.fps)) % (columns * rows);
        entry.texture.offset.set((frame % columns) / columns, 1 - (Math.floor(frame / columns) + 1) / rows);
      }
      if (entry.particle) {
        entry.particle.simulationTimeScale = Math.max(0, Number(this.props.speed) || 0);
        if (visible && !entry.active) entry.particle.restart();
        entry.particle.paused = this.state !== "playing";
        entry.particle.setEnabled(visible);
      }
      entry.active = visible;
    }
    this.alignBillboards();
  }
  alignBillboards() {
    const camera = this.entity.engine.camera;
    if (!camera) return;
    camera.getWorldQuaternion(_cameraRotation);
    // Resolve every authored parent transform before orienting any child; list
    // order is independent of hierarchy order in the timeline document.
    this.root?.updateWorldMatrix(true, true);
    for (const entry of this.elements?.values() ?? []) if (entry.element.kind === "sprite" && entry.element.billboard) {
      entry.group.getWorldQuaternion(_parentRotation);
      entry.object.quaternion.copy(_parentRotation.invert().multiply(_cameraRotation));
      const value = evaluateEffectElement(entry.element, this.time);
      entry.object.rotateZ(THREE.MathUtils.degToRad(value.rotationZ));
    }
  }
  resetParticles() { for(const entry of this.elements?.values() ?? []) entry.particle?.restart(); }
  play(from = 0) { this.state = "playing"; if(this.root) this.root.visible = true; this.resetParticles(); this.evaluate(from); }
  pause() { this.state = "paused"; for(const e of this.elements.values()) if(e.particle) e.particle.paused = true; }
  resume() { this.state = "playing"; this.evaluate(this.time); }
  stop() { this.state = "stopped"; this.evaluate(0); if(this.root) this.root.visible = false; for(const e of this.elements.values()) e.particle?.setEnabled(false); }
  seek(time) { this.state = "paused"; if(this.root) this.root.visible = true; this.resetParticles(); this.evaluate(time); }
  onPropChanged(key) { if (key === "timeline") this.rebuild(); }
  onDisable() { if(this.root) this.root.visible = false; for(const e of this.elements?.values() ?? []) e.particle?.setEnabled(false); }
  onEnable() { this.evaluate(this.time); }
  disposeElements() { for (const e of this.elements?.values() ?? []) { e.particle?.onDetach(); e.texture?.dispose(); e.object?.geometry?.dispose(); e.object?.material?.dispose(); e.object?.dispose?.(); } this.root?.removeFromParent(); this.elements?.clear(); }
  onDetach() { this._off?.(); this._offPlay?.(); this.disposeElements(); }
}
