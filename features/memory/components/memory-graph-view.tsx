"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredItem } from "../lib/types";
import {
  buildMemoryGraph,
  documentSource,
  placeGraph,
  type GraphNode,
} from "../lib/memory-graph";
import { placeGraph2D } from "../lib/memory-graph-layout";

interface MemoryGraphViewProps {
  material: StoredItem[];
  conclusions: StoredItem[];
  onSelect: (drawerId: string) => void;
  onFindSimilar: (drawerId: string) => Promise<string[]>;
}

const COLORS = {
  document: "var(--color-primary)",
  material: "var(--color-info)",
  verification: "var(--color-accent)",
  adopted: "var(--color-warning)",
  candidate:
    "color-mix(in srgb, var(--color-warning) 65%, var(--color-base-content))",
};
const pixel = (value: number) => Math.round(value * 1000) / 1000;
const control =
  "rounded-lg px-3 py-1.5 text-xs text-base-content/80 transition-colors hover:bg-base-content/10 focus-visible:outline-2 focus-visible:outline-primary";
function color(node: GraphNode) {
  return node.kind === "conclusion"
    ? COLORS[
        node.status === "promoted" || node.status === "canonical"
          ? "adopted"
          : "candidate"
      ]
    : COLORS[node.kind];
}
function radius(node: GraphNode) {
  return node.kind === "conclusion"
    ? 6.5
    : node.kind === "document"
      ? 3 + Math.min(4, Math.sqrt(node.weight ?? 1) * 0.6)
      : node.kind === "verification"
        ? 3.5
        : 2;
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
  const [detail, setDetail] = useState(true);
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
    () => (mode === "2D" ? placeGraph2D(graph) : placeGraph(graph)),
    [graph, mode],
  );
  const projected = useMemo(
    () =>
      new Map(
        placed.map((node) => {
          if (mode === "2D")
            return [
              node.id,
              {
                x: pixel(size.w / 2 + node.x * size.w * 0.47),
                y: pixel(size.h / 2 + node.y * size.h * 0.46),
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
      ),
    [placed, size, rotation, mode],
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
    const occupied: Array<{ x: number; y: number; w: number }> = [];
    const result = new Map<string, { x: number; y: number; text: string }>();
    const priority = (node: GraphNode) =>
      node.id === focus
        ? 10000
        : matched.has(node.id)
          ? 5000
          : node.kind === "conclusion"
            ? 1000
            : node.kind === "document"
              ? 100 + (node.weight ?? 1)
              : 0;
    const candidates = [...placed].sort((a, b) => priority(b) - priority(a));
    for (const node of candidates) {
      if (result.size >= 18 && node.id !== focus) break;
      if (priority(node) === 0 || (focus && !neighbours.has(node.id))) continue;
      const at = projected.get(node.id)!;
      if (mode === "3D" && at.depth < -0.2 && node.id !== focus) continue;
      const text =
        node.label.length > 25 ? `${node.label.slice(0, 24)}…` : node.label;
      const w = [...text].reduce(
        (sum, char) => sum + (char.charCodeAt(0) > 255 ? 11 : 6.2),
        0,
      );
      const x = (at.x - box.x) / unit + radius(node) + 7;
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base-100 text-base-content">
      <div className="flex flex-wrap items-center gap-3 border-b border-base-content/10 px-5 py-3">
        <div className="mr-2">
          <div className="text-sm font-medium tracking-wide">记忆图谱</div>
          <div className="mt-0.5 text-[11px] text-base-content/65">
            已加载 {graph.nodes.length} 个节点 · {graph.edges.length} 条连接
          </div>
        </div>
        <div className="relative min-w-40 flex-1">
          <input
            aria-label="搜索图谱"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) locate(matches[0]);
              if (event.key === "Escape") setQuery("");
            }}
            placeholder="搜索文档、素材或结论…"
            className="w-full rounded-lg border border-base-content/15 bg-base-200 px-3 py-2 text-xs text-base-content outline-none placeholder:text-base-content/65 focus:border-primary/70"
          />
          {query.trim() && (
            <div className="absolute left-0 right-0 top-full z-20 mt-2 rounded-lg border border-base-content/15 bg-base-200 p-2 shadow-xl">
              <div className="px-2 py-1 text-[11px] text-base-content/65">
                {matches.length
                  ? `${matches.length} 个匹配 · 选择以定位`
                  : "没有匹配的节点"}
              </div>
              {matches.slice(0, 7).map((node) => (
                <button
                  key={node.id}
                  className={`${control} block w-full truncate text-left`}
                  onClick={() => locate(node)}
                >
                  {node.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex rounded-lg bg-base-200 p-1" aria-label="图谱维度">
          {(["2D", "3D"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={mode === value}
              className={`${control} ${mode === value ? "bg-base-content/10 text-base-content" : ""}`}
              onClick={() => {
                setMode(value);
                setView(null);
              }}
            >
              {value}
            </button>
          ))}
        </div>
        <button
          aria-pressed={detail}
          className={`${control} border border-base-content/15`}
          onClick={() => {
            setDetail(!detail);
            setCollapsed(new Set());
          }}
        >
          {detail ? "收起分块" : "展开分块"}
        </button>
        <div className="flex items-center gap-0.5 border-l border-base-content/15 pl-2">
          <button
            className={control}
            aria-label="放大"
            onClick={() => zoom(1 / 1.4)}
          >
            ＋
          </button>
          <button
            className={control}
            aria-label="缩小"
            onClick={() => zoom(1.4)}
          >
            −
          </button>
          <button
            className={control}
            onClick={() => {
              setView(null);
              setRotation({ yaw: 0, pitch: 0 });
              setSelected(null);
              setQuery("");
            }}
          >
            复位
          </button>
        </div>
      </div>
      <div
        ref={frame}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {graph.nodes.length > 0 && (
          <svg
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            className="block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
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
                  Math.hypot(event.clientX - from.x, event.clientY - from.y) < 4
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
                    ? COLORS.document
                    : edge.kind === "verifies"
                      ? COLORS.verification
                      : edge.kind === "similar"
                        ? COLORS.material
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
                      ? 0.85
                      : focus
                        ? 0.055
                        : edge.kind === "holds"
                          ? 0.32
                          : 0.55
                  }
                  strokeWidth={active ? 1.4 : 0.7}
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
                (query.trim() && !matched.has(node.id));
              const r = radius(node) * unit;
              // A hover label is added locally; the overview labels never reflow on hover.
              const label =
                labels.get(node.id) ??
                (node.id === hovered
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
                  {(active ||
                    node.kind === "conclusion" ||
                    node.kind === "document") && (
                    <circle
                      cx={at.x}
                      cy={at.y}
                      r={r * (active ? 2.6 : 2)}
                      fill={color(node)}
                      opacity={active ? 0.2 : 0.09}
                      pointerEvents="none"
                    />
                  )}
                  {node.kind === "verification" ? (
                    <path
                      d={`M ${at.x} ${at.y - r} l ${r} ${r} l ${-r} ${r} l ${-r} ${-r} Z`}
                      fill={color(node)}
                    />
                  ) : (
                    <circle
                      cx={at.x}
                      cy={at.y}
                      r={r}
                      fill={color(node)}
                      stroke={
                        active ? "var(--color-base-content)" : color(node)
                      }
                      strokeWidth={active ? 1.5 : 0.4}
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
          <aside className="absolute right-4 top-4 w-72 max-w-[80%] rounded-xl border border-base-content/15 bg-base-200 p-4 text-xs shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="break-all leading-relaxed text-base-content">
                {selectedNode.label}
              </div>
              <button
                aria-label="关闭"
                className="text-base-content/65 hover:text-base-content"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
            {selectedSource !== null ? (
              <>
                <p className="mb-3 text-base-content/65">
                  文档 · {selectedChunks.length} 条素材 ·{" "}
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
                <button
                  className={control}
                  onClick={() => onSelect(selectedNode.id)}
                >
                  查看全文
                </button>
                <button
                  disabled={searching}
                  className={`${control} disabled:opacity-40`}
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
                </button>
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
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-base-content/10 px-5 py-3 text-[11px] text-base-content/65">
        <div className="flex flex-wrap gap-4">
          {[
            [COLORS.document, "文档"],
            [COLORS.material, "素材"],
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
        </div>
        <span>实线：归属 / 引用 · 虚线：检索相近</span>
        <span className="ml-auto">
          {mode === "2D" ? "拖拽平移" : "拖拽旋转"} · 滚轮缩放 · 点击查看
        </span>
        {graph.missing > 0 && <span>{graph.missing} 条引用素材未加载</span>}
      </div>
    </div>
  );
}
