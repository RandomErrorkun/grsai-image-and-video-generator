export interface MovementGizmo {
  sync(enabled: boolean): void;
  dispose(): void;
}

export function createMovementGizmo(
  viewer: unknown,
  options: {
    getTransform: () => { x: number; y: number; z: number; zoom: number };
    onStart: () => void;
    onChange: (next: { x: number; y: number; z: number; zoom: number }) => void;
  },
): MovementGizmo;
