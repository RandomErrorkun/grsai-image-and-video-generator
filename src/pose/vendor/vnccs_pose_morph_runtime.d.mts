export interface MorphPack {
  buffer: ArrayBuffer;
  vertexCount: number;
  baseVertices: Float32Array;
  uvs: Float32Array;
  baseIndices: Uint32Array;
  genitalIndices: Uint32Array;
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
  targets: unknown[];
  joints: Record<string, Uint32Array>;
  bones: Array<{ name: string; parent?: string | null }>;
  landmarkGroups: Record<string, Uint32Array>;
  landmarkJoints: Record<string, Uint32Array>;
}

export interface SolvedMorph {
  vertices: Float32Array;
  bonePositions: Float32Array;
  landmarks?: Record<string, unknown>;
  landmarkIndices?: Record<string, unknown>;
  includeGenitals: boolean;
}

export function parseMorphPack(buffer: ArrayBuffer): MorphPack;
export function solveMorph(pack: MorphPack, params: Record<string, unknown>): SolvedMorph;
export function buildStaticModelData(
  pack: MorphPack,
  includeGenitals: boolean,
): {
  uvs: Float32Array;
  indices: Uint32Array;
  bones: Array<{ name: string; parent?: string | null }>;
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
};
