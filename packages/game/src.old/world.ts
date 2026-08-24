import * as THREE from 'three';
import { Artefact } from './artefacts/artefact';
import { Polygon, EditorArtefact } from './editor';
import { WORLD_SCALE, TILE_SIZE } from './constants';
import { Hulls } from './coldet';
import { RetroWallShader } from './shaders/retroWallShader';
import { createCircleArtefact } from './artefacts/circleArtefact';
import { createPyramidArtefact, createDodecahedronArtefact, createDecompressArtefact } from './artefacts/platonicArtefacts';
import { DitherPass } from './shaders/ditherPass';

const WALL_HEIGHT = 7;
const LINE_COLOR = 0x000000;
const LINE_WIDTH = 1;
const FLOOR_COLOR = 0xbbbbbb;
const FLOOR_POLYGON_COLOR = 0x000000;

// Polygon offset to prevent z-fighting between lines and filled surfaces.
const POLYGON_OFFSET_FACTOR = 1;
const POLYGON_OFFSET_UNITS = 1;

/** Distance at which an artefact description is shown. */
const ARTEFACT_SHOW_DIST = 5.0;

/**
 * Floor is placed slightly below y=0 so that artefact shadow quads
 * (which sit exactly at y=0) always render on top without z-fighting,
 * regardless of scene-graph insertion order.
 */
const FLOOR_Y_OFFSET = -0.01;

/**
 * Floor-type polygons sit slightly above the main floor to avoid z-fighting.
 */
const FLOOR_POLYGON_Y_OFFSET = -0.005;

export interface NearestArtefactInfo {
  editorArtefact: EditorArtefact;
  artefact: Artefact;
  distance: number;
  index: number;
}

export interface TraceResult {
  position: THREE.Vector2;
  nearestArtefact: NearestArtefactInfo | null;
}

interface LevelMeshes {
  walls: THREE.Mesh;
  wallLines: THREE.LineSegments;
  floor: THREE.Mesh;
  floorLines: THREE.LineSegments;
  floorPolygons: THREE.Mesh[];
}

interface ArtefactEntry {
  artefact: Artefact;
  editorArtefact: EditorArtefact;
}

export class World {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private polygons: Polygon[] = [];
  private levelMeshes: LevelMeshes | null = null;

  private artefactEntries: ArtefactEntry[] = [];

  /** Collision hulls for the current level. */
  hulls: Hulls;

  /** Wall shader */
  private wallShader = new RetroWallShader();
  private playerPosition = new THREE.Vector3();

  /** Screen-space dithering post-process */
  readonly ditherPass: DitherPass;

  constructor(
    scene: THREE.Scene,
    polygons: Polygon[],
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera
  ) {
    this.scene = scene;
    this.camera = camera;
    this.polygons = polygons;

    // ── Set up dither post-process ──
    this.ditherPass = new DitherPass(renderer, {
      colorLevels: 5,
      ditherStrength: 1.1,
      pixelSize: 1,
    });

    // Build initial level geometry & hulls
    this.hulls = new Hulls(polygons);
    this.buildLevel();
  }

  /**
   * Load a new set of polygons (version), disposing existing geometry
   * but NOT artefacts (those are managed separately).
   */
  loadVersion(polygons: Polygon[]): void {
    this.disposeLevelMeshes();
    this.polygons = polygons;
    this.hulls = new Hulls(polygons);
    this.buildLevelMeshes();
  }

  /**
   * Full level load: dispose everything and rebuild with new polygons and artefacts.
   */
  loadLevel(polygons: Polygon[], editorArtefacts: EditorArtefact[]): void {
    this.disposeLevel();
    this.polygons = polygons;
    this.hulls = new Hulls(polygons);
    this.buildLevelMeshes();
    this.spawnArtefacts(editorArtefacts);
  }

