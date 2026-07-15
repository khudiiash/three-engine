import * as THREE from "three/webgpu";

const GIZMO_COLOR = 0xffd34e;

function pushSegment(points, a, b) {
  points.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

/** Compact sun-dial helper. Local -Z is the emitted light direction. */
export class DirectionalLightGizmo extends THREE.Group {
  constructor(entity, size = 1) {
    super();
    this.entity = entity;
    this.userData.editorOnly = true;
    this.userData.entityId = entity.id;

    const points = [];
    const radius = size * 0.65;
    const steps = 24;

    // A back hemisphere (+Z), leaving the arrow unobscured on the emitting
    // side. Ribs and rings make pitch/yaw readable from any camera angle.
    for (const azimuth of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      let previous = null;
      for (let i = 0; i <= steps; i += 1) {
        const latitude = -Math.PI / 2 + (i / steps) * Math.PI;
        const point = new THREE.Vector3(
          radius * Math.sin(latitude) * Math.cos(azimuth),
          radius * Math.sin(latitude) * Math.sin(azimuth),
          radius * Math.cos(latitude),
        );
        if (previous) pushSegment(points, previous, point);
        previous = point;
      }
    }
    for (const polar of [Math.PI / 4, Math.PI / 2]) {
      let previous = null;
      for (let i = 0; i <= steps; i += 1) {
        const azimuth = (i / steps) * Math.PI * 2;
        const point = new THREE.Vector3(
          radius * Math.sin(polar) * Math.cos(azimuth),
          radius * Math.sin(polar) * Math.sin(azimuth),
          radius * Math.cos(polar),
        );
        if (previous) pushSegment(points, previous, point);
        previous = point;
      }
    }

    pushSegment(points, new THREE.Vector3(0, 0, radius * 0.25), new THREE.Vector3(0, 0, -size * 1.25));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    this.lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: GIZMO_COLOR, depthTest: false }));
    this.lines.renderOrder = 2;
    this.add(this.lines);

    this.arrow = new THREE.Mesh(
      new THREE.ConeGeometry(size * 0.14, size * 0.38, 12),
      new THREE.MeshBasicMaterial({ color: GIZMO_COLOR, depthTest: false }),
    );
    this.arrow.rotation.x = -Math.PI / 2;
    this.arrow.position.z = -size * 1.42;
    this.arrow.renderOrder = 2;
    this.add(this.arrow);
  }

  update() {
    this.entity.object3D.updateWorldMatrix(true, false);
    this.entity.object3D.getWorldPosition(this.position);
    this.entity.object3D.getWorldQuaternion(this.quaternion);
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.arrow.geometry.dispose();
    this.arrow.material.dispose();
  }
}
