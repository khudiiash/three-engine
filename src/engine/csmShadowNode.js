import { Box3, Matrix4, Vector3 } from "three/webgpu";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";

const worldUp = new Vector3(0, 1, 0);

/**
 * Three's CSM assumes an identity light parent: it combines local light poses
 * with a world camera, then parents the fitted centers again. Engine lights live
 * below rotated entities. Fit in world space and convert only the final poses.
 * prepare() also resolves those poses before ShadowFreeze reads their matrices.
 */
export class EngineCSMShadowNode extends CSMShadowNode {
  constructor(light, data = {}) {
    super(light, data);
    this._boundProjection = new Matrix4();
    this._boundCamera = null;
    this._boundSettings = [];
    this._lightWorld = new Vector3();
    this._targetWorld = new Vector3();
    this._directionWorld = new Vector3();
    this._orientation = new Matrix4();
    this._cameraToLight = new Matrix4();
    this._worldToParent = new Matrix4();
    this._bounds = new Box3();
    this._point = new Vector3();
    this._center = new Vector3();
  }

  updateFrustums() {
    super.updateFrustums();
    this._boundCamera = this.camera;
    this._boundProjection.copy(this.camera.projectionMatrix);
    this._boundSettings = [this.maxFar, this.mode, this.fade, this.cascades, this.customSplitsCallback];
  }

  _initCascades() {
    // CameraComponent/Engine own projection updates. Upstream reconstructs the
    // matrix here, which would erase a supplied off-axis or custom projection.
    this.mainFrustum.setFromProjectionMatrix(this.camera.projectionMatrix, this.maxFar);
    this.mainFrustum.split(this.breaks, this.frustums);
  }

  prepare(camera, { force = false } = {}) {
    // setup() must retain ownership of lazy initialization, including renderer
    // depth conventions. Setting camera before _init() would bypass it entirely.
    if (!camera || this.mainFrustum === null) return;
    this.camera = camera;
    camera.updateWorldMatrix(true, false);
    const settings = this._boundSettings;
    if (force || camera !== this._boundCamera
      || !this._boundProjection.equals(camera.projectionMatrix)
      || settings[0] !== this.maxFar || settings[1] !== this.mode
      || settings[2] !== this.fade || settings[3] !== this.cascades
      || settings[4] !== this.customSplitsCallback) {
      this.updateFrustums();
    }
    this._poseCascades();
  }

  updateBefore() {
    // Still needed for the first lazy setup and renders outside Engine.#tick.
    this.prepare(this.camera);
  }

  _poseCascades() {
    const light = this.light;
    const parent = light.parent;
    if (!parent) return;
    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    this._lightWorld.setFromMatrixPosition(light.matrixWorld);
    this._targetWorld.setFromMatrixPosition(light.target.matrixWorld);
    this._directionWorld.subVectors(this._targetWorld, this._lightWorld).normalize();
    this._orientation.lookAt(this._lightWorld, this._targetWorld, worldUp);
    this._cameraToLight.copy(this._orientation).invert().multiply(this.camera.matrixWorld);
    this._worldToParent.copy(parent.matrixWorld).invert();

    for (let i = 0; i < this.frustums.length; i++) {
      const cascade = this.lights[i];
      const shadow = cascade.shadow;
      const camera = shadow.camera;
      const vertices = this.frustums[i].vertices;
      this._bounds.makeEmpty();
      for (let j = 0; j < 4; j++) {
        this._bounds.expandByPoint(this._point.copy(vertices.near[j]).applyMatrix4(this._cameraToLight));
        this._bounds.expandByPoint(this._point.copy(vertices.far[j]).applyMatrix4(this._cameraToLight));
      }
      this._bounds.getCenter(this._center);
      this._center.z = this._bounds.max.z + this.lightMargin;
      const texelX = (camera.right - camera.left) / shadow.mapSize.width;
      const texelY = (camera.top - camera.bottom) / shadow.mapSize.height;
      this._center.x = Math.floor(this._center.x / texelX) * texelX;
      this._center.y = Math.floor(this._center.y / texelY) * texelY;
      this._center.applyMatrix4(this._orientation);

      if (cascade.parent !== parent) parent.add(cascade);
      if (cascade.target.parent !== parent) parent.add(cascade.target);
      cascade.position.copy(this._center).applyMatrix4(this._worldToParent);
      cascade.target.position.copy(this._center).add(this._directionWorld).applyMatrix4(this._worldToParent);
      // Renderer scene traversal has already happened when updateBefore runs.
      // Resolve both now; preRender's freeze must also see these current inputs.
      cascade.updateWorldMatrix(false, false);
      cascade.target.updateWorldMatrix(false, false);
    }
  }
}
