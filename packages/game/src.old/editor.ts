// ============================================================
// Theme / Constants
// ============================================================

import { WORLD_SCALE, MOVE_SPEED } from './constants';
import simplepolygon from 'simplepolygon';
import { polygon as turfPolygon } from '@turf/helpers';

interface Theme {
  background: string;
  gridLine: string;
  gridLineMain: string;
  polygonFill: string;
  polygonFillSelected: string;
  polygonStroke: string;
  polygonStrokeSelected: string;
  solidFill: string;
  solidStroke: string;
  floorFill: string;
  floorStroke: string;
  point: string;
  pointSelected: string;
  pointHover: string;
  lineHover: string;
  previewLine: string;
  firstPointHighlight: string;
  text: string;
  modeIndicator: string;
  origin: string;
  originRadius: number;
  lineWidth: number;
  lineWidthSelected: number;
  pointRadius: number;
  pointHitRadius: number;
  lineHitDistance: number;
  gridSize: number;
  snapToGrid: boolean;
  firstPointCloseRadius: number;
  normalLength: number;
  normalColor: string;
  vertexNormalColor: string;
  normalLineWidth: number;
  pathColor: string;
  pathColorSelected: string;
  pathLineWidth: number;
  pathPointRadius: number;
  pathTimeColor: string;
  artefactRadius: number;
  artefactColors: Record<ArtefactType, string>;
  artefactHitRadius: number;
  versionIndicatorColor: string;
}

const darkTheme: Theme = {
  background: '#1e1e2e',
  gridLine: '#2a2a3a',
  gridLineMain: '#3a3a4a',
  polygonFill: 'rgba(80, 120, 200, 0.15)',
  polygonFillSelected: 'rgba(100, 160, 255, 0.25)',
  polygonStroke: '#5078c8',
  polygonStrokeSelected: '#80b0ff',
  solidFill: 'rgba(200, 80, 80, 0.15)',
  solidStroke: '#c85050',
  floorFill: 'rgba(80, 200, 80, 0.15)',
  floorStroke: '#50c850',
  point: '#6090d0',
  pointSelected: '#ffcc44',
  pointHover: '#ff8844',
  lineHover: '#ff8844',
  previewLine: 'rgba(255, 255, 255, 0.4)',
  firstPointHighlight: '#44ff88',
  text: '#ccccdd',
  modeIndicator: '#ffcc44',
  origin: '#ff4444',
  originRadius: 4,
  lineWidth: 2,
  lineWidthSelected: 3,
  pointRadius: 5,
  pointHitRadius: 10,
  lineHitDistance: 8,
  gridSize: 20,
  snapToGrid: true,
  firstPointCloseRadius: 12,
  normalLength: 20,
  normalColor: '#44ddaa',
  vertexNormalColor: '#dd44aa',
  normalLineWidth: 1.5,
  pathColor: '#cc88ff',
  pathColorSelected: '#eebb44',
  pathLineWidth: 2,
  pathPointRadius: 4,
  pathTimeColor: '#cc88ff',
  artefactRadius: 8,
  artefactColors: {
    key: '#ffdd44',
    exit: '#44ff88',
    delay: '#ff8844',
    anchor: '#4488ff',
    compass: '#ff44cc',
  },
  artefactHitRadius: 12,
  versionIndicatorColor: '#88ccff',
};

const theme: Theme = darkTheme;

// ============================================================
// Types
// ============================================================

export type PolygonType = 'level' | 'solid' | 'floor';

export type ArtefactType = 'key' | 'exit' | 'delay' | 'decompress' | 'anchor' | 'compass' | 'start';

export interface Point {
  x: number;
  y: number;
}

export interface EdgeNormal {
  mx: number;  // midpoint x
  my: number;  // midpoint y
  nx: number;  // normal x (unit)
  ny: number;  // normal y (unit)
}

export interface VertexNormal {
  x: number;   // vertex position
  y: number;
  nx: number;  // bisector normal x (scaled so parallel offset works)
  ny: number;  // bisector normal y (scaled so parallel offset works)
}

export interface Polygon {
  points: Point[];
  type: PolygonType;
}

export interface EditorArtefact {
  x: number;
  y: number;
  type: ArtefactType;
}

export interface Path {
  points: Point[];
}

export interface Version {
  polygons: Polygon[];
}

export interface Map {
  versions: Version[];
  paths: Path[];
  artefacts: EditorArtefact[];
}

type EditorMode = 'polygon' | 'point' | 'world' | 'artefact';

// ============================================================
// Undo / Redo
// ============================================================

class UndoStack {
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  save(state: Map): void {
    this.undoStack.push(JSON.stringify(state));
    this.redoStack = [];
  }

  undo(current: Map): Map | null {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(JSON.stringify(current));
    const prev = this.undoStack.pop()!;
    return JSON.parse(prev);
  }

  redo(current: Map): Map | null {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(JSON.stringify(current));
    const next = this.redoStack.pop()!;
    return JSON.parse(next);
  }
}

// ============================================================
// Utility
// ============================================================

function cloneState(state: Map): Map {
  return JSON.parse(JSON.stringify(state));
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function snapToGrid(p: Point): Point {
  if (!theme.snapToGrid) return { ...p };
  return {
    x: Math.round(p.x / theme.gridSize) * theme.gridSize,
    y: Math.round(p.y / theme.gridSize) * theme.gridSize,
  };
}

function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function pointOnSegmentProjection(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { ...a };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function isPointInPolygon(p: Point, poly: Polygon): boolean {
  let inside = false;
  const pts = poly.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > p.y) !== (yj > p.y)) &&
        (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Signed area of a polygon. Positive = CCW, Negative = CW. */
function signedArea(pts: Point[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return area / 2;
}

/**
 * Compute inward-pointing edge normals for a polygon.
 * Each edge from points[i] to points[(i+1) % n] gets a unit normal
 * pointing toward the polygon interior.
 */
function computeEdgeNormals(poly: Polygon): EdgeNormal[] {
  const pts = poly.points;
  const n = pts.length;
  if (n < 2) return [];

  const area = signedArea(pts);
  const sign = area > 0 ? 1 : -1;

  const normals: EdgeNormal[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) {
      normals.push({ mx: a.x, my: a.y, nx: 0, ny: 0 });
      continue;
    }
    const nx = (sign * dy) / len;
    const ny = (sign * -dx) / len;
    normals.push({
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      nx,
      ny,
    });
  }
  return normals;
}

/**
 * Compute inward-pointing vertex normals (bisectors) for a polygon.
 */
function computeVertexNormals(poly: Polygon, edgeNormals: EdgeNormal[]): VertexNormal[] {
  const pts = poly.points;
  const n = pts.length;
  if (n < 2) return [];

  const vertexNormals: VertexNormal[] = [];
  for (let i = 0; i < n; i++) {
    const prevEdge = edgeNormals[(i - 1 + n) % n];
    const nextEdge = edgeNormals[i];

    let bx = prevEdge.nx + nextEdge.nx;
    let by = prevEdge.ny + nextEdge.ny;
    const bLen = Math.sqrt(bx * bx + by * by);

    if (bLen < 1e-8) {
      vertexNormals.push({
        x: pts[i].x,
        y: pts[i].y,
        nx: prevEdge.nx,
        ny: prevEdge.ny,
      });
      continue;
    }

    const bnx = bx / bLen;
    const bny = by / bLen;

    const cosHalf = bnx * prevEdge.nx + bny * prevEdge.ny;

    const scale = cosHalf > 0.1 ? 1 / cosHalf : 1 / 0.1;

    vertexNormals.push({
      x: pts[i].x,
      y: pts[i].y,
      nx: bnx * scale,
      ny: bny * scale,
    });
  }
  return vertexNormals;
}

/**
 * Compute the total path length in world units, then convert to
 * approximate travel time using WORLD_SCALE and MOVE_SPEED.
 */
function computePathLength(pts: Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += dist(pts[i - 1], pts[i]);
  }
  return total;
}

function computePathTravelTime(pts: Point[]): number {
  const editorLength = computePathLength(pts);
  // Editor coordinates -> world coordinates
  const worldLength = editorLength * WORLD_SCALE;
  // Time = distance / speed
  return worldLength / MOVE_SPEED;
}

/**
 * Compute cumulative travel time at each point along a path.
 */
function computePathCumulativeTimes(pts: Point[]): number[] {
  const times: number[] = [0];
  let cumDist = 0;
  for (let i = 1; i < pts.length; i++) {
    cumDist += dist(pts[i - 1], pts[i]);
    const worldDist = cumDist * WORLD_SCALE;
    times.push(worldDist / MOVE_SPEED);
  }
  return times;
}

function formatTime(seconds: number): string {
  if (seconds < 60) {
    return seconds.toFixed(1) + 's';
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins + 'm ' + secs.toFixed(1) + 's';
}

/**
 * Remove consecutive duplicate points from a polygon (after snapping).
 * Also checks wrap-around (last vs first).
 * Returns the deduplicated array.
 */
function deduplicatePoints(pts: Point[]): Point[] {
  if (pts.length < 2) return [...pts];
  const result: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x !== result[result.length - 1].x || pts[i].y !== result[result.length - 1].y) {
      result.push(pts[i]);
    }
  }
  // Check wrap-around
  if (result.length > 1 &&
      result[result.length - 1].x === result[0].x &&
      result[result.length - 1].y === result[0].y) {
    result.pop();
  }
  return result;
}

