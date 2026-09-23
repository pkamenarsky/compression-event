// -----------------------------------------------------------------------------
// Identity, and the arrangement carrying it
//
// Two halves. The names are a small interned value and the questions of them
// are cheap: the same construction is the same handle, a crossing does not care
// which way round it was read, and a name written out says its structure and
// not its handle.
//
// The half that matters is the second: a boolean operation hands back points
// that know what they came of, and *nothing in the naming reads a coordinate*.
// So the test for it is to move the geometry — slide an operand, then carry the
// whole arrangement a thousand units off and turn one of its rooms into another
// size — and ask for the names again. While the same edges cross the same
// edges, the answer is the same list, to the character.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { OpSubtract, OpUnion, Shape } from './geometry';
import { born, combineIdentified, corner, identify, madeOf, on, shows } from './ids';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** Every point's name, ring by ring — the whole of what an arrangement says
 * about where its output came from. */
const names = (r: { ids: ReturnType<typeof identify> }) => r.ids.map(ring => ring.map(shows));

describe('names', () => {
  test('the same construction is the same handle', () => {
    expect(corner(3, 1)).toBe(corner(3, 1));
    expect(corner(3, 1)).not.toBe(corner(3, 2));
    expect(corner(3, 1)).not.toBe(corner(4, 1));

    expect(born(corner(3, 1), corner(4, 2))).toBe(born(corner(3, 1), corner(4, 2)));
    expect(on(corner(3, 1), 0.25)).toBe(on(corner(3, 1), 0.25));
    expect(on(corner(3, 1), 0.25)).not.toBe(on(corner(3, 1), 0.5));
  });

  test('a crossing does not know which side read it first', () => {
    expect(born(corner(1, 0), corner(2, 0))).toBe(born(corner(2, 0), corner(1, 0)));
  });

  test('they nest, and say so', () => {
    const cross = born(corner(3, 1), corner(4, 2));

    expect(shows(corner(3, 1))).toBe('3.1');
    expect(shows(cross)).toBe('(3.1×4.2)');
    expect(shows(on(cross, 0.5))).toBe('(3.1×4.2)@0.5');
    expect(shows(born(cross, corner(5, 0)))).toBe('((3.1×4.2)×5.0)');
  });

  test('and can be read back one level at a time', () => {
    expect(madeOf(corner(7, 2))).toEqual({ kind: 'corner', member: 7, vertex: 2 });

    const what = madeOf(born(corner(7, 2), corner(8, 0)));

    expect(what.kind).toBe('born');
    expect(what.kind === 'born' && shows(what.a)).toBe('7.2');
  });

  test('a polygon with a hole numbers its corners across the whole of it', () => {
    const ids = identify([rect(0, 0, 10, 10), rect(3, 3, 4, 4)], 5);

    expect(ids.map(ring => ring.map(shows))).toEqual([
      ['5.0', '5.1', '5.2', '5.3'],
      ['5.4', '5.5', '5.6', '5.7'],
    ]);
  });
});

describe('the arrangement carries them', () => {
  const a: Shape = [rect(0, 0, 100, 100)];
  const b = (dx: number): Shape => [rect(50 + dx, 50, 100, 100)];
  const drawn = (shape: Shape, member: number) => ({ shape, ids: identify(shape, member) });
  const union = (dx: number) => combineIdentified(drawn(a, 0), drawn(b(dx), 1), OpUnion);

  test('every point of the answer has exactly one name', () => {
    const r = union(0);

    expect(r.ids.length).toBe(r.shape.length);
    r.shape.forEach((ring, i) => expect(r.ids[i].length).toBe(ring.length));
  });

  test('a corner of an operand keeps the name it came in with', () => {
    // The two rects overlap at a corner apiece, so all but one corner of each
    // survives the union outright.
    const said = names(union(0)).flat();

    expect(said).toContain('0.0');
    expect(said).toContain('1.2');
  });

  test('a crossing is born of the two edges that made it', () => {
    const said = names(union(0)).flat();

    // The right wall of the first room crossed by the bottom wall of the
    // second, and the top wall of the first by the second's left.
    expect(said).toContain('(0.1×1.0)');
    expect(said).toContain('(0.2×1.3)');
  });

  test('nothing in a name came off a coordinate: the geometry may move', () => {
    expect(names(union(2))).toEqual(names(union(0)));
    expect(names(union(-15.5))).toEqual(names(union(0)));
  });

  test('nor off how big the arrangement is, nor where it stands', () => {
    const far: Shape = [rect(9000, -4000, 250, 250)];
    const over: Shape = [rect(9125, -3875, 250, 250)];

    expect(names(combineIdentified(drawn(far, 0), drawn(over, 1), OpUnion)))
      .toEqual(names(union(0)));
  });

  test('the same input always says the same thing', () => {
    expect(names(union(0))).toEqual(names(union(0)));
  });

  test('a subtraction names its points the same way', () => {
    const room: Shape = [rect(0, 0, 200, 100)];
    const bite: Shape = [rect(80, -20, 40, 60)];
    const r = combineIdentified(drawn(room, 0), drawn(bite, 1), OpSubtract);
    const said = names(r).flat();

    expect(said).toContain('(0.0×1.1)');
    expect(said).toContain('(0.0×1.3)');
    expect(said).toContain('1.2');
  });

  test('and a crossing is as good a thing to cross as a drawn corner is', () => {
    // Two rooms unioned, and a strip taken out of the wall that runs away
    // from one of the crossings: the answer carries names two arrangements
    // deep, which is what lets a corner be followed through a group.
    const first = union(0);
    const c: Shape = [rect(120, 30, 12, 200)];
    const r = combineIdentified(first, drawn(c, 2), OpSubtract);
    const said = names(r).flat();

    expect(said).toContain('((0.1×1.0)×2.1)');
    expect(said).toContain('((0.1×1.0)×2.3)');
  });
});
