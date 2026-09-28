// @vitest-environment jsdom

import { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
    MarkdownEditorSurface,
    type EditorCommandRefusal,
    type MarkdownEditorSurfaceHandle,
} from "./markdown-editor-surface";
import { ImageFailureBar } from "./image-failure-bar";
import {
    createEditorSessionBinding,
    type EditorSessionBinding,
} from "../lib/editor-session-binding";
import type {
    EditorReplaceReason,
    EditorSurfaceMode,
} from "../../../packages/mdx-editor";
import { parseMarkdownOutline } from "../../workspace/lib/outline";
import type {
    CliSelectionSnapshot,
    PendingCliEditorCommand,
} from "../../workspace/lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
    while (mounted.length > 0) {
        const entry = mounted.pop();
        if (!entry) continue;
        await act(async () => {
            entry.root.unmount();
        });
        entry.container.remove();
    }
});

interface StoreImageRequest {
    file: File;
    resolve: (stored: { url: string; altText: string }) => void;
    reject: (error: unknown) => void;
}

interface Controls {
    show(documentId: string): void;
    replace(
        documentId: string,
        markdown: string,
        reason: EditorReplaceReason,
    ): void;
    queueCli(command: PendingCliEditorCommand): void;
    markdownOf(documentId: string): string | undefined;
    /**
     * Takes the editor surface off screen, as a shell does when the last tab
     * closes or a non-Markdown tab is shown; the host itself stays.
     */
    unmountSurface(): void;
}

interface Harness {
    container: HTMLElement;
    binding: EditorSessionBinding;
    controls: Controls;
    handle: MarkdownEditorSurfaceHandle;
    /** Every store request the surface made, in the order it made them. */
    imageRequests: StoreImageRequest[];
    refusals: EditorCommandRefusal[];
    handledCommandIds: string[];
    selections: Array<{
        documentId: string;
        selection: CliSelectionSnapshot | null;
    }>;
    /** The selection the surface last reported, as the CLI context. */
    lastSelection(): CliSelectionSnapshot | null;
    settle(): Promise<void>;
}

function SessionHost({
    binding,
    initialDocumentId,
    initialDocuments,
    initialMode,
    controlsRef,
    surfaceRef,
    imageRequests,
    refusals,
    handledCommandIds,
    selections,
}: {
    binding: EditorSessionBinding;
    initialDocumentId: string;
    initialDocuments: Record<string, string>;
    initialMode: EditorSurfaceMode;
    controlsRef: { current: Controls | null };
    surfaceRef: { current: MarkdownEditorSurfaceHandle | null };
    imageRequests: StoreImageRequest[];
    refusals: EditorCommandRefusal[];
    handledCommandIds: string[];
    selections: Array<{
        documentId: string;
        selection: CliSelectionSnapshot | null;
    }>;
}) {
    const [documents, setDocuments] =
        useState<Record<string, string>>(initialDocuments);
    const [documentId, setDocumentId] = useState(initialDocumentId);
    const [pendingCliCommand, setPendingCliCommand] =
        useState<PendingCliEditorCommand | null>(null);
    const [surfaceMounted, setSurfaceMounted] = useState(true);
    // Shown by the host, as the shells show it.
    const [imageFailure, setImageFailure] = useState<string | null>(null);
    const documentsRef = useRef(documents);

    useEffect(() => {
        documentsRef.current = documents;
        controlsRef.current = {
            show: setDocumentId,
            replace(targetId, markdown, reason) {
                binding.declareReplace({ documentId: targetId, markdown, reason });
                setDocuments((current) => ({ ...current, [targetId]: markdown }));
            },
            queueCli: setPendingCliCommand,
            markdownOf: (targetId) => documentsRef.current[targetId],
            unmountSurface: () => setSurfaceMounted(false),
        };
    }, [binding, controlsRef, documents]);

    const storeImage = useCallback(
        (file: File) =>
            new Promise<{ url: string; altText: string }>((resolve, reject) => {
                imageRequests.push({ file, resolve, reject });
            }),
        [imageRequests],
    );

    return (
        <>
            <ImageFailureBar
                message={imageFailure}
                onDismiss={() => setImageFailure(null)}
            />
            {surfaceMounted ? (
                <MarkdownEditorSurface
                    ref={surfaceRef}
                    session={binding}
                    documentId={documentId}
                    markdown={documents[documentId] ?? ""}
                    initialMode={initialMode}
                    storeImage={storeImage}
                    onImageFailure={setImageFailure}
                    pendingCliCommand={
                        pendingCliCommand?.tabId === documentId
                            ? pendingCliCommand
                            : null
                    }
                    onPendingCliCommandHandled={(commandId) => {
                        handledCommandIds.push(commandId);
                        setPendingCliCommand((current) =>
                            current?.id === commandId ? null : current,
                        );
                    }}
                    onCommandRefused={(refusal) => refusals.push(refusal)}
                    onSelectionChange={(changedDocumentId, selection) => {
                        selections.push({
                            documentId: changedDocumentId,
                            selection: selection as CliSelectionSnapshot | null,
                        });
                    }}
                    onMarkdownChange={(changedDocumentId, markdown) => {
                        setDocuments((current) => ({
                            ...current,
                            [changedDocumentId]: markdown,
                        }));
                    }}
                />
            ) : null}
        </>
    );
}

