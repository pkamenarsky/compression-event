import * as THREE from 'three';
import { Artefact } from './artefact';
import { createDitheredRectShadow, createDitheredShadow } from '../shaders/dither';

export interface PyramidArtefactOptions {
  /** World-space position of the pyramid base centre. */
  position: THREE.Vector3;
  /** Half-width of the square base. Default 0.5 */
  baseSize?: number;
  /** Height of the pyramid. Default 1.0 */
  height?: number;
  /** Fill colour. Default black */
  fillColor?: THREE.Color;
  /** Edge colour. Default white */
  edgeColor?: THREE.Color;
  /** Line width for edges (note: most GPUs clamp to 1). Default 1 */
  lineWidth?: number;
  /** World-space half-width of the shadow quad. Default baseSize * 2 */
  shadowHalfWidth?: number;
  /** World-space half-depth of the shadow quad. Default baseSize * 2 */
  shadowHalfDepth?: number;
  /** Shadow colour. Default black */
  shadowColor?: THREE.Color;
  /** Y-axis rotation speed in radians per second. Default π/2 (~90°/s) */
  rotationSpeed?: number;
  /** Vertical bob amplitude in world units. Default 0.15 */
  bobAmplitude?: number;
  /** Vertical bob speed in radians per second. Default 2π (~1 cycle/s) */
  bobSpeed?: number;
}

export function createPyramidArtefact(opts: PyramidArtefactOptions): Artefact {
  const baseSize = opts.baseSize ?? 0.5;
  const height = opts.height ?? 1.0;
  const fillColor = opts.fillColor ?? new THREE.Color(0x000000);
  const edgeColor = opts.edgeColor ?? new THREE.Color(0xffffff);
  const lineWidth = opts.lineWidth ?? 1;
  const shadowHalfWidth = opts.shadowHalfWidth ?? baseSize * 4;
  const shadowHalfDepth = opts.shadowHalfDepth ?? baseSize * 4;
  const shadowColor = opts.shadowColor ?? new THREE.Color(0, 0, 0);
  const rotationSpeed = opts.rotationSpeed ?? Math.PI / 2;
  const bobAmplitude = opts.bobAmplitude ?? 0.15;
  const bobSpeed = opts.bobSpeed ?? Math.PI * 2;

  const pos = opts.position;

  // Vertices
  const half = baseSize;
  //  Base corners (y = 0 relative)
  //   0 --- 1
  //   |     |
  //   3 --- 2
  const b0 = new THREE.Vector3(-half, 0, -half);
  const b1 = new THREE.Vector3(half, 0, -half);
  const b2 = new THREE.Vector3(half, 0, half);
  const b3 = new THREE.Vector3(-half, 0, half);
  // Apex
  const apex = new THREE.Vector3(0, height, 0);

  // ── Solid mesh (triangles) ──
  const positions: number[] = [];

  function pushTri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    positions.push(a.x, a.y, a.z);
    positions.push(b.x, b.y, b.z);
    positions.push(c.x, c.y, c.z);
  }

  // Four side faces (wound CCW when viewed from outside)
  pushTri(b0, b1, apex); // front
  pushTri(b1, b2, apex); // right
  pushTri(b2, b3, apex); // back
  pushTri(b3, b0, apex); // left

  // Base (two triangles, facing down)
  pushTri(b0, b3, b2);
  pushTri(b0, b2, b1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: fillColor,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(pos);

  // ── Wireframe edges ──
  const edgePositions: number[] = [];

  function pushLine(a: THREE.Vector3, b: THREE.Vector3) {
    edgePositions.push(a.x, a.y, a.z);
    edgePositions.push(b.x, b.y, b.z);
  }

  // Base edges
  pushLine(b0, b1);
  pushLine(b1, b2);
  pushLine(b2, b3);
  pushLine(b3, b0);

  // Side edges to apex
  pushLine(b0, apex);
  pushLine(b1, apex);
  pushLine(b2, apex);
  pushLine(b3, apex);

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: edgeColor,
    linewidth: lineWidth,
  });

  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.position.copy(pos);

  // ── Dithered rectangular ground shadow ──
  const shadow = createDitheredRectShadow({
    position: pos,
    halfWidth: shadowHalfWidth,
    halfDepth: shadowHalfDepth,
    color: shadowColor,
  });

  // ── Animation state ──
  let elapsed = 0;
  const baseY = pos.y;

  const artefact: Artefact = {
    addTo(scene: THREE.Scene) {
      scene.add(mesh);
      scene.add(edgeLines);
      scene.add(shadow.mesh);
    },

    update(dt: number, _camera: THREE.Camera) {
      elapsed += dt;

      // Rotate around Y axis
      const yaw = elapsed * rotationSpeed;
      mesh.rotation.y = yaw;
      edgeLines.rotation.y = yaw;
      shadow.mesh.rotation.z = yaw;

      // Bob up and down with a sine wave
      const bobOffset = Math.sin(elapsed * bobSpeed) * bobAmplitude;
      mesh.position.y = baseY + bobOffset;
      edgeLines.position.y = baseY + bobOffset;
    },

    dispose(scene: THREE.Scene) {
      scene.remove(mesh);
      scene.remove(edgeLines);
      scene.remove(shadow.mesh);
      geometry.dispose();
      material.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      shadow.geometry.dispose();
      shadow.material.dispose();
    },
  };

  return artefact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dodecahedron artefact
