// What the shaders read, built from the application state. Shared by both implementations of THE CORE: the same numbers
// go to the same uniforms whichever way the GPU resources are managed.
import { d } from 'typegpu';
import { Disturbance, Params, View } from './core.gpu';
import { MAX_EVENTS, cameraBasis, focalFor, type CoreState, type Vec3 } from './core.model';

const vec3 = (v: Vec3) => d.vec3f(v[0], v[1], v[2]);

/** The camera and the canvas. */
export function viewData(state: CoreState, size: { width: number; height: number } | undefined): d.InferInput<typeof View> {
  const basis = cameraBasis(state.camera);
  const width = size?.width ?? 1;
  const height = size?.height ?? 1;
  return {
    pos: vec3(basis.pos),
    focal: focalFor(width / height),
    right: vec3(basis.right),
    distance: state.camera.distance,
    up: vec3(basis.up),
    aspect: width / height,
    forward: vec3(basis.forward),
    height,
  };
}

const NO_EVENT = { pos: d.vec3f(), birth: -1000, dir: d.vec3f(), strength: 0 };

/** The recent pushes (padded to the size the shader expects) and the vortex under a pressed pointer. */
export function disturbanceData(state: CoreState): d.InferInput<typeof Disturbance> {
  const events = state.events.map((event) => ({ pos: vec3(event.pos), birth: event.birth, dir: vec3(event.dir), strength: event.strength }));
  while (events.length < MAX_EVENTS) events.push(NO_EVENT);
  const { vortex } = state;
  return { events, vortex: { pos: vec3(vortex.pos), strength: vortex.strength, axis: vec3(vortex.axis), held: vortex.held ? 1 : 0 } };
}

export function paramsData(confinement: number, energy: number, instability: number, reduced: boolean): d.InferInput<typeof Params> {
  return { confinement, energy, instability, reduced: reduced ? 1 : 0 };
}
