// -----------------------------------------------------------------------------
// Artefacts, in three dimensions
//
// The jam build's look, carried over: a black solid with white edges, floating
// a little off the ground, turning slowly and bobbing, over a dithered shadow.
// What changed on the way over is the bookkeeping. There the four kinds were
// four factories with fifteen options each, and each one owned its meshes, its
// materials, its shadow and its own copy of the same rotate-and-bob; here a
// kind is a *body* — two geometries and a handful of switches — and everything
// built on top of it is written once.
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
import { IconType, SCALE } from './world';

/** Where one artefact stands, in editor units. */
export interface Standing {
  /** Which artefact this is. Two frames naming the same id are one thing
   * moving, rather than one thrown away and another built. */
  id: number
  type: IconType
  x: number
  y: number
}

export interface Artefacts {
  /** The artefacts that should be in the scene, and where. Anything not in
   * the list goes. */
  show(all: readonly Standing[]): void

  /**
   * Whether the level is being looked down on rather than stood in.
   *
   * Some kinds are drawn from above and nowhere else: the start is a mark on
   * the floor saying where the player comes in, and standing at it and finding
   * it hanging in front of one's face would be strange. The same distinction
   * is what the game will want when it has a player to put there — the editor
   * is simply the first caller to need it.
   */
  overhead(on: boolean): void

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

  // One unit patch for every shadow there will ever be, scaled per artefact.
  // Two materials rather than one, because the fade has to know the shape it
  // is fading out of: a round thing over a square of shadow, or a square one
  // over a disc, both read as a mistake.
  const patch = new THREE.PlaneGeometry(2, 2);
  const shades = {
    round: shadow(roundShadow),
    boxy: shadow(boxyShadow),
  };

  /** Built the first time a kind is asked for, and shared by every artefact of
   * that kind after. */
  const bodies = new Map<IconType, Body>();

  const bodyOf = (type: IconType): Body => {
    let it = bodies.get(type);

    if (it === undefined) {
      it = body(type);
      bodies.set(type, it);
    }

    return it;
  };

  interface Held {
    type: IconType
    /** The solid and its edges together, so that one turn moves both. */
    group: THREE.Group
    /** Null where the kind casts none. */
    shadow: THREE.Mesh | null
    /** Its own, so that a room full of them is not a room of one metronome. */
    phase: number
  }

  const held = new Map<number, Held>();

  let elapsed = 0;
  let above = true;

  /** Whether a kind is drawn at all from where the level is being looked at. */
  const drawn = (it: Held): boolean => above || !bodyOf(it.type).overhead;

  const build = (type: IconType): Held => {
    const it = bodyOf(type);
    const group = new THREE.Group();

    group.add(new THREE.Mesh(it.solid, fill));
    group.add(new THREE.LineSegments(it.edges, edge));
    group.position.y = it.y;

    let patched: THREE.Mesh | null = null;

    if (it.shade !== null) {
      patched = new THREE.Mesh(patch, shades[it.shade.round ? 'round' : 'boxy']);

      patched.rotation.x = -Math.PI / 2;
      patched.scale.set(it.shade.w, it.shade.d, 1);
      patched.renderOrder = 1;

      scene.add(patched);
    }

    scene.add(group);

    return { type, group, shadow: patched, phase: Math.random() * Math.PI * 2 };
  };

  const drop = (it: Held): void => {
    scene.remove(it.group);

    if (it.shadow !== null) scene.remove(it.shadow);
  };

  const dressed = (it: Held): void => {
    const on = drawn(it);

    it.group.visible = on;

    if (it.shadow !== null) it.shadow.visible = on;
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
          dressed(it);
        }

        const x = p.x * SCALE, z = p.y * SCALE;

        it.group.position.x = x;
        it.group.position.z = z;
        it.shadow?.position.set(x, SHADOW_Y, z);
      }

      for (const [id, it] of held) {
        if (wanted.has(id)) continue;

        drop(it);
        held.delete(id);
      }
    },

    overhead(on: boolean): void {
      if (on === above) return;

      above = on;

      for (const it of held.values()) dressed(it);
    },

    update(dt: number, camera: THREE.Camera): void {
      elapsed += dt;

      for (const it of held.values()) {
        if (!it.group.visible) continue;

        const kind = bodyOf(it.type);

        it.group.position.y = kind.bobs
          ? kind.y + Math.sin(elapsed * BOB_SPEED + it.phase) * BOB
          : kind.y;

        // A flat kind has nothing to turn — turning a disc about its own axis
        // is a still picture — so it faces whoever is looking instead.
        if (kind.motion === 'face') {
          it.group.quaternion.copy(camera.quaternion);
        }
        else if (kind.motion === 'spin') {
          const yaw = elapsed * SPIN + it.phase;

          it.group.rotation.y = yaw;

          // The shadow of a square thing is square, and a square that stayed
          // put under one that turned would read as two objects.
          if (it.shadow !== null && kind.shade !== null && !kind.shade.round) {
            it.shadow.rotation.z = yaw;
          }
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
      shades.round.dispose();
      shades.boxy.dispose();
      fill.dispose();
      edge.dispose();
    },
  };
}

// -----------------------------------------------------------------------------
// Bodies
//
// What a kind of artefact looks like, and nothing about where it is. Every one
// is the same two geometries — a solid and the lines along its edges — so that
// the spinning, the bobbing and the shadow are written once and a new kind is
// a shape and a handful of switches.
// -----------------------------------------------------------------------------

