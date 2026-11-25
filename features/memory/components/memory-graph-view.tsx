"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Chip,
  PrimaryTextControlButton,
  SearchField,
  SegmentedControl,
  TextControlButton,
} from "@/common/components/ui-controls";
import type { StoredItem } from "../lib/types";
import {
  buildMemoryGraph,
  documentSource,
  placeGraph,
  type GraphNode,
  type PlacedNode,
  type Point,
} from "../lib/memory-graph";
import { placeGraph2D, type GraphShape } from "../lib/memory-graph-layout";

interface MemoryGraphViewProps {
  material: StoredItem[];
  conclusions: StoredItem[];
  onSelect: (drawerId: string) => void;
  onFindSimilar: (drawerId: string) => Promise<string[]>;
}

const COLORS = {
  verification: "#8b5cf6",
  adopted: "#d97706",
  candidate:
    "color-mix(in srgb, var(--color-warning) 72%, var(--color-base-content))",
};
const CONSTELLATION_COLORS = [
  [59, 125, 221], // #3b7ddd
  [139, 95, 191], // #8b5fbf
  [217, 95, 102], // #d95f66
];
const NODE_KIND_LABELS = {
  document: "文档",
  material: "素材",
  conclusion: "结论",
  verification: "采纳记录",
};
const pixel = (value: number) => Math.round(value * 1000) / 1000;

function nodeColor(node: GraphNode, anchor: PlacedNode) {
  if (node.kind === "conclusion")
    return node.status === "promoted" || node.status === "canonical"
      ? COLORS.adopted
      : COLORS.candidate;
  if (node.kind === "verification") return COLORS.verification;

  // Start at the top and sweep left through violet, then right through coral.
  const turn =
    (((1 - (Math.atan2(anchor.y, anchor.x) + Math.PI / 2) / (2 * Math.PI)) %
      1) +
      1) %
    1;
  const angle = turn * 3;
  const stop = Math.min(2, Math.floor(angle));
  const next = CONSTELLATION_COLORS[(stop + 1) % 3];
  const channels = CONSTELLATION_COLORS[stop].map((value, i) =>
    Math.round(value + (next[i] - value) * (angle - stop)),
  );
  return `rgb(${channels.join(" ")})`;
}
function radius(node: GraphNode) {
  return node.kind === "conclusion"
    ? 4.6
    : node.kind === "document"
      ? 2.7 + Math.min(2.6, Math.sqrt(node.weight ?? 1) * 0.42)
      : node.kind === "verification"
        ? 3.0
        : 2.1;
}

function buildMeshPairs(
  placed: PlacedNode[],
  mode: "2D" | "3D",
  shape: GraphShape,
): Array<[number, number]> {
  const count = placed.length;
  if (count <= 2) return [];
  const ring = mode === "2D" && shape === "ring";
  const maxDistance = ring
    ? (count < 20 ? 0.65 : 0.36)
    : mode === "3D"
      ? (count < 30 ? 1.45 : count < 120 ? 0.95 : 0.62)
      : (count < 30 ? 1.15 : count < 120 ? 0.72 : 0.48);
  const maxDistanceSquared = maxDistance ** 2;
  const maxNeighbors = ring
    ? (count > 500 ? 2 : count > 250 ? 3 : 4)
    : (count > 500 ? 3 : count > 250 ? 4 : 6);
  const avoidCentre = ring && count >= 6;
  const clusterBias = ring ? 0.55 : 0.65;
  const seen = new Set<number>();
  const pairs: Array<[number, number]> = [];

  for (const [i, node] of placed.entries()) {
    const nearest: Array<{ j: number; score: number }> = [];
    for (let j = 0; j < placed.length; j++) {
      if (i === j) continue;
      const other = placed[j];
      const dx = other.x - node.x;
      const dy = other.y - node.y;
      const dz = other.z - node.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared > maxDistanceSquared) continue;
      if (avoidCentre) {
        if (Math.hypot(node.x + dx / 2, node.y + dy / 2) < 0.25) continue;
        // A chord can enter the opening even when its midpoint is outside it.
        const t = Math.max(
          0,
          Math.min(1, -(node.x * dx + node.y * dy) / distanceSquared),
        );
        if (Math.hypot(node.x + t * dx, node.y + t * dy) < 0.25) continue;
      }
      const sameCluster =
        node.cluster !== undefined && node.cluster === other.cluster;
      const score = distanceSquared * (sameCluster ? clusterBias : 1);
      const rank = nearest.findIndex((entry) => entry.score > score);
      if (rank !== -1) nearest.splice(rank, 0, { j, score });
      else if (nearest.length < maxNeighbors) nearest.push({ j, score });
      if (nearest.length > maxNeighbors) nearest.pop();
    }

    for (const { j } of nearest) {
      const key = Math.min(i, j) * count + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([i, j]);
    }
  }
  return pairs;
}

