// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentShell } from "./document-shell";
import type { FrontendFileWatchEvent } from "@/features/file-watch/lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const readDocumentFile = vi.fn();
const draftGet = vi.fn();
const draftDelete = vi.fn();
const close = vi.fn(async () => {});
const destroy = vi.fn(async () => {});
const listen = vi.fn(async () => () => {});
const onCloseRequested = vi.fn(async () => () => {});
const fileWatchOptions: {
  current: { onEvent: (event: FrontendFileWatchEvent) => void } | null;
} = { current: null };

vi.mock("@/common/lib/tauri", () => ({
  tauriCore: async () => ({
    invoke: async (command: string) => {
      if (command === "load_app_state") {
        return {
          preferences: {
            fileTreeExcludeDirs: [],
            fileWatchEnabled: true,
            searchMaxFileBytes: 1048576,
            searchMaxResults: 100,
            searchMaxMatchesPerFile: 20,
          },
        };
      }

      return undefined;
    },
  }),
  tauriDialog: async () => ({}),
  tauriWindow: async () => ({
    getCurrentWindow: () => ({
      close,
      destroy,
      listen,
      onCloseRequested,
    }),
  }),
}));

vi.mock("@/common/lib/image-storage", () => ({
  storeImageForDocument: vi.fn(async () => ""),
}));

vi.mock("@/features/editor/components/markdown-editor-surface", () => ({
  MarkdownEditorSurface: ({ markdown }: { markdown: string }) => (
    <div data-testid="editor">{markdown}</div>
  ),
}));

vi.mock("@/features/file-watch/hooks/use-file-watch", () => ({
  useFileWatch: (options: { onEvent: (event: FrontendFileWatchEvent) => void }) => {
    fileWatchOptions.current = options;
  },
}));

vi.mock("@/features/recovery/hooks/use-draft-autosave", () => ({
  useDraftAutosave: () => ({
    flush: async () => {},
    cancel: () => {},
    createFlushTask: () => async () => {},
  }),
}));

vi.mock("@/features/recovery/lib/draft-client", () => ({
  draftDelete: (input: unknown) => draftDelete(input),
  draftGet: (realPath: string) => draftGet(realPath),
}));

vi.mock("@/features/workspace/components/app-dialogs", () => ({
  useAppDialogs: () => ({
    alert: vi.fn(),
    choice: vi.fn(),
  }),
}));

vi.mock("../lib/document-client", () => ({
  isWorkspacePathDirty: vi.fn(async () => false),
  overwriteDocumentFile: vi.fn(),
  readDocumentFile: (realPath: string) => readDocumentFile(realPath),
  saveDocumentFile: vi.fn(),
}));

