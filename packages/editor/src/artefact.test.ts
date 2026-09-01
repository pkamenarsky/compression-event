import { describe, expect, test } from 'vitest';
import { artefactsDuring, bakeAll, replayed } from './bake';
import { artefactsShipped, shipped } from './export';
import { Point } from '@ce/game/world';

import {
  TOP,
  addArtefact,
  addPolygon,
  artefactsAt,
  artefactsIn,
  artefactsWithinBox,
  copied,
  editAt,
  grouped,
  hitArtefact,
  movedStart,
  pasted,
  placeAt,
  removeArtefacts,
  retypeArtefacts,
  shownAt,
  stamped,
  starting,
  START_ID,
  turnedStart,
  reachable,
  swallowed,
  ungrouped,
  withEdit,
} from './scene';
import { ARTEFACTS, Clipping, EMPTY_TRANSFORM, World, emptyWorld, within } from './types';

/** One artefact, put down at `v` and nowhere else. */
function dropped(v = 0, x = 10, y = 20): { world: World, id: number } {
  return addArtefact(emptyWorld(), 'key', { x, y }, v, TOP);
}

/** What a drag writes: a translation in that version's layer, replacing
 * whatever it held. The same call `draggingSelection` makes. */
function moved(world: World, v: number, ids: number[], by: Point): World {
  let out = world;

  for (const [id, edit] of starting(world, v, ids)) {
    out = withEdit(out, v, id, {
      ...edit,
      transform: {
        ...edit.transform,
        translation: {
          x: edit.transform.translation.x + by.x,
          y: edit.transform.translation.y + by.y,
        },
      },
    });
  }

  return out;
}

describe('an artefact is a point, and the versions do to it what they do', () => {
  test('it stands where it was put, from the version that put it there', () => {
    const { world, id } = dropped(2);

    expect(placeAt(world, id, 2)).toEqual({ x: 10, y: 20 });

    // A version cannot see what a later one did, which is the whole of what a
    // layer means here as much as it does for a polygon.
    expect(placeAt(world, id, 1)).toBeNull();
    expect(placeAt(world, id, 0)).toBeNull();
  });

  test('a version that says nothing leaves it where it was', () => {
    const { world, id } = dropped(0);

    expect(placeAt(world, id, 4)).toEqual({ x: 10, y: 20 });

    const shifted = moved(world, 2, [id], { x: 80, y: -20 });

    expect(placeAt(shifted, id, 1)).toEqual({ x: 10, y: 20 });
    expect(placeAt(shifted, id, 2)).toEqual({ x: 90, y: 0 });
    expect(placeAt(shifted, id, 4)).toEqual({ x: 90, y: 0 });
  });

  test('a move upstream is carried by everything downstream of it', () => {
    const { world, id } = dropped(0, 0, 0);
    const late = moved(world, 3, [id], { x: 0, y: 7 });
    const early = moved(late, 1, [id], { x: 100, y: 0 });

    expect(placeAt(early, id, 0)).toEqual({ x: 0, y: 0 });
    expect(placeAt(early, id, 3)).toEqual({ x: 100, y: 7 });
  });

  test('a turn about a pivot is a turn about that pivot, twice over', () => {
    // The worry this design answers. Two rotations about two different pivots
    // in one version compose into one transform of this family — a rotation
    // and whatever translation the two pivots left over — so the second does
    // not have to undo or re-read the first. It is what polygons have always
    // done, and an artefact is now doing it with them.
    const { world, id } = dropped(0, 1, 0);
    const edit = editAt(world, 0, id, 0);

    const quarter = (t: typeof edit.transform, p: Point) => {
      const dx = t.translation.x - p.x, dy = t.translation.y - p.y;

      return {
        ...t,
        rotation: t.rotation + Math.PI / 2,
        translation: { x: p.x - dy, y: p.y + dx },
      };
    };

    // About the origin, then about (1, 0): (1,0) → (0,1) → (0,-1).
    const once = quarter(EMPTY_TRANSFORM, { x: 0, y: 0 });
    const twice = quarter(once, { x: 1, y: 0 });
    const turned = withEdit(world, 0, id, {
      transform: twice,
      vertices: new Map(),
      depths: new Map(),
    });

    expect(placeAt(turned, id, 0)!.x).toBeCloseTo(0, 9);
    expect(placeAt(turned, id, 0)!.y).toBeCloseTo(-1, 9);
  });

  test('the type is one fact about it, not one per version', () => {
    const { world, id } = dropped(0);
    const shifted = moved(world, 2, [id], { x: 1, y: 1 });
    const typed = retypeArtefacts(shifted, [id], 'exit');

    expect(typed.artefacts.get(id)!.type).toEqual('exit');
    expect(artefactsAt(typed, 0)[0].type).toEqual('exit');
  });

  test('removing takes it out of every version at once', () => {
    const { world, id } = dropped(0);

    expect(artefactsAt(removeArtefacts(world, [id]), 4)).toEqual([]);
  });

  test('ids come off the world counter, so nothing can be confused for one', () => {
    const one = dropped(0);
    const two = addArtefact(one.world, 'exit', { x: 0, y: 0 }, 0, TOP);

    expect(two.id).not.toEqual(one.id);
    expect(two.world.nextId).toBeGreaterThan(two.id);
  });
});

