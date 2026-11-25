import type { MemoryGraph, PlacedNode, Point } from "./memory-graph";

export type GraphShape = "ring" | "sphere";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function seed(id: string): number {
  let value = 2166136261;
  for (const char of id)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
}

/** A deterministic ring or sphere layout of document anchors and their real citations.
 * Chunks stay local to their source; opening a document cannot move its anchor.
 */
export function placeGraph2D(
  graph: MemoryGraph,
  shape: GraphShape = "ring",
): PlacedNode[] {
  const anchors = new Map<string, Point>();
  const owner = new Map<string, string>();
  const clusterDirs = new Map<string, string>();
  const documents = new Map(
    graph.nodes
      .filter((node) => node.kind === "document")
      .map((node) => [node.cluster ?? node.id, node.id]),
  );
  for (const node of graph.nodes) {
    const cluster = node.cluster ?? node.id;
    const id =
      node.kind === "document" ? node.id : (documents.get(cluster) ?? node.id);
    owner.set(node.id, id);
    if (id === node.id) {
      clusterDirs.set(id, cluster.slice(0, cluster.lastIndexOf("/") + 1));
    }
  }
  const ids = [...clusterDirs.keys()].sort((a, b) => {
    const left = clusterDirs.get(a)!;
    const right = clusterDirs.get(b)!;
    return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const count = ids.length;
  const sphere = shape === "sphere";
  const points = ids.map((id, rank) => {
    const angle =
      (rank / count) * 2 * Math.PI +
      (seed(`${id}:ang`) - 0.5) * (Math.PI / Math.max(4, count));
    const u = seed(`${id}:${shape}`);
    const targetR = sphere
      ? 0.16 + Math.pow(u, 0.62) * 0.78
      : count >= 6
        ? 0.44 + u * 0.34
        : 0.52 + (u - 0.5) * 0.16;
    return {
      x: count === 1 ? 0 : Math.cos(angle) * targetR,
      y: count === 1 ? 0 : Math.sin(angle) * targetR,
      targetR,
    };
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = new Set<string>();
  for (const edge of graph.edges) {
    const from = index.get(owner.get(edge.from) ?? "");
    const to = index.get(owner.get(edge.to) ?? "");
    if (from === undefined || to === undefined || from === to) continue;
    links.add([Math.min(from, to), Math.max(from, to)].join(":"));
  }
  const pairs = [...links].sort().map((link) => link.split(":").map(Number));
  const spacing = (sphere ? 1.25 : 1.35) / Math.sqrt(Math.max(1, count));
  const repulsionStrength = sphere ? 0.08 : 0.085;
  for (let step = 0; count >= 2 && step < 100; step++) {
    const force = points.map((point) => {
      const r = Math.max(0.001, Math.hypot(point.x, point.y));
      let radial = (point.targetR - r) * (sphere ? 0.085 : 0.11);
      if (!sphere && count >= 6 && r < 0.34) radial += (0.34 - r) * 0.35;
      return { x: (point.x / r) * radial, y: (point.y / r) * radial };
    });
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const repulsion = ((spacing * spacing) / distance) * repulsionStrength;
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
      const pull = (distance - spacing * 1.1) * 0.24;
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
  const scale =
    count >= (sphere ? 4 : 6)
      ? (sphere ? 0.9 : 0.86) /
        Math.max(0.1, ...points.map((point) => Math.hypot(point.x, point.y)))
      : 1;
  const occupied = new Set<string>();
  const uniquePoint = (x: number, y: number): Point => {
    let key = `${x},${y}`;
    while (occupied.has(key)) {
      x += 1e-9;
      key = `${x},${y}`;
    }
    occupied.add(key);
    return { x, y, z: 0 };
  };
  points.forEach((point, i) =>
    anchors.set(ids[i], uniquePoint(point.x * scale, point.y * scale)),
  );

  const members = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const parent = owner.get(node.id)!;
    if (parent === node.id) continue;
    const group = members.get(parent) ?? [];
    group.push(node.id);
    members.set(parent, group);
  }
  const offsets = new Map<string, Point>();
  for (const id of ids) {
    const group = members.get(id);
    if (!group) continue;
    group.sort();
    const centre = anchors.get(id)!;
    const radius = Math.min(0.192, 0.036 + Math.sqrt(group.length) * 0.013);
    const angleOffset = seed(id) * 2 * Math.PI;
    group.forEach((member, i) => {
      const angle = i * GOLDEN_ANGLE + angleOffset;
      const r =
        radius * Math.sqrt((i + 1) / group.length) *
        (0.82 + 0.18 * seed(`${member}:r`));
      offsets.set(
        member,
        uniquePoint(centre.x + Math.cos(angle) * r, centre.y + Math.sin(angle) * r),
      );
    });
  }
  return graph.nodes.map((node) => ({
    ...node,
    ...(offsets.get(node.id) ?? anchors.get(node.id)!),
  }));
}