// ─────────────────────────────────────────────────────────────────────────────

export interface DodecahedronArtefactOptions {
  /** World-space position (centre of the dodecahedron). */
  position: THREE.Vector3;
  /** Radius of the circumscribed sphere. Default 0.5 */
  radius?: number;
  /** Fill colour. Default black */
  fillColor?: THREE.Color;
  /** Edge colour. Default white */
  edgeColor?: THREE.Color;
  /** Line width for edges (note: most GPUs clamp to 1). Default 1 */
  lineWidth?: number;
  /** World-space radius of the circular shadow. Default radius * 4 */
  shadowRadius?: number;
  /** Shadow colour. Default black */
  shadowColor?: THREE.Color;
  /** Y-axis rotation speed in radians per second. Default π/2 (~90°/s) */
  rotationSpeed?: number;
  /** Vertical bob amplitude in world units. Default 0.15 */
  bobAmplitude?: number;
  /** Vertical bob speed in radians per second. Default 2π (~1 cycle/s) */
  bobSpeed?: number;
}

export function createDodecahedronArtefact(opts: DodecahedronArtefactOptions): Artefact {
  const radius = opts.radius ?? 0.5;
  const fillColor = opts.fillColor ?? new THREE.Color(0x000000);
  const edgeColor = opts.edgeColor ?? new THREE.Color(0xffffff);
  const lineWidth = opts.lineWidth ?? 1;
  const shadowRadius = opts.shadowRadius ?? radius * 4;
  const shadowColor = opts.shadowColor ?? new THREE.Color(0, 0, 0);
  const rotationSpeed = opts.rotationSpeed ?? Math.PI / 2;
  const bobAmplitude = opts.bobAmplitude ?? 0.15;
  const bobSpeed = opts.bobSpeed ?? Math.PI * 2;

  const pos = opts.position;

  // ── Solid mesh ──
  const geometry = new THREE.DodecahedronGeometry(radius, 0);

  const material = new THREE.MeshBasicMaterial({
    color: fillColor,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(pos);

  // ── Wireframe edges ──
  const edgeGeometry = new THREE.EdgesGeometry(geometry);

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: edgeColor,
    linewidth: lineWidth,
  });

  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.position.copy(pos);

  // ── Dithered circular ground shadow ──
  const shadow = createDitheredShadow({
    position: pos,
    color: shadowColor,
    size: shadowRadius
  });

  // ── Animation state ──
  let elapsed = 0;
  const baseY = pos.y;

  const artefact: Artefact = {
    addTo(scene: THREE.Scene) {
      scene.add(mesh);
      scene.add(edgeLines);
      scene.add(shadow.mesh);
    },

    update(dt: number, _camera: THREE.Camera) {
      elapsed += dt;

      // Rotate around Y axis
      const yaw = elapsed * rotationSpeed;
      mesh.rotation.y = yaw;
      edgeLines.rotation.y = yaw;

      // Bob up and down with a sine wave
      const bobOffset = Math.sin(elapsed * bobSpeed) * bobAmplitude;
      mesh.position.y = baseY + bobOffset;
      edgeLines.position.y = baseY + bobOffset;
    },

    dispose(scene: THREE.Scene) {
      scene.remove(mesh);
      scene.remove(edgeLines);
      scene.remove(shadow.mesh);
      geometry.dispose();
      material.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      shadow.geometry.dispose();
      shadow.material.dispose();
    },
  };

  return artefact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decompress artefact – 4 pyramids pointing inward toward the centre
// ─────────────────────────────────────────────────────────────────────────────

export interface DecompressArtefactOptions {
  /** World-space position (centre of the formation). */
  position: THREE.Vector3;
  /** Half-width of each pyramid's square base. Default 0.35 */
  baseSize?: number;
  /** Height (length) of each pyramid. Default 0.8 */
  height?: number;
  /** Distance from centre to each pyramid's base centre. Default 0.9 */
  spread?: number;
  /** Fill colour. Default black */
  fillColor?: THREE.Color;
  /** Edge colour. Default white */
  edgeColor?: THREE.Color;
  /** Line width for edges. Default 1 */
  lineWidth?: number;
  /** World-space half-width of the shadow quad. Default spread * 4 */
  shadowHalfWidth?: number;
  /** World-space half-depth of the shadow quad. Default spread * 4 */
  shadowHalfDepth?: number;
  /** Shadow colour. Default black */
  shadowColor?: THREE.Color;
  /** Y-axis rotation speed in radians per second. Default π/2 */
  rotationSpeed?: number;
  /** Vertical bob amplitude in world units. Default 0.15 */
  bobAmplitude?: number;
  /** Vertical bob speed in radians per second. Default 2π */
  bobSpeed?: number;
}

/**
 * Build the geometry (positions array) for a single pyramid whose base is
 * centred at the origin in the XZ plane and whose apex points along +Y.
 */
function buildPyramidGeometry(
  baseSize: number,
  height: number
): { triPositions: number[]; linePositions: number[] } {
  const half = baseSize;
  const b0 = new THREE.Vector3(-half, 0, -half);
  const b1 = new THREE.Vector3(half, 0, -half);
  const b2 = new THREE.Vector3(half, 0, half);
  const b3 = new THREE.Vector3(-half, 0, half);
  const apex = new THREE.Vector3(0, height, 0);

  const triPositions: number[] = [];

  function pushTri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    triPositions.push(a.x, a.y, a.z);
    triPositions.push(b.x, b.y, b.z);
    triPositions.push(c.x, c.y, c.z);
  }

  // Side faces
  pushTri(b0, b1, apex);
  pushTri(b1, b2, apex);
  pushTri(b2, b3, apex);
  pushTri(b3, b0, apex);

  // Base
  pushTri(b0, b3, b2);
  pushTri(b0, b2, b1);

  const linePositions: number[] = [];

  function pushLine(a: THREE.Vector3, b: THREE.Vector3) {
    linePositions.push(a.x, a.y, a.z);
    linePositions.push(b.x, b.y, b.z);
  }

  // Base edges
  pushLine(b0, b1);
  pushLine(b1, b2);
  pushLine(b2, b3);
  pushLine(b3, b0);

  // Side edges
  pushLine(b0, apex);
  pushLine(b1, apex);
  pushLine(b2, apex);
  pushLine(b3, apex);

  return { triPositions, linePositions };
}

