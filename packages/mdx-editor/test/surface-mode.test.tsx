// @vitest-environment jsdom
import { createRef, type RefObject } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownEditorAdapter } from "../adapter/markdown-editor-adapter";
import type {
    EditorAdapterDiagnostic,
    EditorChangeEvent,
    EditorDocumentSnapshot,
    EditorSurfaceMode,
    MarkdownEditorAdapterHandle,
} from "../adapter/types";

const roots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
    while (roots.length > 0) {
        const entry = roots.pop();
        if (!entry) continue;
        await act(async () => {
            entry.root.unmount();
        });
        entry.container.remove();
    }
});

interface Session {
    handle: RefObject<MarkdownEditorAdapterHandle | null>;
    container: HTMLElement;
    changes: EditorChangeEvent[];
    diagnostics: EditorAdapterDiagnostic[];
    modeChanges: EditorSurfaceMode[];
    /** What the session holds, updated from change events exactly as a shell would. */
    markdown(): string;
    revision(): number;
    mode(): EditorSurfaceMode;
    /** An external clean reload: new content from disk, nothing unsaved left. */
    reload(markdown: string): Promise<void>;
    settle(): Promise<void>;
}

/**
 * A minimal stand-in for the Workspace/Document shell: it owns the canonical
 * Markdown and the revision, applies changes, and drives `mode` as controlled
 * state. Nothing here is a second copy of the content — the adapter reports,
 * the session decides.
 */
async function openSession(initialMarkdown: string): Promise<Session> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });

    const handle = createRef<MarkdownEditorAdapterHandle>();
    let snapshot: EditorDocumentSnapshot = {
        documentId: "doc",
        revision: 1,
        markdown: initialMarkdown,
    };
    let mode: EditorSurfaceMode = "wysiwyg";

    const session: Session = {
        handle,
        container,
        changes: [],
        diagnostics: [],
        modeChanges: [],
        markdown: () => snapshot.markdown,
        revision: () => snapshot.revision,
        mode: () => mode,
        reload: async (markdown) => {
            snapshot = {
                documentId: snapshot.documentId,
                revision: snapshot.revision + 1,
                markdown,
                replaceReason: "clean-reload",
            };
            await render();
        },
        settle: async () => {
            await act(async () => {
                await Promise.resolve();
            });
        },
    };

    const render = async (): Promise<void> => {
        await act(async () => {
            root.render(
                <MarkdownEditorAdapter
                    ref={handle}
                    snapshot={snapshot}
                    mode={mode}
                    editable
                    onChange={(event) => {
                        session.changes.push(event);
                        if (event.documentId !== snapshot.documentId) return;
                        snapshot = {
                            documentId: snapshot.documentId,
                            revision: snapshot.revision + 1,
                            markdown: event.markdown,
                        };
                    }}
                    onSelectionChange={() => {}}
                    onModeChange={(next) => {
                        session.modeChanges.push(next);
                        mode = next;
                        void render();
                    }}
                    onDiagnostic={(diagnostic) =>
                        session.diagnostics.push(diagnostic)
                    }
                    onOpenWikilink={() => {}}
                    onReady={() => {}}
                />,
            );
        });
    };

    await render();
    return session;
}

function surfaceKinds(container: HTMLElement): {
    wysiwyg: number;
    source: number;
} {
    return {
        wysiwyg: container.querySelectorAll(".ProseMirror").length,
        source: container.querySelectorAll(".cm-editor").length,
    };
}

