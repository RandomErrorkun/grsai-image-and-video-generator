export interface ReferenceOverlay {
  sync(): void;
  setSource(url: string | null): Promise<void>;
  setOpacity(value: number): void;
  dispose(): void;
}

export function createReferenceOverlay(viewer: unknown): ReferenceOverlay;