function buildMeshPaths(
  pairs: Array<[number, number]>,
  placed: PlacedNode[],
  projected: ReadonlyMap<string, Pick<Point, "x" | "y"> & { depth: number }>,
  mode: "2D" | "3D",
) {
  const front: string[] = [];
  const back: string[] = [];
  for (const [i, j] of pairs) {
    const from = projected.get(placed[i].id)!;
    const to = projected.get(placed[j].id)!;
    const segments =
      mode === "3D" && (from.depth + to.depth) / 2 < 0 ? back : front;
    segments.push(`M ${from.x} ${from.y} L ${to.x} ${to.y}`);
  }
  return { front: front.join(" "), back: back.join(" ") };
}

export function MemoryGraphView({
  material,
  conclusions,
  onSelect,
  onFindSimilar,
}: MemoryGraphViewProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [mode, setMode] = useState<"2D" | "3D">("2D");
  const [shape, setShape] = useState<GraphShape>("ring");
  const [detail, setDetail] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [similar, setSimilar] = useState<Record<string, string[]>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotation, setRotation] = useState({ yaw: 0, pitch: 0 });
  const [view, setView] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const box = view ?? { x: 0, y: 0, w: size.w, h: size.h };
  const unit = box.w / size.w;
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    dragged: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
      setSize({
        w: Math.round(entry.contentRect.width),
        h: Math.round(entry.contentRect.height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const expanded = useMemo(
    () =>
      new Set(
        material.flatMap((item) =>
          item.sourceFile && detail !== collapsed.has(item.sourceFile)
            ? [item.sourceFile]
            : [],
        ),
      ),
    [material, detail, collapsed],
  );
  const graph = useMemo(
    () => buildMemoryGraph(material, conclusions, { expanded, similar }),
    [material, conclusions, expanded, similar],
  );
  const placed = useMemo(
    () => (mode === "2D" ? placeGraph2D(graph, shape) : placeGraph(graph)),
    [graph, mode, shape],
  );
  const documentAnchors = useMemo(
    () =>
      new Map(
        placed
          .filter((node) => node.kind === "document")
          .map((node) => [node.cluster, node]),
      ),
    [placed],
  );
  const projected = useMemo(
    () => {
      const scale = Math.min(size.w, size.h) * 0.47;
      return new Map(
        placed.map((node) => {
          if (mode === "2D")
            return [
              node.id,
              {
                x: pixel(size.w / 2 + node.x * scale),
                y: pixel(size.h / 2 + node.y * scale),
                depth: 1,
              },
            ];
          const r = Math.min(size.w, size.h) * 0.43;
          const x =
            node.x * Math.cos(rotation.yaw) + node.z * Math.sin(rotation.yaw);
          const z =
            -node.x * Math.sin(rotation.yaw) + node.z * Math.cos(rotation.yaw);
          const y =
            node.y * Math.cos(rotation.pitch) + z * Math.sin(rotation.pitch);
          const depth =
            -node.y * Math.sin(rotation.pitch) + z * Math.cos(rotation.pitch);
          return [
            node.id,
            {
              x: pixel(size.w / 2 + x * r),
              y: pixel(size.h / 2 + y * r),
              depth: pixel(depth),
            },
          ];
        }),
      );
    },
    [placed, size, rotation, mode],
  );
  const meshPairs = useMemo(
    () => buildMeshPairs(placed, mode, shape),
    [placed, mode, shape],
  );
  const mesh = useMemo(
    () => buildMeshPaths(meshPairs, placed, projected, mode),
    [meshPairs, placed, projected, mode],
  );
  const drawOrder = useMemo(
    () =>
      [...placed].sort(
        (a, b) =>
          (projected.get(a.id)?.depth ?? 0) - (projected.get(b.id)?.depth ?? 0),
      ),
    [placed, projected],
  );
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  const focus = selectedNode?.id;
  const queryActive = query.trim() !== "";
  const sphereMesh = mode === "2D" && shape === "sphere";
  const meshOpacity =
    focus || queryActive
      ? 0.025
      : placed.length > 200
        ? (sphereMesh ? 0.11 : 0.14)
        : placed.length > 60
          ? (sphereMesh ? 0.15 : 0.19)
          : (sphereMesh ? 0.2 : 0.24);
  const neighbours = useMemo(() => {
    const ids = new Set<string>();
    if (focus) ids.add(focus);
    for (const edge of graph.edges) {
      if (edge.from === focus) ids.add(edge.to);
      if (edge.to === focus) ids.add(edge.from);
    }
    return ids;
  }, [graph, focus]);
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? graph.nodes.filter((node) =>
          `${node.label} ${node.kind === "document" ? (node.cluster ?? "") : ""}`
            .toLocaleLowerCase()
            .includes(term),
        )
      : [];
  }, [graph, query]);
  const matched = useMemo(
    () => new Set(matches.map((node) => node.id)),
    [matches],
  );

  // Labels are placed in screen space and rejected on collision, including after zoom.
  const labels = useMemo(() => {
    const result = new Map<string, { x: number; y: number; text: string }>();
    if (!showLabels && !focus && matched.size === 0) return result;
    const occupied: Array<{ x: number; y: number; w: number }> = [];
    const priority = (node: GraphNode) =>
      node.id === focus
        ? 10000
        : matched.has(node.id)
          ? 5000
          : showLabels && node.kind === "conclusion"
            ? 1000
            : showLabels && node.kind === "document"
              ? 100 + (node.weight ?? 1)
              : 0;
    const candidates = [...placed].sort((a, b) => priority(b) - priority(a));
    for (const node of candidates) {
      if (result.size >= 18 && node.id !== focus) break;
      if (priority(node) === 0) break;
      if (focus && !neighbours.has(node.id) && !matched.has(node.id)) continue;
      const at = projected.get(node.id)!;
      if (
        mode === "3D" &&
        at.depth < -0.2 &&
        node.id !== focus &&
        !matched.has(node.id)
      )
        continue;
      const text =
        node.label.length > 25 ? `${node.label.slice(0, 24)}…` : node.label;
      const w = [...text].reduce(
        (sum, char) => sum + (char.charCodeAt(0) > 255 ? 11 : 6.2),
        0,
      );
      const centreX = (at.x - box.x) / unit;
      const gap = radius(node) + 7;
      const right = centreX + gap;
      const x = right + w <= size.w - 12 ? right : centreX - gap - w;
      const y = (at.y - box.y) / unit + 4;
      if (x < 0 || x + w > size.w - 12 || y < 18 || y > size.h - 12) continue;
      if (
        occupied.some(
          (label) =>
            Math.abs(label.y - y) < 18 &&
            x < label.x + label.w + 12 &&
            x + w + 12 > label.x,
        )
      )
        continue;
      occupied.push({ x, y, w });
      result.set(node.id, { x: box.x + x * unit, y: box.y + y * unit, text });
    }
    return result;
  }, [
    placed,
    projected,
    focus,
    neighbours,
    matched,
    showLabels,
    mode,
    box.x,
    box.y,
    unit,
    size,
  ]);

  function zoom(factor: number, px = 0.5, py = 0.5) {
    setView((current) => {
      const from = current ?? { x: 0, y: 0, w: size.w, h: size.h };
      const w = Math.min(size.w * 3, Math.max(size.w / 12, from.w * factor));
      const h = (w * size.h) / size.w;
      return {
        x: from.x + (from.w - w) * px,
        y: from.y + (from.h - h) * py,
        w,
        h,
      };
    });
  }
  function activate(node: GraphNode) {
    setSelected(node.id);
    setError(null);
    const source = documentSource(node.id);
    if (source !== null) {
      if (mode === "3D") {
        const point = placed.find((item) => item.id === node.id)!;
        setRotation({
          yaw: Math.atan2(-point.x, point.z),
          pitch: Math.atan2(-point.y, Math.hypot(point.x, point.z)),
        });
      }
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(source)) next.add(source);
        return next;
      });
    } else onSelect(node.id);
  }
  function locate(node: GraphNode) {
    setSelected(node.id);
    setQuery("");
    const at = projected.get(node.id)!;
    setView({
      x: at.x - size.w / 4,
      y: at.y - size.h / 4,
      w: size.w / 2,
      h: size.h / 2,
    });
  }
  const selectedSource = selectedNode ? documentSource(selectedNode.id) : null;
  const selectedChunks =
    selectedSource === null
      ? []
      : material.filter((item) => item.sourceFile === selectedSource);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--mdx-content-bg)] text-base-content @container">
      <div ref={frame} className="relative min-h-0 min-w-0 flex-1">
        {graph.nodes.length > 0 && (
          <svg
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            className="absolute inset-0 block size-full cursor-grab touch-none select-none active:cursor-grabbing"
            role="img"
            aria-label="记忆关系图"
            onWheel={(event) => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              zoom(
                Math.exp(event.deltaY * 0.0015),
                (event.clientX - rect.left) / rect.width,
                (event.clientY - rect.top) / rect.height,
              );
            }}
            onPointerDown={(event) => {
              // Dragging must not also select the SVG: WebKit paints that
              // native selection across the entire canvas.
              event.preventDefault();
              suppressClick.current = false;
              press.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                dragged: false,
              };
            }}
            onPointerMove={(event) => {
              const from = press.current;
              if (!from) return;
              if (!from.dragged) {
                if (
                  Math.hypot(event.clientX - from.x, event.clientY - from.y) <= 4
                )
                  return;
                from.dragged = true;
                suppressClick.current = true;
                event.currentTarget.setPointerCapture(from.id);
              }
              const dx = event.clientX - from.x;
              const dy = event.clientY - from.y;
              from.x = event.clientX;
              from.y = event.clientY;
              if (mode === "3D")
                setRotation((current) => ({
                  yaw: current.yaw + dx / 250,
                  pitch: Math.max(
                    -1.35,
                    Math.min(1.35, current.pitch + dy / 250),
                  ),
                }));
              else
                setView((current) => {
                  const from = current ?? { x: 0, y: 0, w: size.w, h: size.h };
                  return {
                    ...from,
                    x: from.x - (dx * from.w) / size.w,
                    y: from.y - (dy * from.h) / size.h,
                  };
                });
            }}
            onPointerUp={(event) => {
              if (press.current?.dragged)
                event.currentTarget.releasePointerCapture(event.pointerId);
              press.current = null;
            }}
            onPointerCancel={() => {
              press.current = null;
              suppressClick.current = true;
            }}
            onClick={(event) => {
              if (
                !suppressClick.current &&
                event.target === event.currentTarget
              )
                setSelected(null);
            }}
          >
            {(["back", "front"] as const).map(
              (side) =>
                mesh[side] && (
                  <path
                    key={side}
                    data-mesh-edge=""
                    d={mesh[side]}
                    pointerEvents="none"
                    stroke="#40a9b2"
                    strokeWidth={0.65}
                    vectorEffect="non-scaling-stroke"
                    fill="none"
                    opacity={side === "back" ? meshOpacity / 2 : meshOpacity}
                  />
                ),
            )}
            {graph.edges.map((edge) => {
              const from = projected.get(edge.from),
                to = projected.get(edge.to);
              if (!from || !to) return null;
              const active =
                edge.from === focus ||
                edge.to === focus ||
                edge.from === hovered ||
                edge.to === hovered;
              const stroke =
                edge.kind === "contradicts"
                  ? "var(--color-error)"
                  : edge.kind === "holds"
                    ? "#3fa3ad"
                    : edge.kind === "verifies"
                      ? COLORS.verification
                      : edge.kind === "similar"
                        ? "#3b7ddd"
                        : COLORS.adopted;
              return (
                <line
                  key={`${edge.from}-${edge.to}-${edge.kind}`}
                  data-edge-kind={edge.kind}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={stroke}
                  opacity={
                    active
                      ? 0.88
                      : focus
                        ? 0.055
                        : edge.kind === "holds"
                          ? 0.28
                          : 0.42
                  }
                  strokeWidth={active ? 1.35 : edge.kind === "holds" ? 0.65 : 0.75}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray={edge.kind === "similar" ? "4 4" : undefined}
                />
              );
            })}
            {drawOrder.map((node) => {
              const at = projected.get(node.id)!;
              const active =
                node.id === focus ||
                node.id === hovered ||
                matched.has(node.id);
              const dim =
                (focus && !neighbours.has(node.id)) ||
                (queryActive && !matched.has(node.id));
              const depthScale =
                mode === "3D" ? 0.72 + (at.depth + 1) * 0.22 : 1;
              const r = radius(node) * depthScale * unit;
              const anchor = node.cluster
                ? (documentAnchors.get(node.cluster) ?? node)
                : node;
              const fill = nodeColor(node, anchor);
              const highlight = active ? "var(--color-base-content)" : undefined;
              // A hover label is added locally; the overview labels never reflow on hover.
              const label =
                labels.get(node.id) ??
                (node.id === hovered || node.id === focus
                  ? {
                      x: at.x + (radius(node) + 7) * unit,
                      y: at.y - (radius(node) + 7) * unit,
                      text:
                        node.label.length > 25
                          ? `${node.label.slice(0, 24)}…`
                          : node.label,
                    }
                  : undefined);
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={node.label}
                  className="cursor-pointer outline-none"
                  opacity={
                    dim
                      ? 0.16
                      : mode === "3D"
                        ? 0.35 + (at.depth + 1) * 0.325
                        : 1
                  }
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(node.id)}
                  onBlur={() => setHovered(null)}
                  onClick={() => {
                    if (!suppressClick.current) activate(node);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      activate(node);
                    }
                  }}
                >
                  <title>{`${node.label}${node.kind === "document" ? ` · ${node.weight} 条素材` : ""}`}</title>
                  <circle
                    cx={at.x}
                    cy={at.y}
                    r={Math.max(8 * unit, r * 2)}
                    fill="transparent"
                  />
                  <circle
                    cx={at.x}
                    cy={at.y}
                    r={r * (active ? 3.4 : 2.5)}
                    fill={fill}
                    opacity={
                      active ? 0.26 : node.kind === "material" ? 0.14 : 0.18
                    }
                    pointerEvents="none"
                  />
                  {node.kind === "conclusion" && (
                    <circle
                      cx={at.x}
                      cy={at.y}
                      r={r * 1.55}
                      fill="none"
                      stroke={fill}
                      strokeWidth={0.9}
                      opacity={0.55}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                  {node.kind === "verification" ? (
                    <path
                      d={`M ${at.x} ${at.y - r} l ${r} ${r} l ${-r} ${r} l ${-r} ${-r} Z`}
                      fill={fill}
                      stroke={highlight}
                      strokeWidth={active ? 1.4 : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : (
                    <circle
                      cx={at.x}
                      cy={at.y}
                      r={r}
                      fill={fill}
                      stroke={highlight}
                      strokeWidth={active ? 1.4 : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {label && (
                    <text
                      x={label.x}
                      y={label.y}
                      fontSize={11 * unit}
                      fill="var(--color-base-content)"
                      stroke="var(--color-base-100)"
                      strokeWidth={4 * unit}
                      strokeLinejoin="round"
                      style={{ paintOrder: "stroke" }}
                      pointerEvents="none"
                    >
                      {label.text}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {graph.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-base-content/65">
            这个范围还没有素材。导入素材或切换到全部项目后查看关系。
          </div>
        )}
        {selectedNode && (
          <aside className="absolute right-4 top-16 z-20 w-72 max-w-[calc(100%-2rem)] rounded-[var(--mdx-panel-radius)] bg-base-100/92 p-4 text-xs shadow-[var(--mdx-panel-shadow)] backdrop-blur-md @max-[720px]:top-40">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5 break-all leading-relaxed">
                <Chip
                  tone={selectedNode.kind === "conclusion" ? "warning" : "neutral"}
                >
                  {NODE_KIND_LABELS[selectedNode.kind]}
                </Chip>
                {selectedNode.label}
              </div>
              <TextControlButton
                aria-label="关闭"
                onClick={() => setSelected(null)}
              >
                ×
              </TextControlButton>
            </div>
            {selectedSource !== null ? (
              <>
                <p className="mb-3 text-base-content/65">
                  {selectedChunks.length} 条素材 ·{" "}
                  {expanded.has(selectedSource)
                    ? "点击节点收起"
                    : "点击节点展开"}
                </p>
                <ul className="max-h-60 space-y-1 overflow-y-auto">
                  {selectedChunks.map((chunk) => (
                    <li key={chunk.drawerId}>
                      <button
                        className="w-full rounded-md p-2 text-left leading-relaxed text-base-content/80 hover:bg-base-content/5"
                        onClick={() => onSelect(chunk.drawerId)}
                      >
                        {chunk.excerpt.slice(0, 100) || chunk.drawerId}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="flex gap-2">
                <PrimaryTextControlButton onClick={() => onSelect(selectedNode.id)}>
                  查看全文
                </PrimaryTextControlButton>
                <TextControlButton
                  disabled={searching}
                  onClick={async () => {
                    const id = selectedNode.id;
                    setSearching(true);
                    setError(null);
                    try {
                      const ids = await onFindSimilar(id);
                      setSimilar((current) => ({ ...current, [id]: ids }));
                    } catch (reason) {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      );
                    } finally {
                      setSearching(false);
                    }
                  }}
                >
                  {searching ? "查找中…" : "找相似"}
                </TextControlButton>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-2 text-error">
                {error}
              </p>
            )}
          </aside>
        )}
      </div>
      {graph.nodes.length > 0 && (
        <>
          <div className="absolute left-4 top-4 z-10 flex max-w-[min(460px,calc(100%-2rem))] flex-wrap items-center gap-2.5 rounded-[var(--mdx-panel-radius)] bg-base-100/85 px-3 py-2 shadow-[var(--mdx-panel-shadow)] backdrop-blur-md focus-within:z-30 @max-[720px]:top-16">
            <div>
              <div className="text-sm font-medium">记忆图谱</div>
              <div className="text-[11px] text-base-content/65">
                已加载 {graph.nodes.length} 个节点 · {graph.edges.length} 条连接
              </div>
            </div>
            <div
              className="relative min-w-[min(10rem,100%)] flex-1"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  event.target instanceof HTMLInputElement &&
                  matches[0]
                )
                  locate(matches[0]);
                if (event.key === "Escape") setQuery("");
              }}
            >
              <SearchField
                label="搜索图谱"
                placeholder="搜索文档、素材或结论…"
                value={query}
                onChange={setQuery}
              />
              {queryActive && (
                <div className="absolute inset-x-0 top-full mt-2 rounded-[var(--mdx-panel-radius)] bg-base-100/95 p-1.5 shadow-[var(--mdx-panel-shadow)] backdrop-blur-md">
                  <div className="px-2 py-1 text-[11px] text-base-content/65">
                    {matches.length
                      ? `${matches.length} 个匹配 · 选择以定位`
                      : "没有匹配的节点"}
                  </div>
                  {matches.slice(0, 7).map((node) => (
                    <TextControlButton
                      key={node.id}
                      className="w-full"
                      onClick={() => locate(node)}
                    >
                      <span className="w-full truncate text-left">
                        {node.label}
                      </span>
                    </TextControlButton>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-[var(--mdx-panel-radius)] bg-base-100/85 p-1.5 shadow-[var(--mdx-panel-shadow)] backdrop-blur-md">
            <SegmentedControl
              label="图谱维度"
              value={mode}
              options={[
                { value: "2D", label: "2D" },
                { value: "3D", label: "3D" },
              ]}
              onChange={(value) => {
                setMode(value);
                setView(null);
              }}
            />
            {mode === "2D" && (
              <SegmentedControl
                label="图谱形态"
                value={shape}
                options={[
                  { value: "ring", label: "环形" },
                  { value: "sphere", label: "星团" },
                ]}
                onChange={(value) => {
                  setShape(value);
                  setView(null);
                }}
              />
            )}
            <TextControlButton
              aria-pressed={detail}
              onClick={() => {
                setDetail(!detail);
                setCollapsed(new Set());
              }}
            >
              {detail ? "收起分块" : "展开分块"}
            </TextControlButton>
            <TextControlButton
              aria-pressed={showLabels}
              className="aria-pressed:bg-base-content/10 aria-pressed:text-base-content"
              onClick={() => setShowLabels(!showLabels)}
            >
              标签
            </TextControlButton>
          </div>
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-[var(--mdx-panel-radius)] bg-base-100/85 p-1 shadow-[var(--mdx-panel-shadow)] backdrop-blur-md">
            <TextControlButton aria-label="放大" onClick={() => zoom(1 / 1.4)}>
              ＋
            </TextControlButton>
            <TextControlButton aria-label="缩小" onClick={() => zoom(1.4)}>
              −
            </TextControlButton>
            <TextControlButton
              onClick={() => {
                setView(null);
                setRotation({ yaw: 0, pitch: 0 });
                setSelected(null);
                setQuery("");
              }}
            >
              复位
            </TextControlButton>
          </div>
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex max-w-[calc(100%-9rem)] flex-wrap items-center gap-x-3.5 gap-y-1 rounded-[var(--mdx-panel-radius)] bg-base-100/75 px-3 py-1.5 text-[11px] text-base-content/60 backdrop-blur-md">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-5 rounded-full bg-[linear-gradient(90deg,#3b7ddd,#8b5fbf,#d95f66)]" />
              文档 / 素材
            </span>
            {[
              [COLORS.adopted, "已采纳"],
              [COLORS.candidate, "候选结论"],
              [COLORS.verification, "采纳记录"],
            ].map(([fill, name]) => (
              <span key={name} className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: fill }}
                />
                {name}
              </span>
            ))}
            <span>实线：归属 / 引用 · 虚线：检索相近</span>
            <span>{mode === "2D" ? "拖拽平移" : "拖拽旋转"} · 滚轮缩放</span>
            {graph.missing > 0 && <span>{graph.missing} 条引用素材未加载</span>}
          </div>
        </>
      )}
    </div>
  );
}
