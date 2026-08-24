import * as THREE from 'three';
import { World } from './world';
import { WORLD_SCALE } from './constants';
import { setupControls } from './controls';
import level1 from '../assets/level(16).json';
import level2 from '../assets/level(13).json';
import latestDownload from 'virtual:latest-download';
// import level3 from '../assets/level(209).json';
import level3 from '../assets/level(161).json';
// import level4 from '../assets/level(161).json';
import level5 from '../assets/level(95).json';
import level6 from '../assets/level(145).json';
// import level6 from '../assets/level(153).json';
import { Map, ArtefactType } from './editor';
import { showMessage, showBlackScreen, showDescription, hideDescription } from './ui';
import { playSound, playSoundFor, drone, versionShift, SoundHandle, error, pickup, levelComplete } from './sound';

const START_LEVEL = 0;

const levels: Map[] = [
  (latestDownload as Map) ?? level1 as Map,
  level2 as Map,
  // (latestDownload as Map) ?? level3 as Map,
  level3 as Map,
  // level4 as Map,
  level5 as Map,
  level6 as Map,
];

// ── Renderer / scene / camera setup ──

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  200
);
camera.position.set(0, 1.6, 0);

const controls = setupControls(camera, renderer.domElement);

// ── Game state ──

let currentLevelIndex = START_LEVEL;
let currentVersionIndex = 0;
let inventory: ArtefactType[] = [];
let versionTimer = 0;
const VERSION_SWITCH_INTERVAL = 5.0; // seconds
let gameRunning = false;
let gamePaused = false; // true while overlay is showing

const ARTEFACT_PICKUP_DIST = 1.5;

// ── Sound state ──

let droneHandle: SoundHandle | null = null;
let versionShiftHandle: SoundHandle | null = null;

// ── World ──

const firstMap = levels[currentLevelIndex];
const firstPolygons = firstMap.versions?.[0]?.polygons ?? [];
const world = new World(scene, firstPolygons, renderer, camera);

// ── Resize handler ──

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  world.resizeDitherPass(window.innerWidth, window.innerHeight);
});

// ── Inertia / momentum parameters ──

const velocity = new THREE.Vector2(0, 0);
const ACCELERATION = 30.0;
const FRICTION = 8.0;

let prevTime = performance.now();

// ── Sound helpers ──

/** Play the version-shift escalation sound (stops any previous one). */
function stopAndStartVersionShiftSound(restart: boolean = true): void {
  if (versionShiftHandle) {
    versionShiftHandle.stop();
    versionShiftHandle = null;
  }

  if (restart) {
    // Each call to versionShift() generates fresh random parameters
    versionShiftHandle = playSoundFor(versionShift(), 5);
  }
}

// ── Level management ──

function loadCurrentLevel(): void {
  const map = levels[currentLevelIndex];
  currentVersionIndex = 0;
  versionTimer = 0;
  inventory = [];

  const polygons = map.versions?.[currentVersionIndex]?.polygons ?? [];
  const artefacts = map.artefacts ?? [];

  world.loadLevel(polygons, artefacts);

  // Reset player position and look direction (face east = positive X)
  camera.position.set(0, 1.6, 0);

  for (const artefact of map.artefacts) {
    if (artefact.type === 'start') {
      camera.position.set(artefact.x * WORLD_SCALE, 1.6, artefact.y * WORLD_SCALE);
    }
  }

  controls.resetYaw(-Math.PI / 2);
  velocity.set(0, 0);

  // Play the escalation sound for the new level
  stopAndStartVersionShiftSound();
}

function switchToVersion(versionIndex: number) {
  const map = levels[currentLevelIndex];
  if (!map.versions || versionIndex >= map.versions.length) return;

  currentVersionIndex = versionIndex;
  const polygons = map.versions[currentVersionIndex].polygons ?? [];
  world.loadVersion(polygons);

  // Play the escalation sound for the version switch
  if (world.isInsideMap(camera.position.x, camera.position.z)) {
    stopAndStartVersionShiftSound();
  }
  else {
    stopAndStartVersionShiftSound(false);
    playSoundFor(error, 1);
  }
}

function resetLevel(): void {
  loadCurrentLevel();
}

// ── Artefact description helpers ──

function getArtefactDescription(type: ArtefactType, hasKey: boolean): string {
  switch (type) {
    case 'delay':
      return 'DELAY COMPRESSION';
    case 'decompress':
      return 'DECOMPRESS';
    case 'key':
      return 'KEY';
    case 'exit':
      return hasKey ? 'EXIT' : 'EXIT: FIND KEY';
    default:
      return type.toUpperCase();
  }
}

// ── Main gameplay loop ──