  /**
   * Spawn artefacts from editor data.
   */
  spawnArtefacts(editorArtefacts: EditorArtefact[]): void {
    this.disposeAllArtefacts();

    for (const ea of editorArtefacts) {
      const wx = ea.x * WORLD_SCALE;
      const wz = ea.y * WORLD_SCALE;

      let artefact: Artefact | undefined;

      if (ea.type === 'exit') {
        artefact = createCircleArtefact({
          position: new THREE.Vector3(wx, 2.0, wz),
          size: 1.6,
        });
      } else if (ea.type === 'key') {
        artefact = createPyramidArtefact({
          position: new THREE.Vector3(wx, 1.10, wz),
          baseSize: 0.65,
          height: 1.15
        });
      } else if (ea.type === 'delay') {
        artefact = createDodecahedronArtefact({
          position: new THREE.Vector3(wx, 1.5, wz),
          radius: 0.7
        });
      } else if (ea.type === 'decompress') {
        artefact = createDecompressArtefact({
          position: new THREE.Vector3(wx, 1.5, wz),
        });
      }

      if (artefact) {
        artefact.addTo(this.scene);
        this.artefactEntries.push({ artefact, editorArtefact: ea });
      }
    }
  }

  /**
   * Remove a specific artefact by index.
   */
  removeArtefact(index: number): void {
    if (index < 0 || index >= this.artefactEntries.length) return;
    const entry = this.artefactEntries[index];
    entry.artefact.dispose(this.scene);
    this.artefactEntries.splice(index, 1);
  }

  /**
   * Trace movement with collision and also return nearest artefact info.
   */
  traceWithArtefacts(
    currentPos: THREE.Vector2,
    frameMove: THREE.Vector2
  ): TraceResult {
    const newPos = this.hulls.trace(currentPos, frameMove);

    let nearestArtefact: NearestArtefactInfo | null = null;
    let nearestDist = Infinity;

    for (let i = 0; i < this.artefactEntries.length; i++) {
      const entry = this.artefactEntries[i];
      const ea = entry.editorArtefact;
      const ax = ea.x * WORLD_SCALE;
      const az = ea.y * WORLD_SCALE;
      const dx = newPos.x - ax;
      const dz = newPos.y - az;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestArtefact = {
          editorArtefact: ea,
          artefact: entry.artefact,
          distance: dist,
          index: i,
        };
      }
    }

    // Only return artefact info if within show distance
    if (nearestArtefact && nearestArtefact.distance > ARTEFACT_SHOW_DIST) {
      nearestArtefact = null;
    }