describe('a group takes one with it, because it is a member like any other', () => {
  function room(): { world: World, artefact: number, group: number } {
    const drawn = addPolygon(emptyWorld(), 'level', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ], 0, TOP);

    const put = addArtefact(drawn.world, 'key', { x: 50, y: 50 }, 0, TOP);
    const made = grouped(put.world, 0, [drawn.id, put.id], TOP)!;

    return { world: made.world, artefact: put.id, group: made.id };
  }

  test('the group moves and the key goes with it, having written nothing', () => {
    const { world, artefact, group } = room();
    const shifted = moved(world, 1, [group], { x: 200, y: 0 });

    expect(placeAt(shifted, artefact, 0)).toEqual({ x: 50, y: 50 });
    expect(placeAt(shifted, artefact, 1)).toEqual({ x: 250, y: 50 });
    expect(shifted.artefacts.get(artefact)!.at).toEqual({ x: 50, y: 50 });
  });

  test('and turning the group swings it round, which is the whole point', () => {
    const { world, artefact, group } = room();
    const turned = withEdit(world, 1, group, {
      transform: { ...EMPTY_TRANSFORM, rotation: Math.PI / 2 },
      vertices: new Map(),
      depths: new Map(),
    });

    expect(placeAt(turned, artefact, 1)!.x).toBeCloseTo(-50, 9);
    expect(placeAt(turned, artefact, 1)!.y).toBeCloseTo(50, 9);
  });

  test('a gesture over the group reaches it, the way it reaches the rooms', () => {
    const { world, artefact, group } = room();

    expect(artefactsIn(world, [group])).toEqual([artefact]);
  });

  test('and taking the group apart leaves it where the group had put it', () => {
    const { world, artefact, group } = room();
    const shifted = moved(world, 1, [group], { x: 200, y: 0 });
    const apart = ungrouped(shifted, group)!;

    expect(placeAt(apart, artefact, 1)).toEqual({ x: 250, y: 50 });
    expect(placeAt(apart, artefact, 0)).toEqual({ x: 50, y: 50 });
  });

  test('deleting the group takes it, since leaving it would hang it in the air', () => {
    const { world, artefact, group } = room();
    const gone = new Set(within(world, group));

    expect(gone.has(artefact)).toBe(true);
  });

  test('and one inside a shut group is not pickable on its own', () => {
    // Drawn — the group's outline says nothing about where a key in it is —
    // but a click on it is a click on the group, and getting at it means going
    // in. The same rule the rooms inside follow.
    const { world, artefact, group } = room();

    expect(swallowed(world, artefact, [])).toBe(true);
    expect(swallowed(world, artefact, [group])).toBe(false);
    expect(reachable(world, artefact, null)).toBe(true);
    expect(reachable(world, artefact, group)).toBe(true);
  });

  test('one dropped inside an open group lands where the cursor put it', () => {
    // Read in the group's frame on the way in, so a group already turned does
    // not send the thing you just placed somewhere else.
    const { world, group } = room();
    const turned = withEdit(world, 0, group, {
      transform: { ...EMPTY_TRANSFORM, rotation: Math.PI / 2 },
      vertices: new Map(),
      depths: new Map(),
    });

    const put = addArtefact(turned, 'exit', { x: 10, y: 0 }, 0, {
      into: group,
      frame: { a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0 },
    });

    expect(placeAt(put.world, put.id, 0)!.x).toBeCloseTo(10, 9);
    expect(placeAt(put.world, put.id, 0)!.y).toBeCloseTo(0, 9);
  });
});

