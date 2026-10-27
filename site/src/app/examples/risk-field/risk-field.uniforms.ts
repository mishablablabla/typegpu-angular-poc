// What the shader reads, built from the application state. Shared by both implementations of RISK FIELD: the same numbers
// go to the same uniforms whichever way the GPU resources are managed.
import { d } from 'typegpu';
import type { Marks, Surface, View } from './risk-field.gpu';
import { cameraBasis, focalFor, type Effective, type RiskState, type Vec3 } from './risk-field.model';

const vec3 = (v: Vec3) => d.vec3f(v[0], v[1], v[2]);

export function viewData(state: RiskState, size: { width: number; height: number } | undefined): d.InferInput<typeof View> {
  const basis = cameraBasis(state.camera);
  const aspect = (size?.width ?? 1) / (size?.height ?? 1);
  return { pos: vec3(basis.pos), focal: focalFor(aspect), right: vec3(basis.right), aspect, up: vec3(basis.up), pad: 0, forward: vec3(basis.forward), pad2: 0 };
}

export const surfaceData = (e: Effective): d.InferInput<typeof Surface> => ({ ...e });

export function marksData(state: RiskState): d.InferInput<typeof Marks> {
  const { selected, hover } = state;
  return {
    selected: d.vec2f(selected.a, selected.b),
    hover: d.vec2f(hover?.a ?? 0, hover?.b ?? 0),
    selectedOn: 1,
    hoverOn: hover ? 1 : 0,
  };
}
