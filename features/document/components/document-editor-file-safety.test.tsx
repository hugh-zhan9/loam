// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentShell } from "./document-shell";
import type { FrontendFileWatchEvent } from "@/features/file-watch/lib/types";

/**
 * File-safety scenarios for the Milkdown adapter surface driven against a real
 * Document session.
 *
 * `EditorPane` is not mocked away and replaced with a stub here — the editor
 * under test is the real adapter surface the document shell mounts, and the
 * session it reports to is the real document state machine.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const readDocumentFile = vi.fn();
const saveDocumentFile = vi.fn();
const overwriteDocumentFile = vi.fn();
const draftGet = vi.fn();
const draftDelete = vi.fn();
const alertDialog = vi.fn(async () => {});
const choiceDialog = vi.fn(async () => "discard");
const close = vi.fn(async () => {});
const destroy = vi.fn(async () => {});
const listen = vi.fn(async () => () => {});
type DocumentCloseHandler = (event: { preventDefault: () => void }) => void;
const onCloseRequested =
  vi.fn<(handler: DocumentCloseHandler) => Promise<() => void>>();
const fileWatch: {
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

const imageStorage = vi.hoisted(() => ({
  storeImageForDocument: vi.fn(),
  loadImage: vi.fn(async () => ""),
}));

vi.mock("@/common/lib/image-storage", () => ({
  storeImageForDocument: imageStorage.storeImageForDocument,
  loadImage: imageStorage.loadImage,
}));

vi.mock("@/features/file-watch/hooks/use-file-watch", () => ({
  useFileWatch: (options: {
    onEvent: (event: FrontendFileWatchEvent) => void;
  }) => {
    fileWatch.current = options;
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
    alert: alertDialog,
    choice: choiceDialog,
  }),
}));

vi.mock("@/features/workspace/components/outline-panel", () => ({
  OutlinePanel: () => <div data-testid="outline" />,
}));

vi.mock("../lib/document-client", () => ({
  isWorkspacePathDirty: vi.fn(async () => false),
  overwriteDocumentFile: (realPath: string, content: string) =>
    overwriteDocumentFile(realPath, content),
  readDocumentFile: (realPath: string) => readDocumentFile(realPath),
  saveDocumentFile: (
    realPath: string,
    content: string,
    expectedFingerprint: string,
  ) => saveDocumentFile(realPath, content, expectedFingerprint),
}));

const DISK_MARKDOWN = "# Disk\n";
const EXTERNAL_MARKDOWN = "# External\n";

function documentFile(
  content: string,
  fingerprint: string,
  realPath = "/tmp/note.md",
) {
  return {
    content,
    displayPath: realPath,
    fileName: realPath.split("/").at(-1) ?? realPath,
    fingerprint,
    realPath,
  };
}

/**
 * jsdom ships no clipboard, so a paste is delivered the way the browser
 * delivers it. This is a genuine user edit made inside the real editor.
 */
function paste(surface: HTMLElement, text: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["text/plain"],
      files: [],
      items: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
      setData: () => {},
    },
  });
  surface.dispatchEvent(event);
}

/** The same delivery for an image the user pasted or dragged in. */
function transferImage(
  surface: HTMLElement,
  type: "paste" | "drop",
  file: File,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: {
      types: ["Files"],
      files: [file],
      items: [],
      getData: () => "",
      setData: () => {},
    },
  });
  surface.dispatchEvent(event);
}

