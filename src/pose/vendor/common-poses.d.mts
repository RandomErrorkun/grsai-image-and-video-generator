export interface CommonPoseSpec {
  id: string;
  name: string;
  turn?: number;
  torso?: number[];
  head?: number[];
  arms?: { l: number[][]; r: number[][] };
  legs?: { l: number[][]; r: number[][] };
}

export const COMMON_POSES: CommonPoseSpec[];

export function directionKeypoints(
  spec: CommonPoseSpec,
  rest: Record<string, number[]>,
  restHead: number[],
): Record<string, number[]>;