    return { position: newPos, nearestArtefact };
  }

  /**
   * Check if a point (in world space) is inside any "level" type polygon
   * and not inside any collision hull (i.e. not stuck inside a wall).
   * Also returns false if inside a "solid" polygon.
   * "floor" type polygons are ignored entirely.
   * Uses ray-casting (point-in-polygon) test on the XZ plane for polygons,
   * and convex hull containment test for collision hulls.
   */
  isInsideMap(worldX: number, worldZ: number): boolean {
    // If the player is inside a collision hull, they are inside a wall — invalid
    if (this.hulls.isInsideAnyHull(worldX, worldZ)) {
      return false;
    }

    // Convert world coords back to editor coords for testing
    const ex = worldX / WORLD_SCALE;
    const ey = worldZ / WORLD_SCALE;

    // If inside a solid polygon, it's invalid
    for (const poly of this.polygons) {
      if (poly.type !== 'solid') continue;
      if (this.pointInPolygon(ex, ey, poly.points)) {
        return false;
      }
    }

    // Must be inside at least one level polygon
    for (const poly of this.polygons) {
      if (poly.type !== 'level') continue;
      if (this.pointInPolygon(ex, ey, poly.points)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Ray-casting point-in-polygon test.
   */
  private pointInPolygon(
    px: number,
    py: number,
    points: { x: number; y: number }[]
  ): boolean {
    let inside = false;
    const n = points.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;

      const intersect =
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ───────────────────── level build / dispose ─────────────────────

  private buildLevel(): void {
    this.buildLevelMeshes();
  }

  private disposeLevel(): void {
    this.disposeLevelMeshes();
    this.disposeAllArtefacts();
  }

  private disposeLevelMeshes(): void {
    if (!this.levelMeshes) return;
    const m = this.levelMeshes;

    this.scene.remove(m.walls);
    this.scene.remove(m.wallLines);
    this.scene.remove(m.floor);
    this.scene.remove(m.floorLines);

    m.walls.geometry.dispose();
    m.wallLines.geometry.dispose();
    (m.wallLines.material as THREE.Material).dispose();
    m.floor.geometry.dispose();
    (m.floor.material as THREE.Material).dispose();
    m.floorLines.geometry.dispose();
    (m.floorLines.material as THREE.Material).dispose();

    for (const fp of m.floorPolygons) {
      this.scene.remove(fp);
      fp.geometry.dispose();
      (fp.material as THREE.Material).dispose();
    }

    this.levelMeshes = null;
  }

  // ───────────────────── artefacts ─────────────────────

  private updateArtefacts(dt: number, camera: THREE.Camera): void {
    for (const entry of this.artefactEntries) {
      entry.artefact.update(dt, camera);
    }
  }

  private disposeAllArtefacts(): void {
    for (const entry of this.artefactEntries) {
      entry.artefact.dispose(this.scene);
    }
    this.artefactEntries.length = 0;
  }

  // ───────────────────── shader helpers ─────────────────────

  /**
   * Call once per frame so shaders can update their uniforms.
   */
  updateShaders(dt: number, playerPos: THREE.Vector3): void {
    this.playerPosition.copy(playerPos);
    this.wallShader.update(dt, this.playerPosition);

    // Update all artefacts (billboarding, animations, etc.)
    this.updateArtefacts(dt, this.camera);
  }

  // ───────────────────── dither helpers ─────────────────────

  /** Resize the dither pass render target (call on window resize). */
  resizeDitherPass(width: number, height: number): void {
    this.ditherPass.setSize(width, height);
  }

  /**
   * Render the scene. Uses the dither pass if enabled, otherwise renders
   * directly. Call this from your main loop instead of renderer.render().
   */
  render(): void {
    this.ditherPass.apply(this.scene, this.camera);
  }

  // ───────────────────────── helpers ─────────────────────────

  /**
   * Compute the world-space bounding box of all polygons (after WORLD_SCALE),
   * snapped outward to TILE_SIZE boundaries, with one tile of padding.
   */
  private computeTileBounds(): { minX: number; minZ: number; maxX: number; maxZ: number } {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (const poly of this.polygons) {
      for (const pt of poly.points) {
        const wx = pt.x * WORLD_SCALE;
        const wz = pt.y * WORLD_SCALE;
        if (wx < minX) minX = wx;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wz > maxZ) maxZ = wz;
      }
    }

    if (!isFinite(minX)) {
      return { minX: -TILE_SIZE, minZ: -TILE_SIZE, maxX: TILE_SIZE, maxZ: TILE_SIZE };
    }

    minX = Math.floor(minX / TILE_SIZE) * TILE_SIZE - TILE_SIZE;
    minZ = Math.floor(minZ / TILE_SIZE) * TILE_SIZE - TILE_SIZE;
    maxX = Math.ceil(maxX / TILE_SIZE) * TILE_SIZE + TILE_SIZE;
    maxZ = Math.ceil(maxZ / TILE_SIZE) * TILE_SIZE + TILE_SIZE;

    return { minX, minZ, maxX, maxZ };
  }

  // ───────────────────────── floor polygon triangulation ─────────────────────────

  /**
   * Simple ear-clipping triangulation for a flat polygon on the XZ plane.
   * Returns an array of vertex positions [x, y, z, x, y, z, ...].
   */
  private triangulatePolygon(
    points: { x: number; y: number }[],
    yPos: number
  ): number[] {
    if (points.length < 3) return [];

    // Work with indices into the points array
    const indices: number[] = [];
    for (let i = 0; i < points.length; i++) indices.push(i);

    // Ensure CCW winding (positive signed area)
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      area += points[i].x * points[j].y;
      area -= points[j].x * points[i].y;
    }
    if (area < 0) indices.reverse();

    const result: number[] = [];

    let safety = points.length * points.length;
    while (indices.length > 3 && safety-- > 0) {
      let earFound = false;
      for (let i = 0; i < indices.length; i++) {
        const prev = indices[(i - 1 + indices.length) % indices.length];
        const curr = indices[i];
        const next = indices[(i + 1) % indices.length];

        const ax = points[prev].x, ay = points[prev].y;
        const bx = points[curr].x, by = points[curr].y;
        const cx = points[next].x, cy = points[next].y;

        // Check if this is a convex vertex (left turn)
        const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (cross <= 0) continue;

        // Check no other vertex is inside this triangle
        let containsPoint = false;
        for (let j = 0; j < indices.length; j++) {
          const idx = indices[j];
          if (idx === prev || idx === curr || idx === next) continue;
          if (this.pointInTriangle(
            points[idx].x, points[idx].y,
            ax, ay, bx, by, cx, cy
          )) {
            containsPoint = true;
            break;
          }
        }
        if (containsPoint) continue;

        // Emit triangle
        result.push(
          ax * WORLD_SCALE, yPos, ay * WORLD_SCALE,
          bx * WORLD_SCALE, yPos, by * WORLD_SCALE,
          cx * WORLD_SCALE, yPos, cy * WORLD_SCALE
        );

        indices.splice(i, 1);
        earFound = true;
        break;
      }
      if (!earFound) break;
    }

    // Last triangle
    if (indices.length === 3) {
      const a = points[indices[0]];
      const b = points[indices[1]];
      const c = points[indices[2]];
      result.push(
        a.x * WORLD_SCALE, yPos, a.y * WORLD_SCALE,
        b.x * WORLD_SCALE, yPos, b.y * WORLD_SCALE,
        c.x * WORLD_SCALE, yPos, c.y * WORLD_SCALE
      );
    }

    return result;
  }

  private pointInTriangle(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
  ): boolean {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);

    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

    return !(hasNeg && hasPos);
  }

  // ───────────────────────── level geometry ─────────────────────────

  private buildLevelMeshes(): void {
    const yBase = 0;
    const floorY = yBase + FLOOR_Y_OFFSET;
    const floorPolyY = yBase + FLOOR_POLYGON_Y_OFFSET;

    const wallVertices: number[] = [];
    const wallYBaseAttr: number[] = [];
    const wallYTopAttr: number[] = [];
    const wallLineVertices: number[] = [];
    const floorVertices: number[] = [];
    const floorLineVertices: number[] = [];

    const floorPolygonMeshes: THREE.Mesh[] = [];

    for (const poly of this.polygons) {
      const pts = poly.points;
      if (pts.length < 3) continue;

      // Floor-type polygons: render as flat black polygon, skip wall generation
      if (poly.type === 'floor') {
        const triVerts = this.triangulatePolygon(pts, floorPolyY);
        if (triVerts.length > 0) {
          const geom = new THREE.BufferGeometry();
          geom.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(triVerts, 3)
          );
          geom.computeVertexNormals();

          const mat = new THREE.MeshBasicMaterial({
            color: FLOOR_POLYGON_COLOR,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: POLYGON_OFFSET_FACTOR,
            polygonOffsetUnits: POLYGON_OFFSET_UNITS,
          });

          const mesh = new THREE.Mesh(geom, mat);
          this.scene.add(mesh);
          floorPolygonMeshes.push(mesh);
        }
        continue;
      }

      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];

        const ax = a.x * WORLD_SCALE;
        const az = a.y * WORLD_SCALE;
        const bx = b.x * WORLD_SCALE;
        const bz = b.y * WORLD_SCALE;

        const y0 = yBase;
        const y1 = yBase + WALL_HEIGHT;

        // Triangle 1
        wallVertices.push(ax, y0, az);
        wallVertices.push(bx, y0, bz);
        wallVertices.push(ax, y1, az);

        // Triangle 2
        wallVertices.push(bx, y0, bz);
        wallVertices.push(bx, y1, bz);
        wallVertices.push(ax, y1, az);

        for (let v = 0; v < 6; v++) {
          wallYBaseAttr.push(y0);
          wallYTopAttr.push(y1);
        }

        // Wall outline lines
        wallLineVertices.push(ax, y0, az);
        wallLineVertices.push(bx, y0, bz);

        wallLineVertices.push(ax, y1, az);
        wallLineVertices.push(bx, y1, bz);

        wallLineVertices.push(ax, y0, az);
        wallLineVertices.push(ax, y1, az);
      }
    }

    // ── Build tiled floor ──
    const bounds = this.computeTileBounds();
    const tilesX = Math.round((bounds.maxX - bounds.minX) / TILE_SIZE);
    const tilesZ = Math.round((bounds.maxZ - bounds.minZ) / TILE_SIZE);

    for (let ix = 0; ix < tilesX; ix++) {
      for (let iz = 0; iz < tilesZ; iz++) {
        const x0 = bounds.minX + ix * TILE_SIZE;
        const z0 = bounds.minZ + iz * TILE_SIZE;
        const x1 = x0 + TILE_SIZE;
        const z1 = z0 + TILE_SIZE;

        floorVertices.push(x0, floorY, z0);
        floorVertices.push(x1, floorY, z0);
        floorVertices.push(x1, floorY, z1);

        floorVertices.push(x0, floorY, z0);
        floorVertices.push(x1, floorY, z1);
        floorVertices.push(x0, floorY, z1);
      }
    }

    for (let iz = 0; iz <= tilesZ; iz++) {
      const z = bounds.minZ + iz * TILE_SIZE;
      floorLineVertices.push(bounds.minX, floorY, z);
      floorLineVertices.push(bounds.maxX, floorY, z);
    }

    for (let ix = 0; ix <= tilesX; ix++) {
      const x = bounds.minX + ix * TILE_SIZE;
      floorLineVertices.push(x, floorY, bounds.minZ);
      floorLineVertices.push(x, floorY, bounds.maxZ);
    }

    // ── Set up geometries ──

    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(wallVertices, 3)
    );
    wallGeometry.setAttribute(
      'aWallYBase',
      new THREE.Float32BufferAttribute(wallYBaseAttr, 1)
    );
    wallGeometry.setAttribute(
      'aWallYTop',
      new THREE.Float32BufferAttribute(wallYTopAttr, 1)
    );
    wallGeometry.computeVertexNormals();

    const wallMaterial = this.wallShader.createMaterial();
    if (this.wallShader.setWallHeight) {
      this.wallShader.setWallHeight(WALL_HEIGHT);
    }

    const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
    this.scene.add(wallMesh);

    const wallLineGeometry = new THREE.BufferGeometry();
    wallLineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(wallLineVertices, 3)
    );
    const wallLineMaterial = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      linewidth: LINE_WIDTH,
    });
    const wallLines = new THREE.LineSegments(wallLineGeometry, wallLineMaterial);
    this.scene.add(wallLines);

    const floorGeometry = new THREE.BufferGeometry();
    floorGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(floorVertices, 3)
    );
    floorGeometry.computeVertexNormals();

    const floorMaterial = new THREE.MeshBasicMaterial({
      color: FLOOR_COLOR,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: POLYGON_OFFSET_FACTOR,
      polygonOffsetUnits: POLYGON_OFFSET_UNITS,
    });
    const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial);
    this.scene.add(floorMesh);

    const floorLineGeometry = new THREE.BufferGeometry();
    floorLineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(floorLineVertices, 3)
    );
    const floorLineMaterial = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      linewidth: LINE_WIDTH,
    });
    const floorLines = new THREE.LineSegments(floorLineGeometry, floorLineMaterial);
    this.scene.add(floorLines);

    this.levelMeshes = {
      walls: wallMesh,
      wallLines,
      floor: floorMesh,
      floorLines,
      floorPolygons: floorPolygonMeshes,
    };
  }
}