describe("document file safety with the adapter surface", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    fileWatch.current = null;
    listen.mockResolvedValue(() => {});
    onCloseRequested.mockResolvedValue(() => {});
    choiceDialog.mockResolvedValue("discard");
    draftGet.mockResolvedValue({ draft: null, fileExists: true });
    draftDelete.mockResolvedValue(undefined);
    imageStorage.storeImageForDocument.mockResolvedValue({
      altText: "clip.png",
      storedPath: "/tmp/assets/clip.png",
      url: "assets/clip.png",
      usedFallback: false,
    });
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
    vi.unstubAllEnvs();
  });

  async function mountDocument(realPath = "/tmp/note.md") {
    await act(async () => {
      root.render(
        <DocumentShell
          session={{
            kind: "document",
            fileName: realPath.split("/").at(-1) ?? realPath,
            displayPath: realPath,
            realPath,
            workspaceDirty: false,
          }}
        />,
      );
      await flushPromises();
    });
  }

  function editorText() {
    return host.querySelector("[data-mdx-markdown-editor]")?.textContent ?? "";
  }

  function surface() {
    const element = host.querySelector<HTMLElement>(".ProseMirror");
    if (!element) throw new Error("editing surface did not mount");
    return element;
  }

  function externalChange() {
    fileWatch.current?.onEvent({
      kind: "changed",
      watchId: "watch-1",
      path: "/tmp/note.md",
      eventTime: "2026-08-13T00:00:00Z",
      fingerprint: "fingerprint-external",
    });
  }

  it("mounts the adapter surface for the loaded document", async () => {
    readDocumentFile.mockResolvedValue(
      documentFile(DISK_MARKDOWN, "fingerprint-disk"),
    );
    await mountDocument();

    expect(editorText()).toContain("Disk");
  });

  it("accepts an external change on a clean document and moves the clean baseline", async () => {
    readDocumentFile
      .mockResolvedValueOnce(documentFile(DISK_MARKDOWN, "fingerprint-disk"))
      .mockResolvedValue(
        documentFile(EXTERNAL_MARKDOWN, "fingerprint-external"),
      );
    await mountDocument();

    await act(async () => {
      externalChange();
      await flushPromises();
    });

    expect(editorText()).toContain("External");
    expect(editorText()).not.toContain("Disk");
    // A clean baseline means the title carries no dirty marker.
    expect(host.textContent).not.toContain("● ");
  });

  it("keeps the user's edits when an external change arrives on a dirty document", async () => {
    readDocumentFile
      .mockResolvedValueOnce(documentFile(DISK_MARKDOWN, "fingerprint-disk"))
      .mockResolvedValue(
        documentFile(EXTERNAL_MARKDOWN, "fingerprint-external"),
      );
    await mountDocument();

    await act(async () => {
      paste(surface(), "USER-EDIT");
      await flushPromises();
    });
    expect(host.textContent).toContain("● note.md");

    await act(async () => {
      externalChange();
      await flushPromises();
    });

    expect(host.textContent).toContain("文件已被外部修改");
    expect(editorText()).toContain("USER-EDIT");
    expect(editorText()).not.toContain("External");
    expect(host.textContent).toContain("● note.md");
    expect(draftDelete).not.toHaveBeenCalled();
  });

  it("merges separate edits in the real editor and saves against the new disk fingerprint", async () => {
    readDocumentFile
      .mockResolvedValueOnce(documentFile("# Disk\n\nOriginal body\n", "base"))
      .mockResolvedValueOnce(documentFile("# Disk\n\nExternal body\n", "disk-1"))
      .mockResolvedValueOnce(documentFile("# Disk\n\nSecond body\n", "disk-2"));
    saveDocumentFile.mockResolvedValue({ fingerprint: "saved" });
    await mountDocument();
    await act(async () => { paste(surface(), "USER-EDIT"); await flushPromises(); });
    await act(async () => { externalChange(); await flushPromises(); });
    expect(editorText()).toContain("USER-EDIT");
    expect(editorText()).toContain("External body");
    expect(host.textContent).not.toContain("文件已被外部修改");
    expect(host.textContent).toContain("● note.md");
    expect(draftDelete).not.toHaveBeenCalled();
    await act(async () => { externalChange(); await flushPromises(); });
    expect(editorText()).toContain("USER-EDIT");
    expect(editorText()).toContain("Second body");
    await act(async () => { getButton("保存").click(); await flushPromises(); });
    expect(saveDocumentFile).toHaveBeenCalledWith("/tmp/note.md", expect.stringContaining("USER-EDITDisk\n\nSecond body"), "disk-2");
  });

  it("merges typing made while a clean external read is pending", async () => {
    let resolveRead!: (file: ReturnType<typeof documentFile>) => void;
    readDocumentFile
      .mockResolvedValueOnce(documentFile("# Disk\n\nOriginal body\n", "base"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    await mountDocument();
    await act(async () => { externalChange(); await flushPromises(); });
    await act(async () => { paste(surface(), "USER-EDIT"); await flushPromises(); });
    await act(async () => {
      resolveRead(documentFile("# Disk\n\nExternal body\n", "external"));
      await flushPromises();
    });
    expect(editorText()).toContain("USER-EDIT");
    expect(editorText()).toContain("External body");
    expect(host.textContent).not.toContain("文件已被外部修改");
    expect(host.textContent).toContain("● note.md");
  });

  it("does not resurrect an external read captured before a successful local save", async () => {
    let resolveRead!: (file: ReturnType<typeof documentFile>) => void;
    readDocumentFile
      .mockResolvedValueOnce(documentFile(DISK_MARKDOWN, "base"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    saveDocumentFile.mockResolvedValue({ fingerprint: "saved" });
    await mountDocument();
    await act(async () => { externalChange(); await flushPromises(); });
    await act(async () => { paste(surface(), "USER-EDIT"); await flushPromises(); });
    await act(async () => { getButton("保存").click(); await flushPromises(); });
    await act(async () => { resolveRead(documentFile(DISK_MARKDOWN, "base")); await flushPromises(); });
    expect(editorText()).toContain("USER-EDIT");
    expect(host.textContent).not.toContain("● note.md");
    expect(host.textContent).not.toContain("文件已被外部修改");
  });

  it("does not clear a newer overlapping conflict when an older failed-save read completes", async () => {
    let resolveOlder!: (file: ReturnType<typeof documentFile>) => void;
    readDocumentFile
      .mockResolvedValueOnce(documentFile("# Disk\n\nBody\n", "base"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce(documentFile("# Remote\n\nNewest body\n", "newest"));
    saveDocumentFile.mockRejectedValue({ errorCode: "external_modified" });
    await mountDocument();
    await act(async () => { paste(surface(), "USER-EDIT"); await flushPromises(); });
    await act(async () => { getButton("保存").click(); await flushPromises(); });
    await act(async () => { externalChange(); await flushPromises(); });
    expect(host.textContent).toContain("文件已被外部修改");
    expect(host.textContent).toContain("Newest body");
    await act(async () => {
      resolveOlder(documentFile("# Disk\n\nOlder body\n", "older"));
      await flushPromises();
    });
    expect(host.textContent).toContain("文件已被外部修改");
    expect(host.textContent).toContain("Newest body");
    expect(editorText()).toContain("USER-EDIT");
    expect(editorText()).not.toContain("Older body");
  });

  it("keeps a newer accepted disk baseline when an older save response arrives", async () => {
    let resolveSave!: (value: { fingerprint: string }) => void;
    readDocumentFile
      .mockResolvedValueOnce(documentFile("# Disk\n\nOriginal body\n", "base"))
      .mockResolvedValueOnce(documentFile("# Disk\n\nNew body\n", "newer"));
    saveDocumentFile
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }))
      .mockResolvedValueOnce({ fingerprint: "latest-save" });
    await mountDocument();
    await act(async () => { paste(surface(), "USER-EDIT"); await flushPromises(); });
    await act(async () => { getButton("保存").click(); await flushPromises(); });
    await act(async () => { externalChange(); await flushPromises(); });
    await act(async () => { resolveSave({ fingerprint: "older-save" }); await flushPromises(); });
    expect(editorText()).toContain("USER-EDIT");
    expect(editorText()).toContain("New body");
    expect(draftDelete).not.toHaveBeenCalled();
    await act(async () => { getButton("保存").click(); await flushPromises(); });
    expect(saveDocumentFile).toHaveBeenLastCalledWith("/tmp/note.md", expect.stringContaining("New body"), "newer");
  });

  it("keeps a recovery draft across a clean reload", async () => {
    readDocumentFile
      .mockResolvedValueOnce(documentFile(DISK_MARKDOWN, "fingerprint-disk"))
      .mockResolvedValue(
        documentFile(EXTERNAL_MARKDOWN, "fingerprint-external"),
      );
    draftGet.mockResolvedValue({
      draft: {
        draftId: "draft-1",
        realPath: "/tmp/note.md",
        displayPath: "/tmp/note.md",
        markdown: "# Crash draft",
        baseFingerprint: "fingerprint-disk",
        mode: "document",
        updatedAt: "2026-08-13T00:00:00Z",
      },
      fileExists: true,
    });
    await mountDocument();
    expect(host.textContent).toContain("发现未保存草稿");

    await act(async () => {
      externalChange();
      await flushPromises();
    });

    expect(editorText()).toContain("External");
    expect(draftDelete).not.toHaveBeenCalled();
    expect(host.textContent).toContain("发现未保存草稿");
  });

  it("saves with the last clean fingerprint and preserves everything when the backend rejects", async () => {
    readDocumentFile
      .mockResolvedValueOnce(documentFile(DISK_MARKDOWN, "fingerprint-disk"))
      .mockResolvedValue(
        documentFile(EXTERNAL_MARKDOWN, "fingerprint-external"),
      );
    saveDocumentFile.mockRejectedValue({ errorCode: "external_modified" });
    await mountDocument();

    await act(async () => {
      paste(surface(), "USER-EDIT");
      await flushPromises();
    });
    const editedMarkdown = editorText();

    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    expect(saveDocumentFile).toHaveBeenCalledWith(
      "/tmp/note.md",
      expect.stringContaining("USER-EDIT"),
      "fingerprint-disk",
    );
    expect(host.textContent).toContain("文件已被外部修改");
    expect(editorText()).toBe(editedMarkdown);
    expect(editorText()).toContain("USER-EDIT");
    expect(host.textContent).toContain("● note.md");
    expect(draftDelete).not.toHaveBeenCalled();
  });

  it.each([
    { name: "pasted", how: "paste" as const },
    { name: "dropped", how: "drop" as const },
  ])(
    "stores a $name image beside the document and inserts what the store returned",
    async ({ how }) => {
      readDocumentFile.mockResolvedValue(
        documentFile(DISK_MARKDOWN, "fingerprint-disk"),
      );
      saveDocumentFile.mockResolvedValue({ fingerprint: "fingerprint-saved" });
      await mountDocument();

      const file = new File(["image-bytes"], "clip.png", { type: "image/png" });

      await act(async () => {
        transferImage(surface(), how, file);
        await flushPromises();
      });

      // The document window has no workspace root, so the asset is addressed
      // by the file being edited.
      expect(imageStorage.storeImageForDocument).toHaveBeenCalledWith(file, {
        documentPath: "/tmp/note.md",
      });

      // What the store returned has to reach the document the session holds,
      // which is the text a save would write.
      await act(async () => {
        getButton("保存").click();
        await flushPromises();
      });

      expect(saveDocumentFile).toHaveBeenCalledWith(
        "/tmp/note.md",
        expect.stringContaining("![clip.png](assets/clip.png)"),
        "fingerprint-disk",
      );
    },
  );

  it("stops closing the window when discarding the draft fails", async () => {
    readDocumentFile.mockResolvedValue(
      documentFile(DISK_MARKDOWN, "fingerprint-disk"),
    );
    draftDelete.mockRejectedValue(new Error("draft store is locked"));
    await mountDocument();

    await act(async () => {
      paste(surface(), "USER-EDIT");
      await flushPromises();
    });

    const closeHandler = onCloseRequested.mock.calls[0]?.[0];
    const preventDefault = vi.fn();

    await act(async () => {
      closeHandler?.({ preventDefault });
      await flushPromises();
    });

    expect(choiceDialog).toHaveBeenCalled();
    expect(draftDelete).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(editorText()).toContain("USER-EDIT");
  });

  function getButton(label: string) {
    const button = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );

    if (!button) {
      throw new Error(`Expected button "${label}"`);
    }

    return button;
  }
});

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
