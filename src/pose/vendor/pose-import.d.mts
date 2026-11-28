export function readSkeletonImage(
  image: HTMLImageElement | HTMLCanvasElement,
): Array<Record<string, [number, number]>> & { warnings?: string[] };
