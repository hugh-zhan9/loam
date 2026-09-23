// @vitest-environment jsdom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownEditorSurface } from "./markdown-editor-surface";
import { createEditorSessionBinding } from "../lib/editor-session-binding";
import type { EditorSurfaceMode } from "../../../packages/mdx-editor";

/**
 * Find and replace on the adapter surface.
 *
 * Every match here is one the editor found by walking the document it holds.
 * That is the point of the tests that count: a preview repeats its own source
 * into the rendered output, so anything reading what is on screen reports more
 * matches than the document contains, and the same query would mean different
 * things in the visual view and the source view.
 */

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

/** What the session reports back about the caret, as the CLI context shape. */
interface ReportedSelection {
    has_selection: boolean;
    selected_text: string;
    before: string;
    before_truncated: boolean;
}

interface Harness {
    container: HTMLElement;
    /** The Markdown the session holds right now. */
    markdown(): string;
    /** The most recent selection the surface reported, or null. */
    selection(): ReportedSelection | null;
    editor(): HTMLElement;
}

function SessionHost({
    initialMarkdown,
    initialMode,
    markdownRef,
    selectionRef,
}: {
    initialMarkdown: string;
    initialMode: EditorSurfaceMode;
    markdownRef: { current: string };
    selectionRef: { current: ReportedSelection | null };
}) {
    const [binding] = useState(createEditorSessionBinding);
    const [markdown, setMarkdown] = useState(initialMarkdown);

    useEffect(() => {
        markdownRef.current = markdown;
    }, [markdown, markdownRef]);

    return (
        <MarkdownEditorSurface
            session={binding}
            documentId="doc"
            markdown={markdown}
            initialMode={initialMode}
            onMarkdownChange={(_, next) => setMarkdown(next)}
            onSelectionChange={(_, selection) => {
                selectionRef.current =
                    (selection as unknown as ReportedSelection | null) ?? null;
            }}
        />
    );
}

async function mountSurface(
    initialMarkdown: string,
    initialMode: EditorSurfaceMode = "wysiwyg",
): Promise<Harness> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    const markdownRef = { current: initialMarkdown };
    const selectionRef: { current: ReportedSelection | null } = {
        current: null,
    };

    await act(async () => {
        root.render(
            <SessionHost
                initialMarkdown={initialMarkdown}
                initialMode={initialMode}
                markdownRef={markdownRef}
                selectionRef={selectionRef}
            />,
        );
    });

    return {
        container,
        markdown: () => markdownRef.current,
        selection: () => selectionRef.current,
        editor() {
            const surface = container.querySelector<HTMLElement>(
                initialMode === "source" ? ".cm-content" : ".ProseMirror",
            );
            if (!surface) throw new Error("editing surface did not mount");
            return surface;
        },
    };
}

/**
 * A keystroke delivered to the editor the way the browser delivers one: a real
 * event dispatched at the focused editing element, which reaches the surface by
 * bubbling exactly as a user's would.
 */
function pressInEditor(
    harness: Harness,
    init: { key: string; code?: string; metaKey?: boolean; shiftKey?: boolean },
): void {
    harness.editor().dispatchEvent(
        new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: init.key,
            code: init.code ?? "",
            metaKey: init.metaKey ?? false,
            shiftKey: init.shiftKey ?? false,
        }),
    );
}

/**
 * Types into a controlled input the way React sees typing.
 *
 * React keeps its own record of an input's last value, so assigning `value`
 * through the element hides the change from it. The prototype setter writes
 * past that record, which is what makes the following `input` event look like a
 * keystroke rather than a no-op.
 */
function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    if (!setter) throw new Error("no value setter on HTMLInputElement");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findBarInput(harness: Harness, label: string): HTMLInputElement {
    const input = harness.container.querySelector<HTMLInputElement>(
        `input[aria-label='${label}']`,
    );
    if (!input) throw new Error(`find bar has no "${label}" field`);
    return input;
}

function countLabel(harness: Harness): string {
    const label = harness.container.querySelector<HTMLElement>(
        ".tabular-nums",
    );
    if (!label) throw new Error("find bar has no match count");
    return label.textContent ?? "";
}

function clickLabelled(harness: Harness, label: string): void {
    const button = harness.container.querySelector<HTMLButtonElement>(
        `button[aria-label='${label}']`,
    );
    if (!button) throw new Error(`find bar has no "${label}" button`);
    act(() => {
        button.click();
    });
}

async function clickText(harness: Harness, text: string): Promise<void> {
    const button = Array.from(
        harness.container.querySelectorAll("button"),
    ).find((candidate) => candidate.textContent?.trim() === text);
    if (!button) throw new Error(`find bar has no "${text}" button`);
    await act(async () => {
        button.click();
    });
}

async function openFind(harness: Harness): Promise<void> {
    await act(async () => {
        pressInEditor(harness, { key: "f", code: "KeyF", metaKey: true });
    });
}

async function search(harness: Harness, query: string): Promise<void> {
    await act(async () => {
        typeInto(findBarInput(harness, "查找"), query);
    });
}

/** Every offset at which `word` really occurs, found without the editor. */
function occurrences(markdown: string, word: string): number[] {
    const found: number[] = [];
    for (
        let at = markdown.indexOf(word);
        at !== -1;
        at = markdown.indexOf(word, at + word.length)
    ) {
        found.push(at);
    }
    return found;
}

/**
 * A document whose preview repeats its own source: KaTeX emits the formula
 * again inside a MathML annotation, so `anchor` is on screen more times than
 * the document contains it.
 */
const PREVIEW_DOCUMENT = [
    "# Find the anchor",
    "",
    "The anchor appears in prose here.",
    "",
    "$$",
    "anchor = 2",
    "$$",
    "",
    "- anchor in a list",
    "",
].join("\n");

