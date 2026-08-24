import * as THREE from 'three';

/**
 * GLSL function: float bayerDither(vec2 screenCoord)
 * Returns a value in [0, 1) from a 4×4 Bayer matrix.
 * Paste this into any fragment shader that needs ordered dithering.
 */
export const bayerDitherGLSL = /* glsl */ `
  float bayerDither(vec2 screenCoord) {
    int x = int(mod(screenCoord.x, 4.0));
    int y = int(mod(screenCoord.y, 4.0));
    int index = x + y * 4;

    float bayer[16];
    bayer[0]  =  0.0 / 16.0;
    bayer[1]  =  8.0 / 16.0;
    bayer[2]  =  2.0 / 16.0;
    bayer[3]  = 10.0 / 16.0;
    bayer[4]  = 12.0 / 16.0;
    bayer[5]  =  4.0 / 16.0;
    bayer[6]  = 14.0 / 16.0;
    bayer[7]  =  6.0 / 16.0;
    bayer[8]  =  3.0 / 16.0;
    bayer[9]  = 11.0 / 16.0;
    bayer[10] =  1.0 / 16.0;
    bayer[11] =  9.0 / 16.0;
    bayer[12] = 15.0 / 16.0;
    bayer[13] =  7.0 / 16.0;
    bayer[14] = 13.0 / 16.0;
    bayer[15] =  5.0 / 16.0;

    return bayer[index];
  }
`;

/* ------------------------------------------------------------------ */
/*  Shared shadow vertex shader                                       */
/* ------------------------------------------------------------------ */

const shadowVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/*  Reusable dithered circular ground-shadow                          */
/* ------------------------------------------------------------------ */

const circularShadowFragment = /* glsl */ `
  uniform vec3 uShadowColor;
  uniform float uShadowRadius; // UV-space radius

  varying vec2 vUv;

  ${bayerDitherGLSL}

  void main() {
    vec2 center = vec2(0.5);
    float d = distance(vUv, center);

    if (d > uShadowRadius) discard;

    // Fade out toward edge
    float alpha = 1.0 - smoothstep(0.0, uShadowRadius, d);

    // Dither: compare alpha against Bayer threshold
    float threshold = bayerDither(gl_FragCoord.xy);
    if (alpha < threshold) discard;

    gl_FragColor = vec4(uShadowColor, 1.0);
  }
`;

export interface DitheredShadowOptions {
  /** World-space position of the object that casts the shadow. */
  position: THREE.Vector3;
  /** World-space radius of the shadow quad. */
  size: number;
  /** Shadow colour. Default black. */
  color?: THREE.Color;
  /** UV-space radius of the visible shadow disc (0–0.5). Default 0.45. */
  radius?: number;
}

export interface DitheredShadow {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
}

/**
 * Create a flat, dithered circular shadow that sits on the ground plane.
 */
export function createDitheredShadow(opts: DitheredShadowOptions): DitheredShadow {
  const color = opts.color ?? new THREE.Color(0, 0, 0);
  const radius = opts.radius ?? 0.45;

  const geometry = new THREE.PlaneGeometry(opts.size * 2, opts.size * 2);
  const material = new THREE.ShaderMaterial({
    vertexShader: shadowVertex,
    fragmentShader: circularShadowFragment,
    uniforms: {
      uShadowColor: { value: color.clone() },
      uShadowRadius: { value: radius },
    },
    side: THREE.DoubleSide,
    depthWrite: false,
    transparent: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(opts.position.x, 0.005, opts.position.z);
  mesh.renderOrder = 1;

  return { mesh, geometry, material };
}

/* ------------------------------------------------------------------ */
/*  Reusable dithered rectangular ground-shadow                       */
/* ------------------------------------------------------------------ */

const rectShadowFragment = /* glsl */ `
  uniform vec3 uShadowColor;
  uniform vec2 uShadowHalfSize; // UV-space half-extents (0–0.5 each axis)

  varying vec2 vUv;

  ${bayerDitherGLSL}

  void main() {
    vec2 center = vec2(0.5);
    vec2 offset = abs(vUv - center);

    // Outside the rectangle -> discard
    if (offset.x > uShadowHalfSize.x || offset.y > uShadowHalfSize.y) discard;

    // Fade: use the maximum normalised distance along either axis
    float fx = offset.x / uShadowHalfSize.x;
    float fy = offset.y / uShadowHalfSize.y;
    float d = max(fx, fy);

    float alpha = 1.0 - smoothstep(0.0, 1.0, d);

    // Dither: compare alpha against Bayer threshold
    float threshold = bayerDither(gl_FragCoord.xy);
    if (alpha < threshold) discard;

    gl_FragColor = vec4(uShadowColor, 1.0);
  }
`;

export interface DitheredRectShadowOptions {
  /** World-space position of the object that casts the shadow. */
  position: THREE.Vector3;
  /** World-space half-width (X axis) of the shadow quad. */
  halfWidth: number;
  /** World-space half-depth (Z axis) of the shadow quad. */
  halfDepth: number;
  /** Shadow colour. Default black. */
  color?: THREE.Color;
  /**
   * UV-space half-extents of the visible shadow rectangle (0–0.5 each).
   * Default (0.45, 0.45).
   */
  uvHalfSize?: { x: number; y: number };
}

/**
 * Create a flat, dithered rectangular shadow that sits on the ground plane.
 */
export function createDitheredRectShadow(opts: DitheredRectShadowOptions): DitheredShadow {
  const color = opts.color ?? new THREE.Color(0, 0, 0);
  const uvHalf = opts.uvHalfSize ?? { x: 0.45, y: 0.45 };

  // PlaneGeometry(width, height) – width maps to X, height maps to Z after rotation
  const geometry = new THREE.PlaneGeometry(opts.halfWidth * 2, opts.halfDepth * 2);
  const material = new THREE.ShaderMaterial({
    vertexShader: shadowVertex,
    fragmentShader: rectShadowFragment,
    uniforms: {
      uShadowColor: { value: color.clone() },
      uShadowHalfSize: { value: new THREE.Vector2(uvHalf.x, uvHalf.y) },
    },
    side: THREE.DoubleSide,
    depthWrite: false,
    transparent: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(opts.position.x, 0.005, opts.position.z);
  mesh.renderOrder = 1;

  return { mesh, geometry, material };
}
