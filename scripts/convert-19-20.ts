// -----------------------------------------------------------------------------
// A format-19 world as a format-21 one
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v21.json` beside each. Format 18 is read too: it is 19 without
// a bake.
//
// A version's layer is a transform about the world origin composed onto
// everything before it, and a keyframe's list is operations about points of
// the thing. There is no list that *is* a stack of layers, so this does not
// translate one into the other. It resolves the old world at every version —
// where each thing's frame is, how deep it is eroded, where its corners stand
// and how deep each is — and writes the fewest operations that put the new
// world in exactly those places:
//
//   scale  by the change in size along the thing's own axes, about its middle
//   skew   by the change in skew, about the same point
//   turn   by the change in angle, about the point the rest of the step keeps
//          still, so that it plays as a swing about the same point it did
//   move   whatever is left, usually nothing
//   erode  by the change in depth
//
// A corner's nudge is the same displacement in both, and goes over as it is. A
// footing is a stand. A group has no birth and no death in 20: its death is
// written onto everything it held, which is what the old world did with it. Then every thing is resolved again through `rig.ts` and
// compared with the old answer, and the file is only written if they agree.
//
// A frame the old chain sheared — turned, squashed, turned again — comes over
// exactly, as a skew. What cannot come over is one it mirrored, which is
// reported and written as the nearest frame. The bake is left out, since it was baked for the old
// motion: bake again once it is open.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { Affine, IDENTITY, compose, unplace } from '../packages/editor/src/affine';
import {
  Entry,
  Erode,
  Frame,
  Move,
  Op,
  REST,
  Rig,
  Timeline,
  framed,
  once,
  placed,
  played,
  stateAt,
  worldFrame,
} from '../packages/editor/src/rig';
import { enclosing } from '../packages/editor/src/types';
import type {
  Artefact,
  Group,
  Id,
  Path,
  Point,
  Polygon,
  Vertex,
  VertexId,
} from '../packages/editor/src/types';
import type { Saved, SavedEntry, SavedRig } from '../packages/editor/src/save';

// -----------------------------------------------------------------------------
// The old file
// -----------------------------------------------------------------------------

interface Transform {
  translation: Point
  rotation: number
  scale: { x: number, y: number }
  erosion: number
}

interface Edit {
  transform: Transform
  vertices: Map<VertexId, Point>
  depths: Map<VertexId, number>
}

interface Footing {
  frame: Affine
  local: Map<VertexId, Point>
  erosion: number
  depths: Map<VertexId, number>
}

/** A group as 18 and 19 wrote one, with a life of its own. */
type OldGroup = Group & { birth: number, death?: number | null };

interface Old {
  format: number
  tool: Saved['tool']
  figure?: Saved['figure']
  currentVersion: number
  selection: number[]
  artefacts?: number[]
  paths?: number[]
  settings: Saved['settings']
  view: Saved['view']
  world: {
    nextId: number
    polygons: [number, Polygon][]
    groups?: [number, OldGroup][]
    artefacts?: [number, { type: Artefact['type'], birth: number, death?: number | null, at: Point }][]
    paths?: [number, { birth?: number, death?: number | null, points: Point[] }][]
    start?: Saved['world']['start']
    versions: {
      name: string
      base: number | null
      visible: boolean
      edits: [Id, { transform: Transform, vertices: [VertexId, Point][], depths?: [VertexId, number][] }][]
      footings?: [Id, { frame: Affine, local: [VertexId, Point][], erosion: number, depths: [VertexId, number][] }][]
    }[]
  }
  baked?: string
}

/** One layer as a matrix: scale per axis, then turn, then move. */
function layer(t: Transform | undefined): Affine {
  if (t === undefined) return IDENTITY;

  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);

  return {
    a: c * t.scale.x,
    b: s * t.scale.x,
    c: -s * t.scale.y,
    d: c * t.scale.y,
    tx: t.translation.x,
    ty: t.translation.y,
  };
}

function inverse(m: Affine): Affine {
  const o = unplace(m, { x: 0, y: 0 });
  const x = unplace(m, { x: 1, y: 0 });
  const y = unplace(m, { x: 0, y: 1 });

  return { a: x.x - o.x, b: x.y - o.y, c: y.x - o.x, d: y.y - o.y, tx: o.x, ty: o.y };
}

// -----------------------------------------------------------------------------
// The conversion
// -----------------------------------------------------------------------------

interface Converted {
  file: Saved
  warnings: string[]
  /** The largest disagreement found when the new world was resolved again. */
  error: number
  /** Whether it disagreed anywhere it was expected to agree. */
  wrong: boolean
}

const TAU = 2 * Math.PI;

export function converted(old: Old): Converted {
  if (old.format !== 18 && old.format !== 19) {
    throw new Error(`format ${old.format}: this reads 18 and 19. Open it on master and save it again first`);
  }

  const warnings: string[] = [];
  const n = old.world.versions.length;

  old.world.versions.forEach((v, i) => {
    if (v.base !== (i === 0 ? null : i - 1)) throw new Error(`version ${i} forks from ${v.base}, and keyframes are a line`);
  });

  const edits = old.world.versions.map(v => new Map<Id, Edit>(v.edits.map(([id, e]) => [id, {
    transform: e.transform,
    vertices: new Map(e.vertices),
    depths: new Map(e.depths ?? []),
  }])));

  const footings = old.world.versions.map(v => new Map<Id, Footing>((v.footings ?? []).map(([id, f]) => [id, {
    frame: f.frame,
    local: new Map(f.local),
    erosion: f.erosion,
    depths: new Map(f.depths),
  }])));

  const polygons = new Map(old.world.polygons.map(([id, p]) => [id, { ...p, death: p.death ?? null }]));

  // With their lives, for reading the old world by. What is written has none.
  const groups = new Map((old.world.groups ?? []).map(([id, g]) => [id, { ...g, death: g.death ?? null }]));
  const artefacts = new Map<number, Artefact>((old.world.artefacts ?? []).map(([id, a]) => [id, {
    type: a.type,
    birth: a.birth,
    death: a.death ?? null,
    at: a.at,
  }]));
  const paths = new Map<number, Path>((old.world.paths ?? []).map(([id, p]) => [id, {
    birth: p.birth ?? 0,
    death: p.death ?? null,
    points: p.points,
  }]));

  const structure = { groups };

  // What 20 holds: the groups as structure alone, and each group's death
  // written onto everything under it — the earlier of the two, where a thing
  // had already gone. The old world took a thing out wherever anything holding
  // it was, and nothing in 20 does that on its own.
  const newGroups = new Map<number, Group>([...groups].map(([id, g]) => [id, { members: g.members, sealed: g.sealed }]));

  const handed = <T extends { death: number | null }>(id: Id, it: T): T => {
    let death = it.death;

    for (const g of enclosing(structure, id)) {
      const d = groups.get(g)!.death;

      if (d !== null && (death === null || d < death)) death = d;
    }

    return death === it.death ? it : { ...it, death };
  };

  const newPolygons = new Map([...polygons].map(([id, p]) => [id, handed(id, p)]));
  const newArtefacts = new Map([...artefacts].map(([id, a]) => [id, handed(id, a)]));
  const newPaths = new Map([...paths].map(([id, p]) => [id, handed(id, p)]));
  const lived = (id: Id) => polygons.get(id) ?? groups.get(id) ?? artefacts.get(id) ?? paths.get(id)!;
  const ids = [...polygons.keys(), ...groups.keys(), ...artefacts.keys(), ...paths.keys()];

  const bornAt = (id: Id, v: VertexId, k: number): boolean =>
    polygons.get(id)?.points.some(c => c.id === v && c.birth === k) === true;

  /** Whether it and everything holding it are still there at `k`. */
  const alive = (id: Id, k: number): boolean => {
    const own = lived(id);

    if (own.birth > k) return false;

    return [own.death, ...enclosing(structure, id).map(g => groups.get(g)!.death)]
      .every(d => d === null || d > k);
  };

  // --- The old world, resolved at every version ------------------------------

  interface Resolved19 {
    /** The frame in world units, from the thing's birth. Before it, nothing —
     * and the identity for a group, which holds its members regardless. */
    world: (Affine | undefined)[]
    erosion: number[]
    /** Corners in the thing's own frame, standing ones only. */
    corners: Map<VertexId, Point>[]
    depths: Map<VertexId, number>[]
    /** Where a footing restarted it, by version. */
    stood: (Footing | undefined)[]
  }

  const held = (k: number, id: Id): Affine => enclosing(structure, id).reduce(
    (m, g) => compose(layer(edits[k].get(g)?.transform), m),
    IDENTITY,
  );

  const old19 = new Map<Id, Resolved19>();

  for (const id of ids) {
    const thing = lived(id);
    const points: readonly Vertex[] = polygons.get(id)?.points ?? [];
    const group = groups.has(id);

    const out: Resolved19 = { world: [], erosion: [], corners: [], depths: [], stood: [] };
    let m: Affine | undefined = undefined;
    let erosion = 0;
    let over = new Map<VertexId, number>();
    let at = new Map<VertexId, Point>();
    let since = 0;
    let kept: ReadonlySet<VertexId> | null = null;

    for (let k = 0; k < n; k++) {
      const edit = edits[k].get(id);
      const footing = thing.birth <= k && (!polygons.has(id) || alive(id, k)) ? footings[k].get(id) : undefined;

      // A group's depth is read over the whole chain rather than from its
      // birth, which is what `depths` in the old scene did.
      if (k < thing.birth) {
        if (group && edit !== undefined) erosion = edit.transform.erosion;

        out.world.push(group ? IDENTITY : undefined);
        out.erosion.push(erosion);
        out.corners.push(new Map());
        out.depths.push(new Map());
        out.stood.push(undefined);
        continue;
      }

      m ??= IDENTITY;

      if (footing !== undefined) {
        m = footing.frame;
        erosion = footing.erosion;
        over = new Map(footing.depths);
        at = new Map(footing.local);
        since = k;
        kept = new Set(footing.local.keys());
      }

      for (const c of points) {
        if (c.birth === k) at.set(c.id, { ...c.at });
      }

      if (edit !== undefined) {
        for (const [v, d] of edit.vertices) {
          const p = at.get(v);

          if (p !== undefined) at.set(v, { x: p.x + d.x, y: p.y + d.y });
        }

        m = compose(layer(edit.transform), m);
        erosion = edit.transform.erosion;
        over = new Map(edit.depths);
      }

      m = compose(held(k, id), m);

      const standing = new Map<VertexId, Point>();
      const deep = new Map<VertexId, number>();

      for (const c of points) {
        const born = (c.birth >= since && c.birth <= k) || kept?.has(c.id) === true;
        const gone = c.death !== null && c.death >= since && c.death <= k;

        if (!born || gone) continue;

        standing.set(c.id, at.get(c.id) ?? { ...c.at });

        const d = over.get(c.id) ?? 0;

        if (d !== 0) deep.set(c.id, d);
      }

      out.world.push(m);
      out.erosion.push(erosion);
      out.corners.push(standing);
      out.depths.push(deep);
      out.stood.push(footing);
    }

    old19.set(id, out);
  }

  // --- The frames each thing has in whatever holds it ------------------------

  const parentOf = new Map<Id, Id>();

  for (const [g, it] of groups) for (const m of it.members) parentOf.set(m, g);

  const outer = (id: Id, k: number): Affine => {
    const up = parentOf.get(id);

    return up === undefined || k < 0 ? IDENTITY : old19.get(up)!.world[k] ?? IDENTITY;
  };

  const sheared = new Set<string>();

  /** A matrix as the frame a keyframe can hold, or the nearest one where it mirrors. */
  const asFrame = (id: Id, k: number, m: Affine): Frame => {
    const f = framed(m);

    if (f !== null) return f;

    const key = `${id}@${k}`;

    if (!sheared.has(key)) {
      sheared.add(key);
      warnings.push(`#${id} at v${k} is mirrored in its holder, which no frame can be: written as the nearest one`);
    }

    const x = Math.hypot(m.a, m.b);
    const angle = Math.atan2(m.b, m.a);

    return { t: { x: m.tx, y: m.ty }, angle, skew: 0, scale: { x, y: Math.abs((m.a * m.d - m.b * m.c) / x) } };
  };

  /** `angle` moved by whole turns to within half of one of `near`. */
  const unwrapped = (angle: number, near: number): number => angle + TAU * Math.round((near - angle) / TAU);

  /** The middle of a thing in its own frame: what a gesture paints. */
  const middle = (id: Id, k: number, frames: Map<Id, (Frame | undefined)[]>): Point => {
    const pts: Point[] = [];

    if (polygons.has(id)) {
      pts.push(...(k < 0 ? [] : old19.get(id)!.corners[k].values()));

      if (pts.length === 0) pts.push(...polygons.get(id)!.points.filter(c => c.birth <= Math.max(k, 0)).map(c => c.at));
    }
    else if (artefacts.has(id)) {
      pts.push(artefacts.get(id)!.at);
    }
    else if (paths.has(id)) {
      pts.push(...paths.get(id)!.points);
    }
    else {
      for (const m of groups.get(id)!.members) {
        if (!alive(m, Math.max(k, 0)) && !alive(m, k + 1)) continue;

        pts.push(placed(frames.get(m)?.[k] ?? REST, middle(m, k, frames)));
      }
    }

    if (pts.length === 0) return { x: 0, y: 0 };

    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);

    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  };

  // --- Writing the operations ------------------------------------------------

  const rigs = new Map<Id, Rig>();

  /** The frame each thing is actually left in by what has been written, by
   * version: what the next keyframe's operations start from. */
  const frames = new Map<Id, (Frame | undefined)[]>();

  // Innermost first, so that a group's middle can be read off the frames its
  // members have already been given.
  const depthOf = (id: Id) => enclosing(structure, id).length;
  const order = [...ids].sort((a, b) => depthOf(b) - depthOf(a));

  for (const id of order) {
    const thing = lived(id);
    const r19 = old19.get(id)!;
    const group = groups.has(id);

    const keys = new Map<number, Entry[]>();
    const nudges = new Map<VertexId, Map<number, Entry<Move>>>();
    const depths = new Map<VertexId, Map<number, Entry<Erode>>>();
    const mine: (Frame | undefined)[] = [];

    frames.set(id, mine);

    let cur: Frame = REST;
    let erosion = 0;
    let deep = new Map<VertexId, number>();

    const add = (k: number, op: Op): void => {
      keys.set(k, [...(keys.get(k) ?? []), once(op)]);
    };

    for (let k = 0; k < n; k++) {
      if (k < thing.birth) {
        mine.push(group ? REST : undefined);

        if (r19.erosion[k] !== erosion) {
          add(k, { kind: 'erode', by: r19.erosion[k] - erosion });
          erosion = r19.erosion[k];
        }

        continue;
      }

      const footing = r19.stood[k];
      let start = cur;

      if (footing !== undefined) {
        const f = asFrame(id, k, compose(inverse(outer(id, k - 1)), footing.frame));

        start = { ...f, angle: unwrapped(f.angle, cur.angle) };
        erosion = footing.erosion;
        deep = new Map(footing.depths);

        add(k, {
          kind: 'stand',
          frame: start,
          erosion: footing.erosion,
          // Less any corner born here, which the old chain put at rest over
          // whatever the footing said.
          corners: new Map([...footing.local].filter(([v]) => !bornAt(id, v, k))),
          depths: new Map(footing.depths),
          radius: 0,
          amplitude: 0,
          radii: new Map(),
          amplitudes: new Map(),
        });
      }

      const target = asFrame(id, k, compose(inverse(outer(id, k)), r19.world[k]!));
      const ref = middle(id, k - 1 < thing.birth ? thing.birth : k - 1, frames);
      let f = start;

      // Scale first, along the thing's own axes about its middle: sizes along
      // them multiply, whatever turns after.
      const by = { x: target.scale.x / f.scale.x, y: target.scale.y / f.scale.y };

      if (Math.abs(by.x - 1) > 1e-12 || Math.abs(by.y - 1) > 1e-12) {
        const op: Op = { kind: 'scale', by, ref, shift: { x: 0, y: 0 }, along: f.angle, lean: f.skew };

        add(k, op);
        f = played(f, op);
      }

      // Then the skew, about the same point, where the holder shears it.
      if (Math.abs(target.skew - f.skew) > 1e-12) {
        const op: Op = { kind: 'skew', by: target.skew - f.skew, ref, shift: { x: 0, y: 0 }, along: f.angle };

        add(k, op);
        f = played(f, op);
      }

      // Then the turn, the long way round where the layer went the long way.
      const turn = edits[k].get(id)?.transform.rotation ?? 0;
      let angle = target.angle - f.angle;

      angle = unwrapped(angle, turn);

      if (Math.abs(angle) > 1e-12) {
        // The point this turn and the move after it keep still, where there is
        // one: turned about it, nothing is left over to move.
        const p = placed(f, ref);
        const c = Math.cos(angle), s = Math.sin(angle);
        const rx = target.t.x - (c * f.t.x - s * f.t.y);
        const ry = target.t.y - (s * f.t.x + c * f.t.y);
        const a = 1 - c, det = a * a + s * s;

        const about = det < 1e-12
          ? { x: 0, y: 0 }
          : { x: (a * rx - s * ry) / det - p.x, y: (s * rx + a * ry) / det - p.y };

        const op: Op = { kind: 'turn', angle, ref, about };

        add(k, op);
        f = played(f, op);
      }

      const move = { x: target.t.x - f.t.x, y: target.t.y - f.t.y };

      if (Math.hypot(move.x, move.y) > 1e-9 * Math.max(1, Math.abs(target.t.x), Math.abs(target.t.y))) {
        const op: Op = { kind: 'move', by: move };

        add(k, op);
        f = played(f, op);
      }

      cur = f;
      mine.push(cur);

      if (r19.erosion[k] !== erosion) {
        add(k, { kind: 'erode', by: r19.erosion[k] - erosion });
        erosion = r19.erosion[k];
      }

      // A nudge is the same displacement of the same corner in the same frame.
      const edit = edits[k].get(id);
      const standing = r19.corners[k];

      for (const [v, d] of edit?.vertices ?? []) {
        if (!standing.has(v) || (d.x === 0 && d.y === 0)) continue;

        nudges.set(v, (nudges.get(v) ?? new Map()).set(k, once<Move>({ kind: 'move', by: d })));
      }

      // Depths on single corners were stated outright at every version that
      // wrote an edit, and are added to here.
      for (const v of standing.keys()) {
        const was = bornAt(id, v, k) ? 0 : deep.get(v) ?? 0;
        const now = r19.depths[k].get(v) ?? 0;

        if (now !== was) depths.set(v, (depths.get(v) ?? new Map()).set(k, once<Erode>({ kind: 'erode', by: now - was })));

        deep.set(v, now);
      }
    }

    if (keys.size > 0 || nudges.size > 0 || depths.size > 0) rigs.set(id, { keys, nudges, depths, rounds: new Map(), deforms: new Map() });
  }

  // --- Checking it -----------------------------------------------------------

  const keyframes = old.world.versions.map((v, i) => ({ id: i, name: v.name, visible: v.visible }));
  const tl: Timeline = { keyframes, rigs, polygons: newPolygons, groups: newGroups, artefacts: newArtefacts, paths: newPaths };
  let error = 0;
  let wrong = false;

  const miss = (what: string): void => {
    warnings.push(what);
    wrong = true;
  };

  const off = (what: string, e: number): void => {
    if (e > 1e-6) miss(`${what} is out by ${e.toExponential(2)}`);

    error = Math.max(error, e);
  };

  // Everything stands at exactly the keyframes it stood at: its own life, with
  // the deaths of what held it handed down.
  for (const [id, it] of [...newPolygons, ...newArtefacts, ...newPaths]) {
    for (let k = 0; k < n; k++) {
      const now = it.birth <= k && (it.death === null || it.death > k);

      if (now !== alive(id, k)) miss(`#${id} ${now ? 'stands' : 'is gone'} at v${k}, and ${now ? 'was gone' : 'stood'}`);
    }
  }

  for (const id of ids) {
    const r19 = old19.get(id)!;

    for (let k = 0; k < n; k++) {
      if (!alive(id, k)) continue;

      const a = r19.world[k]!;
      const b = worldFrame(tl, id, k);
      const size = Math.max(1, Math.abs(a.tx), Math.abs(a.ty));

      if (!sheared.has(`${id}@${k}`) && ![...enclosing(structure, id)].some(g => sheared.has(`${g}@${k}`))) {
        off(`#${id}'s frame at v${k}`, Math.max(
          Math.abs(a.a - b.a), Math.abs(a.b - b.b), Math.abs(a.c - b.c), Math.abs(a.d - b.d),
          Math.abs(a.tx - b.tx) / size, Math.abs(a.ty - b.ty) / size,
        ));
      }

      const state = stateAt(tl, id, k);

      off(`#${id}'s erosion at v${k}`, Math.abs(state.erosion - r19.erosion[k]));

      if (!polygons.has(id)) continue;

      const want = r19.corners[k];

      if (want.size !== state.corners.size) miss(`#${id} has ${state.corners.size} corners at v${k}, and had ${want.size}`);

      for (const [v, p] of want) {
        const q = state.corners.get(v);

        if (q === undefined) miss(`#${id}'s corner ${v} is missing at v${k}`);
        else off(`#${id}'s corner ${v} at v${k}`, Math.hypot(p.x - q.x, p.y - q.y));

        off(`#${id}'s corner ${v}'s depth at v${k}`, Math.abs((r19.depths[k].get(v) ?? 0) - (state.depths.get(v) ?? 0)));
      }
    }
  }

  const file: Saved = {
    format: 21,
    tool: old.tool,
    figure: old.figure ?? 'polyline',
    keyframe: old.currentVersion,
    selection: old.selection,
    artefacts: (old.artefacts ?? []).filter(id => artefacts.has(id)),
    paths: (old.paths ?? []).filter(id => paths.has(id)),
    settings: { gridSize: old.settings.gridSize, showGrid: old.settings.showGrid },
    view: old.view,
    world: {
      nextId: old.world.nextId,
      polygons: [...newPolygons],
      groups: [...newGroups],
      artefacts: [...newArtefacts],
      paths: [...newPaths],
      start: old.world.start ?? { at: { x: 0, y: 0 }, facing: 0 },
      keyframes,
      rigs: [...rigs].map(([id, rig]) => [id, savedRig(rig)]),
    },
  };

  return { file, warnings, error, wrong };
}