async function mountSession(
    initialDocuments: Record<string, string>,
    initialDocumentId: string,
    initialMode: EditorSurfaceMode,
): Promise<Harness> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    const binding = createEditorSessionBinding();
    const controlsRef: { current: Controls | null } = { current: null };
    const surfaceRef: { current: MarkdownEditorSurfaceHandle | null } = {
        current: null,
    };
    const imageRequests: StoreImageRequest[] = [];
    const refusals: EditorCommandRefusal[] = [];
    const handledCommandIds: string[] = [];
    const selections: Array<{
        documentId: string;
        selection: CliSelectionSnapshot | null;
    }> = [];

    await act(async () => {
        root.render(
            <SessionHost
                binding={binding}
                initialDocumentId={initialDocumentId}
                initialDocuments={initialDocuments}
                initialMode={initialMode}
                controlsRef={controlsRef}
                surfaceRef={surfaceRef}
                imageRequests={imageRequests}
                refusals={refusals}
                handledCommandIds={handledCommandIds}
                selections={selections}
            />,
        );
    });

    // The command suite has to be answered by the surface the case names, not
    // by whichever one happened to build. A suite that passed against the wrong
    // surface would prove nothing about the other.
    const mountedMode = container
        .querySelector("[data-mdx-surface-mode]")
        ?.getAttribute("data-mdx-surface-mode");
    expect(mountedMode).toBe(initialMode);
    expect(container.querySelectorAll(".ProseMirror").length).toBe(
        initialMode === "wysiwyg" ? 1 : 0,
    );
    expect(container.querySelectorAll(".cm-editor").length).toBe(
        initialMode === "source" ? 1 : 0,
    );

    return {
        container,
        binding,
        get controls() {
            const controls = controlsRef.current;
            if (!controls) throw new Error("session host did not mount");
            return controls;
        },
        get handle() {
            const handle = surfaceRef.current;
            if (!handle) throw new Error("editor surface handle was not set");
            return handle;
        },
        imageRequests,
        refusals,
        handledCommandIds,
        selections,
        lastSelection: () => selections.at(-1)?.selection ?? null,
        settle: async () => {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });
        },
    };
}

/** Puts focus back on the document body so a focus assertion means something. */
function blurEverything(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
}

function imageFile(name: string): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/**
 * Delivers a paste the way a browser does: a `paste` event on the editing
 * surface carrying a transfer with files on it.
 */
