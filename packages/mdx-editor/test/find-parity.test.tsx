// @vitest-environment jsdom
import { createRef, type RefObject } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { createEditingSurface, type EditingSurface } from "../adapter/editing-surface";
import { MarkdownEditorAdapter } from "../adapter/markdown-editor-adapter";
import type {
    EditorAdapterDiagnostic,
    EditorDocumentSnapshot,
    EditorFindRequest,
    EditorFindResult,
    EditorSurfaceMode,
    MarkdownEditorAdapterHandle,
} from "../adapter/types";

/**
 * Find searches the document's text, and both surfaces answer the same.
 *
 * The Markdown a source view shows is a *spelling* of the document, not the
 * document: the `**` around a bold word, a link's destination, an image's alt
 * and src, an inline formula's LaTeX, a wikilink's target and a callout's
 * marker are all on screen there and none of them is text the reader is
 * searching. None has a text position in WYSIWYG either, so a match inside one
 * could not be revealed — and a match the user cannot navigate to is worse than
 * no match.
 *
 * Every case below therefore states two things: what both surfaces must return,
 * and how many times the query occurs in the raw Markdown. The second is what
 * keeps an exclusion honest — a case claiming "the destination is not searched"
 * has to show the destination was there to be searched.
 */

(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLElement }> = [];
const surfaces: EditingSurface[] = [];

afterEach(async () => {
    while (roots.length > 0) {
        const entry = roots.pop();
        if (!entry) continue;
        await act(async () => {
            entry.root.unmount();
        });
        entry.container.remove();
    }
    while (surfaces.length > 0) await surfaces.pop()?.destroy();
    document.body.innerHTML = "";
});

interface Session {
    handle: RefObject<MarkdownEditorAdapterHandle | null>;
    container: HTMLElement;
    diagnostics: EditorAdapterDiagnostic[];
    switchTo(mode: EditorSurfaceMode): Promise<void>;
}

