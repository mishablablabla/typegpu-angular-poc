// Small helpers of the Autoscaler example that are about motion, not about the platform. Shared by both implementations.


/** How much light is left of the previous frame's after `deltaSeconds`: the same trail length at any frame rate. */
export const trailDecay = (deltaSeconds: number): number => Math.pow(0.84, Math.min(deltaSeconds, 0.05) * 60);
