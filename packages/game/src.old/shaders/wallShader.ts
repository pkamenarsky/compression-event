import * as THREE from 'three';

/**
 * Interface for a pluggable wall shader.
 * Each implementation creates a THREE.Material and can update per-frame uniforms.
 */
export interface WallShader {
  /** Human-readable name for this shader. */
  readonly name: string;

  /** Create (or return) the material used for wall meshes. */
  createMaterial(): THREE.Material;

  /**
   * Called every frame so the shader can update uniforms
   * (e.g. player position, time, etc.).
   */
  update(dt: number, playerPosition: THREE.Vector3): void;

  /**
   * Inform the shader of the wall height so it can use it in calculations.
   * Optional — shaders that don't need it can implement as a no-op.
   */
  setWallHeight?(height: number): void;

  /** Dispose GPU resources. */
  dispose(): void;
}