function pasteImages(harness: Harness, files: File[]): void {
    const target =
        harness.container.querySelector(".ProseMirror") ??
        harness.container.querySelector(".cm-content") ??
        harness.container.querySelector("[data-mdx-surface-mode]");
    if (!target) throw new Error("no editing surface to paste into");

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
        value: { files, items: [], types: ["Files"], getData: () => "" },
    });
    target.dispatchEvent(event);
}

/** Delivers a drop the way a browser does, with the files on its transfer. */
function dropImages(harness: Harness, files: File[]): void {
    const target = harness.container.querySelector(
        "[data-mdx-markdown-editor-stage]",
    );
    if (!target) throw new Error("no editor stage to drop onto");

    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
        value: { files, items: [], types: ["Files"], getData: () => "" },
    });
    target.dispatchEvent(event);
}

function imageNotice(harness: Harness): HTMLElement | null {
    return harness.container.querySelector("[data-mdx-image-notice]");
}

/** Real time passing, for the delay before a running batch is shown. */
async function wait(ms: number): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

/**
 * The document with Markdown escapes removed.
 *
 * These cases are about *where* an insert lands, which is what this component
 * decides. How the editor spells an image once it is there belongs to the
 * adapter, and the visual surface currently escapes the Markdown it is given,
 * so comparing the raw text would make a position assertion fail for a reason
 * that has nothing to do with position.
 */
function insertedMarkdown(harness: Harness): string {
    return (harness.controls.markdownOf("doc") ?? "").replace(/\\/g, "");
}

const MODES: EditorSurfaceMode[] = ["wysiwyg", "source"];