/** As `save.ts` writes one. */
function savedRig(rig: Rig): SavedRig {
  return {
    keys: [...rig.keys].map(([k, list]) => [k, list.map(savedEntry)]),
    nudges: [...rig.nudges].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedEntry(e)])]),
    depths: [...rig.depths].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedEntry(e)])]),
  };
}

function savedEntry(e: Entry): SavedEntry {
  const op = e.op.kind === 'stand'
    ? { ...e.op, corners: [...e.op.corners], depths: [...e.op.depths] }
    : e.op;

  return { op, times: e.times };
}

// -----------------------------------------------------------------------------
// The command
// -----------------------------------------------------------------------------

const inputs = process.argv.slice(2).filter(a => a !== '--');

if (inputs.length === 0) {
  console.error('usage: pnpm convert <world.json>...   (writes <world>.v21.json beside each)');
  process.exit(1);
}

let failed = false;

for (const path of inputs) {
  try {
    const { file, warnings, error, wrong } = converted(JSON.parse(readFileSync(path, 'utf8')) as Old);
    const out = path.replace(/(\.json)?$/, '.v21.json');

    for (const w of warnings) console.warn(`  ${path}: ${w}`);

    if (wrong) throw new Error('the converted world does not resolve to the old one, so nothing was written');

    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`${path} -> ${out}  (${file.world.rigs.length} timelines, agrees to ${error.toExponential(1)})`);
  }
  catch (e) {
    failed = true;
    console.error(`${path}: ${e instanceof Error ? e.message : e}`);
  }
}

process.exit(failed ? 1 : 0);
