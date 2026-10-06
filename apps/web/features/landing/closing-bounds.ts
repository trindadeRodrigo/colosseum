import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CLOSING_BEARING, type ClosingPose, closingPoseAt, placeFor, WORLD } from './closing-pose';
import { MM } from './joint-geometry';
import { DRAW } from './joint-pose';

// Where the closing's joint stands on a screen, worked out the way its scene draws it, without a GPU:
// for the layout's checks that the pieces stand beside the words and not on them. Kept apart from
// closing-pose.ts, which the page loads, so three.js stays in the scene's own chunk.

type Box = { x: [number, number]; y: [number, number]; z: [number, number] };
const RAIL_ORIGIN = -MM.post.w / 2;
const PIN_ORIGIN = RAIL_ORIGIN + (MM.slot.x0 + MM.slot.x1) / 2;

/** Each piece's box in the joint's own millimetres, at a pose (joint-scene.ts places them the same). */
function boxes(pose: ClosingPose): Box[] {
  const rx = RAIL_ORIGIN - pose.rail;
  const px = PIN_ORIGIN - Math.min(pose.rail, DRAW);
  return [
    { x: [-15, 15], y: [MM.post.bottom + pose.post, MM.post.top + pose.post], z: [-15, 15] },
    { x: [rx - MM.rail.len, rx + MM.tenon.len], y: [-15, 15], z: [-12, 12] },
    {
      x: [px - MM.pin.x / 2, px + MM.pin.x / 2],
      y: [pose.pin - MM.pin.len / 2, pose.pin + MM.pin.len / 2],
      z: [-MM.pin.z / 2, MM.pin.z / 2],
    },
  ];
}

/**
 * The joint's bounds on a screen of `width` × `height` CSS pixels at progress p, as the scene draws it:
 * for the layout's own checks that the pieces stand beside the words and not on them.
 */
export function screenBounds(width: number, height: number, p: number) {
  const camera = new PerspectiveCamera(WORLD.fov, width / height, 1, 200);
  camera.position.set(...WORLD.camera);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const at = placeFor(width, height);
  const world = new Matrix4().compose(
    new Vector3(at.x, at.y, at.z),
    new Quaternion().setFromEuler(new Euler(CLOSING_BEARING.x, CLOSING_BEARING.y, 0)),
    new Vector3().setScalar(WORLD.scale * at.scale),
  );
  const out = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const b of boxes(closingPoseAt(p)))
    for (const x of b.x)
      for (const y of b.y)
        for (const z of b.z) {
          const v = new Vector3(x, y, z).applyMatrix4(world).project(camera);
          const sx = ((v.x + 1) / 2) * width;
          const sy = ((1 - v.y) / 2) * height;
          out.left = Math.min(out.left, sx);
          out.right = Math.max(out.right, sx);
          out.top = Math.min(out.top, sy);
          out.bottom = Math.max(out.bottom, sy);
        }
  return out;
}