describe("surface mode — the two surfaces are one session", () => {
    it("mounts exactly one editable surface at a time", async () => {
        const session = await openSession("# Title\n\nBody.\n");
        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 1,
            source: 0,
        });

        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();

        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 0,
            source: 1,
        });
    });

    it("round-trips content through source and back", async () => {
        const markdown = "# Title\n\nBody.\n";
        const session = await openSession(markdown);

        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();
        expect(session.container.textContent).toContain("# Title");

        await act(async () => {
            await session.handle.current!.setMode("wysiwyg");
        });
        await session.settle();

        expect(session.markdown()).toBe(markdown);
        expect(session.container.querySelector("h1")?.textContent).toBe("Title");
    });

    it("keeps empty anchor markup in source mode and out of the visual text", async () => {
        const markdown = '<a id="D-003"></a>\n\n## D-003 · Behavior Contract\n';
        const session = await openSession(markdown);
        const expectPreview = () => {
            const preview = session.container.querySelector("[data-mdx-preview]");
            expect(preview?.querySelector("a")).not.toBeNull();
            expect(preview?.textContent).toBe("");
            expect(session.container.querySelector(".mdx-inline-source-input")).toBeNull();
            expect(session.container.querySelector("h2")?.textContent).toBe("D-003 · Behavior Contract");
        };
        expectPreview();

        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();
        expect(session.container.querySelector(".cm-content")?.textContent).toContain('<a id="D-003"></a>');

        await act(async () => {
            await session.handle.current!.setMode("wysiwyg");
        });
        await session.settle();
        expectPreview();
        expect(session.markdown()).toBe(markdown);
        expect(session.changes).toEqual([]);
    });

    it("carries an unconfirmed edit across the switch", async () => {
        const session = await openSession("start\n");
        await act(async () => {
            await session.handle.current!.execute({
                commandId: "c1",
                documentId: "doc",
                baseRevision: 1,
                selection: { anchor: 5, head: 5 },
                kind: "replace-selection",
                text: " typed",
            });
        });
        await session.settle();

        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();

        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 0,
            source: 1,
        });
        expect(session.container.textContent).toContain("start typed");
    });

    it("reports the mode change instead of persisting it", async () => {
        const session = await openSession("x\n");
        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();

        expect(session.modeChanges).toEqual(["source"]);
        expect(session.mode()).toBe("source");
        expect(surfaceKinds(session.container).source).toBe(1);
        // The Markdown the session persists says nothing about which surface
        // was showing it.
        expect(session.markdown()).not.toContain("source");
    });

    it("is idempotent when asked for the mode already showing", async () => {
        const session = await openSession("x\n");
        const first = await session.handle.current!.setMode("wysiwyg");
        expect(first).toEqual({ ok: true });
        expect(session.modeChanges).toEqual([]);
        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 1,
            source: 0,
        });
    });
});

describe("surface mode — editing in source feeds the same session", () => {
    it("reports source edits as changes on the same document", async () => {
        const session = await openSession("hello\n");
        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();
        expect(surfaceKinds(session.container).source).toBe(1);
        session.changes.length = 0;

        await act(async () => {
            await session.handle.current!.execute({
                commandId: "c2",
                documentId: "doc",
                baseRevision: session.revision(),
                selection: { anchor: 5, head: 5 },
                kind: "replace-selection",
                text: " world",
            });
        });
        await session.settle();

        expect(session.changes.length).toBeGreaterThan(0);
        for (const change of session.changes) {
            expect(change.documentId).toBe("doc");
        }
        expect(session.markdown()).toContain("hello world");
    });

    it("applies a clean reload to whichever surface is showing", async () => {
        const session = await openSession("before\n");
        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();
        expect(surfaceKinds(session.container).source).toBe(1);
        expect(session.container.textContent).toContain("before");

        await session.reload("after\n");
        await session.settle();

        // The reload reaches the surface that is showing, and it is still the
        // source surface: a reload is not a reason to rebuild the view.
        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 0,
            source: 1,
        });
        expect(session.container.textContent).toContain("after");
        expect(session.container.textContent).not.toContain("before");
        expect(session.markdown()).toBe("after\n");
    });
});

describe("surface mode — unknown syntax is not a fatal parse", () => {
    it("switches back to visual with an unknown directive present", async () => {
        const session = await openSession(":::spoiler\nhidden\n:::\n");
        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();

        // It really left the visual surface, so switching "back" has somewhere
        // to come back from: a switch that never happened would satisfy every
        // claim this test makes about the end state.
        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 0,
            source: 1,
        });
        expect(session.container.textContent).toContain(":::spoiler");

        const result = await act(async () =>
            session.handle.current!.setMode("wysiwyg"),
        );

        expect(result).toEqual({ ok: true });
        await session.settle();
        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 1,
            source: 0,
        });
        expect(session.container.textContent).toContain("hidden");
        expect(session.markdown()).toContain(":::spoiler");
    });

    it("switches back with raw HTML present", async () => {
        const session = await openSession('<div class="x">y</div>\n');
        await act(async () => {
            await session.handle.current!.setMode("source");
        });
        await session.settle();

        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 0,
            source: 1,
        });
        expect(session.container.textContent).toContain('<div class="x">');

        const result = await act(async () =>
            session.handle.current!.setMode("wysiwyg"),
        );

        expect(result).toEqual({ ok: true });
        await session.settle();
        expect(surfaceKinds(session.container)).toEqual({
            wysiwyg: 1,
            source: 0,
        });
        expect(session.markdown()).toContain('<div class="x">y</div>');
    });
});
