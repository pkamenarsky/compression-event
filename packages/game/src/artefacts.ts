// -----------------------------------------------------------------------------
// Artefacts, in three dimensions
//
// The jam build's look, carried over: a black solid with white edges, floating
// a little off the ground, turning slowly and bobbing, over a dithered shadow.
// What changed on the way over is the bookkeeping. There the four kinds were
// four factories with fifteen options each, and each one owned its meshes, its
// materials, its shadow and its own copy of the same rotate-and-bob; here a
// kind is a *body* — two geometries and three numbers — and everything built on
// top of it is written once.
//
// Nothing in here knows where an artefact is over time. It is handed a list of
// places and reconciles the scene to it, so the same code serves a level
// standing still and a version transition part way through: the caller works
// out where things are, by whatever means it has, and says so every frame it
// likes. Which is why this is on the CPU at all — it is a handful of matrices
// per frame, against a vertex shader's worth of format to carry a point
// through the bake.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { bayerGLSL } from './dither';
import { SCALE } from './render';
import { ArtefactType } from './world';

/** Where one artefact stands, in editor units. */
export interface Standing {
  /** Which artefact this is. Two frames naming the same id are one thing
   * moving, rather than one thrown away and another built. */
  id: number
  type: ArtefactType
  x: number
  y: number
}

export interface Artefacts {
  /** The artefacts that should be in the scene, and where. Anything not in
   * the list goes. */
  show(all: readonly Standing[]): void
  /** Turn and bob. `dt` in seconds. */
  update(dt: number, camera: THREE.Camera): void
  dispose(): void
}

const FILL = 0x000000;
const EDGE = 0xffffff;

/** Radians per second about the vertical. */
const SPIN = Math.PI / 2;
/** How far it rides up and down, in world units, and how fast. */
const BOB = 0.15;
const BOB_SPEED = Math.PI * 2;

/** Where a shadow sits, clear of the ground plane and of an authored floor. */
const SHADOW_Y = 0.005;

export function artefacts(scene: THREE.Scene): Artefacts {
  const fill = new THREE.MeshBasicMaterial({ color: FILL, side: THREE.DoubleSide });
  const edge = new THREE.LineBasicMaterial({ color: EDGE });

  // One unit disc for every shadow there will ever be, scaled per artefact.
  // The kinds differ only in how wide the patch is, and a plane is a plane.
  const patch = new THREE.PlaneGeometry(2, 2);
  const shade = new THREE.ShaderMaterial({
    vertexShader: shadowVertex,
    fragmentShader: shadowFragment,
    side: THREE.DoubleSide,
    depthWrite: false,
    transparent: false,
  });

  /** Built the first time a kind is asked for, and shared by every artefact of
   * that kind after. */
  const bodies = new Map<ArtefactType, Body>();

  const bodyOf = (type: ArtefactType): Body => {
    let it = bodies.get(type);

    if (it === undefined) {
      it = body(type);
      bodies.set(type, it);
    }

    return it;
  };

  interface Held {
    type: ArtefactType
    /** The solid and its edges together, so that one turn moves both. */
    group: THREE.Group
    shadow: THREE.Mesh
    /** Its own, so that a room full of them is not a room of one metronome. */
    phase: number
  }

  const held = new Map<number, Held>();
  let elapsed = 0;

  const build = (type: ArtefactType): Held => {
    const it = bodyOf(type);
    const group = new THREE.Group();

    group.add(new THREE.Mesh(it.solid, fill));
    group.add(new THREE.LineSegments(it.edges, edge));

    const shadow = new THREE.Mesh(patch, shade);

    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(it.shade, it.shade, 1);
    shadow.renderOrder = 1;

    scene.add(group, shadow);

    return { type, group, shadow, phase: Math.random() * Math.PI * 2 };
  };

  const drop = (it: Held): void => {
    scene.remove(it.group, it.shadow);
  };

  return {
    show(all: readonly Standing[]): void {
      const wanted = new Set<number>();

      for (const p of all) {
        wanted.add(p.id);

        let it = held.get(p.id);

        // A retype is a different body, so the thing is built again. Nothing
        // else about it survives being a different shape anyway.
        if (it !== undefined && it.type !== p.type) {
          drop(it);
          it = undefined;
        }

        if (it === undefined) {
          it = build(p.type);
          held.set(p.id, it);
        }

        const x = p.x * SCALE, z = p.y * SCALE;

        it.group.position.x = x;
        it.group.position.z = z;
        it.shadow.position.set(x, SHADOW_Y, z);
      }

      for (const [id, it] of held) {
        if (wanted.has(id)) continue;

        drop(it);
        held.delete(id);
      }
    },

    update(dt: number, camera: THREE.Camera): void {
      elapsed += dt;

      for (const it of held.values()) {
        const height = bodyOf(it.type);

        it.group.position.y = height.y + Math.sin(elapsed * BOB_SPEED + it.phase) * BOB;

        // A flat kind has nothing to turn — turning a disc about its own axis
        // is a still picture — so it faces whoever is looking instead.
        if (height.flat) {
          it.group.quaternion.copy(camera.quaternion);
        }
        else {
          it.group.rotation.y = elapsed * SPIN + it.phase;
        }
      }
    },

    dispose(): void {
      for (const it of held.values()) drop(it);

      held.clear();

      for (const it of bodies.values()) {
        it.solid.dispose();
        it.edges.dispose();
      }

      bodies.clear();
      patch.dispose();
      shade.dispose();
      fill.dispose();
      edge.dispose();
    },
  };
}

