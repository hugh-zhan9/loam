import { describe, expect, it } from "vitest";
import { placeGraph2D } from "./memory-graph-layout";
import type { GraphNode, MemoryGraph } from "./memory-graph";

function doc(id: string): GraphNode {
  return {
    id,
    cluster: id,
    kind: "document",
    label: id,
    degree: 0,
    weight: 10,
    status: null,
  };
}

describe("2D relationship layout", () => {
  it("handles empty and single-node graphs with finite centred coordinates", () => {
    expect(placeGraph2D({ nodes: [], edges: [], missing: 0 })).toEqual([]);
    expect(
      placeGraph2D({ nodes: [doc("a")], edges: [], missing: 0 })[0],
    ).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it("uses actual edges to bring related documents closer", () => {
    const graph: MemoryGraph = {
      nodes: Array.from({ length: 30 }, (_, i) => doc(`doc-${i}`)),
      edges: [],
      missing: 0,
    };
    const gap = (nodes: ReturnType<typeof placeGraph2D>) =>
      Math.hypot(nodes[0].x - nodes[15].x, nodes[0].y - nodes[15].y);
    const before = placeGraph2D(graph);
    graph.edges.push({ from: "doc-0", to: "doc-15", kind: "supports" });
    const after = placeGraph2D(graph);
    expect(gap(after)).toBeLessThan(gap(before));
    expect(placeGraph2D(graph)).toEqual(after);
    expect(
      placeGraph2D({ ...graph, nodes: [...graph.nodes].reverse() }).reverse(),
    ).toEqual(after);
  });

  it("keeps document anchors fixed when chunks expand and places chunks near their source", () => {
    const graph: MemoryGraph = {
      nodes: [doc("a"), doc("b")],
      edges: [],
      missing: 0,
    };
    const before = placeGraph2D(graph);
    const chunks = Array.from({ length: 800 }, (_, i): GraphNode => ({
      id: `chunk-${i}`,
      cluster: "a",
      kind: "material",
      label: `${i}`,
      degree: 1,
      status: null,
    }));
    const after = placeGraph2D({
      ...graph,
      nodes: [...graph.nodes, ...chunks],
      edges: chunks.map((node) => ({ from: "a", to: node.id, kind: "holds" })),
    });
    expect(after.slice(0, 2)).toEqual(before);
    expect(after).toHaveLength(802);
    for (const node of after.slice(2)) {
      expect(Number.isFinite(node.x + node.y)).toBe(true);
      expect(
        Math.hypot(node.x - before[0].x, node.y - before[0].y),
      ).toBeLessThanOrEqual(0.201);
    }
    expect(new Set(after.map((node) => `${node.x},${node.y}`)).size).toBe(802);
  });
});