/**
 * Check if a polygon's edges self-intersect.
 */
function isSelfIntersecting(pts: Point[]): boolean {
  const n = pts.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // Skip adjacent edges (they share a vertex)
      if (i === 0 && j === n - 1) continue;
      const b1 = pts[j];
      const b2 = pts[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if two line segments properly intersect (not just touch at endpoints).
 */
function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  return false;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Decompose a self-intersecting polygon into multiple simple (non-self-intersecting) polygons
 * using the simplepolygon library.
 * Returns an array of Point arrays, one per resulting simple polygon.
 * If the polygon is already simple, returns an array containing just the original points.
 */
function decomposePolygon(pts: Point[]): Point[][] {
  if (pts.length < 3) return [pts];
  if (!isSelfIntersecting(pts)) return [pts];

  try {
    // Convert to GeoJSON polygon (closed ring: first point repeated at end)
    const coords = pts.map(p => [p.x, p.y]);
    coords.push([pts[0].x, pts[0].y]); // close the ring
    const geojsonPoly = turfPolygon([coords]);

    const result = simplepolygon(geojsonPoly);

    const decomposed: Point[][] = [];
    if (result && result.features) {
      for (const feature of result.features) {
        const ring = feature.geometry.coordinates[0];
        // ring is a closed GeoJSON ring; remove the closing duplicate
        const polyPts: Point[] = [];
        for (let i = 0; i < ring.length - 1; i++) {
          polyPts.push({ x: ring[i][0], y: ring[i][1] });
        }
        if (polyPts.length >= 3) {
          decomposed.push(polyPts);
        }
      }
    }

    if (decomposed.length === 0) {
      // Fallback: return original if decomposition produced nothing
      return [pts];
    }

    return decomposed;
  } catch (err) {
    console.warn('simplepolygon decomposition failed, keeping original polygon:', err);
    return [pts];
  }
}

// ============================================================
// Editor
// ============================================================

class Editor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: Map = { versions: [{ polygons: [] }], paths: [], artefacts: [] };
  private undoStack = new UndoStack();
  private mode: EditorMode = 'polygon';

  // Current version index
  private currentVersionIndex = 0;

  // Camera / pan
  private panX = 0;
  private panY = 0;
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartPanX = 0;
  private panStartPanY = 0;

  // Space-to-pan
  private spaceDown = false;

  // Polygon mode state
  private selectedPolygonIndex: number = -1;
  private draggingPolygon = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private scalingPolygon = false;
  private scaleStartMouseX = 0;
  private scaleOriginalPoints: Point[] = [];

  // Clipboard for polygon copy/paste (persists across versions)
  private clipboardPolygon: Polygon | null = null;

  // Point mode state
  private buildingPolygon: Point[] = [];
  private selectedPointPolyIndex: number = -1;
  private selectedPointIndex: number = -1;
  private draggingPoint = false;
  private dragPointStart: Point = { x: 0, y: 0 };

  // World mode state
  private buildingPath: Point[] = [];
  private selectedPathIndex: number = -1;
  private selectedPathPointIndex: number = -1;
  private draggingPathPoint = false;
  private draggingPath = false;
  private dragPathOffsetX = 0;
  private dragPathOffsetY = 0;
  // When true, clicks append points to the selected path (extending mode)
  private extendingPath = false;

  // Artefact mode state
  private currentArtefactType: ArtefactType = 'key';
  private selectedArtefactIndex: number = -1;
  private draggingArtefact = false;
  private dragArtefactOffsetX = 0;
  private dragArtefactOffsetY = 0;

  // Mouse
  private mouseWorld: Point = { x: 0, y: 0 };
  private mouseScreen: Point = { x: 0, y: 0 };

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.background = theme.background;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    // Start with origin in the middle of the screen
    this.panX = Math.round(window.innerWidth / 2);
    this.panY = Math.round(window.innerHeight / 2);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    window.addEventListener('beforeunload', (event) => {
      // Cancel the event as stated by the standard.
      event.preventDefault();
      // Older browsers require a returnValue to be set.
      event.returnValue = '';
    });

    // Prevent context menu on right-click
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Drag and drop JSON loading
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        this.loadFile(e.dataTransfer.files[0]);
      }
    });

    this.draw();
  }

  private get currentVersion(): Version {
    return this.state.versions[this.currentVersionIndex];
  }

  /** Get a scale-independent font size: the given size in CSS pixels regardless of browser zoom. */
  private fontSize(basePx: number): string {
    const dpr = window.devicePixelRatio || 1;
    return (basePx / dpr) + 'px';
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.draw();
  }

  // ---- Coordinate transforms ----

  private screenToWorld(sx: number, sy: number): Point {
    return {
      x: sx - this.panX,
      y: sy - this.panY,
    };
  }

  private worldToScreen(wx: number, wy: number): Point {
    return {
      x: wx + this.panX,
      y: wy + this.panY,
    };
  }

  // ---- Hit testing ----

  private findPointAt(wp: Point): { polyIndex: number; pointIndex: number } | null {
    const polys = this.currentVersion.polygons;
    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      for (let vi = 0; vi < poly.points.length; vi++) {
        if (dist(wp, poly.points[vi]) <= theme.pointHitRadius) {
          return { polyIndex: pi, pointIndex: vi };
        }
      }
    }
    return null;
  }

  private findEdgeAt(wp: Point): { polyIndex: number; edgeIndex: number } | null {
    const polys = this.currentVersion.polygons;
    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      for (let ei = 0; ei < poly.points.length; ei++) {
        const a = poly.points[ei];
        const b = poly.points[(ei + 1) % poly.points.length];
        if (pointToSegmentDist(wp, a, b) <= theme.lineHitDistance) {
          return { polyIndex: pi, edgeIndex: ei };
        }
      }
    }
    return null;
  }

  private findPolygonAt(wp: Point): number {
    const polys = this.currentVersion.polygons;
    for (let i = polys.length - 1; i >= 0; i--) {
      if (isPointInPolygon(wp, polys[i])) {
        return i;
      }
    }
    return -1;
  }

  private findArtefactAt(wp: Point): number {
    const artefacts = this.state.artefacts;
    for (let i = artefacts.length - 1; i >= 0; i--) {
      const a = artefacts[i];
      if (dist(wp, { x: a.x, y: a.y }) <= theme.artefactHitRadius) {
        return i;
      }
    }
    return -1;
  }

  private findPathPointAt(wp: Point): { pathIndex: number; pointIndex: number } | null {
    for (let pi = 0; pi < this.state.paths.length; pi++) {
      const path = this.state.paths[pi];
      for (let vi = 0; vi < path.points.length; vi++) {
        if (dist(wp, path.points[vi]) <= theme.pointHitRadius) {
          return { pathIndex: pi, pointIndex: vi };
        }
      }
    }
    return null;
  }

  private findPathSegmentAt(wp: Point): { pathIndex: number; segmentIndex: number } | null {
    for (let pi = 0; pi < this.state.paths.length; pi++) {
      const path = this.state.paths[pi];
      for (let ei = 0; ei < path.points.length - 1; ei++) {
        const a = path.points[ei];
        const b = path.points[ei + 1];
        if (pointToSegmentDist(wp, a, b) <= theme.lineHitDistance) {
          return { pathIndex: pi, segmentIndex: ei };
        }
      }
    }
    return null;
  }

  // ---- Undo / Redo helpers ----

  private performUndo(): void {
    const prev = this.undoStack.undo(cloneState(this.state));
    if (prev) {
      this.state = prev;
      // Clamp version index
      if (this.currentVersionIndex >= this.state.versions.length) {
        this.currentVersionIndex = this.state.versions.length - 1;
      }
      this.clearSelection();
    }
    this.draw();
  }

  private performRedo(): void {
    const next = this.undoStack.redo(cloneState(this.state));
    if (next) {
      this.state = next;
      if (this.currentVersionIndex >= this.state.versions.length) {
        this.currentVersionIndex = this.state.versions.length - 1;
      }
      this.clearSelection();
    }
    this.draw();
  }

  // ---- Copy / Paste helpers ----

  private copySelectedPolygon(): void {
    if (this.mode !== 'polygon' || this.selectedPolygonIndex < 0) return;
    const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
    // Deep clone the polygon into the clipboard
    this.clipboardPolygon = JSON.parse(JSON.stringify(poly));
  }

  private pastePolygon(): void {
    if (this.mode !== 'polygon' || !this.clipboardPolygon) return;
    this.undoStack.save(cloneState(this.state));
    // Deep clone from clipboard so we can paste multiple times
    const pasted: Polygon = JSON.parse(JSON.stringify(this.clipboardPolygon));
    // Offset by one grid unit diagonally so it doesn't sit exactly on top
    const offset = theme.gridSize;
    for (const p of pasted.points) {
      p.x += offset;
      p.y += offset;
    }
    this.currentVersion.polygons.push(pasted);
    this.selectedPolygonIndex = this.currentVersion.polygons.length - 1;
    this.draw();
  }

  private duplicateSelectedPolygon(): void {
    if (this.mode !== 'polygon' || this.selectedPolygonIndex < 0) return;
    this.copySelectedPolygon();
    this.pastePolygon();
  }

  // ---- Mouse handlers ----

  private onMouseDown(e: MouseEvent): void {
    const sx = e.clientX;
    const sy = e.clientY;
    const wp = this.screenToWorld(sx, sy);

    // Middle mouse or right mouse for panning
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true;
      this.panStartX = sx;
      this.panStartY = sy;
      this.panStartPanX = this.panX;
      this.panStartPanY = this.panY;
      e.preventDefault();
      return;
    }

    // Don't process clicks while space-panning
    if (this.spaceDown) {
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    if (this.mode === 'polygon') {
      this.onMouseDownPolygonMode(wp);
    } else if (this.mode === 'point') {
      this.onMouseDownPointMode(wp);
    } else if (this.mode === 'world') {
      this.onMouseDownWorldMode(wp);
    } else if (this.mode === 'artefact') {
      this.onMouseDownArtefactMode(wp);
    }

    this.draw();
  }

  private onMouseDownPolygonMode(wp: Point): void {
    const idx = this.findPolygonAt(wp);
    if (idx >= 0) {
      this.undoStack.save(cloneState(this.state));
      this.selectedPolygonIndex = idx;
      this.draggingPolygon = true;
      const snapped = snapToGrid(wp);
      this.dragOffsetX = snapped.x;
      this.dragOffsetY = snapped.y;
    } else {
      this.selectedPolygonIndex = -1;
    }
  }

  private onMouseDownPointMode(wp: Point): void {
    const snapped = snapToGrid(wp);

    // If building a polygon, check if clicking on first point to close
    if (this.buildingPolygon.length >= 3) {
      const first = this.buildingPolygon[0];
      if (dist(snapped, first) <= theme.firstPointCloseRadius) {
        // Finish polygon
        this.undoStack.save(cloneState(this.state));
        this.currentVersion.polygons.push({ points: [...this.buildingPolygon], type: 'level' });
        this.buildingPolygon = [];
        return;
      }
    }

    // Check if clicking on an existing point
    const pointHit = this.findPointAt(wp);
    if (pointHit) {
      this.undoStack.save(cloneState(this.state));
      this.selectedPointPolyIndex = pointHit.polyIndex;
      this.selectedPointIndex = pointHit.pointIndex;
      this.draggingPoint = true;
      this.dragPointStart = { ...this.currentVersion.polygons[pointHit.polyIndex].points[pointHit.pointIndex] };
      this.buildingPolygon = [];
      return;
    }

    // Check if clicking on an edge (split)
    if (this.buildingPolygon.length === 0) {
      const edgeHit = this.findEdgeAt(wp);
      if (edgeHit) {
        this.undoStack.save(cloneState(this.state));
        const poly = this.currentVersion.polygons[edgeHit.polyIndex];
        const a = poly.points[edgeHit.edgeIndex];
        const b = poly.points[(edgeHit.edgeIndex + 1) % poly.points.length];
        const proj = snapToGrid(pointOnSegmentProjection(wp, a, b));
        poly.points.splice(edgeHit.edgeIndex + 1, 0, proj);
        this.selectedPointPolyIndex = edgeHit.polyIndex;
        this.selectedPointIndex = edgeHit.edgeIndex + 1;
        return;
      }
    }

    // Otherwise, add point to building polygon or start new one
    this.selectedPointPolyIndex = -1;
    this.selectedPointIndex = -1;
    this.buildingPolygon.push(snapped);
  }

  private onMouseDownWorldMode(wp: Point): void {
    const snapped = snapToGrid(wp);

    // If we are extending an existing path, append the point
    if (this.extendingPath && this.selectedPathIndex >= 0) {
      const path = this.state.paths[this.selectedPathIndex];
      path.points.push(snapped);
      this.draw();
      return;
    }

    // If we are building a new path, just append
    if (this.buildingPath.length > 0) {
      this.buildingPath.push(snapped);
      return;
    }

    // Check if clicking on an existing path point (select + drag)
    const pathPointHit = this.findPathPointAt(wp);
    if (pathPointHit) {
      this.undoStack.save(cloneState(this.state));
      this.selectedPathIndex = pathPointHit.pathIndex;
      this.selectedPathPointIndex = pathPointHit.pointIndex;
      this.draggingPathPoint = true;
      return;
    }

    // Check if clicking on a path segment (select path + drag whole path)
    const segHit = this.findPathSegmentAt(wp);
    if (segHit) {
      this.undoStack.save(cloneState(this.state));
      this.selectedPathIndex = segHit.pathIndex;
      this.selectedPathPointIndex = -1;
      this.draggingPath = true;
      this.dragPathOffsetX = snapped.x;
      this.dragPathOffsetY = snapped.y;
      return;
    }

    // Clicking on empty space: start building a new path
    this.selectedPathIndex = -1;
    this.selectedPathPointIndex = -1;
    this.buildingPath.push(snapped);
  }

  private onMouseDownArtefactMode(wp: Point): void {
    const snapped = snapToGrid(wp);

    // Check if clicking on an existing artefact
    const idx = this.findArtefactAt(wp);
    if (idx >= 0) {
      this.undoStack.save(cloneState(this.state));
      this.selectedArtefactIndex = idx;
      this.draggingArtefact = true;
      const a = this.state.artefacts[idx];
      this.dragArtefactOffsetX = snapped.x - a.x;
      this.dragArtefactOffsetY = snapped.y - a.y;
      return;
    }

    // Place a new artefact
    this.undoStack.save(cloneState(this.state));
    this.state.artefacts.push({
      x: snapped.x,
      y: snapped.y,
      type: this.currentArtefactType,
    });
    this.selectedArtefactIndex = this.state.artefacts.length - 1;
  }

  private onMouseMove(e: MouseEvent): void {
    const sx = e.clientX;
    const sy = e.clientY;
    this.mouseScreen = { x: sx, y: sy };

    if (this.isPanning) {
      this.panX = this.panStartPanX + (sx - this.panStartX);
      this.panY = this.panStartPanY + (sy - this.panStartY);
      this.panX = Math.round(this.panX);
      this.panY = Math.round(this.panY);
      this.mouseWorld = this.screenToWorld(sx, sy);
      this.draw();
      return;
    }

    // Space panning
    if (this.spaceDown) {
      const dx = sx - this.panStartX;
      const dy = sy - this.panStartY;
      this.panX = Math.round(this.panStartPanX + dx);
      this.panY = Math.round(this.panStartPanY + dy);
      this.mouseWorld = this.screenToWorld(sx, sy);
      this.draw();
      return;
    }

    this.mouseWorld = this.screenToWorld(sx, sy);

    if (this.mode === 'polygon' && this.draggingPolygon && this.selectedPolygonIndex >= 0) {
      const snapped = snapToGrid(this.mouseWorld);
      const dx = snapped.x - this.dragOffsetX;
      const dy = snapped.y - this.dragOffsetY;
      if (dx !== 0 || dy !== 0) {
        const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
        for (const p of poly.points) {
          p.x += dx;
          p.y += dy;
        }
        this.dragOffsetX = snapped.x;
        this.dragOffsetY = snapped.y;
      }
    }

    if (this.mode === 'polygon' && this.scalingPolygon && this.selectedPolygonIndex >= 0) {
      const deltaX = this.mouseScreen.x - this.scaleStartMouseX;
      // Scale factor: moving mouse right = scale up, left = scale down
      const scaleFactor = 1.0 + deltaX * 0.005;
      const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
      const edgeNormals = computeEdgeNormals({ points: this.scaleOriginalPoints, type: poly.type });
      const vertexNormals = computeVertexNormals({ points: this.scaleOriginalPoints, type: poly.type }, edgeNormals);

      // offset each vertex by (scaleFactor - 1) * base distance along its bisector
      const offsetDist = (scaleFactor - 1.0) * 20.0; // 20 pixels base

      for (let i = 0; i < poly.points.length; i++) {
        poly.points[i].x = this.scaleOriginalPoints[i].x + vertexNormals[i].nx * offsetDist;
        poly.points[i].y = this.scaleOriginalPoints[i].y + vertexNormals[i].ny * offsetDist;
      }
    }

    if (this.mode === 'point' && this.draggingPoint && this.selectedPointPolyIndex >= 0) {
      const snapped = snapToGrid(this.mouseWorld);
      this.currentVersion.polygons[this.selectedPointPolyIndex].points[this.selectedPointIndex] = snapped;
    }

    if (this.mode === 'world' && this.draggingPathPoint && this.selectedPathIndex >= 0) {
      const snapped = snapToGrid(this.mouseWorld);
      this.state.paths[this.selectedPathIndex].points[this.selectedPathPointIndex] = snapped;
    }

    if (this.mode === 'world' && this.draggingPath && this.selectedPathIndex >= 0) {
      const snapped = snapToGrid(this.mouseWorld);
      const dx = snapped.x - this.dragPathOffsetX;
      const dy = snapped.y - this.dragPathOffsetY;
      if (dx !== 0 || dy !== 0) {
        const path = this.state.paths[this.selectedPathIndex];
        for (const p of path.points) {
          p.x += dx;
          p.y += dy;
        }
        this.dragPathOffsetX = snapped.x;
        this.dragPathOffsetY = snapped.y;
      }
    }

    if (this.mode === 'artefact' && this.draggingArtefact && this.selectedArtefactIndex >= 0) {
      const snapped = snapToGrid(this.mouseWorld);
      const a = this.state.artefacts[this.selectedArtefactIndex];
      a.x = snapped.x - this.dragArtefactOffsetX;
      a.y = snapped.y - this.dragArtefactOffsetY;
    }

    this.draw();
  }

  private onMouseUp(_e: MouseEvent): void {
    this.isPanning = false;
    this.draggingPolygon = false;
    this.draggingPoint = false;
    this.draggingPathPoint = false;
    this.draggingPath = false;
    this.draggingArtefact = false;
    this.draw();
  }

  // ---- Keyboard ----

  private onKeyDown(e: KeyboardEvent): void {
    // Track space key for pan
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.canvas.style.cursor = 'grab';
        this.panStartX = this.mouseScreen.x;
        this.panStartY = this.mouseScreen.y;
        this.panStartPanX = this.panX;
        this.panStartPanY = this.panY;
      }
      return;
    }

    // Undo: Ctrl+Z
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.performUndo();
      return;
    }

    // Redo: Ctrl+Shift+Z or Ctrl+Y
    if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      e.preventDefault();
      this.performRedo();
      return;
    }

    // Copy: Ctrl+C (polygon mode)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !e.shiftKey) {
      if (this.mode === 'polygon') {
        e.preventDefault();
        this.copySelectedPolygon();
        this.draw();
        return;
      }
    }

    // Paste: Ctrl+V (polygon mode)
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !e.shiftKey) {
      if (this.mode === 'polygon') {
        e.preventDefault();
        this.pastePolygon();
        return;
      }
    }

    // Duplicate: Ctrl+D (polygon mode)
    if ((e.ctrlKey || e.metaKey) && e.key === 'd' && !e.shiftKey) {
      if (this.mode === 'polygon') {
        e.preventDefault();
        this.duplicateSelectedPolygon();
        return;
      }
    }

    // Mode switching: a = point mode, v = polygon mode, w = world mode, t = artefact mode
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
      if (this.mode !== 'point') {
        this.mode = 'point';
        this.clearSelection();
        this.draw();
      }
      return;
    }
    if (e.key === 'v' && !e.ctrlKey && !e.metaKey) {
      if (this.mode !== 'polygon') {
        this.mode = 'polygon';
        this.clearSelection();
        this.draw();
      }
      return;
    }
    if (e.key === 'w' && !e.ctrlKey && !e.metaKey) {
      if (this.mode !== 'world') {
        this.mode = 'world';
        this.clearSelection();
        this.draw();
      }
      return;
    }
    if (e.key === 't' && !e.ctrlKey && !e.metaKey) {
      if (this.mode !== 'artefact') {
        this.mode = 'artefact';
        this.clearSelection();
        this.draw();
      }
      return;
    }

    // 's' key in polygon mode: start scaling along bisectors
    if (e.key === 's' && !e.ctrlKey && !e.metaKey && this.mode === 'polygon') {
      if (this.selectedPolygonIndex >= 0 && !this.scalingPolygon) {
        this.undoStack.save(cloneState(this.state));
        this.scalingPolygon = true;
        this.scaleStartMouseX = this.mouseScreen.x;
        const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
        this.scaleOriginalPoints = poly.points.map(p => ({ ...p }));
      }
      return;
    }

    // '+' or '=' key in world mode
    if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey && this.mode === 'world') {
      // If a path is selected (and not already building/extending), start extending it
      if (this.selectedPathIndex >= 0 && this.buildingPath.length === 0 && !this.extendingPath) {
        this.undoStack.save(cloneState(this.state));
        this.extendingPath = true;
        this.selectedPathPointIndex = -1;
        this.draw();
        return;
      }

      // Otherwise, add new version by cloning current
      if (this.selectedPathIndex < 0 && this.buildingPath.length === 0) {
        this.undoStack.save(cloneState(this.state));
        const clonedVersion: Version = JSON.parse(JSON.stringify(this.currentVersion));
        this.state.versions.push(clonedVersion);
        this.currentVersionIndex = this.state.versions.length - 1;
        this.clearSelection();
        this.draw();
      }
      return;
    }

    // Number keys
    if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey) {
      const num = parseInt(e.key);

      if (this.mode === 'world') {
        // Only select existing versions, do not create new ones
        const idx = num - 1;
        if (idx < this.state.versions.length) {
          this.currentVersionIndex = idx;
          this.clearSelection();
          this.draw();
        }
        return;
      }

      if (this.mode === 'polygon' && this.selectedPolygonIndex >= 0) {
        const typeMap: Record<number, PolygonType> = {
          1: 'level',
          2: 'solid',
          3: 'floor',
        };
        if (typeMap[num]) {
          this.undoStack.save(cloneState(this.state));
          this.currentVersion.polygons[this.selectedPolygonIndex].type = typeMap[num];
          this.draw();
        }
        return;
      }

      if (this.mode === 'artefact') {
        const artefactTypeMap: Record<number, ArtefactType> = {
          1: 'key',
          2: 'exit',
          3: 'delay',
          4: 'decompress',
          5: 'anchor',
          6: 'compass',
          7: 'start',
        };
        if (artefactTypeMap[num]) {
          this.currentArtefactType = artefactTypeMap[num];
          // If an artefact is selected, change its type
          if (this.selectedArtefactIndex >= 0) {
            this.undoStack.save(cloneState(this.state));
            this.state.artefacts[this.selectedArtefactIndex].type = this.currentArtefactType;
          }
          this.draw();
        }
        return;
      }
    }

    if (e.key === 'Escape') {
      if (this.mode === 'point' && this.buildingPolygon.length > 0) {
        this.buildingPolygon = [];
      } else if (this.mode === 'world' && this.extendingPath) {
        this.extendingPath = false;
      } else if (this.mode === 'world' && this.buildingPath.length > 0) {
        this.buildingPath = [];
      } else if (this.mode === 'polygon' && this.scalingPolygon) {
        // Cancel scaling - revert
        if (this.selectedPolygonIndex >= 0) {
          const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
          for (let i = 0; i < poly.points.length; i++) {
            poly.points[i] = { ...this.scaleOriginalPoints[i] };
          }
        }
        this.scalingPolygon = false;
        this.scaleOriginalPoints = [];
      } else {
        this.selectedPolygonIndex = -1;
        this.selectedPointPolyIndex = -1;
        this.selectedPointIndex = -1;
        this.selectedPathIndex = -1;
        this.selectedPathPointIndex = -1;
        this.selectedArtefactIndex = -1;
      }
      this.draw();
      return;
    }

    // Enter key to finish path in world mode
    if (e.key === 'Enter' && this.mode === 'world') {
      if (this.extendingPath) {
        this.extendingPath = false;
        this.draw();
        return;
      }
      if (this.buildingPath.length >= 2) {
        this.undoStack.save(cloneState(this.state));
        this.state.paths.push({ points: [...this.buildingPath] });
        this.buildingPath = [];
        this.draw();
        return;
      }
    }

    // =
    if (e.key === '[' && this.mode === 'world') {
      e.preventDefault();
      this.undoStack.save(cloneState(this.state));
      const clonedVersion: Version = JSON.parse(JSON.stringify(this.currentVersion));
      this.state.versions.splice(this.currentVersionIndex, 0, clonedVersion);
      this.clearSelection();
      this.draw();
    }

    // Backspace / Delete
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (this.mode === 'point') {
        if (this.buildingPolygon.length > 0) {
          this.buildingPolygon.pop();
        } else if (this.selectedPointPolyIndex >= 0 && this.selectedPointIndex >= 0) {
          this.undoStack.save(cloneState(this.state));
          const poly = this.currentVersion.polygons[this.selectedPointPolyIndex];
          poly.points.splice(this.selectedPointIndex, 1);
          if (poly.points.length < 3) {
            this.currentVersion.polygons.splice(this.selectedPointPolyIndex, 1);
          }
          this.selectedPointPolyIndex = -1;
          this.selectedPointIndex = -1;
        }
      } else if (this.mode === 'polygon') {
        if (this.selectedPolygonIndex >= 0) {
          this.undoStack.save(cloneState(this.state));
          this.currentVersion.polygons.splice(this.selectedPolygonIndex, 1);
          this.selectedPolygonIndex = -1;
        }
      } else if (this.mode === 'world') {
        if (this.extendingPath && this.selectedPathIndex >= 0) {
          // Remove last point from the path being extended
          const path = this.state.paths[this.selectedPathIndex];
          if (path.points.length > 2) {
            path.points.pop();
          } else {
            // Stop extending if we'd go below 2 points
            this.extendingPath = false;
          }
        } else if (this.buildingPath.length > 0) {
          this.buildingPath.pop();
        } else if (this.selectedPathIndex >= 0 && this.selectedPathPointIndex >= 0) {
          // Delete selected path point
          this.undoStack.save(cloneState(this.state));
          const path = this.state.paths[this.selectedPathIndex];
          path.points.splice(this.selectedPathPointIndex, 1);
          if (path.points.length < 2) {
            this.state.paths.splice(this.selectedPathIndex, 1);
            this.selectedPathIndex = -1;
          }
          this.selectedPathPointIndex = -1;
        } else if (this.selectedPathIndex >= 0) {
          // Delete entire selected path
          this.undoStack.save(cloneState(this.state));
          this.state.paths.splice(this.selectedPathIndex, 1);
          this.selectedPathIndex = -1;
        } else {
          // Delete current version
          if (this.state.versions.length > 1) {
            if (confirm(`Delete version ${this.currentVersionIndex + 1}?`)) {
              this.undoStack.save(cloneState(this.state));
              this.state.versions.splice(this.currentVersionIndex, 1);
              if (this.currentVersionIndex === this.state.versions.length) {
                this.currentVersionIndex = this.state.versions.length - 1;
              }
            }
          }
        }
      } else if (this.mode === 'artefact') {
        if (this.selectedArtefactIndex >= 0) {
          this.undoStack.save(cloneState(this.state));
          this.state.artefacts.splice(this.selectedArtefactIndex, 1);
          this.selectedArtefactIndex = -1;
        }
      }
      this.draw();
      return;
    }

    // Save: Ctrl+S
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'w') && !e.shiftKey) {
      e.preventDefault();
      this.exportJSON();
      return;
    }

    // Load: Ctrl+O
    if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'l') && !e.shiftKey) {
      e.preventDefault();
      this.openLoadDialog();
      return;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.spaceDown = false;
      this.canvas.style.cursor = '';
    }

    // Stop scaling when 's' is released
    if (e.key === 's' && this.scalingPolygon) {
      this.scalingPolygon = false;
      this.scaleOriginalPoints = [];
      // Snap all points to grid after scaling, then deduplicate
      if (this.selectedPolygonIndex >= 0) {
        const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
        for (let i = 0; i < poly.points.length; i++) {
          poly.points[i] = snapToGrid(poly.points[i]);
        }
        // Remove collapsed/duplicate points
        poly.points = deduplicatePoints(poly.points);
        if (poly.points.length < 3) {
          this.currentVersion.polygons.splice(this.selectedPolygonIndex, 1);
          this.selectedPolygonIndex = -1;
        } else {
          // Decompose self-intersecting polygon into simple polygons
          const decomposed = decomposePolygon(poly.points);
          if (decomposed.length === 1) {
            // No self-intersection or single result — just update in place
            poly.points = decomposed[0];
          } else {
            // Replace the original polygon with multiple simple polygons
            const polyType = poly.type;
            const insertIndex = this.selectedPolygonIndex;
            // Remove the original polygon
            this.currentVersion.polygons.splice(insertIndex, 1);
            // Insert all decomposed polygons at the same position
            for (let i = 0; i < decomposed.length; i++) {
              const dedupedPts = deduplicatePoints(decomposed[i]);
              if (dedupedPts.length >= 3) {
                this.currentVersion.polygons.splice(insertIndex + i, 0, {
                  points: dedupedPts,
                  type: polyType,
                });
              }
            }
            this.selectedPolygonIndex = -1;
          }
        }
      }
      this.draw();
    }
  }

  private clearSelection(): void {
    this.selectedPolygonIndex = -1;
    this.selectedPointPolyIndex = -1;
    this.selectedPointIndex = -1;
    this.selectedPathIndex = -1;
    this.selectedPathPointIndex = -1;
    this.selectedArtefactIndex = -1;
    this.buildingPolygon = [];
    this.buildingPath = [];
    this.draggingPolygon = false;
    this.draggingPoint = false;
    this.draggingPathPoint = false;
    this.draggingPath = false;
    this.draggingArtefact = false;
    this.scalingPolygon = false;
    this.scaleOriginalPoints = [];
    this.extendingPath = false;
  }

  // ---- Export / Import ----

  private exportJSON(): void {
    const data = JSON.stringify(this.state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'level.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  private openLoadDialog(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        this.loadFile(input.files[0]);
      }
    };
    input.click();
  }

  private loadFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        this.undoStack.save(cloneState(this.state));

        if (raw.versions && Array.isArray(raw.versions)) {
          // New format
          this.state = this.parseMapData(raw);
        } else if (Array.isArray(raw)) {
          // Legacy format: array of polygons
          this.state = {
            versions: [{
              polygons: raw.map((p: any) => ({
                points: Array.isArray(p.points) ? p.points.map((pt: any) => ({ x: pt.x, y: pt.y })) : [],
                type: (p.type as PolygonType) || 'level',
              })),
            }],
            paths: [],
            artefacts: [],
          };
        } else {
          console.error('Unrecognized JSON format');
          return;
        }

        this.currentVersionIndex = 0;
        this.clearSelection();
        this.draw();
      } catch (err) {
        console.error('Failed to load JSON:', err);
      }
    };
    reader.readAsText(file);
  }

  private parseMapData(raw: any): Map {
    const versions: Version[] = [];
    const artefacts: EditorArtefact[] = [];

    for (const v of raw.versions) {
      const polygons: Polygon[] = [];
      if (Array.isArray(v.polygons)) {
        for (const p of v.polygons) {
          polygons.push({
            points: Array.isArray(p.points) ? p.points.map((pt: any) => ({ x: pt.x, y: pt.y })) : [],
            type: (p.type as PolygonType) || 'level',
          });
        }
      }
      // Backward compatibility: if artefacts are inside a version, merge them into the top-level array
      if (Array.isArray(v.artefacts)) {
        for (const a of v.artefacts) {
          artefacts.push({
            x: a.x ?? 0,
            y: a.y ?? 0,
            type: (a.type as ArtefactType) || 'key',
          });
        }
      }
      versions.push({ polygons });
    }

    // Top-level artefacts (new format)
    if (Array.isArray(raw.artefacts)) {
      for (const a of raw.artefacts) {
        artefacts.push({
          x: a.x ?? 0,
          y: a.y ?? 0,
          type: (a.type as ArtefactType) || 'key',
        });
      }
    }

    const paths: Path[] = [];
    if (Array.isArray(raw.paths)) {
      for (const p of raw.paths) {
        if (Array.isArray(p.points)) {
          paths.push({
            points: p.points.map((pt: any) => ({ x: pt.x, y: pt.y })),
          });
        }
      }
    }

    if (versions.length === 0) {
      versions.push({ polygons: [] });
    }

    return { versions, paths, artefacts };
  }

  // ============================================================
  // Drawing
  // ============================================================

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Background
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, w, h);

    // Grid
    this.drawGrid();

    // Origin
    this.drawOrigin();

    // Polygons (current version)
    const polys = this.currentVersion.polygons;
    for (let i = 0; i < polys.length; i++) {
      this.drawPolygon(polys[i], i);
    }

    // Building polygon preview
    if (this.buildingPolygon.length > 0) {
      this.drawBuildingPolygon();
    }

    // Paths (visible in every version)
    for (let i = 0; i < this.state.paths.length; i++) {
      this.drawPath(this.state.paths[i], i);
    }

    // Building path preview
    if (this.buildingPath.length > 0) {
      this.drawBuildingPath();
    }

    // Extending path preview line
    if (this.extendingPath && this.selectedPathIndex >= 0) {
      this.drawExtendingPathPreview();
    }

    // Artefacts (level global)
    const artefacts = this.state.artefacts;
    for (let i = 0; i < artefacts.length; i++) {
      this.drawArtefact(artefacts[i], i);
    }

    // HUD
    this.drawHUD();
  }

  private drawOrigin(): void {
    const ctx = this.ctx;
    const s = this.worldToScreen(0, 0);
    ctx.beginPath();
    ctx.arc(s.x, s.y, theme.originRadius, 0, Math.PI * 2);
    ctx.fillStyle = theme.origin;
    ctx.fill();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const gs = theme.gridSize;
    const majorEvery = 5;
    const majorGs = gs * majorEvery;

    const offsetX = ((this.panX % gs) + gs) % gs;
    const offsetY = ((this.panY % gs) + gs) % gs;

    // Minor grid lines
    ctx.strokeStyle = theme.gridLine;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let sx = offsetX; sx < w; sx += gs) {
      const worldX = sx - this.panX;
      if (Math.round(worldX / majorGs) * majorGs === worldX) continue;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let sy = offsetY; sy < h; sy += gs) {
      const worldY = sy - this.panY;
      if (Math.round(worldY / majorGs) * majorGs === worldY) continue;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    // Major grid lines
    const majorOffsetX = ((this.panX % majorGs) + majorGs) % majorGs;
    const majorOffsetY = ((this.panY % majorGs) + majorGs) % majorGs;

    ctx.strokeStyle = theme.gridLineMain;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let sx = majorOffsetX; sx < w; sx += majorGs) {
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let sy = majorOffsetY; sy < h; sy += majorGs) {
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();
  }

  private getPolygonColors(poly: Polygon, isSelected: boolean): { fill: string; stroke: string } {
    if (isSelected) {
      return { fill: theme.polygonFillSelected, stroke: theme.polygonStrokeSelected };
    }
    switch (poly.type) {
      case 'solid':
        return { fill: theme.solidFill, stroke: theme.solidStroke };
      case 'floor':
        return { fill: theme.floorFill, stroke: theme.floorStroke };
      case 'level':
      default:
        return { fill: theme.polygonFill, stroke: theme.polygonStroke };
    }
  }

  private drawPolygon(poly: Polygon, index: number): void {
    const ctx = this.ctx;
    const pts = poly.points;
    if (pts.length < 2) return;

    const isSelectedPoly = (this.mode === 'polygon' && this.selectedPolygonIndex === index);
    const colors = this.getPolygonColors(poly, isSelectedPoly);

    // Fill
    ctx.beginPath();
    const s0 = this.worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = this.worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();

    // Stroke
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = isSelectedPoly ? theme.lineWidthSelected : theme.lineWidth;
    ctx.stroke();

    // Type label for selected polygon
    if (isSelectedPoly && pts.length >= 3) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const sc = this.worldToScreen(cx, cy);
      ctx.fillStyle = theme.text;
      ctx.font = this.fontSize(11) + ' monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(poly.type.toUpperCase(), sc.x, sc.y);
    }

    // Highlight hovered edge in point mode
    if (this.mode === 'point' && this.buildingPolygon.length === 0 && !this.draggingPoint) {
      const edgeHit = this.findEdgeAt(this.mouseWorld);
      if (edgeHit && edgeHit.polyIndex === index) {
        const a = pts[edgeHit.edgeIndex];
        const b = pts[(edgeHit.edgeIndex + 1) % pts.length];
        const sa = this.worldToScreen(a.x, a.y);
        const sb = this.worldToScreen(b.x, b.y);
        ctx.strokeStyle = theme.lineHover;
        ctx.lineWidth = theme.lineWidthSelected + 1;
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
      }
    }

    // Draw normals
    if (pts.length >= 3) {
      this.drawNormals(poly);
    }

    // Points (in point mode)
    if (this.mode === 'point') {
      for (let vi = 0; vi < pts.length; vi++) {
        const sp = this.worldToScreen(pts[vi].x, pts[vi].y);
        const isSelected = this.selectedPointPolyIndex === index && this.selectedPointIndex === vi;
        const isHovered = !isSelected && this.findPointAt(this.mouseWorld)?.polyIndex === index &&
                          this.findPointAt(this.mouseWorld)?.pointIndex === vi;

        ctx.beginPath();
        ctx.arc(sp.x, sp.y, theme.pointRadius, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? theme.pointSelected : (isHovered ? theme.pointHover : theme.point);
        ctx.fill();
      }
    }
  }

  private drawNormals(poly: Polygon): void {
    const ctx = this.ctx;
    const edgeNormals = computeEdgeNormals(poly);
    const vertexNormals = computeVertexNormals(poly, edgeNormals);
    const len = theme.normalLength;

    // Draw edge normals
    ctx.strokeStyle = theme.normalColor;
    ctx.lineWidth = theme.normalLineWidth;
    for (const en of edgeNormals) {
      const from = this.worldToScreen(en.mx, en.my);
      const to = this.worldToScreen(en.mx + en.nx * len, en.my + en.ny * len);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();

      this.drawArrowhead(to.x, to.y, en.nx, en.ny, 5);
    }

    // Draw vertex normals
    ctx.strokeStyle = theme.vertexNormalColor;
    ctx.lineWidth = theme.normalLineWidth;
    for (const vn of vertexNormals) {
      const vnLen = Math.sqrt(vn.nx * vn.nx + vn.ny * vn.ny);
      if (vnLen < 1e-8) continue;

      const displayNx = vn.nx;
      const displayNy = vn.ny;

      const from = this.worldToScreen(vn.x, vn.y);
      const to = this.worldToScreen(vn.x + displayNx * len, vn.y + displayNy * len);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();

      this.drawArrowhead(to.x, to.y, displayNx, displayNy, 5);
    }
  }

  private drawArrowhead(tipX: number, tipY: number, dirX: number, dirY: number, size: number): void {
    const ctx = this.ctx;
    const ax = -dirX * size - dirY * size * 0.5;
    const ay = -dirY * size + dirX * size * 0.5;
    const bx = -dirX * size + dirY * size * 0.5;
    const by = -dirY * size - dirX * size * 0.5;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + ax, tipY + ay);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + bx, tipY + by);
    ctx.stroke();
  }

  private drawBuildingPolygon(): void {
    const ctx = this.ctx;
    const pts = this.buildingPolygon;

    ctx.strokeStyle = theme.previewLine;
    ctx.lineWidth = theme.lineWidth;
    ctx.beginPath();
    const s0 = this.worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = this.worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    const snapped = snapToGrid(this.mouseWorld);
    const sm = this.worldToScreen(snapped.x, snapped.y);
    ctx.lineTo(sm.x, sm.y);
    ctx.stroke();

    // Points
    for (let i = 0; i < pts.length; i++) {
      const sp = this.worldToScreen(pts[i].x, pts[i].y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, theme.pointRadius, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? theme.firstPointHighlight : theme.point;
      ctx.fill();
    }

    // Highlight first point if close enough to close
    if (pts.length >= 3) {
      const first = pts[0];
      if (dist(snapped, first) <= theme.firstPointCloseRadius) {
        const sf = this.worldToScreen(first.x, first.y);
        ctx.beginPath();
        ctx.arc(sf.x, sf.y, theme.firstPointCloseRadius, 0, Math.PI * 2);
        ctx.strokeStyle = theme.firstPointHighlight;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  private drawPath(path: Path, index: number): void {
    const ctx = this.ctx;
    const pts = path.points;
    if (pts.length < 1) return;

    const isSelected = this.mode === 'world' && this.selectedPathIndex === index;
    const isExtending = this.mode === 'world' && this.extendingPath && this.selectedPathIndex === index;

    // Draw lines
    if (pts.length >= 2) {
      ctx.strokeStyle = (isSelected || isExtending) ? theme.pathColorSelected : theme.pathColor;
      ctx.lineWidth = theme.pathLineWidth;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const s0 = this.worldToScreen(pts[0].x, pts[0].y);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const s = this.worldToScreen(pts[i].x, pts[i].y);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Highlight hovered segment in world mode (when not building/extending)
    if (this.mode === 'world' && !this.draggingPathPoint && !this.draggingPath &&
        this.buildingPath.length === 0 && !this.extendingPath) {
      const segHit = this.findPathSegmentAt(this.mouseWorld);
      if (segHit && segHit.pathIndex === index) {
        const a = pts[segHit.segmentIndex];
        const b = pts[segHit.segmentIndex + 1];
        const sa = this.worldToScreen(a.x, a.y);
        const sb = this.worldToScreen(b.x, b.y);
        ctx.strokeStyle = theme.lineHover;
        ctx.lineWidth = theme.pathLineWidth + 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw points
    if (this.mode === 'world') {
      for (let vi = 0; vi < pts.length; vi++) {
        const sp = this.worldToScreen(pts[vi].x, pts[vi].y);
        const isSelectedPt = isSelected && this.selectedPathPointIndex === vi;
        const isHovered = !isSelectedPt && this.buildingPath.length === 0 && !this.extendingPath &&
                          this.findPathPointAt(this.mouseWorld)?.pathIndex === index &&
                          this.findPathPointAt(this.mouseWorld)?.pointIndex === vi;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, theme.pathPointRadius, 0, Math.PI * 2);
        ctx.fillStyle = isSelectedPt ? theme.pointSelected :
                        isHovered ? theme.pointHover :
                        (isSelected ? theme.pathColorSelected : theme.pathColor);
        ctx.fill();
      }
    } else {
      // In non-world modes, draw points without hover/selection
      for (let vi = 0; vi < pts.length; vi++) {
        const sp = this.worldToScreen(pts[vi].x, pts[vi].y);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, theme.pathPointRadius, 0, Math.PI * 2);
        ctx.fillStyle = theme.pathColor;
        ctx.fill();
      }
    }

    // Draw travel times along segments (skip if extending — we draw with preview instead)
    if (pts.length >= 2 && !isExtending) {
      this.drawPathTimes(pts);
    }
  }

  private drawPathTimes(pts: Point[]): void {
    const ctx = this.ctx;
    const cumulativeTimes = computePathCumulativeTimes(pts);
    const totalTime = cumulativeTimes[cumulativeTimes.length - 1];

    ctx.font = this.fontSize(24) + ' monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = theme.pathTimeColor;

    // Draw cumulative time at each point
    for (let i = 0; i < pts.length; i++) {
      const sp = this.worldToScreen(pts[i].x, pts[i].y);
      ctx.fillText(formatTime(cumulativeTimes[i]), sp.x, sp.y - 8);
    }

    // Draw total time at midpoint of path
    if (pts.length >= 2) {
      const midIdx = Math.floor(pts.length / 2);
      const midPt = pts[midIdx];
      const sp = this.worldToScreen(midPt.x, midPt.y);
      ctx.font = this.fontSize(24) + ' monospace';
      ctx.textBaseline = 'top';
      ctx.fillText('Total: ' + formatTime(totalTime), sp.x, sp.y + 10);
    }
  }

  private drawBuildingPath(): void {
    const ctx = this.ctx;
    const pts = this.buildingPath;

    // Draw lines
    ctx.strokeStyle = theme.pathColor;
    ctx.lineWidth = theme.pathLineWidth;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const s0 = this.worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = this.worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    // Preview line to mouse
    const snapped = snapToGrid(this.mouseWorld);
    const sm = this.worldToScreen(snapped.x, snapped.y);
    ctx.lineTo(sm.x, sm.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw points
    for (let i = 0; i < pts.length; i++) {
      const sp = this.worldToScreen(pts[i].x, pts[i].y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, theme.pathPointRadius, 0, Math.PI * 2);
      ctx.fillStyle = theme.pathColor;
      ctx.fill();
    }

    // Draw travel times including preview segment
    const previewPts = [...pts, snapped];
    if (previewPts.length >= 2) {
      this.drawPathTimes(previewPts);
    }
  }

  private drawExtendingPathPreview(): void {
    if (this.selectedPathIndex < 0) return;
    const path = this.state.paths[this.selectedPathIndex];
    if (!path || path.points.length === 0) return;

    const ctx = this.ctx;
    const lastPt = path.points[path.points.length - 1];
    const snapped = snapToGrid(this.mouseWorld);

    // Draw preview line from last point to mouse
    ctx.strokeStyle = theme.pathColorSelected;
    ctx.lineWidth = theme.pathLineWidth;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const sLast = this.worldToScreen(lastPt.x, lastPt.y);
    const sm = this.worldToScreen(snapped.x, snapped.y);
    ctx.moveTo(sLast.x, sLast.y);
    ctx.lineTo(sm.x, sm.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw travel times for the full path including the preview point
    const previewPts = [...path.points, snapped];
    if (previewPts.length >= 2) {
      this.drawPathTimes(previewPts);
    }
  }

  private drawArtefact(artefact: EditorArtefact, index: number): void {
    const ctx = this.ctx;
    const sp = this.worldToScreen(artefact.x, artefact.y);
    const isSelected = this.mode === 'artefact' && this.selectedArtefactIndex === index;
    const color = theme.artefactColors[artefact.type] || '#ffffff';

    // Draw circle
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, theme.artefactRadius, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? theme.pointSelected : color;
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // Draw type label
    ctx.fillStyle = '#000000';
    ctx.font = this.fontSize(9) + ' monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = artefact.type.charAt(0).toUpperCase();
    ctx.fillText(label, sp.x, sp.y);

    // Draw type name below when selected
    if (isSelected) {
      ctx.fillStyle = color;
      ctx.font = this.fontSize(10) + ' monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(artefact.type, sp.x, sp.y + theme.artefactRadius + 4);
    }
  }

  private drawHUD(): void {
    const ctx = this.ctx;

    // Mode indicator
    ctx.fillStyle = theme.modeIndicator;
    ctx.font = this.fontSize(24) + ' monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let modeText = '';
    switch (this.mode) {
      case 'polygon': modeText = 'POLYGON MODE (v)'; break;
      case 'point': modeText = 'POINT MODE (a)'; break;
      case 'world': modeText = 'WORLD MODE (w)'; break;
      case 'artefact': modeText = 'ARTEFACT MODE (t)'; break;
    }
    ctx.fillText(modeText, 12, 12);

    // Version indicator
    ctx.fillStyle = theme.versionIndicatorColor;
    ctx.fillText(`Version: ${this.currentVersionIndex + 1} / ${this.state.versions.length}`, 12, 32);

    let yOffset = 52;

    // Building polygon point count
    if (this.buildingPolygon.length > 0) {
      ctx.fillStyle = theme.text;
      ctx.fillText(`Building polygon: ${this.buildingPolygon.length} points`, 12, yOffset);
      yOffset += 20;
    }

    // Building path point count
    if (this.buildingPath.length > 0) {
      ctx.fillStyle = theme.text;
      ctx.fillText(`Building path: ${this.buildingPath.length} points (Enter to finish)`, 12, yOffset);
      yOffset += 20;
    }

    // Extending path indicator
    if (this.extendingPath) {
      ctx.fillStyle = theme.modeIndicator;
      ctx.fillText(`Extending path (click to add, Enter/Esc to finish)`, 12, yOffset);
      yOffset += 20;
    }

    // Scaling indicator
    if (this.scalingPolygon) {
      ctx.fillStyle = theme.modeIndicator;
      ctx.fillText('SCALING (move mouse left/right)', 12, yOffset);
      yOffset += 20;
    }

    // Current artefact type in artefact mode
    if (this.mode === 'artefact') {
      ctx.fillStyle = theme.artefactColors[this.currentArtefactType];
      ctx.fillText(`Artefact type: ${this.currentArtefactType} (1-6 to change)`, 12, yOffset);
      yOffset += 20;
    }

    // Selected polygon type in polygon mode
    if (this.mode === 'polygon' && this.selectedPolygonIndex >= 0) {
      const poly = this.currentVersion.polygons[this.selectedPolygonIndex];
      ctx.fillStyle = theme.text;
      ctx.fillText(`Polygon type: ${poly.type} (1-3 to change, s to scale)`, 12, yOffset);
      yOffset += 20;
    }

    // Clipboard indicator in polygon mode
    if (this.mode === 'polygon' && this.clipboardPolygon) {
      ctx.fillStyle = theme.text;
      ctx.fillText(`Clipboard: ${this.clipboardPolygon.type} polygon (${this.clipboardPolygon.points.length} pts)`, 12, yOffset);
      yOffset += 20;
    }

    // Selected path info in world mode
    if (this.mode === 'world' && this.selectedPathIndex >= 0 && !this.extendingPath) {
      const path = this.state.paths[this.selectedPathIndex];
      ctx.fillStyle = theme.text;
      ctx.fillText(`Path: ${path.points.length} pts | +: extend | Del: delete point/path`, 12, yOffset);
      yOffset += 20;
    }

    // Help text
    ctx.fillStyle = theme.text;
    ctx.font = this.fontSize(24) + ' monospace';
    ctx.textAlign = 'right';
    const helpLines = [
      'v: polygon | a: point | w: world | t: artefact | Esc: deselect',
      'Backspace: delete | Ctrl+Z: undo | Ctrl+Shift+Z: redo',
      'Ctrl+S: export JSON | Ctrl+L: load JSON | drag & drop .json',
      'Space+move / Middle-click: pan',
    ];

    if (this.mode === 'world') {
      helpLines.push('1-9: switch version | +: new version (or extend path) | [: insert version');
      helpLines.push('Click to build path | Enter: finish | Click point: select/drag');
      helpLines.push('Click segment: select path & drag | +: extend selected path');
    }
    if (this.mode === 'polygon') {
      helpLines.push('1: level | 2: solid | 3: floor | s: scale along bisectors');
      helpLines.push('Ctrl+C: copy | Ctrl+V: paste | Ctrl+D: duplicate');
    }
    if (this.mode === 'artefact') {
      helpLines.push('1: key | 2: exit | 3: delay | 4: decompress | 5: anchor | 6: compass | 7: start');
    }

    for (let i = 0; i < helpLines.length; i++) {
      ctx.fillText(helpLines[i], this.canvas.width - 12, 12 + i * 18);
    }

    // Polygon count & artefact count
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    const polys = this.currentVersion.polygons.length;
    const arts = this.state.artefacts.length;
    const paths = this.state.paths.length;
    ctx.fillText(`Polygons: ${polys} | Artefacts: ${arts} | Paths: ${paths}`, 12, this.canvas.height - 20);
  }
}

// ============================================================
// Bootstrap
// ============================================================

new Editor();