async function startGame(): Promise<void> {
  // Title screen — wait for user click (timeout = 0 means no auto-dismiss)
  await showMessage('COMPRESSION EVENT', 0, 'CLICK TO START');

  // Start ambient drone
  droneHandle = playSound(drone);

  // Load first level
  loadCurrentLevel();
  gameRunning = true;
  gamePaused = false;
}

function animate(): void {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = (now - prevTime) / 1000;
  prevTime = now;

  if (!gameRunning || gamePaused) {
    // Still render the scene even when paused
    world.render();
    return;
  }

  // ── Controls ──
  const moveDelta = controls.update();
  const inputLen = moveDelta.length();

  if (inputLen > 1e-6) {
    const factor = 1.0 - Math.exp(-ACCELERATION * dt);
    velocity.x += (moveDelta.x - velocity.x) * factor;
    velocity.y += (moveDelta.y - velocity.y) * factor;
  } else {
    const frictionFactor = Math.exp(-FRICTION * dt);
    velocity.x *= frictionFactor;
    velocity.y *= frictionFactor;
    if (velocity.length() < 0.001) {
      velocity.set(0, 0);
    }
  }

  const frameMove = new THREE.Vector2(velocity.x * dt, velocity.y * dt);
  const currentPos = new THREE.Vector2(camera.position.x, camera.position.z);

  // ── Trace with artefact proximity ──
  const traceResult = world.traceWithArtefacts(currentPos, frameMove);

  camera.position.x = traceResult.position.x;
  camera.position.z = traceResult.position.y;
  camera.position.y = 1.6;

  // ── Version switching timer ──
  versionTimer += dt;
  if (versionTimer >= VERSION_SWITCH_INTERVAL) {
    versionTimer = 0;
    const map = levels[currentLevelIndex];
    const numVersions = map.versions?.length ?? 1;
    if (numVersions > 1) {
      const nextVersion = (currentVersionIndex + 1) % numVersions;
      switchToVersion(nextVersion);
    }
  }

  // ── Check if player is inside map ──
  if (!world.isInsideMap(camera.position.x, camera.position.z)) {
    handleOutOfBounds();
  }

  // ── Artefact interaction ──
  const nearest = traceResult.nearestArtefact;
  if (nearest) {
    const hasKey = inventory.includes('key');
    const desc = getArtefactDescription(nearest.editorArtefact.type, hasKey);
    showDescription(desc);

    if (nearest.distance <= ARTEFACT_PICKUP_DIST) {
      handleArtefactPickup(nearest.editorArtefact.type, nearest.index);
    }
  } else {
    hideDescription();
  }

  // ── Update shaders & render ──
  world.updateShaders(dt, camera.position);
  world.render();
}

async function handleOutOfBounds(): Promise<void> {
  if (gamePaused) return;
  gamePaused = true;
  hideDescription();
  await showMessage('PULL YOURSELF TOGETHER', 3000);
  resetLevel();
  gamePaused = false;
}

async function handleArtefactPickup(type: ArtefactType, index: number): Promise<void> {
  if (gamePaused) return;

  switch (type) {
    case 'delay':
      // Restart version switch timer
      versionTimer = 0;
      world.removeArtefact(index);
      stopAndStartVersionShiftSound();
      playSoundFor(pickup, 1);
      break;

    case 'decompress': {
      // Switch back to the previous version, restart timer
      if (currentVersionIndex > 0) {
        versionTimer = 0;
        world.removeArtefact(index);
        currentVersionIndex--;
        switchToVersion(currentVersionIndex);
        playSoundFor(pickup, 1);
      }
      break;
    }

    case 'key':
      inventory.push('key');
      world.removeArtefact(index);
      playSoundFor(pickup, 1);
      break;

    case 'exit':
      if (inventory.includes('key')) {
        gamePaused = true;
        hideDescription();
        stopAndStartVersionShiftSound(false);
        playSoundFor(levelComplete(), 3);

        currentLevelIndex++;

        if (currentLevelIndex < levels.length) {
          await showMessage(`${currentLevelIndex + 1}`, 3000);
          loadCurrentLevel();
          gamePaused = false;
        } else {
          // Game complete — stop the drone and version shift sound
          if (droneHandle) {
            droneHandle.stop();
            droneHandle = null;
          }
          if (versionShiftHandle) {
            versionShiftHandle.stop();
            versionShiftHandle = null;
          }
          await showMessage('DIRECTIVE FULFILLED', 5000);
          await showMessage('forgetful-functor.itch.io', 0, '@pkamenarsky');
          showBlackScreen();
          gameRunning = false;
        }
      }
      // If no key, do nothing (description already shows "EXIT: FIND KEY")
      break;

    default:
      break;
  }
}

// ── Start ──

// // Kick off the render loop immediately so the scene renders behind overlays
requestAnimationFrame(animate);

// Start the game flow
startGame();
