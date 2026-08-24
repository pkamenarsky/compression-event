import * as THREE from 'three';
import { WallShader } from './wallShader';

const WALL_FILL_COLOR = 0x999999;
const POLYGON_OFFSET_FACTOR = 1;
const POLYGON_OFFSET_UNITS = 1;

export class BasicWallShader implements WallShader {
  readonly name = 'basic';
  private material: THREE.MeshBasicMaterial | null = null;

  createMaterial(): THREE.Material {
    if (this.material) return this.material;
    this.material = new THREE.MeshBasicMaterial({
      color: WALL_FILL_COLOR,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: POLYGON_OFFSET_FACTOR,
      polygonOffsetUnits: POLYGON_OFFSET_UNITS,
    });
    return this.material;
  }

  update(_dt: number, _playerPosition: THREE.Vector3): void {
    // Nothing to update for basic material.
  }

  setWallHeight(_height: number): void {
    // Not needed for basic material.
  }

  dispose(): void {
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