describe("DocumentShell draft recovery", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    fileWatchOptions.current = null;
    listen.mockResolvedValue(() => {});
    onCloseRequested.mockResolvedValue(() => {});
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("keeps a pending recovered draft when a clean document auto-reloads from disk", async () => {
    readDocumentFile
      .mockResolvedValueOnce(documentFile("# Disk", "fingerprint-disk"))
      .mockResolvedValueOnce(documentFile("# External", "fingerprint-external"));
    draftGet.mockResolvedValueOnce({
      draft: documentDraft("# Crash draft"),
      fileExists: true,
    });

    await renderDocumentShell(root);

    expect(host.textContent).toContain("发现未保存草稿");

    await act(async () => {
      fileWatchOptions.current?.onEvent({
        kind: "changed",
        path: "/tmp/note.md",
        eventTime: "2026-06-11T00:00:00Z",
        fingerprint: "fingerprint-external",
      });
      await flushPromises();
    });

    expect(host.textContent).toContain("# External");
    expect(draftDelete).not.toHaveBeenCalled();
  });

  it("opens a readonly diff for a recovered draft", async () => {
    readDocumentFile.mockResolvedValueOnce(
      documentFile("# Disk", "fingerprint-disk"),
    );
    draftGet.mockResolvedValueOnce({
      draft: documentDraft("# Crash draft"),
      fileExists: true,
    });

    await renderDocumentShell(root);

    expect(host.textContent).toContain("查看差异");

    await act(async () => {
      getButton("查看差异").click();
      await flushPromises();
    });

    expect(host.textContent).toContain("草稿差异");
    expect(host.textContent).toContain("磁盘版本");
    expect(host.textContent).toContain("草稿");
    expect(host.textContent).toContain("# Crash draft");
  });

  it("keeps the newest external version when disk reads finish out of order", async () => {
    let resolveOlder!: (file: ReturnType<typeof documentFile>) => void;
    let resolveLatest!: (file: ReturnType<typeof documentFile>) => void;
    readDocumentFile
      .mockResolvedValueOnce(documentFile("# Initial", "initial"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLatest = resolve; }));
    draftGet.mockResolvedValueOnce({ draft: null, fileExists: true });
    await renderDocumentShell(root);
    await act(async () => {
      fileWatchOptions.current?.onEvent({ kind: "changed", path: "/tmp/note.md", eventTime: "1", fingerprint: "older" });
      fileWatchOptions.current?.onEvent({ kind: "changed", path: "/tmp/note.md", eventTime: "2", fingerprint: "latest" });
      resolveLatest(documentFile("# Latest", "latest"));
      await flushPromises();
    });
    expect(host.textContent).toContain("# Latest");
    await act(async () => {
      resolveOlder(documentFile("# Older", "older"));
      await flushPromises();
    });
    expect(host.textContent).toContain("# Latest");
    expect(host.textContent).not.toContain("# Older");
  });

  it("keeps the standalone editor body inside the available document height", async () => {
    readDocumentFile.mockResolvedValueOnce(
      documentFile("# Disk", "fingerprint-disk"),
    );
    draftGet.mockResolvedValueOnce({ draft: null, fileExists: true });

    await renderDocumentShell(root);

    const bodyClassName =
      host.querySelector("[data-document-editor-body]")?.className ?? "";
    const gridClassName =
      host.querySelector("[data-document-editor-grid]")?.className ?? "";
    const stageClassName =
      host.querySelector("[data-document-editor-stage]")?.className ?? "";

    expect(bodyClassName).toContain("flex-col");
    expect(bodyClassName).toContain("overflow-hidden");
    expect(bodyClassName).toContain("min-h-0");
    expect(bodyClassName).not.toContain("h-full");
    expect(gridClassName).toContain("flex-1");
    expect(gridClassName).toContain("overflow-hidden");
    expect(stageClassName).not.toContain("h-full");
    expect(stageClassName).toContain("overflow-hidden");
  });

  it("renders macos document shell chrome regions", async () => {
    readDocumentFile.mockResolvedValueOnce(
      documentFile("# Disk", "fingerprint-disk"),
    );
    draftGet.mockResolvedValueOnce({ draft: null, fileExists: true });

    await renderDocumentShell(root);

    expect(host.querySelector("[data-mdx-document-shell]")).not.toBeNull();
    expect(host.querySelector("[data-mdx-document-toolbar]")).not.toBeNull();
  });

  it("destroys clean document windows explicitly on close request", async () => {
    readDocumentFile.mockResolvedValueOnce(
      documentFile("# Disk", "fingerprint-disk"),
    );
    draftGet.mockResolvedValueOnce({ draft: null, fileExists: true });

    await renderDocumentShell(root);
    const closeHandler = onCloseRequested.mock.calls[0]?.[0];
    const preventDefault = vi.fn();

    await act(async () => {
      closeHandler?.({ preventDefault });
      await flushPromises();
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("allows the confirmed close event after destroying a clean document window", async () => {
    readDocumentFile.mockResolvedValueOnce(
      documentFile("# Disk", "fingerprint-disk"),
    );
    draftGet.mockResolvedValueOnce({ draft: null, fileExists: true });

    await renderDocumentShell(root);
    const closeHandler = onCloseRequested.mock.calls[0]?.[0];
    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();

    await act(async () => {
      closeHandler?.({ preventDefault: firstPreventDefault });
      await flushPromises();
      closeHandler?.({ preventDefault: secondPreventDefault });
      await flushPromises();
    });

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(secondPreventDefault).not.toHaveBeenCalled();
  });

  function getButton(label: string) {
    const button = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label,
    );

    if (!button) {
      throw new Error(`Expected button "${label}"`);
    }

    return button;
  }
});

async function renderDocumentShell(root: ReturnType<typeof createRoot>) {
  await act(async () => {
    root.render(
      <DocumentShell
        session={{
          kind: "document",
          realPath: "/tmp/note.md",
          workspaceDirty: false,
        }}
      />,
    );
    await flushPromises();
  });
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function documentFile(content: string, fingerprint: string) {
  return {
    content,
    displayPath: "/tmp/note.md",
    fileName: "note.md",
    fingerprint,
    realPath: "/tmp/note.md",
  };
}

function documentDraft(markdown: string) {
  return {
    draftId: "draft-1",
    realPath: "/tmp/note.md",
    displayPath: "/tmp/note.md",
    markdown,
    baseFingerprint: "fingerprint-disk",
    mode: "document",
    updatedAt: "2026-06-11T00:00:00Z",
  };
}
