// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorStage } from "./editor-stage";
import { createEditorSessionBinding } from "@/features/editor/lib/editor-session-binding";
import type { MarkdownEditorSurfaceHandle } from "@/features/editor/components/markdown-editor-surface";
import type { WorkspaceAction, WorkspaceTab } from "../lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
const imageStorageMocks = vi.hoisted(() => ({
  loadImage: vi.fn(async () => ""),
  storeImageForWorkspace: vi.fn(),
}));

vi.mock("@/common/lib/tauri", () => ({
  tauriCore: async () => ({ invoke }),
}));

vi.mock("@/common/lib/image-storage", () => ({
  loadImage: imageStorageMocks.loadImage,
  storeImageForWorkspace: imageStorageMocks.storeImageForWorkspace,
}));

vi.mock("./html-preview", () => ({
  HtmlPreview: ({ path }: { path: string }) => (
    <div data-testid="html-preview">{path}</div>
  ),
}));

describe("EditorStage preview routing", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    invoke.mockResolvedValue("plain text");
    imageStorageMocks.storeImageForWorkspace.mockResolvedValue({
      altText: "clip.png",
      storedPath: "/tmp/ws/.assets/clip.png",
      url: ".assets/clip.png",
      usedFallback: false,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("routes mhtml files to HtmlPreview instead of TextPreview", async () => {
    await renderStage({
      tabId: "tab-1",
      path: "/tmp/ws/archive.mhtml",
      title: "archive.mhtml",
      dirty: false,
      needsRenameOnFirstSave: false,
    });

    expect(host.querySelector("[data-testid='html-preview']")).not.toBeNull();
    expect(host.querySelector("pre")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "read_preview_text_file",
      expect.anything(),
    );
  });

  it("keeps txt files on TextPreview", async () => {
    await renderStage({
      tabId: "tab-2",
      path: "/tmp/ws/notes.txt",
      title: "notes.txt",
      dirty: false,
      needsRenameOnFirstSave: false,
    });

    expect(host.querySelector("[data-testid='html-preview']")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe("plain text");
  });

  it("routes markdown tabs to the Markdown editor surface", async () => {
    await renderStage({
      tabId: "tab-4",
      path: "/tmp/ws/note.md",
      title: "note.md",
      dirty: false,
      needsRenameOnFirstSave: false,
      markdown: "# Note",
    });

    expect(
      host.querySelector("[data-mdx-markdown-editor-surface]"),
    ).not.toBeNull();
  });

  async function renderStage(
    activeTab: WorkspaceTab,
    options: {
      editorSurfaceRef?: { current: MarkdownEditorSurfaceHandle | null };
      onSelectionChange?: (
        tabId: string,
        selection: Record<string, unknown> | null,
      ) => void;
    } = {},
  ) {
    await act(async () => {
      root.render(
        <EditorStage
          rootPath="/tmp/ws"
          activeTab={activeTab}
          dispatch={vi.fn()}
          editorSession={createEditorSessionBinding()}
          editorSurfaceRef={options.editorSurfaceRef}
          pendingCliCommand={null}
          onPendingCliCommandHandled={vi.fn()}
          onSelectionChange={options.onSelectionChange ?? vi.fn()}
        />,
      );
      await flushPromises();
    });
  }
});

describe("EditorStage adapter surface wiring", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    imageStorageMocks.storeImageForWorkspace.mockResolvedValue({
      altText: "clip.png",
      storedPath: "/tmp/ws/.assets/clip.png",
      url: ".assets/clip.png",
      usedFallback: false,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  const tab: WorkspaceTab = {
    tabId: "tab-q",
    path: "/tmp/ws/Purpose.md",
    title: "Purpose.md",
    dirty: false,
    needsRenameOnFirstSave: false,
    markdown: "alpha beta gamma\n",
  };

  it("stores a pasted image through the workspace asset path and inserts it", async () => {
    const editorSurfaceRef: { current: MarkdownEditorSurfaceHandle | null } = {
      current: null,
    };
    const onSelectionChange = vi.fn();
    await renderQualificationStage(tab, { editorSurfaceRef, onSelectionChange });

    const surface = host.querySelector(".ProseMirror");
    expect(surface).not.toBeNull();

    const file = new File(["image"], "clip.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [file], items: [], types: ["Files"], getData: () => "" },
    });

    await act(async () => {
      surface?.dispatchEvent(event);
      await flushPromises();
    });

    expect(imageStorageMocks.storeImageForWorkspace).toHaveBeenCalledWith(file, {
      currentFilePath: "/tmp/ws/Purpose.md",
      rootPath: "/tmp/ws",
    });
  });

  it("writes a stored image link into the document exactly as it was handed over", async () => {
    // A document below the workspace root gets a link that climbs back to the
    // one .assets directory. Nothing between the store and the document may
    // rewrite it, or it stops pointing at the file that was just written.
    imageStorageMocks.storeImageForWorkspace.mockResolvedValue({
      altText: "clip.png",
      storedPath: "/tmp/ws/.assets/clip.png",
      url: "../../.assets/clip.png",
      usedFallback: false,
    });
    const dispatch = vi.fn();
    const editorSurfaceRef: { current: MarkdownEditorSurfaceHandle | null } = {
      current: null,
    };
    await renderQualificationStage(
      {
        tabId: "tab-nested",
        path: "/tmp/ws/docs/plans/Untitled.md",
        title: "Untitled.md",
        dirty: false,
        needsRenameOnFirstSave: false,
        markdown: "alpha\n",
      },
      { editorSurfaceRef, onSelectionChange: vi.fn(), dispatch },
    );

    const surface = host.querySelector(".ProseMirror");
    const file = new File(["image"], "clip.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [file], items: [], types: ["Files"], getData: () => "" },
    });

    await act(async () => {
      surface?.dispatchEvent(event);
      await flushPromises();
    });

    const markdown = dispatch.mock.calls
      .map(([action]) => action as WorkspaceAction)
      .filter((action) => action.type === "tab/contentChanged")
      .at(-1);
    expect(markdown).toBeDefined();
    expect(markdown).toMatchObject({
      markdown: expect.stringContaining("(../../.assets/clip.png)"),
    });
  });

  it("publishes a surface handle that reveals a Markdown source range", async () => {
    const editorSurfaceRef: { current: MarkdownEditorSurfaceHandle | null } = {
      current: null,
    };
    const onSelectionChange = vi.fn();
    await renderQualificationStage(tab, { editorSurfaceRef, onSelectionChange });

    expect(editorSurfaceRef.current).not.toBeNull();

    await act(async () => {
      await editorSurfaceRef.current?.reveal({ anchor: 6, head: 10 });
    });

    expect(onSelectionChange).toHaveBeenCalledWith(
      "tab-q",
      expect.objectContaining({ selected_text: "beta" }),
    );
  });

  async function renderQualificationStage(
    activeTab: WorkspaceTab,
    options: {
      editorSurfaceRef: { current: MarkdownEditorSurfaceHandle | null };
      onSelectionChange: (
        tabId: string,
        selection: Record<string, unknown> | null,
      ) => void;
      dispatch?: (action: WorkspaceAction) => void;
    },
  ) {
    await act(async () => {
      root.render(
        <EditorStage
          rootPath="/tmp/ws"
          activeTab={activeTab}
          dispatch={options.dispatch ?? vi.fn()}
          editorSession={createEditorSessionBinding()}
          editorSurfaceRef={options.editorSurfaceRef}
          pendingCliCommand={null}
          onPendingCliCommandHandled={vi.fn()}
          onSelectionChange={options.onSelectionChange}
        />,
      );
      await flushPromises();
    });
  }
});

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