describe.each(MODES)("editor command suite on the %s surface", (mode) => {
    const DOCUMENT = "# Alpha\n\nalpha beta\n\n## Beta heading\n\ntail\n";

    it("reveals an outline heading by its Markdown source range", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const headings = parseMarkdownOutline(DOCUMENT);

        expect(headings.map((heading) => heading.text)).toEqual([
            "Alpha",
            "Beta heading",
        ]);

        await act(async () => {
            await harness.handle.reveal(headings[1].range);
        });

        expect(harness.refusals).toEqual([]);
        expect(harness.lastSelection()?.selected_text).toBe("Beta heading");
        expect(harness.lastSelection()?.has_selection).toBe(true);
    });

    it("reveals the same heading again when the outline is clicked twice", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const headings = parseMarkdownOutline(DOCUMENT);
        const other = headings[0].range;
        const target = headings[1].range;

        await act(async () => {
            await harness.handle.reveal(target);
        });
        await act(async () => {
            await harness.handle.reveal(other);
        });

        let second: { ok: boolean } | null = null;
        await act(async () => {
            second = await harness.handle.reveal(target);
        });

        expect(second).toEqual({ ok: true });
        expect(harness.refusals).toEqual([]);
        expect(harness.lastSelection()?.selected_text).toBe("Beta heading");
    });

    it("inserts CLI text at the pinned selection", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const caret = DOCUMENT.indexOf("beta");

        await act(async () => {
            await harness.handle.reveal({ anchor: caret, head: caret });
        });
        await act(async () => {
            harness.controls.queueCli({
                id: "cli-insert-1",
                kind: "insert",
                tabId: "doc",
                text: "INSERTED-",
            });
        });
        await harness.settle();

        expect(harness.refusals).toEqual([]);
        expect(harness.handledCommandIds).toEqual(["cli-insert-1"]);
        expect(harness.controls.markdownOf("doc")).toContain(
            "alpha INSERTED-beta",
        );
    });

    it("reveals the source range of a CLI scroll target line", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);

        await act(async () => {
            harness.controls.queueCli({
                id: "cli-scroll-1",
                kind: "scrollToLine",
                tabId: "doc",
                lineNumber: 3,
            });
        });
        await harness.settle();

        expect(harness.refusals).toEqual([]);
        expect(harness.handledCommandIds).toEqual(["cli-scroll-1"]);
        expect(harness.lastSelection()?.selected_text).toBe("alpha beta");
    });

    it("focuses the editing surface for a CLI focus request", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        blurEverything();
        expect(harness.container.contains(document.activeElement)).toBe(false);

        await act(async () => {
            harness.controls.queueCli({
                id: "cli-focus-1",
                kind: "focus",
                tabId: "doc",
            });
        });
        await harness.settle();

        expect(harness.refusals).toEqual([]);
        expect(harness.handledCommandIds).toEqual(["cli-focus-1"]);
        expect(harness.container.contains(document.activeElement)).toBe(true);
    });

    it("leaves the editor focused after a CLI insert, not just after a focus request", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        blurEverything();
        expect(harness.container.contains(document.activeElement)).toBe(false);

        await act(async () => {
            harness.controls.queueCli({
                id: "cli-insert-focus",
                kind: "insert",
                tabId: "doc",
                text: "X",
            });
        });
        await harness.settle();

        expect(harness.refusals).toEqual([]);
        expect(harness.container.contains(document.activeElement)).toBe(true);
    });

    it("lands a stored image at the position the paste started from, not the caret it finished at", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const origin = DOCUMENT.indexOf("beta");
        const elsewhere = DOCUMENT.indexOf("tail");

        await act(async () => {
            await harness.handle.reveal({ anchor: origin, head: origin });
        });

        await act(async () => {
            pasteImages(harness, [imageFile("shot.png")]);
        });
        // Proves the paste reached the surface: without a request there is no
        // asynchronous gap for the rest of this case to exercise.
        expect(harness.imageRequests).toHaveLength(1);

        // The user keeps working while the asset is being stored, and ends up
        // somewhere else entirely.
        await act(async () => {
            await harness.handle.reveal({ anchor: elsewhere, head: elsewhere });
        });
        expect(harness.lastSelection()?.after.startsWith("tail")).toBe(true);

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "assets/shot.png",
                altText: "shot",
            });
        });
        await harness.settle();

        expect(harness.refusals).toEqual([]);
        expect(insertedMarkdown(harness)).toContain(
            "alpha ![shot](assets/shot.png)beta",
        );
    });

    it("keeps a batch of images in order from one pinned origin", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const origin = DOCUMENT.indexOf("beta");

        await act(async () => {
            await harness.handle.reveal({ anchor: origin, head: origin });
        });
        await act(async () => {
            pasteImages(harness, [imageFile("one.png"), imageFile("two.png")]);
        });
        expect(harness.imageRequests).toHaveLength(1);

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "assets/one.png",
                altText: "one",
            });
        });
        await harness.settle();
        expect(harness.imageRequests).toHaveLength(2);

        await act(async () => {
            harness.imageRequests[1].resolve({
                url: "assets/two.png",
                altText: "two",
            });
        });
        await harness.settle();

        expect(harness.refusals).toEqual([]);
        expect(insertedMarkdown(harness)).toContain(
            "alpha ![one](assets/one.png)![two](assets/two.png)beta",
        );
    });

    it("refuses a stored image when a clean reload replaced the document", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const origin = DOCUMENT.indexOf("beta");

        await act(async () => {
            await harness.handle.reveal({ anchor: origin, head: origin });
        });
        await act(async () => {
            pasteImages(harness, [imageFile("shot.png")]);
        });
        expect(harness.imageRequests).toHaveLength(1);

        const reloaded = "# Alpha\n\nrewritten from disk\n";
        await act(async () => {
            harness.controls.replace("doc", reloaded, "clean-reload");
        });

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "assets/shot.png",
                altText: "shot",
            });
        });
        await harness.settle();

        expect(harness.refusals.map((refusal) => refusal.code)).toEqual([
            "stale_revision",
        ]);
        expect(harness.controls.markdownOf("doc")).toBe(reloaded);
        expect(harness.controls.markdownOf("doc")).not.toContain("shot.png");
    });

    it("refuses a stored image when the target document is gone, and writes nothing to the one on screen", async () => {
        const harness = await mountSession(
            { doc: DOCUMENT, other: "other document\n" },
            "doc",
            mode,
        );
        const origin = DOCUMENT.indexOf("beta");

        await act(async () => {
            await harness.handle.reveal({ anchor: origin, head: origin });
        });
        await act(async () => {
            pasteImages(harness, [imageFile("shot.png")]);
        });
        expect(harness.imageRequests).toHaveLength(1);

        await act(async () => {
            harness.controls.show("other");
            harness.binding.retain(["other"]);
        });

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "assets/shot.png",
                altText: "shot",
            });
        });
        await harness.settle();

        expect(harness.refusals.map((refusal) => refusal.code)).toEqual([
            "stale_document",
        ]);
        expect(harness.controls.markdownOf("doc")).toBe(DOCUMENT);
        expect(harness.controls.markdownOf("other")).toBe("other document\n");
    });

    it("applies a redelivered CLI command once and refuses nothing", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", mode);
        const caret = DOCUMENT.indexOf("beta");
        const command: PendingCliEditorCommand = {
            id: "cli-insert-repeat",
            kind: "insert",
            tabId: "doc",
            text: "ONCE-",
        };

        await act(async () => {
            await harness.handle.reveal({ anchor: caret, head: caret });
        });
        await act(async () => {
            harness.controls.queueCli(command);
        });
        await harness.settle();
        await act(async () => {
            harness.controls.queueCli({ ...command });
        });
        await harness.settle();

        const markdown = harness.controls.markdownOf("doc") ?? "";
        expect(markdown.split("ONCE-")).toHaveLength(2);
        expect(harness.refusals).toEqual([]);
    });
});

