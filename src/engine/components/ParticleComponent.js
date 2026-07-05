import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  deltaTime,
  float,
  hash,
  instanceIndex,
  instancedArray,
  smoothstep,
  time,
  texture as tslTexture,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { Component } from "./Component.js";
import { compileParticleGraph, legacyPropsToGraph, DEFAULT_PARTICLE_GRAPH } from "../particleGraph.js";

const MAX_CAPACITY = 200_000;

/**
 * Node-graph GPU particle system. The graph (props.graph) compiles to TSL:
 * an init compute pass, a per-frame update pass (age/respawn/forces/
 * integration), and a sprite material whose size/color/opacity are graph
 * expressions evaluated per instance. Per-particle state lives in storage
 * buffers; everything simulates on the GPU, in the editor too.
 *
 * Old scenes with pre-graph props (count/shape/startColor/…) are converted
 * to an equivalent graph on attach.
 */
export class ParticleComponent extends Component {
  static type = "particles";
  static label = "Particles";
  static defaults = { graph: null };
  // The node editor (Window → Particles) is the real UI; nothing to inspect here.
  static schema = [];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    let graph = this.props.graph;
    if (!graph && this.props.startColor !== undefined) graph = legacyPropsToGraph(this.props);
    if (!graph) graph = DEFAULT_PARTICLE_GRAPH;
    this.#build(graph, this.generation);
  }

  async #build(graph, generation) {
    let compiled;
    try {
      compiled = await compileParticleGraph(graph);
    } catch (err) {
      console.error(`Particle graph failed to compile: ${err.message ?? err}`);
      return;
    }
    if (generation !== this.generation) return; // detached/rebuilt meanwhile

    const s = compiled.system;
    const capacity = Math.min(MAX_CAPACITY, Math.max(1, Math.floor(s.capacity)));
    const jitter = Math.min(1, Math.max(0, s.lifetimeJitter));

    const positions = instancedArray(capacity, "vec3");
    const velocities = instancedArray(capacity, "vec3");
    const ages = instancedArray(capacity, "float");

    // Per-particle lifetime, stable per index in every context.
    const lifetimeOf = (indexFloat) =>
      float(s.lifetime).mul(hash(indexFloat.add(555)).mul(jitter).oneMinus()).max(0.05);

    // A context bundles what attribute nodes resolve to in one evaluation
    // domain. `rand(k)` in spawn contexts is salted per respawn cycle.
    const makeComputeCtx = (key, salt) => {
      const index = instanceIndex.toFloat();
      const age = ages.element(instanceIndex);
      const life = lifetimeOf(index);
      return {
        key,
        cache: new Map(),
        index,
        position: positions.element(instanceIndex),
        velocity: velocities.element(instanceIndex),
        age,
        life01: age.div(life).clamp(0, 1),
        rand: (k) => hash(index.add(salt).add(k * 1013)),
      };
    };

    this.initCompute = Fn(() => {
      const ctx = makeComputeCtx("spawn", float(0));
      positions.element(instanceIndex).assign(compiled.spawnPosition(ctx));
      velocities.element(instanceIndex).assign(compiled.spawnVelocity(ctx));
      // Stagger ages across a lifetime so emission ramps in instead of popping.
      ages.element(instanceIndex).assign(hash(instanceIndex).mul(s.lifetime));
    })().compute(capacity);

    this.updateCompute = Fn(() => {
      const index = instanceIndex.toFloat();
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const age = ages.element(instanceIndex);
      const life = lifetimeOf(index);

      age.addAssign(deltaTime);
      If(age.greaterThanEqual(life), () => {
        // time-derived salt → fresh randoms every respawn cycle
        const ctx = makeComputeCtx("spawn", time.mul(1e3));
        age.assign(0);
        position.assign(compiled.spawnPosition(ctx));
        velocity.assign(compiled.spawnVelocity(ctx));
      });

      if (compiled.force) {
        const ctx = makeComputeCtx("update", float(77.7));
        velocity.addAssign(compiled.force(ctx).mul(deltaTime));
      }
      position.addAssign(velocity.mul(deltaTime));

      if (s.floor === "bounce") {
        If(position.y.lessThan(s.floorY).and(velocity.y.lessThan(0)), () => {
          position.assign(vec3(position.x, float(s.floorY).mul(2).sub(position.y), position.z));
          velocity.assign(vec3(velocity.x.mul(0.85), velocity.y.negate().mul(s.bounce), velocity.z.mul(0.85)));
        });
      } else if (s.floor === "kill") {
        If(position.y.lessThan(s.floorY), () => age.assign(life));
      }
    })().compute(capacity);

    // Render context: same expressions, but reading instanced attributes.
    const renderIndex = instanceIndex.toFloat();
    const renderAge = ages.toAttribute();
    const renderLife = lifetimeOf(renderIndex);
    const renderCtx = {
      key: "render",
      cache: new Map(),
      index: renderIndex,
      position: positions.toAttribute(),
      velocity: velocities.toAttribute(),
      age: renderAge,
      life01: renderAge.div(renderLife).clamp(0, 1),
      rand: (k) => hash(renderIndex.add(k * 1013)),
    };

    this.material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: s.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.material.positionNode = positions.toAttribute();

    const sizeJitter = hash(renderIndex.add(999)).mul(s.sizeJitter ?? 0).oneMinus();
    this.material.scaleNode = compiled.size(renderCtx).mul(sizeJitter).max(0);

    let rgb = compiled.color(renderCtx);
    let mask;
    if (compiled.spriteTexture) {
      const texel = tslTexture(compiled.spriteTexture, uv());
      rgb = rgb.mul(texel.rgb);
      mask = texel.a;
    } else {
      mask = smoothstep(0.5, 0.15, uv().sub(0.5).length());
    }
    const alpha = compiled.opacity ? compiled.opacity(renderCtx) : renderCtx.life01.oneMinus();
    this.material.colorNode = vec4(rgb, alpha.clamp(0, 1).mul(mask));

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.count = capacity;
    this.sprite.frustumCulled = false;
    this.sprite.userData.entityId = this.entity.id;
    this.entity.object3D.add(this.sprite);

    this.initialized = false;
    this.unsubUpdate = this.entity.engine.onUpdate(() => this.#tick());
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1; // cancels in-flight builds
    this.unsubUpdate?.();
    this.unsubUpdate = null;
    if (!this.sprite) return;
    this.entity.object3D.remove(this.sprite);
    this.material.dispose();
    this.sprite = null;
    this.material = null;
    this.initCompute = null;
    this.updateCompute = null;
  }

  onPropChanged() {
    this.onDetach();
    this.onAttach();
  }

  /** Re-runs the init pass (editor Restart button). */
  restart() {
    this.initialized = false;
  }

  #tick() {
    const renderer = this.entity.engine.renderer;
    if (!renderer || !this.updateCompute) return;
    if (!this.initialized) {
      this.initialized = true;
      renderer.compute(this.initCompute);
    }
    renderer.compute(this.updateCompute);
  }
}
