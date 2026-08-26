import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';

import {
  addArtefact,
  addPolygon,
  artefactsAt,
  artefactsDuring,
  artefactsWithinBox,
  hitArtefact,
  movedArtefacts,
  placeAt,
  startingArtefacts,
  removeArtefacts,
  retypeArtefacts,
} from './scene';
import {
  ARTEFACTS,
  Clipping,
  EMPTY_TRANSFORM,
  World,
  emptyWorld,
} from './types';
import { TOP, affine, copied, pasted, place, stamped } from './scene';

/** One artefact, put down at `v` and nowhere else. */
function dropped(v = 0, x = 10, y = 20): { world: World, id: number } {
  return addArtefact(emptyWorld(), 'key', { x, y }, v);
}

describe('an artefact is a place, and its versions are the places', () => {
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

    const moved = movedArtefacts(world, [id], 2, { x: 80, y: -20 });

    expect(placeAt(moved, id, 1)).toEqual({ x: 10, y: 20 });
    expect(placeAt(moved, id, 2)).toEqual({ x: 90, y: 0 });
    expect(placeAt(moved, id, 4)).toEqual({ x: 90, y: 0 });
  });

  test('a move upstream is carried by everything downstream of it', () => {
    // Which is the whole reason a layer holds movement rather than position.
    // Nudge v1 and v3 goes with it, because v3 says what it does rather than
    // where the thing is — the same thing a transform written at v1 does to a
    // polygon that is turned again at v3.
    const { world, id } = dropped(0, 0, 0);
    const late = movedArtefacts(world, [id], 3, { x: 0, y: 7 });
    const early = movedArtefacts(late, [id], 1, { x: 100, y: 0 });

    expect(placeAt(early, id, 0)).toEqual({ x: 0, y: 0 });
    expect(placeAt(early, id, 3)).toEqual({ x: 100, y: 7 });
  });

  test('a move replaces the one that version held, so a drag cannot drift', () => {
    // Two drags at one version are the second drag, not both — `startingArtefacts`
    // hands over what the layer holds so the gesture recomputes from there.
    const { world, id } = dropped(0);
    const once = movedArtefacts(world, [id], 1, { x: 5, y: 0 });

    expect(startingArtefacts(once, 1, [id]).get(id)).toEqual({ x: 5, y: 0 });
    expect(placeAt(movedArtefacts(world, [id], 1, { x: 5, y: 0 }), id, 1))
      .toEqual({ x: 15, y: 20 });

    // The second drag starts from where the first left the layer, so writing
    // its own total replaces rather than stacks.
    expect(world.artefacts.get(id)!.at.size).toEqual(1);
  });

  test('moving one at a version it is not at yet does nothing', () => {
    const { world, id } = dropped(3);

    expect(movedArtefacts(world, [id], 1, { x: 9, y: 9 })).toEqual(world);
  });

  test('the type is one fact about it, not one per version', () => {
    // Which is why it is a field rather than another map. A key that becomes an
    // exit half way through a level is a different thing, not the same thing
    // later, and nothing yet wants to say it.
    const { world, id } = dropped(0);
    const moved = movedArtefacts(world, [id], 2, { x: 1, y: 1 });
    const typed = retypeArtefacts(moved, [id], 'exit');

    expect(typed.artefacts.get(id)!.type).toEqual('exit');
    expect(artefactsAt(typed, 0)[0].type).toEqual('exit');
  });

  test('removing takes it out of every version at once', () => {
    const { world, id } = dropped(0);

    expect(artefactsAt(removeArtefacts(world, [id]), 4)).toEqual([]);
  });

  test('ids come off the world counter, so nothing can be confused for one', () => {
    const one = dropped(0);
    const two = addArtefact(one.world, 'exit', { x: 0, y: 0 }, 0);

    expect(two.id).not.toEqual(one.id);
    expect(two.world.nextId).toBeGreaterThan(two.id);
  });
});