describe("editor command suite — selection reporting", () => {
    it("derives the CLI selection context from Markdown source offsets", async () => {
        const document = "alpha beta gamma\n";
        const harness = await mountSession({ doc: document }, "doc", "wysiwyg");

        await act(async () => {
            await harness.handle.reveal({ anchor: 6, head: 10 });
        });

        expect(harness.lastSelection()).toEqual({
            has_selection: true,
            selected_text: "beta",
            before: "alpha ",
            after: " gamma\n",
            before_truncated: false,
            after_truncated: false,
        });
    });
});

describe("editor command suite — pinned range validation", () => {
    it("refuses a reveal whose range is outside the document", async () => {
        const harness = await mountSession({ doc: "short\n" }, "doc", "wysiwyg");

        let result: { ok: boolean } | null = null;
        await act(async () => {
            result = await harness.handle.reveal({ anchor: 400, head: 500 });
        });

        expect(result).toEqual({ ok: false, code: "invalid_range" });
        expect(harness.refusals.map((refusal) => refusal.code)).toEqual([
            "invalid_range",
        ]);
    });

    it("refuses a CLI scroll request for a line the document does not have", async () => {
        const harness = await mountSession({ doc: "one\ntwo\n" }, "doc", "wysiwyg");

        await act(async () => {
            harness.controls.queueCli({
                id: "cli-scroll-missing",
                kind: "scrollToLine",
                tabId: "doc",
                lineNumber: 99,
            });
        });
        await harness.settle();

        // The request is finished either way: it is cleared, and nothing was
        // revealed at a substitute line.
        expect(harness.handledCommandIds).toEqual(["cli-scroll-missing"]);
        expect(harness.selections).toEqual([]);
    });
});

