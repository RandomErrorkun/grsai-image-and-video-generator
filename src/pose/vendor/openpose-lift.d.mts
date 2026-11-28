export const WORLD_KEYPOINT_NAMES: Record<string, string>;

export function liftOpenPose(
  points: Record<string, [number, number]>,
  rest: Record<string, number[]>,
  flips?: Record<string, boolean>,
  depthMode?: "planar" | "estimate",
): { kps: Record<string, number[]>; facingAway: boolean; scale: number };
