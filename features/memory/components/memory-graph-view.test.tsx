// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryGraphView } from "./memory-graph-view";
import type { StoredItem } from "../lib/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function chunk(id: string, file: string): StoredItem {
  return {
    drawerId: id,
    kind: "material",
    room: "corporate-action",
    sourceFile: file,
    addedAt: "2026-08-14",
    importance: 0,
    statement: null,
    status: null,
    excerpt: `素材 ${id}`,
    supportingRefs: [],
    verificationRefs: [],
    counterexampleRefs: [],
  };
}

/** A pointer event jsdom can build: React dispatches by type, not by class. */
function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
}

describe("MemoryGraphView", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function mount(
    overrides: {
      material?: StoredItem[];
      onSelect?: (drawerId: string) => void;
    } = {},
  ) {
    act(() => {
      root.render(
        <MemoryGraphView
          material={
            overrides.material ?? [
              chunk("ev_1", "notes/one.md"),
              chunk("ev_2", "notes/one.md"),
              chunk("ev_3", "notes/one.md"),
            ]
          }
          conclusions={[]}
          onSelect={overrides.onSelect ?? (() => {})}
          onFindSimilar={async () => []}
        />,
      );
    });
  }

  it("does not take the pointer until it is dragged", () => {
    // Capturing on pointerdown is what made the dots unclickable: while a capture
    // is active the browser retargets the click to the capturing element, so every
    // click landed on the canvas and nothing drawn on it could be pressed.
    mount();

    const svg = host.querySelector("svg");

    if (!svg) throw new Error("Expected the canvas to be rendered.");

    const capture = vi.fn();
    svg.setPointerCapture = capture;
    svg.releasePointerCapture = vi.fn();

    act(() => {
      svg.dispatchEvent(pointer("pointerdown", 100, 100));
      svg.dispatchEvent(pointer("pointermove", 101, 101));
    });

    expect(capture).not.toHaveBeenCalled();

    act(() => {
      svg.dispatchEvent(pointer("pointermove", 140, 130));
    });

    // Past the slop it is a pan, and then the capture is what keeps panning working
    // when the pointer leaves the canvas.
    expect(capture).toHaveBeenCalled();
  });

  it.each(["2D", "3D"])(
    "prevents native selection on the %s canvas without swallowing node clicks",
    (mode) => {
      const onSelect = vi.fn();
      mount({ onSelect });
      act(() => {
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === mode)!
          .click();
      });
      const svg = host.querySelector("svg")!;
      const node = host.querySelector('[data-node-id="ev_1"]')!;
      for (const target of [svg, node]) {
        const down = pointer("pointerdown", 100, 100);
        act(() => {
          target.dispatchEvent(down);
          target.dispatchEvent(pointer("pointerup", 100, 100));
        });
        expect(down.defaultPrevented).toBe(true);
      }
      act(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(onSelect).toHaveBeenCalledWith("ev_1");

      const inputDown = pointer("pointerdown", 10, 10);
      act(() => host.querySelector("input")!.dispatchEvent(inputDown));
      expect(inputDown.defaultPrevented).toBe(false);
    },
  );

  it("shows real document–chunk links by default and collapses on click", () => {
    mount();

    // The document and its three source chunks are visible on first open.
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(4);
    expect(host.querySelectorAll("[data-edge-kind=holds]")).toHaveLength(3);

    const node = host.querySelector('[data-node-id="doc:notes/one.md"]');

    act(() => {
      node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-edge-kind=holds]")).toHaveLength(0);
  });

  it("says what a clicked document holds, and opens a chunk from the card", () => {
    // A document node has no entry of its own, and its click used to be a dead
    // end: more dots, no way to read anything. The card is the content path.
    const onSelect = vi.fn();
    mount({ onSelect });

    act(() => {
      host
        .querySelector('[data-node-id="doc:notes/one.md"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const card = host.querySelector("ul");

    if (!card) throw new Error("Expected the selection card to list chunks.");

    const rows = card.querySelectorAll("button");

    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("素材 ev_1");

    act(() => {
      rows[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("ev_1");
  });

  it("opens an entry when a chunk is clicked", () => {
    const onSelect = vi.fn();
    // A chunk with no source file is drawn on its own, with no document above it.
    mount({ material: [{ ...chunk("ev_1", ""), sourceFile: null }], onSelect });

    act(() => {
      host
        .querySelector('[data-node-id="ev_1"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("ev_1");
  });
  it("searches loaded nodes and locates the selected result", () => {
    mount();
    const input = host.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "one.md");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("1 个匹配");
    const result = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "one.md",
    )!;
    act(() => result.click());
    expect(host.querySelector("aside")?.textContent).toContain("one.md");
    expect(input.value).toBe("");
    expect(
      host.querySelector("svg")?.getAttribute("viewBox")?.split(" ").slice(2),
    ).toEqual(["450", "280"]);
  });

  it("pans the default 2D map and does not open a node after dragging", () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    const svg = host.querySelector("svg")!;
    svg.setPointerCapture = vi.fn();
    svg.releasePointerCapture = vi.fn();
    act(() => {
      svg.dispatchEvent(pointer("pointerdown", 100, 100));
      svg.dispatchEvent(pointer("pointermove", 140, 130));
      svg.dispatchEvent(pointer("pointerup", 140, 130));
      host
        .querySelector('[data-node-id="ev_1"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(svg.getAttribute("viewBox")).toBe("-40 -30 900 560");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("supports keyboard activation, overview, and 3D without losing nodes", () => {
    mount();
    const doc = host.querySelector('[data-node-id="doc:notes/one.md"]')!;
    act(() =>
      doc.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(1);
    act(() =>
      doc.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(4);
    const button = (text: string) =>
      [...host.querySelectorAll("button")].find(
        (item) => item.textContent === text,
      )!;
    act(() => button("3D").click());
    expect(button("3D").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(4);
    act(() => button("收起分块").click());
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(1);
  });

  it("shows the empty state and accepts data arriving after mount", () => {
    mount({ material: [] });
    expect(host.textContent).toContain("这个范围还没有素材");
    mount();
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(4);
  });
  it("highlights a hovered node without dimming or relabelling the rest of the map", () => {
    mount({
      material: [chunk("ev_1", "notes/one.md"), chunk("ev_2", "notes/two.md")],
    });
    const first = host.querySelector('[data-node-id="doc:notes/one.md"]')!;
    const other = host.querySelector('[data-node-id="doc:notes/two.md"]')!;
    const otherEdge = host.querySelectorAll("line")[1];
    const opacity = other.getAttribute("opacity");
    const edgeOpacity = otherEdge.getAttribute("opacity");
    const label = other.querySelector("text")?.outerHTML;
    act(() =>
      first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    expect(other.getAttribute("opacity")).toBe(opacity);
    expect(otherEdge.getAttribute("opacity")).toBe(edgeOpacity);
    expect(other.querySelector("text")?.outerHTML).toBe(label);
    act(() =>
      first.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
    );
    expect(other.getAttribute("opacity")).toBe(opacity);
  });

  it("keeps the clicked neighbourhood fixed while hovering other nodes", () => {
    mount({
      material: [chunk("ev_1", "notes/one.md"), chunk("ev_2", "notes/two.md")],
    });
    const first = host.querySelector('[data-node-id="doc:notes/one.md"]')!;
    const other = host.querySelector('[data-node-id="doc:notes/two.md"]')!;
    act(() => first.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(first.getAttribute("opacity")).toBe("1");
    expect(other.getAttribute("opacity")).toBe("0.16");
    act(() =>
      other.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    expect(first.getAttribute("opacity")).toBe("1");
    expect(first.querySelector("text")).not.toBeNull();
  });
});
