// The shaders of the Life example, shared by both implementations: a compute kernel that advances the
// simulation, one that copies it back, one that paints cells, and the fragment shader that draws them.
import tgpu, { d, std } from 'typegpu';
import type { TgpuMutable, TgpuReadonly, TgpuUniform } from 'typegpu';

export const GRID = 128;

/** One u32 per cell: 1 is alive. */
export const Cells = d.arrayOf(d.u32, GRID * GRID);

/** The pointer: where to paint (in cell coordinates), how large, and whether to draw or erase. */
export const Brush = d.struct({ center: d.vec2f, radius: d.f32, value: d.u32 });

type CellsMutable = TgpuMutable<typeof Cells>;

/** One generation: `next` = the rules applied to `current`. `wrap` joins opposite edges. */
export const stepKernel = (current: CellsMutable, next: CellsMutable, wrap: TgpuUniform<d.U32>) => (x: number, y: number) => {
  'use gpu';
  const n = d.i32(GRID);
  const px = d.i32(x);
  const py = d.i32(y);
  let alive = d.i32(0);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      let nx = px + dx;
      let ny = py + dy;
      if (wrap.$ === 1) {
        nx = (nx + n) % n;
        ny = (ny + n) % n;
      }
      const inside = nx >= 0 && ny >= 0 && nx < n && ny < n;
      const neighbor = d.i32(current.$[d.u32(std.clamp(ny, 0, n - 1) * n + std.clamp(nx, 0, n - 1))]);
      alive = alive + std.select(d.i32(0), neighbor, inside);
    }
  }
  const index = d.u32(py * n + px);
  const self = current.$[index];
  const survives = self === 1 && (alive === 2 || alive === 3);
  const born = self === 0 && alive === 3;
  next.$[index] = std.select(d.u32(0), d.u32(1), survives || born);
};

/** Copies `next` back into `current`. */
export const commitKernel = (current: CellsMutable, next: CellsMutable) => (x: number, y: number) => {
  'use gpu';
  const index = d.u32(y) * GRID + d.u32(x);
  current.$[index] = next.$[index];
};

/** Sets every cell within the brush radius. */
export const paintKernel = (current: CellsMutable, brush: TgpuUniform<typeof Brush>) => (x: number, y: number) => {
  'use gpu';
  const center = d.vec2f(d.f32(x) + 0.5, d.f32(y) + 0.5);
  if (std.distance(center, brush.$.center) <= brush.$.radius) {
    current.$[d.u32(y) * GRID + d.u32(x)] = brush.$.value;
  }
};

export function lifeFragment(cells: TgpuReadonly<typeof Cells>) {
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const grid = d.f32(GRID);
    const gx = input.uv.x * grid;
    const gy = input.uv.y * grid;
    const index = d.u32(std.min(gy, grid - 1)) * GRID + d.u32(std.min(gx, grid - 1));
    // A thin darker border around every cell.
    const edge = std.min(std.min(gx - std.floor(gx), 1 - (gx - std.floor(gx))), std.min(gy - std.floor(gy), 1 - (gy - std.floor(gy))));
    const gridline = 0.7 + 0.3 * std.smoothstep(0, 0.12, edge);
    const alive = cells.$[index] === 1;
    const live = d.vec3f(0.35 + 0.55 * input.uv.x, 0.45 + 0.35 * input.uv.y, 1);
    const dead = d.vec3f(0.08, 0.09, 0.15);
    return d.vec4f(std.mul(std.select(dead, live, alive), gridline), 1);
  });
}

/** A random starting generation (runs on the CPU, so it is a plain function). */
export const randomCells = (): number[] => Array.from({ length: GRID * GRID }, () => (Math.random() < 0.28 ? 1 : 0));
export const emptyCells = (): number[] => new Array<number>(GRID * GRID).fill(0);
