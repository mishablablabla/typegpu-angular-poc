// What the shaders read, built from the application state. Shared by both implementations of NEURAL FLOW: the same numbers
// go to the same uniforms and buffers whichever way the GPU resources are managed.
import { d } from 'typegpu';
import { Edges, Neurons, Params, Pointer, Shell, Sites, View } from './neural-flow.gpu';
import { EDGE_COUNT, FIBRE_KINDS, MAX_BURSTS, NETWORK, NEURONS, SHELL, STATES, cameraBasis, focalFor, type NeuralState, type Vec3 } from './neural-flow.model';

const vec3 = (v: Vec3) => d.vec3f(v[0], v[1], v[2]);

/** The camera and the canvas. */
export function viewData(state: NeuralState, size: { width: number; height: number } | undefined): d.InferInput<typeof View> {
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

/** The three controls and the state they are in. */
export function paramsData(stateName: string, frequency: number, connectivity: number, stimulation: number): d.InferInput<typeof Params> {
  return { frequency, connectivity, mode: stateName === STATES[1] ? 1 : 0, strength: stimulation };
}

const NO_BURST = { pos: d.vec3f(), birth: -1000, strength: 0 };

/** The pointer: where it stimulates, the neurons it hovers and has selected, and the latest clicks (padded to the size the shader expects). */
export function pointerData(state: NeuralState): d.InferInput<typeof Pointer> {
  const bursts = state.bursts.map((burst) => ({ pos: vec3(burst.pos), birth: burst.birth, strength: burst.strength }));
  while (bursts.length < MAX_BURSTS) bursts.push(NO_BURST);
  return { pos: vec3(state.stimulus.pos), pressed: state.stimulus.active ? 1 : 0, hovered: state.hovered, selected: state.selected, bursts };
}

/** The neurons at rest: never fired. Also what Reset writes back. */
export const restingNeurons = (): d.InferInput<typeof Neurons> => Array.from({ length: NEURONS }, () => ({ v: 0, spike: -1000, heat: 0, pad: 0 }));
export const noInputs = (): number[] => new Array<number>(NEURONS).fill(0);

/** The topology, uploaded once. */
export const sitesData = (): d.InferInput<typeof Sites> =>
  NETWORK.positions.map((p, i) => d.vec4f(p[0], p[1], p[2], NETWORK.pacemaker[i]!));
export const edgesData = (): d.InferInput<typeof Edges> =>
  NETWORK.edges.slice(0, EDGE_COUNT).map((e) => ({ src: e.src, dst: e.dst, delay: e.delay, weight: e.weight, mid: vec3(e.mid), rank: e.rank, mid2: vec3(e.mid2), kind: FIBRE_KINDS.indexOf(e.kind) }));

/** The brain's surface, uploaded once. */
export const shellData = (): d.InferInput<typeof Shell> =>
  SHELL.positions.map((p, i) => ({ pos: vec3(p), fold: SHELL.folds[i]!, normal: vec3(SHELL.normals[i]!), pad: 0 }));
