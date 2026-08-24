import * as THREE from 'three';

/**
 * Anything that can be placed in the world.
 */
export interface Artefact {
  /** Add meshes / objects to the scene. */
  addTo(scene: THREE.Scene): void;

  /** Called once per frame. */
  update(dt: number, camera: THREE.Camera): void;

  /** Clean up GPU resources and remove from scene. */
  dispose(scene: THREE.Scene): void;
}