const PROSE = "alpha beta alpha\n\nalpha tail\n";

describe("adapter surface find bar — opening", () => {
    it("opens on the editor's find shortcut", async () => {
        const harness = await mountSurface(PROSE);
        expect(
            harness.container.querySelector("input[aria-label='查找']"),
        ).toBeNull();

        await openFind(harness);

        expect(
            harness.container.querySelector("input[aria-label='查找']"),
        ).not.toBeNull();
        expect(
            harness.container.querySelector("input[aria-label='替换为']"),
        ).toBeNull();
    }, 60000);

    it("opens with the replacement field on the editor's replace shortcut", async () => {
        const harness = await mountSurface(PROSE);

        await act(async () => {
            pressInEditor(harness, { key: "r", code: "KeyR", metaKey: true });
        });

        expect(
            harness.container.querySelector("input[aria-label='查找']"),
        ).not.toBeNull();
        expect(
            harness.container.querySelector("input[aria-label='替换为']"),
        ).not.toBeNull();
    }, 60000);
});

describe("adapter surface find bar — what counts as a match", () => {
    it("counts the document's own text, not what the preview drew", async () => {
        const harness = await mountSurface(PREVIEW_DOCUMENT);

        // The preview really did render and really does repeat the source.
        // Without this the count below would be a claim about nothing.
        const preview =
            harness.container.querySelector<HTMLElement>(".mdx-math-preview");
        expect(preview).not.toBeNull();
        expect(preview?.textContent).toContain("anchor");
        const onScreen = occurrences(
            harness.container.textContent ?? "",
            "anchor",
        ).length;
        expect(onScreen).toBeGreaterThan(4);

        await openFind(harness);
        await search(harness, "anchor");

        expect(occurrences(PREVIEW_DOCUMENT, "anchor")).toHaveLength(4);
        expect(countLabel(harness)).toBe("1/4");
    }, 60000);

    it("selects the first match, and steps to the next one on Enter in the editor", async () => {
        const harness = await mountSurface(PROSE);
        const [first, second] = occurrences(PROSE, "alpha");

        await openFind(harness);
        await search(harness, "alpha");

        expect(countLabel(harness)).toBe("1/3");
        expect(harness.selection()?.selected_text).toBe("alpha");
        expect(harness.selection()?.before_truncated).toBe(false);
        expect(harness.selection()?.before.length).toBe(first);

        await act(async () => {
            pressInEditor(harness, { key: "Enter" });
        });

        expect(countLabel(harness)).toBe("2/3");
        expect(harness.selection()?.selected_text).toBe("alpha");
        expect(harness.selection()?.before.length).toBe(second);
    }, 60000);

    it("does not move the selection when Enter confirms IME input in the editor", async () => {
        const harness = await mountSurface(PROSE);
        await openFind(harness);
        await search(harness, "alpha");
        const before = harness.selection();

        for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
            await act(async () => {
                harness.editor().dispatchEvent(new KeyboardEvent("keydown", {
                    key: "Enter", bubbles: true, cancelable: true, ...flags,
                }));
            });
            expect(countLabel(harness)).toBe("1/3");
            expect(harness.selection()).toEqual(before);
            expect(harness.markdown()).toBe(PROSE);
        }
    });

    it("honours the case-sensitivity toggle", async () => {
        const harness = await mountSurface("Alpha and alpha.\n");

        await openFind(harness);
        await search(harness, "alpha");
        expect(countLabel(harness)).toBe("1/2");

        clickLabelled(harness, "大小写敏感");

        expect(countLabel(harness)).toBe("1/1");
    }, 60000);
});

describe("adapter surface find bar — replacing", () => {
    async function openReplace(harness: Harness, query: string, to: string) {
        await act(async () => {
            pressInEditor(harness, { key: "r", code: "KeyR", metaKey: true });
        });
        await search(harness, query);
        await act(async () => {
            typeInto(findBarInput(harness, "替换为"), to);
        });
    }

    it("replaces only the current match", async () => {
        const harness = await mountSurface(PROSE);
        await openReplace(harness, "alpha", "om");
        expect(countLabel(harness)).toBe("1/3");

        await clickText(harness, "替换");

        expect(harness.markdown()).toBe("om beta alpha\n\nalpha tail\n");
    }, 60000);

    it("replaces the match the user stepped to, not the first one", async () => {
        const harness = await mountSurface(PROSE);
        await openReplace(harness, "alpha", "om");

        clickLabelled(harness, "下一处");
        expect(countLabel(harness)).toBe("2/3");

        await clickText(harness, "替换");

        expect(harness.markdown()).toBe("alpha beta om\n\nalpha tail\n");
    }, 60000);

    it("replaces every match", async () => {
        const harness = await mountSurface(PROSE);
        await openReplace(harness, "alpha", "om");

        await clickText(harness, "替换全部");

        expect(harness.markdown()).toBe("om beta om\n\nom tail\n");
    }, 60000);
});

describe("adapter surface find bar — the source surface", () => {
    it("finds and replaces the same matches with the source view mounted", async () => {
        const harness = await mountSurface(PROSE, "source");
        expect(harness.container.querySelector(".cm-editor")).not.toBeNull();
        expect(harness.container.querySelector(".ProseMirror")).toBeNull();

        await act(async () => {
            pressInEditor(harness, { key: "r", code: "KeyR", metaKey: true });
        });
        await search(harness, "alpha");
        expect(countLabel(harness)).toBe("1/3");

        await act(async () => {
            typeInto(findBarInput(harness, "替换为"), "om");
        });
        await clickText(harness, "替换全部");

        expect(harness.markdown()).toBe("om beta om\n\nom tail\n");
    }, 60000);
});