/** A key in a room, with the room's group turning a quarter turn at v1. */
function turningRoom(): { world: World, artefact: number, group: number } {
  const drawn = addPolygon(emptyWorld(), 'level', [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
  ], 0, TOP);

  const put = addArtefact(drawn.world, 'key', { x: 100, y: 0 }, 0, TOP);
  const made = grouped(put.world, 0, [drawn.id, put.id], TOP)!;

  const world = withEdit(made.world, 1, made.id, {
    transform: { ...EMPTY_TRANSFORM, rotation: Math.PI / 2 },
    vertices: new Map(),
    depths: new Map(),
  });

  return { world, artefact: put.id, group: made.id };
}

describe('a walk moves them on the walls’ clock', () => {
  test('half way across one span is half way between the two places', () => {
    const { world, id } = dropped(0, 0, 0);
    const shifted = moved(world, 1, [id], { x: 100, y: 40 });

    expect(artefactsDuring(shifted, 0, 1, 0)[0].at).toEqual({ x: 0, y: 0 });
    expect(artefactsDuring(shifted, 0, 1, 0.5)[0].at).toEqual({ x: 50, y: 20 });
    expect(artefactsDuring(shifted, 0, 1, 1)[0].at).toEqual({ x: 100, y: 40 });
  });

  test('a walk over two versions spends half its time on each', () => {
    // Per version rather than per distance, because that is how `replayed`
    // cuts the same `u`. A key crossing a room while the room is still is a
    // key that arrived before its floor did.
    const { world, id } = dropped(0, 0, 0);
    const a = moved(world, 1, [id], { x: 10, y: 0 });
    const b = moved(a, 2, [id], { x: 1000, y: 0 });

    expect(artefactsDuring(b, 0, 2, 0.25)[0].at.x).toBeCloseTo(5, 9);
    expect(artefactsDuring(b, 0, 2, 0.5)[0].at.x).toBeCloseTo(10, 9);
    expect(artefactsDuring(b, 0, 2, 0.75)[0].at.x).toBeCloseTo(510, 9);
  });

  test('and backwards is the same walk, read the other way', () => {
    const { world, id } = dropped(0, 0, 0);
    const shifted = moved(world, 1, [id], { x: 100, y: 0 });

    expect(artefactsDuring(shifted, 1, 0, 0)[0].at.x).toBeCloseTo(100, 9);
    expect(artefactsDuring(shifted, 1, 0, 0.25)[0].at.x).toBeCloseTo(75, 9);
    expect(artefactsDuring(shifted, 1, 0, 1)[0].at.x).toBeCloseTo(0, 9);
  });

  test('a turn goes round the arc, not across the chord', () => {
    // The layer is eased, not the place. Half a half-turn about the origin is
    // a quarter turn — (10, 0) to (0, 10) — where lerping the two ends would
    // have sent it through the origin and out the other side.
    const { world, id } = dropped(0, 10, 0);
    const turned = withEdit(world, 1, id, {
      transform: { ...EMPTY_TRANSFORM, rotation: Math.PI },
      vertices: new Map(),
      depths: new Map(),
    });

    expect(artefactsDuring(turned, 0, 1, 0.5)[0].at.x).toBeCloseTo(0, 9);
    expect(artefactsDuring(turned, 0, 1, 0.5)[0].at.y).toBeCloseTo(10, 9);
  });

  test('and a group turning carries it round with the room, in step', () => {
    // The whole reason this is not a lerp: the key and the wall it sits by are
    // being moved by the same layer, so they have to be eased the same way or
    // the key cuts the corner while the room goes round.
    const { world, artefact, group } = turningRoom();

    const half = artefactsDuring(world, 0, 1, 0.5)[0].at;

    // A quarter of the way round from (100, 0), about the origin.
    expect(half.x).toBeCloseTo(Math.SQRT1_2 * 100, 9);
    expect(half.y).toBeCloseTo(Math.SQRT1_2 * 100, 9);
  });

  test('a turn about a pivot swings about that pivot the whole way', () => {
    // `easing` holds the pivot still rather than easing the translation in a
    // straight line, which is what stops a turning thing swinging out on a
    // great arc and coming back. The walls get this; so does a key among them.
    const { world, id } = dropped(0, 2, 0);
    const turn = { x: 1, y: 0 };
    const spun = withEdit(world, 1, id, {
      transform: {
        ...EMPTY_TRANSFORM,
        rotation: Math.PI,
        translation: { x: 2 * turn.x, y: 2 * turn.y },
      },
      vertices: new Map(),
      depths: new Map(),
    });

    // Half way is a quarter turn about (1, 0): (2, 0) goes to (1, 1).
    const half = artefactsDuring(spun, 0, 1, 0.5)[0].at;

    expect(half.x).toBeCloseTo(1, 9);
    expect(half.y).toBeCloseTo(1, 9);

    // And every instant is exactly one unit from the pivot, which is what
    // going round rather than across means.
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = artefactsDuring(spun, 0, 1, u)[0].at;

      expect(Math.hypot(p.x - turn.x, p.y - turn.y)).toBeCloseTo(1, 9);
    }
  });

  test('walked backwards it retraces the same arc', () => {
    const { world, artefact } = turningRoom();

    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const there = artefactsDuring(world, 0, 1, u)[0].at;
      const back = artefactsDuring(world, 1, 0, 1 - u)[0].at;

      expect(back.x).toBeCloseTo(there.x, 9);
      expect(back.y).toBeCloseTo(there.y, 9);
    }

    expect(artefactsDuring(world, 1, 0, 1)[0].id).toEqual(artefact);
  });

  test('one that is not there yet appears where it is put, not sliding in', () => {
    const { world } = dropped(1, 60, 0);

    expect(artefactsDuring(world, 0, 1, 0)[0].at).toEqual({ x: 60, y: 0 });
    expect(artefactsDuring(world, 0, 1, 0.5)[0].at).toEqual({ x: 60, y: 0 });
  });

  test('a walk of no length is just the version', () => {
    const { world, id } = dropped(0);

    expect(artefactsDuring(world, 1, 1, 0.5)).toEqual(artefactsAt(world, 1));
    expect(placeAt(world, id, 1)).toEqual({ x: 10, y: 20 });
  });
});