// -----------------------------------------------------------------------------
// Bodies
//
// What a kind of artefact looks like, and nothing about where it is or what it
// is doing. Every one is the same two geometries — a solid and the lines along
// its edges — so that the spinning, the bobbing and the shadow are written
// once and a new kind is a shape and three numbers.
// -----------------------------------------------------------------------------

interface Body {
  solid: THREE.BufferGeometry
  edges: THREE.BufferGeometry
  /** How high its middle floats, before the bob. */
  y: number
  /** Half-width of the patch of shadow under it. */
  shade: number
  /** Flat, and therefore turned to face the camera rather than spun. */
  flat: boolean
}

/**
 * One piece of a body, moved into place.
 *
 * The matrix is baked into the geometry rather than kept on a mesh, because a
 * body is two geometries and not a little scene graph: a formation of four
 * pyramids turns and bobs as one thing, exactly the way a single solid does.
 */
function piece(geometry: THREE.BufferGeometry, m?: THREE.Matrix4): Piece {
  if (m !== undefined) geometry.applyMatrix4(m);

  const edges = new THREE.EdgesGeometry(geometry);
  const solid = geometry.toNonIndexed();

  geometry.dispose();

  return { solid, edges };
}

interface Piece {
  solid: THREE.BufferGeometry
  edges: THREE.BufferGeometry
}

/** The pieces' positions end to end in one buffer. Both halves are plain
 * triangle and line soup by the time they get here, so this is a concatenation
 * and nothing more. */
function merged(all: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;

  for (const g of all) n += g.getAttribute('position').array.length;

  const out = new Float32Array(n);
  let at = 0;

  for (const g of all) {
    const a = g.getAttribute('position').array as Float32Array;

    out.set(a, at);
    at += a.length;
    g.dispose();
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));

  return geometry;
}

function assembled(pieces: readonly Piece[], y: number, shade: number, flat = false): Body {
  return {
    solid: merged(pieces.map(p => p.solid)),
    edges: merged(pieces.map(p => p.edges)),
    y,
    shade,
    flat,
  };
}

/**
 * The four pyramids of the decompress artefact, each tipped over so its point
 * is at the middle of the formation.
 *
 * A cone of four sides is a square pyramid, apex up and the origin at half its
 * height; a quarter turn about the axis across from the direction it is being
 * moved lays it on its side pointing back the way it came.
 */
function inward(spread: number, radius: number, height: number): Piece[] {
  const out: Piece[] = [];

  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const m = new THREE.Matrix4()
      .makeTranslation(Math.cos(angle) * spread, 0, Math.sin(angle) * spread)
      .multiply(new THREE.Matrix4().makeRotationY(-angle))
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));

    out.push(piece(new THREE.ConeGeometry(radius, height, 4), m));
  }

  return out;
}

function body(type: ArtefactType): Body {
  switch (type) {
    // The way out: a black disc facing whoever is looking at it, and the one
    // kind that is a hole rather than a thing.
    case 'exit':
      return assembled([piece(new THREE.CircleGeometry(1.6, 32))], 2.0, 1.6, true);

    case 'key':
      return assembled([piece(new THREE.ConeGeometry(0.9, 1.15, 4))], 1.1, 1.2);

    case 'delay':
      return assembled([piece(new THREE.DodecahedronGeometry(0.7))], 1.5, 1.2);

    case 'decompress':
      return assembled(inward(0.45, 0.5, 0.9), 1.5, 1.4);

    case 'start':
      return assembled([piece(new THREE.TetrahedronGeometry(0.7))], 0.9, 1.0);

    case 'anchor':
      return assembled([piece(new THREE.BoxGeometry(0.9, 0.9, 0.9))], 0.9, 1.1);

    case 'compass':
      return assembled([piece(new THREE.OctahedronGeometry(0.8))], 1.5, 1.2);
  }
}

// -----------------------------------------------------------------------------
// The shadow
//
// A disc on the ground that fades out towards its edge, with the fade dithered
// rather than blended: the whole look is opaque pixels in a pattern, and an
// alpha ramp under a floating object is the one place a soft edge would show.
// -----------------------------------------------------------------------------

const shadowVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const shadowFragment = /* glsl */ `
  varying vec2 vUv;

  ${bayerGLSL}

  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;

    if (d > 1.0) discard;
    if (1.0 - smoothstep(0.0, 1.0, d) < bayerDither(gl_FragCoord.xy)) discard;

    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
`;