export function createDecompressArtefact(opts: DecompressArtefactOptions): Artefact {
  const baseSize = opts.baseSize ?? 0.35;
  const height = opts.height ?? 0.45;
  const spread = opts.spread ?? 0.45;
  const fillColor = opts.fillColor ?? new THREE.Color(0x000000);
  const edgeColor = opts.edgeColor ?? new THREE.Color(0xffffff);
  const lineWidth = opts.lineWidth ?? 1;
  const shadowHalfWidth = opts.shadowHalfWidth ?? spread * 4;
  const shadowHalfDepth = opts.shadowHalfDepth ?? spread * 4;
  const shadowColor = opts.shadowColor ?? new THREE.Color(0, 0, 0);
  const rotationSpeed = opts.rotationSpeed ?? Math.PI / 2;
  const bobAmplitude = opts.bobAmplitude ?? 0.15;
  const bobSpeed = opts.bobSpeed ?? Math.PI * 2;

  const pos = opts.position;

  // Build one canonical pyramid geometry
  const { triPositions, linePositions } = buildPyramidGeometry(baseSize, height);

  // We'll place 4 pyramids around the centre. Each pyramid's base is offset
  // outward along one of the cardinal directions (+X, -X, +Z, -Z) by `spread`,
  // and the pyramid is tilted 90° so its apex points toward the centre.
  //
  // The canonical pyramid has its base at y=0 and apex at y=+height.
  // To point the apex toward the centre from offset +X, we rotate -90° around Z.
  // For -X: +90° around Z.  For +Z: +90° around X.  For -Z: -90° around X.

  const pyramidConfigs: { offset: THREE.Vector3; rotation: THREE.Euler }[] = [
    {
      // +X side: base at +X, apex points toward -X (centre)
      offset: new THREE.Vector3(spread, 0, 0),
      rotation: new THREE.Euler(0, 0, -Math.PI / 2),
    },
    {
      // -X side: base at -X, apex points toward +X (centre)
      offset: new THREE.Vector3(-spread, 0, 0),
      rotation: new THREE.Euler(0, 0, Math.PI / 2),
    },
    {
      // +Z side: base at +Z, apex points toward -Z (centre)
      offset: new THREE.Vector3(0, 0, spread),
      rotation: new THREE.Euler(Math.PI / 2, 0, 0),
    },
    {
      // -Z side: base at -Z, apex points toward +Z (centre)
      offset: new THREE.Vector3(0, 0, -spread),
      rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
    },
  ];

  // Use a parent group so all 4 pyramids rotate/bob together
  const group = new THREE.Group();
  group.position.copy(pos);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const fillMaterial = new THREE.MeshBasicMaterial({
    color: fillColor,
    side: THREE.DoubleSide,
  });
  materials.push(fillMaterial);

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: edgeColor,
    linewidth: lineWidth,
  });
  materials.push(edgeMaterial);

  for (const config of pyramidConfigs) {
    // Solid mesh
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(triPositions.slice(), 3));
    geo.computeVertexNormals();
    geometries.push(geo);

    const mesh = new THREE.Mesh(geo, fillMaterial);
    mesh.position.copy(config.offset);
    mesh.rotation.copy(config.rotation);
    group.add(mesh);

    // Edge lines
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions.slice(), 3));
    geometries.push(lineGeo);

    const lines = new THREE.LineSegments(lineGeo, edgeMaterial);
    lines.position.copy(config.offset);
    lines.rotation.copy(config.rotation);
    group.add(lines);
  }

  // ── Dithered rectangular ground shadow ──
  const shadow = createDitheredRectShadow({
    position: pos,
    halfWidth: shadowHalfWidth,
    halfDepth: shadowHalfDepth,
    color: shadowColor,
  });

  // ── Animation state ──
  let elapsed = 0;
  const baseY = pos.y;

  const artefact: Artefact = {
    addTo(scene: THREE.Scene) {
      scene.add(group);
      scene.add(shadow.mesh);
    },

    update(dt: number, _camera: THREE.Camera) {
      elapsed += dt;

      // Rotate the whole formation around Y
      group.rotation.y = elapsed * rotationSpeed;
      shadow.mesh.rotation.z = elapsed * rotationSpeed + Math.PI / 4;

      // Bob up and down
      const bobOffset = Math.sin(elapsed * bobSpeed) * bobAmplitude;
      group.position.y = baseY + bobOffset;
    },

    dispose(scene: THREE.Scene) {
      scene.remove(group);
      scene.remove(shadow.mesh);
      for (const geo of geometries) {
        geo.dispose();
      }
      for (const mat of materials) {
        mat.dispose();
      }
      shadow.geometry.dispose();
      shadow.material.dispose();
    },
  };

  return artefact;
}
