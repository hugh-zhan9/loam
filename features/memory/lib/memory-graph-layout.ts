import type { MemoryGraph, PlacedNode, Point } from "./memory-graph";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function seed(id: string): number {
  let value = 2166136261;
  for (const char of id)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
}

/** A deterministic force layout of document anchors and their real citations.
 * Chunks stay local to their source; opening a document cannot move its anchor.
 */
export function placeGraph2D(graph: MemoryGraph): PlacedNode[] {
  const anchors = new Map<string, Point>();
  const owner = new Map<string, string>();
  const documents = new Map(
    graph.nodes
      .filter((node) => node.kind === "document")
      .map((node) => [node.cluster, node.id]),
  );
  for (const node of graph.nodes) {
    const id = (node.cluster && documents.get(node.cluster)) || node.id;
    owner.set(node.id, id);
    anchors.set(id, { x: 0, y: 0, z: 0 });
  }
  const ids = [...anchors.keys()].sort();
  const points = ids.map((id) => {
    const angle = seed(id) * Math.PI * 2;
    const radius = Math.sqrt(seed(`${id}:radius`));
    const point = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      z: 0,
    };
    anchors.set(id, point);
    return point;
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = new Set<string>();
  for (const edge of graph.edges) {
    const from = index.get(owner.get(edge.from) ?? "");
    const to = index.get(owner.get(edge.to) ?? "");
    if (from === undefined || to === undefined || from === to) continue;
    links.add([Math.min(from, to), Math.max(from, to)].join(":"));
  }
  const pairs = [...links].map((link) => link.split(":").map(Number));
  const spacing = 1.4 / Math.sqrt(Math.max(1, points.length));
  for (let step = 0; step < 100; step++) {
    const force = points.map((point) => ({
      x: -point.x * 0.04,
      y: -point.y * 0.04,
    }));
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const repulsion = ((spacing * spacing) / distance) * 0.09;
        force[i].x += (dx / distance) * repulsion;
        force[i].y += (dy / distance) * repulsion;
        force[j].x -= (dx / distance) * repulsion;
        force[j].y -= (dy / distance) * repulsion;
      }
    }
    for (const [from, to] of pairs) {
      const dx = points[to].x - points[from].x;
      const dy = points[to].y - points[from].y;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const pull = (distance - spacing * 1.4) * 0.18;
      force[from].x += (dx / distance) * pull;
      force[from].y += (dy / distance) * pull;
      force[to].x -= (dx / distance) * pull;
      force[to].y -= (dy / distance) * pull;
    }
    const speed = 0.5 * (1 - step / 120);
    points.forEach((point, i) => {
      point.x += Math.max(-0.08, Math.min(0.08, force[i].x)) * speed;
      point.y += Math.max(-0.08, Math.min(0.08, force[i].y)) * speed;
    });
  }
  const extent = Math.max(
    0.1,
    ...points.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y))),
  );
  points.forEach((point) => {
    point.x *= 0.8 / extent;
    point.y *= 0.8 / extent;
  });
  if (points.length === 1) Object.assign(points[0], { x: 0, y: 0 });

  const members = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const parent = owner.get(node.id)!;
    if (parent === node.id) continue;
    const group = members.get(parent) ?? [];
    group.push(node.id);
    members.set(parent, group);
  }
  const offsets = new Map<string, Point>();
  for (const [id, group] of members) {
    group.sort();
    const centre = anchors.get(id)!;
    const radius = Math.min(0.2, 0.035 + Math.sqrt(group.length) * 0.014);
    group.forEach((member, i) => {
      const angle = i * GOLDEN_ANGLE + seed(id) * Math.PI * 2;
      const r = radius * Math.sqrt((i + 1) / group.length);
      offsets.set(member, {
        x: centre.x + Math.cos(angle) * r,
        y: centre.y + Math.sin(angle) * r,
        z: 0,
      });
    });
  }
  return graph.nodes.map((node) => ({
    ...node,
    ...(offsets.get(node.id) ?? anchors.get(node.id)!),
  }));
}