async function openSession(initialMarkdown: string): Promise<Session> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });

    const handle = createRef<MarkdownEditorAdapterHandle>();
    const snapshot: EditorDocumentSnapshot = {
        documentId: "doc",
        revision: 1,
        markdown: initialMarkdown,
    };
    let mode: EditorSurfaceMode = "wysiwyg";

    const render = async (): Promise<void> => {
        await act(async () => {
            root.render(
                <MarkdownEditorAdapter
                    ref={handle}
                    snapshot={snapshot}
                    mode={mode}
                    editable
                    onChange={() => {}}
                    onSelectionChange={() => {}}
                    onModeChange={(next) => {
                        mode = next;
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

    const session: Session = {
        handle,
        container,
        diagnostics: [],
        switchTo: async (next) => {
            await act(async () => {
                await handle.current!.setMode(next);
            });
            await render();
        },
    };

    await render();
    return session;
}

function request(query: string): EditorFindRequest {
    return { query, caseSensitive: false, wholeWord: false };
}

function slices(markdown: string, result: EditorFindResult): string[] {
    return result.matches.map((match) =>
        markdown.slice(match.range.anchor, match.range.head),
    );
}

/** How many times `query` occurs in the raw Markdown, ignoring case. */
function rawOccurrences(markdown: string, query: string): number {
    const haystack = markdown.toLowerCase();
    const needle = query.toLowerCase();
    let count = 0;
    for (
        let at = haystack.indexOf(needle);
        at !== -1;
        at = haystack.indexOf(needle, at + needle.length)
    ) {
        count += 1;
    }
    return count;
}

interface ParityCase {
    name: string;
    markdown: string;
    query: string;
    /** The source slice of every match, in document order, on both surfaces. */
    matches: string[];
    /** Occurrences in the raw Markdown, so an exclusion has to be a real one. */
    rawCount: number;
}

const cases: ParityCase[] = [
    {
        name: "a link's destination is markup, its text is not",
        markdown: "A [label](http://example.test/path) here.\n",
        query: "example",
        matches: [],
        rawCount: 1,
    },
    {
        name: "a link's text is searched",
        markdown: "A [label](http://example.test/path) here.\n",
        query: "label",
        matches: ["label"],
        rawCount: 1,
    },
    {
        name: "an image's alt text is an attribute, not text",
        markdown: "An ![alt text](http://img.test/a.png) here.\n",
        query: "alt",
        matches: [],
        rawCount: 1,
    },
    {
        name: "an image's source is an attribute, not text",
        markdown: "An ![alt text](http://img.test/a.png) here.\n",
        query: "img",
        matches: [],
        rawCount: 1,
    },
    {
        name: "inline math source is an attribute, not text",
        markdown: "Euler wrote $e^{ipi} + 1 = 0$ here.\n",
        query: "ipi",
        matches: [],
        rawCount: 1,
    },
    {
        name: "a math block's source is the block's text",
        markdown: "$$\nanchor = 2\n$$\n",
        query: "anchor",
        matches: ["anchor"],
        rawCount: 1,
    },
    {
        name: "a wikilink's target is an attribute, not text",
        markdown: "See [[Target Page|the page]] now.\n",
        query: "Target",
        matches: [],
        rawCount: 1,
    },
    {
        name: "a wikilink's alias is an attribute too",
        markdown: "See [[Target Page|the page]] now.\n",
        query: "the page",
        matches: [],
        rawCount: 1,
    },
    {
        name: "emphasis delimiters are markup",
        markdown: "Some *emphasis* here.\n",
        query: "*",
        matches: [],
        rawCount: 2,
    },
    {
        name: "emphasized text is text",
        markdown: "Some *emphasis* here.\n",
        query: "emphasis",
        matches: ["emphasis"],
        rawCount: 1,
    },
    {
        name: "a callout's marker is markup",
        markdown: "> [!WARNING]\n> Be careful.\n",
        query: "WARNING",
        matches: [],
        rawCount: 1,
    },
    {
        name: "a callout's body is text",
        markdown: "> [!WARNING]\n> Be careful.\n",
        query: "careful",
        matches: ["careful"],
        rawCount: 1,
    },
    {
        name: "a preserved reference link keeps its bytes out of the search",
        markdown: "See [ref][1] here.\n\n[1]: http://x\n",
        query: "ref",
        matches: [],
        rawCount: 1,
    },
    {
        name: "a preserved inline extension keeps its bytes out of the search",
        markdown: "Text with {{macro:value}} inside.\n",
        query: "macro",
        matches: [],
        rawCount: 1,
    },
    {
        name: "a preserved fallback block's content is the block's text",
        markdown: ":::spoiler\nHidden content.\n:::\n",
        query: "Hidden",
        matches: ["Hidden"],
        rawCount: 1,
    },
    {
        name: "raw html is the block's text",
        markdown: '<div class="note">\n  <p>Hello.</p>\n</div>\n',
        query: "Hello",
        matches: ["Hello"],
        rawCount: 1,
    },
    {
        name: "frontmatter is the block's text",
        markdown: "---\ntitle: Example\n---\n\nBody.\n",
        query: "title",
        matches: ["title"],
        rawCount: 1,
    },
    {
        name: "a footnote reference and its definition are both text",
        markdown: "Text with a note[^n1].\n\n[^n1]: The note body.\n",
        query: "note",
        matches: ["note", "note"],
        rawCount: 2,
    },
    {
        name: "a mermaid fence's source is the block's text",
        markdown: "```mermaid\ngraph TD\n  A --> B\n```\n",
        query: "graph",
        matches: ["graph"],
        rawCount: 1,
    },
    {
        name: "inline code is text",
        markdown: "Use `code here` now.\n",
        query: "code",
        matches: ["code"],
        rawCount: 1,
    },
    {
        name: "list items are text",
        markdown: "- item one\n- item two\n",
        query: "item",
        matches: ["item", "item"],
        rawCount: 2,
    },
    {
        name: "a query spanning a delimiter matches the text, not the spelling",
        // `boldword` is one run of text in the document and four characters of
        // markup away from itself in the source. It matches, and the range
        // covers the source those two characters came from — both edges exact,
        // nothing guessed.
        markdown: "A **bold**word here.\n",
        query: "dw",
        matches: ["d**w"],
        rawCount: 0,
    },
];

describe("find — the same query means the same thing on either surface", () => {
    for (const entry of cases) {
        it(entry.name, async () => {
            // The Markdown really does contain what the case claims, so a case
            // asserting an exclusion is asserting that something present was
            // left out rather than that nothing was ever there.
            expect(
                rawOccurrences(entry.markdown, entry.query),
                "the raw Markdown does not hold what this case is about",
            ).toBe(entry.rawCount);

            const session = await openSession(entry.markdown);
            expect(session.container.querySelector(".ProseMirror")).not.toBeNull();
            const visual = session.handle.current!.find(request(entry.query));
            expect(slices(entry.markdown, visual)).toEqual(entry.matches);

            await session.switchTo("source");
            expect(session.container.querySelector(".cm-editor")).not.toBeNull();
            expect(session.container.querySelector(".ProseMirror")).toBeNull();
            const source = session.handle.current!.find(request(entry.query));

            expect(source.matches).toEqual(visual.matches);
            expect(slices(entry.markdown, source)).toEqual(entry.matches);
            expect(session.diagnostics).toEqual([]);
        }, 60000);
    }
});

describe("find — named character references", () => {
    /**
     * A named character reference is one character of document text spelled
     * with five of source. Both surfaces must use the same decoded-text map.
     */
    const ENTITY = "A &amp; B\n";

    it("maps the decoded ampersand to the whole reference on both surfaces", async () => {
        const session = await openSession(ENTITY);
        const visual = session.handle.current!.find(request("&"));

        expect(slices(ENTITY, visual)).toEqual(["&amp;"]);
        expect(session.diagnostics).toEqual([]);

        await session.switchTo("source");
        session.diagnostics.length = 0;
        const source = session.handle.current!.find(request("&"));

        expect(source.matches).toEqual(visual.matches);
        expect(session.diagnostics).toEqual([]);
    }, 60000);

    it("reports nothing at all for a query the text does not contain", async () => {
        const session = await openSession(ENTITY);
        expect(session.handle.current!.find(request("zzz")).matches).toEqual([]);
        expect(session.diagnostics).toEqual([]);
    }, 60000);
});

describe("find — a document with no text to search", () => {
    /**
     * Deep blockquote nesting exhausts the parser's stack — the one input found
     * that genuinely defeats the build, which is why source mode exists at all.
     */
    const UNBUILDABLE = `${"> ".repeat(3000)}deep\n`;

    it("reports nothing, and says so, rather than searching the Markdown", async () => {
        const diagnostics: EditorAdapterDiagnostic[] = [];
        const root = document.createElement("div");
        document.body.append(root);
        const surface = await createEditingSurface("source", {
            root,
            markdown: UNBUILDABLE,
            editable: true,
            onMarkdownChange: () => {},
            onSelectionChange: () => {},
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });
        surfaces.push(surface);

        // The word is right there in the Markdown the user is editing, so a
        // search of the Markdown would find it. There is no document, so there
        // is no document text, and the surface says that instead of answering a
        // different question.
        expect(rawOccurrences(UNBUILDABLE, "deep")).toBe(1);

        expect(surface.findMatches(request("deep"))).toEqual([]);
        expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
            "editor_semantic_text_unavailable",
        ]);
    }, 60000);

    it("still finds text in a document that does build", async () => {
        // Control. Without it, "no matches" above would be equally true of a
        // surface that can never find anything.
        const diagnostics: EditorAdapterDiagnostic[] = [];
        const root = document.createElement("div");
        document.body.append(root);
        const surface = await createEditingSurface("source", {
            root,
            markdown: "> > deep enough\n",
            editable: true,
            onMarkdownChange: () => {},
            onSelectionChange: () => {},
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });
        surfaces.push(surface);

        expect(surface.findMatches(request("deep"))).toEqual([
            { anchor: 4, head: 8 },
        ]);
        expect(diagnostics).toEqual([]);
    }, 60000);
});