describe('what a click and a marquee land on', () => {
  test('the last drawn is the first picked, since it is the one on top', () => {
    const one = dropped(0, 0, 0);
    const two = addArtefact(one.world, 'exit', { x: 1, y: 0 }, 0, TOP);
    const shown = artefactsAt(two.world, 0);

    expect(hitArtefact(shown, { x: 0.5, y: 0 }, 4)).toEqual(two.id);
    expect(hitArtefact(shown, { x: 0, y: 0 }, 0.1)).toEqual(one.id);
    expect(hitArtefact(shown, { x: 50, y: 50 }, 4)).toBeNull();
  });

  test('a box takes what is in it, whichever way it was dragged', () => {
    const one = dropped(0, 10, 10);
    const two = addArtefact(one.world, 'exit', { x: 90, y: 90 }, 0, TOP);
    const shown = artefactsAt(two.world, 0);

    expect(artefactsWithinBox(shown, { x: 0, y: 0 }, { x: 50, y: 50 })).toEqual([one.id]);
    expect(artefactsWithinBox(shown, { x: 50, y: 50 }, { x: 0, y: 0 })).toEqual([one.id]);
    expect(artefactsWithinBox(shown, { x: 100, y: 100 }, { x: 0, y: 0 })).toHaveLength(2);
  });

  test('and one not standing at this version is not there to be hit', () => {
    const { world } = dropped(3, 0, 0);

    expect(hitArtefact(artefactsAt(world, 0), { x: 0, y: 0 }, 4)).toBeNull();
    expect(hitArtefact(artefactsAt(world, 3), { x: 0, y: 0 }, 4)).not.toBeNull();
  });
});

