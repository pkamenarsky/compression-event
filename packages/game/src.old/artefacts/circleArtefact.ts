import * as THREE from 'three';
import { Artefact } from './artefact';
import { bayerDitherGLSL, createDitheredShadow } from '../shaders/dither';

/* ------------------------------------------------------------------ */
/*  Shader for the circle (fill + outline, screen-aligned billboard)  */
/* ------------------------------------------------------------------ */

const circleVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const circleFragment = /* glsl */ `
  uniform vec3 uFillColor;
  uniform vec3 uFillColor2;
  uniform vec3 uOutlineColor;
  uniform float uRadius;           // in UV space (radius of filled area)
  uniform float uDitherAlpha;      // controls dither mix between fillColor and fillColor2 (0..1)

  varying vec2 vUv;

  ${bayerDitherGLSL}

  void main() {
    vec2 center = vec2(0.5);
    float d = distance(vUv, center);

    // Outside the circle entirely -> discard
    if (d > uRadius) discard;

    // Compute a 1-2 pixel outline band using screen-space derivatives
    float fw = fwidth(d) * 1.5;
    float innerEdge = uRadius - fw;

    // // Outline band (thin black ring at the edge)
    // if (d > innerEdge) {
    //   gl_FragColor = vec4(uOutlineColor, 1.0);
    //   return;
    // }

    // Fill area: dither between two opaque colors
    float threshold = bayerDither(gl_FragCoord.xy);
    if (uDitherAlpha >= threshold) {
      gl_FragColor = vec4(uFillColor, 1.0);
    } else {
      gl_FragColor = vec4(uFillColor2, 1.0);
    }
  }
`;

/* ------------------------------------------------------------------ */
/*  CircleArtefact                                                    */
/* ------------------------------------------------------------------ */

export interface CircleArtefactOptions {
  position: THREE.Vector3;
  /** World-space radius of the circle billboard. Default 0.5 */
  size?: number;
  fillColor?: THREE.Color;
  /** Second fill color for dither pattern. Default white */
  fillColor2?: THREE.Color;
  outlineColor?: THREE.Color;
  /** Dither density for the fill (0 = all fillColor2, 1 = all fillColor). Default 0.5 */
  ditherAlpha?: number;
  /** World-space radius of the shadow quad. Default size * 2 */
  shadowSize?: number;
  shadowColor?: THREE.Color;
}

export function createCircleArtefact(opts: CircleArtefactOptions): Artefact {
  const size = opts.size ?? 0.5;
  const shadowSize = opts.shadowSize ?? size * 4.0;
  const fillColor = opts.fillColor ?? new THREE.Color(0.0, 0.0, 0.0);
  const fillColor2 = opts.fillColor2 ?? new THREE.Color(0.0, 0.0, 0.0);
  const outlineColor = opts.outlineColor ?? new THREE.Color(0.0, 0.0, 0.0);
  const ditherAlpha = opts.ditherAlpha ?? 0.5;
  const shadowColor = opts.shadowColor ?? new THREE.Color(0, 0, 0);

  // -- Circle billboard --
  const circleGeo = new THREE.PlaneGeometry(size * 2, size * 2);
  const circleMat = new THREE.ShaderMaterial({
    vertexShader: circleVertex,
    fragmentShader: circleFragment,
    uniforms: {
      uFillColor: { value: fillColor.clone() },
      uFillColor2: { value: fillColor2.clone() },
      uOutlineColor: { value: outlineColor.clone() },
      uRadius: { value: 0.48 },
      uDitherAlpha: { value: ditherAlpha },
    },
    side: THREE.DoubleSide,
    depthWrite: true,
    transparent: false,
    extensions: {
      derivatives: true,
    },
  });
  const circleMesh = new THREE.Mesh(circleGeo, circleMat);
  circleMesh.position.copy(opts.position);

  // -- Shadow (flat on the ground) --
  const shadow = createDitheredShadow({
    position: opts.position,
    size: shadowSize,
    color: shadowColor,
  });

  const artefact: Artefact = {
    addTo(scene: THREE.Scene) {
      scene.add(circleMesh);
      scene.add(shadow.mesh);
    },

    update(_dt: number, camera: THREE.Camera) {
      // Billboard: make the circle always face the camera
      circleMesh.quaternion.copy(camera.quaternion);
    },

    dispose(scene: THREE.Scene) {
      scene.remove(circleMesh);
      scene.remove(shadow.mesh);
      circleGeo.dispose();
      circleMat.dispose();
      shadow.geometry.dispose();
      shadow.material.dispose();
    },
  };

  return artefact;
}
