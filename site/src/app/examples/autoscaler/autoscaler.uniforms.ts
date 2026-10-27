// What the shaders read, built from the simulation's snapshot and the selection. Shared by both implementations of the
// Autoscaler example: the same numbers go to the same resources whichever way the GPU is managed.
import { d } from 'typegpu';
import type { Edges, Nodes, View } from './autoscaler.gpu';
import {
  CLIENT_NODE,
  CLIENT_POS,
  EDGES,
  HUB_RADIUS,
  INSTANCE_CODE,
  MAX_RPS,
  NODE_COUNT,
  NO_NODE,
  RATE_FULL,
  SERVICES,
  SERVICE_COUNT,
  SLOT_BASE,
  SLOT_NODE_RADIUS,
  fitFor,
  nodeIndex,
  slotPos,
  type PlatformSnapshot,
} from './autoscaler.model';

type NodeData = d.InferInput<typeof Nodes>[number];

const empty = (pos: readonly [number, number]): NodeData => ({
  pos: d.vec2f(pos[0], pos[1]),
  radius: SLOT_NODE_RADIUS,
  load: 0,
  state: -1,
  progress: 0,
  base: 0,
  count: 0,
  health: 0,
});

/** Every node of the map: services, replica slots (empty unless a replica lives there), the clients. */
export function nodesData(snapshot: PlatformSnapshot): d.InferInput<typeof Nodes> {
  const nodes: NodeData[] = [];
  SERVICES.forEach((def, s) => {
    const stat = snapshot.services[s]!;
    nodes.push({
      pos: d.vec2f(def.pos[0], def.pos[1]),
      radius: HUB_RADIUS,
      load: stat.load,
      state: 1,
      progress: 1,
      base: SERVICE_COUNT + SLOT_BASE[s]!,
      count: def.max,
      health: stat.health,
    });
  });
  SERVICES.forEach((def, s) => {
    for (let slot = 0; slot < def.max; slot++) nodes.push(empty(slotPos(s, slot)));
  });
  nodes.push({ ...empty(CLIENT_POS), radius: 0.06, state: 1, progress: 1, load: snapshot.rps / MAX_RPS });
  for (const instance of snapshot.instances) {
    const node = nodes[nodeIndex(instance.service, instance.slot)]!;
    node.state = INSTANCE_CODE[instance.state];
    node.progress = instance.progress;
    node.load = instance.load;
  }
  if (nodes.length !== NODE_COUNT || nodes.length - 1 !== CLIENT_NODE) throw new Error('the node table does not match the layout');
  return nodes;
}

export function edgesData(snapshot: PlatformSnapshot): d.InferInput<typeof Edges> {
  return EDGES.map((edge, e) => ({
    source: edge.from,
    sink: edge.to,
    rate: Math.min(1, snapshot.edgeRates[e]! / RATE_FULL),
    drop: snapshot.edgeDrops[e]!,
    curve: edge.curve,
  }));
}

export function viewData(size: { width: number; height: number } | undefined, selected: number | undefined, hovered: number | undefined): d.InferInput<typeof View> {
  const width = size?.width ?? 1;
  const height = size?.height ?? 1;
  return { aspect: width / height, fit: fitFor(width / height), height, selected: selected ?? NO_NODE, hovered: hovered ?? NO_NODE };
}