describe('copying one takes what it goes on to do', () => {
  function clipped(): { world: World, id: number, clip: Clipping[] } {
    const { world, id } = dropped(0, 10, 20);
    const shifted = moved(world, 2, [id], { x: 100, y: 0 });

    return { world: shifted, id, clip: copied(shifted, 0, [id]) };
  }

  test('the copy version is where it stood, and the rest is what it had left', () => {
    const { clip } = clipped();

    expect(clip).toHaveLength(1);
    expect(clip[0].kind).toEqual('artefact');
    expect(clip[0]).toMatchObject({ type: 'key', at: { x: 10, y: 20 } });
  });

  test('pasted, it does from here what the original did from there', () => {
    const { world, clip } = clipped();
    const put = pasted(world, 1, clip, { x: 0, y: 0 }, TOP);
    const [made] = put.artefacts;

    expect(put.ids).toEqual([]);
    expect(placeAt(put.world, made, 1)).toEqual({ x: 10, y: 20 });

    // Its v2 landed in v3, the way a polygon's layers do.
    expect(placeAt(put.world, made, 2)).toEqual({ x: 10, y: 20 });
    expect(placeAt(put.world, made, 3)).toEqual({ x: 110, y: 20 });
  });

  test('the offset lands on the place and nowhere else', () => {
    const { world, clip } = clipped();
    const put = pasted(world, 0, clip, { x: 5, y: 5 }, TOP);
    const [made] = put.artefacts;

    expect(placeAt(put.world, made, 0)).toEqual({ x: 15, y: 25 });
    expect(placeAt(put.world, made, 2)).toEqual({ x: 115, y: 25 });
  });

  test('a stamp brings the thing and not its history', () => {
    const { world, clip } = clipped();
    const put = stamped(world, 0, clip, { x: 0, y: 0 }, TOP);
    const [made] = put.artefacts;

    expect(placeAt(put.world, made, 0)).toEqual({ x: 10, y: 20 });
    expect(placeAt(put.world, made, 2)).toEqual({ x: 10, y: 20 });
  });

  test('one not yet born at the copy version is not copied', () => {
    const { world, id } = dropped(3);

    expect(copied(world, 0, [id])).toEqual([]);
  });

  test('a mixed selection copies both, and both land in the open group', () => {
    const { world, id } = dropped(0, 0, 0);
    const drawn = addPolygon(world, 'level', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ], 0, TOP);

    const clip = copied(drawn.world, 0, [drawn.id, id]);

    expect(clip.map(c => c.kind)).toEqual(['polygon', 'artefact']);

    const put = pasted(drawn.world, 0, clip, { x: 1, y: 1 }, TOP);

    expect(put.ids).toHaveLength(1);
    expect(put.artefacts).toHaveLength(1);
    expect(put.world.polygons.size).toEqual(2);
    expect(put.world.artefacts.size).toEqual(2);
  });

  test('every kind the number keys can reach is a kind that survives a copy', () => {
    for (const type of ARTEFACTS) {
      const made = addArtefact(emptyWorld(), type, { x: 0, y: 0 }, 0, TOP);
      const put = pasted(made.world, 0, copied(made.world, 0, [made.id]), { x: 0, y: 0 }, TOP);

      expect(put.world.artefacts.get(put.artefacts[0])!.type).toEqual(type);
    }
  });
});