describe('a walk moves them in straight lines, on the walls’ clock', () => {
  test('half way across one span is half way between the two places', () => {
    const { world, id } = dropped(0, 0, 0);
    const moved = movedArtefacts(world, [id], 1, { x: 100, y: 40 });

    expect(artefactsDuring(moved, 0, 1, 0)[0].at).toEqual({ x: 0, y: 0 });
    expect(artefactsDuring(moved, 0, 1, 0.5)[0].at).toEqual({ x: 50, y: 20 });
    expect(artefactsDuring(moved, 0, 1, 1)[0].at).toEqual({ x: 100, y: 40 });
  });

  test('a walk over two versions spends half its time on each', () => {
    // Per version rather than per distance, because that is how `replayed`
    // cuts the same `u`. A key crossing a room while the room is still is a
    // key that arrived before its floor did.
    const { world, id } = dropped(0, 0, 0);
    const a = movedArtefacts(world, [id], 1, { x: 10, y: 0 });
    const b = movedArtefacts(a, [id], 2, { x: 1000, y: 0 });

    expect(artefactsDuring(b, 0, 2, 0.25)[0].at.x).toBeCloseTo(5, 9);
    expect(artefactsDuring(b, 0, 2, 0.5)[0].at.x).toBeCloseTo(10, 9);
    expect(artefactsDuring(b, 0, 2, 0.75)[0].at.x).toBeCloseTo(510, 9);
  });

  test('and backwards is the same walk, read the other way', () => {
    const { world, id } = dropped(0, 0, 0);
    const moved = movedArtefacts(world, [id], 1, { x: 100, y: 0 });

    expect(artefactsDuring(moved, 1, 0, 0)[0].at.x).toBeCloseTo(100, 9);
    expect(artefactsDuring(moved, 1, 0, 0.25)[0].at.x).toBeCloseTo(75, 9);
    expect(artefactsDuring(moved, 1, 0, 1)[0].at.x).toBeCloseTo(0, 9);
  });

  test('one that is not there yet appears where it is put, not sliding in', () => {
    // There is nowhere for it to slide from. Half a walk in it is already at
    // the place the next version has for it, and the alternative is inventing
    // a start for it out of geometry it has nothing to do with.
    const { world, id } = dropped(1, 60, 0);

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
    const two = addArtefact(one.world, 'exit', { x: 1, y: 0 }, 0);
    const shown = artefactsAt(two.world, 0);

    expect(hitArtefact(shown, { x: 0.5, y: 0 }, 4)).toEqual(two.id);
    expect(hitArtefact(shown, { x: 0, y: 0 }, 0.1)).toEqual(one.id);
    expect(hitArtefact(shown, { x: 50, y: 50 }, 4)).toBeNull();
  });

  test('a box takes what is in it, whichever way it was dragged', () => {
    const one = dropped(0, 10, 10);
    const two = addArtefact(one.world, 'exit', { x: 90, y: 90 }, 0);
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

describe('a selection carries them wherever polygons go', () => {
  /** What `transforming` does to an artefact: the gesture's own map, applied to
   * the place, read back as a move. */
  function through(world: World, id: number, v: number, t: Parameters<typeof affine>[0]): Point {
    const p = placeAt(world, id, v)!;
    const q = place(affine(t), [p])[0];

    return { x: q.x - p.x, y: q.y - p.y };
  }

  test('a turn about the selection centre becomes the move it came to', () => {
    // An artefact has no shape for a rotation to turn, so what the transform
    // does to its point is the whole of what it can mean. A quarter turn about
    // the origin takes (10, 0) to (0, 10), which is a move of (-10, 10).
    const { world, id } = dropped(0, 10, 0);
    const move = through(world, id, 0, { ...EMPTY_TRANSFORM, rotation: Math.PI / 2 });

    expect(move.x).toBeCloseTo(-10, 9);
    expect(move.y).toBeCloseTo(10, 9);

    const turned = movedArtefacts(world, [id], 0, move);

    expect(placeAt(turned, id, 0)!.x).toBeCloseTo(0, 9);
    expect(placeAt(turned, id, 0)!.y).toBeCloseTo(10, 9);
  });

  test('and a squash is a move too, which is what keeps the family closed', () => {
    // Whatever composition of turns and squashes the polygons end up carrying,
    // an artefact ends up somewhere — and somewhere is all a move has to say.
    const { world, id } = dropped(0, 10, 4);
    const move = through(world, id, 0, { ...EMPTY_TRANSFORM, scale: { x: 3, y: 0.5 } });

    expect(move).toEqual({ x: 20, y: -2 });
  });

  test('a move written at one version leaves the ones before it alone', () => {
    const { world, id } = dropped(0, 10, 0);
    const turned = movedArtefacts(world, [id], 2, { x: -10, y: 10 });

    expect(placeAt(turned, id, 1)).toEqual({ x: 10, y: 0 });
    expect(placeAt(turned, id, 2)).toEqual({ x: 0, y: 10 });
  });
});

describe('copying one takes what it goes on to do', () => {
  function clipped(): { world: World, id: number, clip: Clipping[] } {
    const { world, id } = dropped(0, 10, 20);
    const moved = movedArtefacts(world, [id], 2, { x: 100, y: 0 });

    return { world: moved, id, clip: copied(moved, 0, [id]) };
  }

  test('the copy version is where it stood, and the rest is what it had left', () => {
    const { clip } = clipped();

    expect(clip).toHaveLength(1);
    expect(clip[0]).toEqual({ kind: 'artefact', type: 'key', at: [[0, { x: 10, y: 20 }], [2, { x: 100, y: 0 }]] });
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
    // A move is a direction rather than a place, so pasting somewhere else
    // leaves every one of them saying what it said.
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

  test('a mixed selection copies both, and only the polygons are grouped', () => {
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
      const made = addArtefact(emptyWorld(), type, { x: 0, y: 0 }, 0);
      const put = pasted(made.world, 0, copied(made.world, 0, [made.id]), { x: 0, y: 0 }, TOP);

      expect(put.world.artefacts.get(put.artefacts[0])!.type).toEqual(type);
    }
  });
});