describe("editor command suite — image notices", () => {
    const DOCUMENT = "# Alpha\n\nalpha beta\n\ntail\n";

    async function pastedAt(files: File[]) {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", "wysiwyg");
        const origin = DOCUMENT.indexOf("beta");
        await act(async () => {
            await harness.handle.reveal({ anchor: origin, head: origin });
        });
        await act(async () => {
            pasteImages(harness, files);
        });
        expect(harness.imageRequests).toHaveLength(1);
        return harness;
    }

    it("says why a stored image failed and leaves the document as it was", async () => {
        const harness = await pastedAt([imageFile("shot.png")]);

        await act(async () => {
            // The shape a Tauri command rejects with.
            harness.imageRequests[0].reject({
                error_code: "image_host_upload_failed",
                message: "could not reach the PicGo server",
            });
        });
        await harness.settle();

        const notice = imageNotice(harness);
        expect(notice?.getAttribute("data-mdx-image-notice")).toBe("failed");
        expect(notice?.getAttribute("role")).toBe("alert");
        expect(notice?.textContent).toContain(
            "图片未插入：could not reach the PicGo server",
        );
        expect(notice?.textContent).not.toContain("张未插入");
        expect(harness.controls.markdownOf("doc")).toBe(DOCUMENT);
        expect(harness.refusals).toEqual([]);
    });

    it("stops a batch at the first failure and says how many did not land", async () => {
        const harness = await pastedAt([
            imageFile("one.png"),
            imageFile("two.png"),
            imageFile("three.png"),
        ]);

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "https://img.example/one.png",
                altText: "one",
            });
        });
        await harness.settle();
        expect(harness.imageRequests).toHaveLength(2);

        await act(async () => {
            harness.imageRequests[1].reject(new Error("HTTP 403"));
        });
        await harness.settle();

        // The third was never attempted.
        expect(harness.imageRequests).toHaveLength(2);
        expect(insertedMarkdown(harness)).toContain(
            "![one](https://img.example/one.png)",
        );
        expect(insertedMarkdown(harness)).not.toContain("two");
        expect(imageNotice(harness)?.textContent).toContain(
            "图片未插入：HTTP 403（本次共 2 张未插入）",
        );
    });

    it("tells the user when a stored image was refused because its document is gone", async () => {
        const harness = await mountSession(
            { doc: DOCUMENT, other: "other document\n" },
            "doc",
            "wysiwyg",
        );
        await act(async () => {
            pasteImages(harness, [imageFile("shot.png")]);
        });
        await act(async () => {
            harness.controls.show("other");
            harness.binding.retain(["other"]);
        });

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "https://img.example/shot.png",
                altText: "shot",
            });
        });
        await harness.settle();

        expect(harness.refusals.map((refusal) => refusal.code)).toEqual([
            "stale_document",
        ]);
        expect(imageNotice(harness)?.textContent).toContain(
            "图片未插入：粘贴时的文档已不在编辑器中",
        );
        expect(harness.controls.markdownOf("other")).toBe("other document\n");
    });

    it("still tells the user when the surface was unmounted while the image was stored", async () => {
        const harness = await pastedAt([imageFile("shot.png")]);

        // The last tab closed, or an image tab was opened: the shell stays,
        // the surface does not.
        await act(async () => {
            harness.controls.unmountSurface();
        });
        expect(harness.container.querySelector(".ProseMirror")).toBeNull();

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "https://img.example/shot.png",
                altText: "shot",
            });
        });
        await harness.settle();

        expect(harness.refusals.map((refusal) => refusal.code)).toEqual([
            "stale_document",
        ]);
        expect(imageNotice(harness)?.textContent).toContain(
            "图片未插入：粘贴时的文档已不在编辑器中",
        );
    });

    it("names an edit made between two images of a batch as the reason the rest stopped", async () => {
        const harness = await pastedAt([imageFile("one.png"), imageFile("two.png")]);

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "https://img.example/one.png",
                altText: "one",
            });
        });
        await harness.settle();
        expect(harness.imageRequests).toHaveLength(2);

        // Something other than the batch changes the document before the
        // second image is ready.
        await act(async () => {
            harness.controls.queueCli({
                id: "cli-insert-during-batch",
                kind: "insert",
                tabId: "doc",
                text: "TYPED-",
            });
        });
        await harness.settle();

        await act(async () => {
            harness.imageRequests[1].resolve({
                url: "https://img.example/two.png",
                altText: "two",
            });
        });
        await harness.settle();

        expect(insertedMarkdown(harness)).not.toContain("two.png");
        expect(imageNotice(harness)?.textContent).toContain(
            "图片未插入：插入过程中文档被修改（本次共 1 张未插入）",
        );
    });

    it("stores a dropped image the same way as a pasted one", async () => {
        const harness = await mountSession({ doc: DOCUMENT }, "doc", "wysiwyg");
        const origin = DOCUMENT.indexOf("beta");
        await act(async () => {
            await harness.handle.reveal({ anchor: origin, head: origin });
        });

        await act(async () => {
            dropImages(harness, [imageFile("dropped.png")]);
        });
        expect(harness.imageRequests).toHaveLength(1);
        expect(harness.imageRequests[0].file.name).toBe("dropped.png");

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "https://img.example/dropped.png",
                altText: "dropped",
            });
        });
        await harness.settle();

        expect(insertedMarkdown(harness)).toContain(
            "alpha ![dropped](https://img.example/dropped.png)beta",
        );
    });

    it("shows a batch as running only once it has run long enough, and hides it when done", async () => {
        const harness = await pastedAt([imageFile("slow.png")]);

        expect(imageNotice(harness)).toBeNull();
        await wait(350);
        const notice = imageNotice(harness);
        expect(notice?.getAttribute("data-mdx-image-notice")).toBe("progress");
        expect(notice?.getAttribute("role")).toBe("status");
        expect(notice?.textContent).toBe("正在处理图片 1/1…");

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: "https://img.example/slow.png",
                altText: "slow",
            });
        });
        await harness.settle();

        expect(imageNotice(harness)).toBeNull();
    });

    it("shows a running batch only over the document it was pasted into", async () => {
        const harness = await mountSession(
            { doc: DOCUMENT, other: "other document\n" },
            "doc",
            "wysiwyg",
        );
        await act(async () => {
            pasteImages(harness, [imageFile("slow.png")]);
        });
        await wait(350);
        expect(imageNotice(harness)?.textContent).toBe("正在处理图片 1/1…");

        // That batch can no longer land here, and its progress would say it can.
        await act(async () => {
            harness.controls.show("other");
        });
        expect(imageNotice(harness)).toBeNull();

        await act(async () => {
            harness.controls.show("doc");
        });
        expect(imageNotice(harness)?.textContent).toBe("正在处理图片 1/1…");
    });

    it("never shows a store that finishes quickly", async () => {
        const harness = await pastedAt([imageFile("quick.png")]);

        await act(async () => {
            harness.imageRequests[0].resolve({
                url: ".assets/quick.png",
                altText: "quick",
            });
        });
        await harness.settle();
        await wait(350);

        expect(imageNotice(harness)).toBeNull();
    });

    it("keeps a failure until it is closed or the next paste starts", async () => {
        const harness = await pastedAt([imageFile("a.png")]);
        await act(async () => {
            harness.imageRequests[0].reject(new Error("first failure"));
        });
        await harness.settle();

        const close = imageNotice(harness)?.querySelector("button");
        expect(close?.textContent).toBe("关闭");
        await act(async () => {
            close?.click();
        });
        expect(imageNotice(harness)).toBeNull();

        await act(async () => {
            pasteImages(harness, [imageFile("b.png")]);
        });
        await act(async () => {
            harness.imageRequests[1].reject(new Error("second failure"));
        });
        await harness.settle();
        expect(imageNotice(harness)?.textContent).toContain("second failure");

        await act(async () => {
            pasteImages(harness, [imageFile("c.png")]);
        });
        expect(imageNotice(harness)).toBeNull();
    });
});
