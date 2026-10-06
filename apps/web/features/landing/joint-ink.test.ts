import { BoxGeometry, CylinderGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { pinGeometry, postGeometry, railGeometry } from './joint-geometry';
import { edgesOf, InkPiece } from './joint-ink';

// The joint drawn as a joiner draws it (gate JOINT-3D): the edges come from the solid, the outline from
// where the eye is, and every edge is also kept for the dashed pass that shows what is hidden.

const box = () => new BoxGeometry(10, 10, 10).toNonIndexed();
const count = (a: number[]) => a.length / 6;

describe('the drawing of a piece', () => {
  it('draws a box by its twelve edges, and not the diagonals of its faces', () => {
    expect(edgesOf(box()).filter((e) => e.crease)).toHaveLength(12);
  });

  it('outlines what turns away from the eye in the heavier line, the rest in the lighter', () => {
    const piece = new InkPiece(box());
    // from a corner: three faces seen, six edges on the outline, three inside it, three behind
    piece.update(new Vector3(50, 50, 50));
    expect(count(piece.segments.outline)).toBe(6);
    expect(count(piece.segments.inner)).toBe(6);
    expect(count(piece.segments.hidden)).toBe(12);
    // square on to one face: its four edges are the outline
    piece.update(new Vector3(0, 0, 50));
    expect(count(piece.segments.outline)).toBe(4);
  });

  it('gives a round pin its two sides from wherever it is seen, though they are no edge', () => {
    const pin = new InkPiece(new CylinderGeometry(5, 5, 20, 48).toNonIndexed());
    pin.update(new Vector3(50, 0, 0));
    const sides = [];
    const o = pin.segments.outline;
    for (let i = 0; i < o.length; i += 6) if (o[i + 1] !== o[i + 4]) sides.push(i);
    expect(sides).toHaveLength(2);
  });

  it('finds a shoulder on all four sides where the rail meets its tenon', () => {
    // the edges at the root of the tenon, x = 0, inside the rail's end
    const root = edgesOf(railGeometry()).filter(
      (e) =>
        e.crease && e.a.x === 0 && e.b.x === 0 && Math.abs(e.a.y) <= 20 && Math.abs(e.b.y) <= 20,
    );
    expect(root.length).toBeGreaterThanOrEqual(4);
  });

  it('cuts the mortise right through the post, and the slot right through the tenon', () => {
    const throughX = edgesOf(postGeometry()).filter(
      (e) => e.crease && e.a.y === e.b.y && Math.abs(e.a.y) < 20 && Math.abs(e.a.x - e.b.x) === 30,
    );
    expect(throughX).toHaveLength(4);
    // the slot's four corners each run the tenon's whole height
    const down = edgesOf(railGeometry()).filter(
      (e) => e.crease && e.a.x > 40 && e.a.x < 50 && Math.abs(e.a.y - e.b.y) === 20,
    );
    expect(down).toHaveLength(4);
    expect(edgesOf(pinGeometry()).filter((e) => e.crease)).toHaveLength(12);
  });
});