describe('the start is not one of them', () => {
  test('a new world has one, at the origin, and nothing takes it away', () => {
    expect(emptyWorld().start).toEqual({ at: { x: 0, y: 0 }, facing: 0 });
  });

  test('it stands in the same place at every version, whatever the layers say', () => {
    // The one thing that separates it from an artefact: a version's layer is
    // keyed by an id, and it has none, so there is nothing a version can say
    // about where the level begins.
    const drawn = addPolygon(emptyWorld(), 'level', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ], 0, TOP);

    const world = movedStart(
      withEdit(drawn.world, 1, drawn.id, {
        transform: { ...EMPTY_TRANSFORM, translation: { x: 500, y: 500 } },
        vertices: new Map(),
        depths: new Map(),
      }),
      { x: 12, y: 34 },
    );

    for (let v = 0; v < world.versions.length; v++) {
      expect(shownAt(world, v).filter(it => it.type === 'start')).toEqual([
        { id: START_ID, type: 'start', at: { x: 12, y: 34 }, facing: 0 },
      ]);
    }
  });

  test('it is what the level ships as its start, and no artefact is one', () => {
    const world = turnedStart(movedStart(emptyWorld(), { x: 5, y: 6 }), 1.25);
    const put = addArtefact(world, 'key', { x: 1, y: 2 }, 0, TOP);

    expect(shipped(put.world, { spans: new Map(), progress: null }).start)
      .toEqual({ at: { x: 5, y: 6 }, facing: 1.25 });
    expect(artefactsShipped(put.world).map(it => it.type)).toEqual(['key']);
  });
});

describe('and it keeps step with the walls it stands among', () => {
  /** The bake, built the way the editor builds it. */
  function baked(world: World) {
    const g = bakeAll(world);

    let step = g.next();

    while (!step.done) step = g.next();

    return { spans: step.value, progress: null };
  }

  test('a key on a corner is on that corner at every instant of the walk', () => {
    // The real requirement, and the one a lerp failed: the two are moved by
    // one layer, so what the shader does to the wall and what the canvas does
    // to the key have to be the same thing. Anything else and the key slides
    // off the corner it was placed on, worst in the middle of the turn.
    const corner = { x: 200, y: 0 };

    const drawn = addPolygon(emptyWorld(), 'level', [
      { x: 0, y: 0 },
      corner,
      { x: 200, y: 200 },
    ], 0, TOP);

    const put = addArtefact(drawn.world, 'anchor', corner, 0, TOP);
    const made = grouped(put.world, 0, [drawn.id, put.id], TOP)!;

    const world = withEdit(made.world, 1, made.id, {
      transform: {
        ...EMPTY_TRANSFORM,
        rotation: Math.PI / 3,
        translation: { x: 40, y: -25 },
        scale: { x: 1.4, y: 0.8 },
      },
      vertices: new Map(),
      depths: new Map(),
    });

    const bake = baked(world);

    for (const u of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
      const here = artefactsDuring(world, 0, 1, u)[0].at;
      const wall = replayed(bake, world, 0, 1, u)!;

      // The nearest point the outline has to it, which should be the corner
      // itself — the walls are drawn from the buffers and this from the world,
      // so agreeing at all is the thing being checked.
      const near = Math.min(...wall.flatMap(r =>
        r.points.map(p => Math.hypot(p.x - here.x, p.y - here.y))));

      expect(near).toBeCloseTo(0, 6);
    }
  });
});
