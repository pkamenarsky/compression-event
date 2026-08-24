import { MOVE_SPEED } from './constants';

import * as THREE from 'three';

export interface Controls {
  update(): THREE.Vector2;
  resetYaw(newYaw: number): void;
}

export function setupControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLCanvasElement
): Controls {
  const keys: Record<string, boolean> = {};
  let yaw = 0;
  const lookSpeed = 0.002;
  let isLocked = false;

  domElement.addEventListener('click', () => {
    domElement.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === domElement;
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isLocked) return;
    yaw -= e.movementX * lookSpeed;
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    keys[e.code] = true;
  });

  document.addEventListener('keyup', (e: KeyboardEvent) => {
    keys[e.code] = false;
  });

  const direction = new THREE.Vector3();

  return {
    update(): THREE.Vector2 {
      camera.rotation.set(0, yaw, 0, 'YXZ');

      direction.set(0, 0, 0);

      if (keys['KeyW']) direction.z -= 1;
      if (keys['KeyS']) direction.z += 1;
      if (keys['KeyA']) direction.x -= 1;
      if (keys['KeyD']) direction.x += 1;

      const moveDelta = new THREE.Vector2(0, 0);

      if (direction.length() > 0) {
        direction.normalize();
        direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

        // Map 3D direction (X, Z) to 2D movement delta (x, y)
        moveDelta.set(direction.x * MOVE_SPEED, direction.z * MOVE_SPEED);
      }

      return moveDelta;
    },

    resetYaw(newYaw: number): void {
      yaw = newYaw;
      camera.rotation.set(0, yaw, 0, 'YXZ');
    },
  };
}