interface Body {
  solid: THREE.BufferGeometry
  edges: THREE.BufferGeometry
  /** How high its middle floats. */
  y: number
  /** The patch of shadow under it, in world units, or nothing where it casts
   * none. */
  shade: Shade | null
  /** `spin` turns about the vertical, `face` turns to whoever is looking, and
   * `still` does neither. */
  motion: 'spin' | 'face' | 'still'
  bobs: boolean
  /** Only drawn looking down on the level. See `Artefacts.overhead`. */
  overhead: boolean
}

/** Half-width and half-depth of a shadow, and whether it fades out of a disc
 * or a rectangle. */
interface Shade {
  w: number
  d: number
  round: boolean
}

interface Piece {
  solid: THREE.BufferGeometry
  edges: THREE.BufferGeometry
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

function assembled(pieces: readonly Piece[], rest: Omit<Body, 'solid' | 'edges'>): Body {
  return {
    solid: merged(pieces.map(p => p.solid)),
    edges: merged(pieces.map(p => p.edges)),
    ...rest,
  };
}

/** A square pyramid: a cone of four sides, turned so that its base lies square
 * with the axes rather than as a diamond across them, which is what lets every
 * rectangular shadow be axis-aligned. */
function pyramid(radius: number, height: number): THREE.BufferGeometry {
  const it = new THREE.ConeGeometry(radius, height, 4);

  it.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 4));

  return it;
}

/**
 * The four pyramids of the decompress artefact, each tipped over so its point
 * is at the middle of the formation.
 *
 * A quarter turn about the axis across from the direction one is moved lays it
 * on its side pointing back the way it came.
 */
function inward(spread: number, radius: number, height: number): Piece[] {
  const out: Piece[] = [];

  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const m = new THREE.Matrix4()
      .makeTranslation(Math.cos(angle) * spread, 0, Math.sin(angle) * spread)
      .multiply(new THREE.Matrix4().makeRotationY(-angle))
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));

    out.push(piece(pyramid(radius, height), m));
  }

  return out;
}

function body(type: IconType): Body {
  switch (type) {
    // The way out: a black disc facing whoever is looking at it, hanging
    // still. It is a hole rather than a thing, and a hole does not bob.
    case 'exit':
      return assembled(
        [piece(new THREE.CircleGeometry(1.6, 32))],
        { y: 2.0, shade: { w: 2.4, d: 2.4, round: true }, motion: 'face', bobs: false, overhead: false },
      );

    case 'key':
      return assembled(
        [piece(pyramid(0.9, 1.15))],
        { y: 1.6, shade: { w: 1.1, d: 1.1, round: false }, motion: 'spin', bobs: true, overhead: false },
      );

    case 'delay':
      return assembled(
        [piece(new THREE.DodecahedronGeometry(0.5))],
        { y: 1.5, shade: { w: 1.2, d: 1.2, round: true }, motion: 'spin', bobs: true, overhead: false },
      );

    case 'decompress':
      return assembled(
        inward(0.35, 0.5, 0.7),
        { y: 1.5, shade: { w: 1.4, d: 1.4, round: false }, motion: 'spin', bobs: true, overhead: false },
      );

    // Where the player comes in: a tall narrow spike balanced on its point,
    // which is an arrow at the spot rather than an object in the room. Nothing
    // to pick up, so nothing turns, nothing bobs, and it casts no shadow — and
    // it is only there when the level is being looked down on.
    case 'start':
      return assembled(
        [piece(pyramid(0.58, 2.2), new THREE.Matrix4().makeRotationZ(Math.PI))],
        { y: 1.15, shade: null, motion: 'still', bobs: false, overhead: true },
      );

    case 'anchor':
      return assembled(
        [piece(new THREE.BoxGeometry(0.9, 0.9, 0.9))],
        { y: 0.9, shade: { w: 1.1, d: 1.1, round: false }, motion: 'spin', bobs: true, overhead: false },
      );

    case 'compass':
      return assembled(
        [piece(new THREE.OctahedronGeometry(0.8))],
        { y: 1.5, shade: { w: 1.2, d: 1.2, round: true }, motion: 'spin', bobs: true, overhead: false },
      );
  }
}

// -----------------------------------------------------------------------------
// The shadow
//
// A patch on the ground that fades out towards its edge, with the fade dithered
// rather than blended: the whole look is opaque pixels in a pattern, and an
// alpha ramp under a floating object is the one place a soft edge would show.
//
// Two of them, and they differ only in what "towards its edge" means — the
// distance from the middle, or the further of the two axes. A round thing over
// a square of shadow reads as a mistake, and so does the other way round.
// -----------------------------------------------------------------------------

function shadow(fragment: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: shadowVertex,
    fragmentShader: fragment,
    side: THREE.DoubleSide,
    depthWrite: false,
    transparent: false,
  });
}

const shadowVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Everything a fade of `d` — 0 in the middle, 1 at the edge — has in common,
 * whatever shape the edge is. */
const fade = /* glsl */ `
  void shed(float d) {
    if (d > 1.0) discard;
    if (1.0 - smoothstep(0.0, 1.0, d) < bayerDither(gl_FragCoord.xy)) discard;

    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
`;

const roundShadow = /* glsl */ `
  varying vec2 vUv;

  ${bayerGLSL}
  ${fade}

  void main() {
    shed(distance(vUv, vec2(0.5)) * 2.0);
  }
`;

const boxyShadow = /* glsl */ `
  varying vec2 vUv;

  ${bayerGLSL}
  ${fade}

  void main() {
    vec2 off = abs(vUv - vec2(0.5)) * 2.0;

    shed(max(off.x, off.y));
  }
`;
