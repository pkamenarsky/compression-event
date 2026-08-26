import { describe, expect, test } from 'vitest';

import {
  addArtefact,
  artefactsAt,
  artefactsDuring,
  artefactsWithinBox,
  hitArtefact,
  placeArtefact,
  placeAt,
  removeArtefacts,
  retypeArtefacts,
} from './scene';
import { World, emptyWorld } from './types';

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

  test('and every later version inherits it until one says otherwise', () => {
    const { world, id } = dropped(0);

    expect(placeAt(world, id, 4)).toEqual({ x: 10, y: 20 });

    const moved = placeArtefact(world, [id], 2, () => ({ x: 90, y: 0 }));

    expect(placeAt(moved, id, 1)).toEqual({ x: 10, y: 20 });
    expect(placeAt(moved, id, 2)).toEqual({ x: 90, y: 0 });
    expect(placeAt(moved, id, 4)).toEqual({ x: 90, y: 0 });
  });

  test('a place replaces rather than composing, so a drag cannot drift', () => {
    // Two drags at the same version are the second drag, not both. There is no
    // identity point for them to layer against, which is why `placeArtefact`
    // takes where it stood rather than a displacement.
    const { world, id } = dropped(0);
    const once = placeArtefact(world, [id], 1, was => ({ x: was.x + 5, y: was.y }));
    const twice = placeArtefact(once, [id], 1, was => ({ x: was.x + 5, y: was.y }));

    expect(placeAt(twice, id, 1)).toEqual({ x: 20, y: 20 });
    expect(world.artefacts.get(id)!.at.size).toEqual(1);
  });

  test('moving one at a version it is not at yet does nothing', () => {
    const { world, id } = dropped(3);

    expect(placeArtefact(world, [id], 1, () => ({ x: 0, y: 0 }))).toEqual(world);
  });

  test('the type is one fact about it, not one per version', () => {
    // Which is why it is a field rather than another map. A key that becomes an
    // exit half way through a level is a different thing, not the same thing
    // later, and nothing yet wants to say it.
    const { world, id } = dropped(0);
    const moved = placeArtefact(world, [id], 2, () => ({ x: 1, y: 1 }));
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
    const moved = placeArtefact(world, [id], 1, () => ({ x: 100, y: 40 }));

    expect(artefactsDuring(moved, 0, 1, 0)[0].at).toEqual({ x: 0, y: 0 });
    expect(artefactsDuring(moved, 0, 1, 0.5)[0].at).toEqual({ x: 50, y: 20 });
    expect(artefactsDuring(moved, 0, 1, 1)[0].at).toEqual({ x: 100, y: 40 });
  });

  test('a walk over two versions spends half its time on each', () => {
    // Per version rather than per distance, because that is how `replayed`
    // cuts the same `u`. A key crossing a room while the room is still is a
    // key that arrived before its floor did.
    const { world, id } = dropped(0, 0, 0);
    const a = placeArtefact(world, [id], 1, () => ({ x: 10, y: 0 }));
    const b = placeArtefact(a, [id], 2, () => ({ x: 1010, y: 0 }));

    expect(artefactsDuring(b, 0, 2, 0.25)[0].at.x).toBeCloseTo(5, 9);
    expect(artefactsDuring(b, 0, 2, 0.5)[0].at.x).toBeCloseTo(10, 9);
    expect(artefactsDuring(b, 0, 2, 0.75)[0].at.x).toBeCloseTo(510, 9);
  });

  test('and backwards is the same walk, read the other way', () => {
    const { world, id } = dropped(0, 0, 0);
    const moved = placeArtefact(world, [id], 1, () => ({ x: 100, y: 0 }));

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
