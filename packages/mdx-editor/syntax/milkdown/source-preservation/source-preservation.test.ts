// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { SchemaReady, schemaCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import {
    DOMParser,
    type Schema,
    type Slice,
} from "@milkdown/kit/prose/model";

import { createBaseMilkdownPlugins } from "../../../milkdown/base-plugins";
import {
    createMilkdownEditorHost,
    type MilkdownEditorHost,
} from "../../../milkdown/editor-host";
import {
    forgedClipboardPayloads,
    htmlFixtures,
    scriptExecutionProbes,
    unknownSyntaxFixtures,
} from "../../../test/syntax-fixtures";
import { sourcePreservationPlugins } from "./index";
import { createMdxMilkdownPlugins } from "../index";
import { sanitizePastedHtml } from "./clipboard-guard";
import {
    HTML_SOURCE_INLINE_NODE,
    HTML_SOURCE_NODE,
    SOURCE_FALLBACK_INLINE_NODE,
    SOURCE_FALLBACK_NODE,
} from "./nodes";
import {
    NODE_TYPE_ATTR,
    PREVIEW_ATTR,
    PREVIEW_ERROR_ATTR,
    SESSION_TOKEN,
    SOURCE_ID_ATTR,
    SOURCE_KIND_ATTR,
    SOURCE_TOKEN_ATTR,
} from "./session";

function editorPlugins(): MilkdownPlugin[] {
    return [...createBaseMilkdownPlugins(), ...sourcePreservationPlugins()];
}

/**
 * The window a payload would actually run in.
 *
 * Vitest hands the test file a facade over jsdom's window rather than the
 * window object jsdom scripts see, so a payload that ran would set the flag on
 * `jsdom.window` and nowhere else. Reading only the test-file `window` would
 * make every inertness assertion pass for the wrong reason.
 */
const runtime = globalThis as unknown as {
    jsdom?: { window: Record<string, unknown> };
    window?: Record<string, unknown>;
    __pwned?: boolean;
};

function pwned(): unknown {
    return (
        runtime.jsdom?.window.__pwned ?? runtime.window?.__pwned ?? runtime.__pwned
    );
}

function clearPwned(): void {
    if (runtime.jsdom) runtime.jsdom.window.__pwned = undefined;
    if (runtime.window) runtime.window.__pwned = undefined;
    runtime.__pwned = undefined;
}

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

const mounted: MilkdownEditorHost[] = [];

afterEach(async () => {
    while (mounted.length > 0) {
        await mounted.pop()?.destroy();
    }
    document.body.innerHTML = "";
    clearPwned();
});

interface Mounted {
    host: MilkdownEditorHost;
    root: HTMLElement;
}

async function mount(
    markdown: string,
    plugins: MilkdownPlugin[] = editorPlugins(),
): Promise<Mounted> {
    const root = document.createElement("div");
    document.body.append(root);
    const host = await createMilkdownEditorHost({
        root,
        markdown,
        editable: true,
        plugins,
        onMarkdownChange: () => {},
        onSelectionChange: () => {},
    });
    mounted.push(host);
    return { host, root };
}

/**
 * Serialization only runs once a transaction dirties the document, so every
 * fidelity assertion edits first. The edit lands in a leading anchor paragraph,
 * which keeps it outside the slice under test even when the slice runs to the
 * end of the file.
 */
const ANCHOR = "Anchor.\n\n";

async function serializeAfterAnchorEdit(
    fixture: string,
    plugins?: MilkdownPlugin[],
): Promise<string> {
    const { host } = await mount(`${ANCHOR}${fixture}`, plugins);
    expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
    host.flush();
    return host.getMarkdown();
}

async function expectRoundTrip(fixture: string): Promise<void> {
    expect(await serializeAfterAnchorEdit(fixture)).toBe(`X${ANCHOR}${fixture}`);
}

function elements(root: ParentNode): Element[] {
    return Array.from(root.querySelectorAll("*"));
}

function eventHandlerAttributes(root: ParentNode): string[] {
    const found: string[] = [];
    for (const element of elements(root)) {
        for (const attribute of Array.from(element.attributes)) {
            if (attribute.name.toLowerCase().startsWith("on")) {
                found.push(`${element.localName}[${attribute.name}]`);
            }
        }
    }
    return found;
}

function urlAttributeValues(root: ParentNode): string[] {
    const found: string[] = [];
    for (const element of elements(root)) {
        for (const attribute of Array.from(element.attributes)) {
            if (["href", "src", "cite", "action"].includes(attribute.name)) {
                found.push(attribute.value);
            }
        }
    }
    return found;
}

function previews(root: ParentNode): Element[] {
    return Array.from(root.querySelectorAll(`[${PREVIEW_ATTR}]`));
}

function nodesOfType(root: ParentNode, type: string): Element[] {
    return Array.from(root.querySelectorAll(`[${NODE_TYPE_ATTR}="${type}"]`));
}

function occurrences(haystack: string, needle: string): number {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/** The schema the plugins under test actually build. */
async function mountedSchema(): Promise<Schema> {
    let schema: Schema | null = null;
    const capture: MilkdownPlugin = (ctx) => async () => {
        await ctx.wait(SchemaReady);
        schema = ctx.get(schemaCtx);
    };
    await mount("Anchor.\n", [...editorPlugins(), capture]);
    if (!schema) throw new Error("the schema was never built");
    return schema;
}

/** Parses HTML with the schema's own rules, with no sanitizer in front. */
function parseSliceOfHtml(schema: Schema, html: string): Slice {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return DOMParser.fromSchema(schema).parseSlice(holder);
}

function countNodes(slice: Slice, typeName: string): number {
    let found = 0;
    slice.content.descendants((node) => {
        if (node.type.name === typeName) found += 1;
    });
    return found;
}

function dispatchPaste(root: HTMLElement, html: string, text = ""): void {
    const editable = root.querySelector<HTMLElement>(".ProseMirror");
    if (!editable) throw new Error("no ProseMirror surface mounted");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
        value: {
            types: ["text/html", "text/plain"],
            getData: (type: string) =>
                type === "text/html" ? html : type === "text/plain" ? text : "",
        },
    });
    editable.dispatchEvent(event);
}

describe("html source round-trips byte-for-byte", () => {
    for (const fixture of htmlFixtures) {
        it(`preserves the ${fixture.name} fixture`, async () => {
            const serialized = await serializeAfterAnchorEdit(fixture.markdown);
            expect(serialized).toBe(`X${ANCHOR}${fixture.markdown}`);
            for (const slice of fixture.preservedSlices) {
                expect(serialized).toContain(slice);
            }
        });
    }

    it("keeps block html as one editable source node", async () => {
        const { root } = await mount(
            `${ANCHOR}<div class="note">\n  <p>Hello.</p>\n</div>\n`,
        );
        const block = nodesOfType(root, HTML_SOURCE_NODE);
        expect(block).toHaveLength(1);
        expect(block[0].querySelector("code")?.textContent).toBe(
            '<div class="note">\n  <p>Hello.</p>\n</div>',
        );
    });

    it("keeps inline html as inline nodes inside the paragraph", async () => {
        const { root } = await mount(
            `${ANCHOR}Press <kbd>Cmd</kbd> + <kbd>Z</kbd>.\n`,
        );
        expect(nodesOfType(root, HTML_SOURCE_INLINE_NODE)).toHaveLength(4);
        expect(nodesOfType(root, HTML_SOURCE_NODE)).toHaveLength(0);
    });

    it.each([
        '<a id="D-003"></a>',
        "<a id='D-003'> </a>",
        '<a id="D-003">\n</a>',
        '<a id="D-003"></a><a id="D-004"></a>',
        '<a id="D-003"></a>\n<a id="D-004"></a>',
    ])("previews standalone empty anchors without source controls: %s", async (html) => {
        const markdown = `${html}\n\n## D-003 · Behavior Contract\n`;
        const { host, root } = await mount(`${ANCHOR}${markdown}`);

        expect(nodesOfType(root, HTML_SOURCE_INLINE_NODE)).toHaveLength(0);
        const block = nodesOfType(root, HTML_SOURCE_NODE)[0];
        expect(block).toBeDefined();
        expect(block.querySelector("pre")?.hidden).toBe(true);
        expect(block.querySelector("input")).toBeNull();
        const preview = block.querySelector(`[${PREVIEW_ATTR}]`)!;
        expect(preview.querySelector("a")).not.toBeNull();
        expect(preview.textContent?.trim()).toBe("");
        expect(root.querySelector("h2")?.textContent).toBe("D-003 · Behavior Contract");

        expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
        host.flush();
        expect(host.getMarkdown()).toBe(`X${ANCHOR}${markdown}`);
    });

    it.each(["> ", "- "])("preserves standalone anchors inside %s containers", async (prefix) => {
        const markdown = `${prefix}<a id="D-003"></a>\n`;
        const { root } = await mount(markdown, createMdxMilkdownPlugins());
        expect(nodesOfType(root, HTML_SOURCE_INLINE_NODE)).toHaveLength(0);
        expect(previews(root)[0].querySelector("a")).not.toBeNull();
        expect(await serializeAfterAnchorEdit(markdown, createMdxMilkdownPlugins()))
            .toBe(`X${ANCHOR}${markdown}`);
    });

    it("keeps anchor examples literal in code", async () => {
        const html = '<a id="D-003"></a>';
        const markdown = `\`${html}\`\n\n\`\`\`html\n${html}\n\`\`\`\n`;
        const { root } = await mount(markdown);
        expect(previews(root)).toHaveLength(0);
        expect(root.querySelector("code")?.textContent).toBe(html);
        await expectRoundTrip(markdown);
    });

    it("survives a second serialization pass unchanged", async () => {
        for (const fixture of htmlFixtures) {
            const once = await serializeAfterAnchorEdit(fixture.markdown);
            const slice = once.slice(`X${ANCHOR}`.length);
            expect(slice, fixture.name).toBe(fixture.markdown);
            expect(await serializeAfterAnchorEdit(slice), fixture.name).toBe(once);
        }
    });
});

describe("unrepresentable syntax round-trips byte-for-byte", () => {
    for (const fixture of unknownSyntaxFixtures) {
        it(`preserves the ${fixture.name} fixture`, async () => {
            const serialized = await serializeAfterAnchorEdit(fixture.markdown);
            expect(serialized).toBe(`X${ANCHOR}${fixture.markdown}`);
            for (const slice of fixture.preservedSlices) {
                expect(serialized).toContain(slice);
            }
        });
    }

    it("preserves an unclosed fence to the end of the file", async () => {
        const markdown = "```unknownlang\nnever closed\n";
        const { host, root } = await mount(`${ANCHOR}${markdown}`);
        const block = nodesOfType(root, SOURCE_FALLBACK_NODE);
        expect(block).toHaveLength(1);
        expect(block[0].getAttribute(SOURCE_KIND_ATTR)).toBe("unclosed_fence");
        expect(block[0].querySelector("code")?.textContent).toBe(
            "```unknownlang\nnever closed",
        );
        expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
        host.flush();
        expect(host.getMarkdown()).toBe(`X${ANCHOR}${markdown}`);
    });

    it("leaves a closed fence to the code-block schema", async () => {
        const { root } = await mount("```js\nconst a = 1;\n```\n");
        expect(nodesOfType(root, SOURCE_FALLBACK_NODE)).toHaveLength(0);
        await expectRoundTrip("```js\nconst a = 1;\n```\n");
    });

    it("preserves an unknown directive block", async () => {
        const { root } = await mount(`${ANCHOR}:::spoiler\nHidden content.\n:::\n`);
        const block = nodesOfType(root, SOURCE_FALLBACK_NODE);
        expect(block).toHaveLength(1);
        expect(block[0].getAttribute(SOURCE_KIND_ATTR)).toBe("directive");
        await expectRoundTrip(":::spoiler\nHidden content.\n:::\n");
    });

    it("preserves an unknown inline extension", async () => {
        const { root } = await mount(`${ANCHOR}Text with {{macro:value}} inside.\n`);
        const inline = nodesOfType(root, SOURCE_FALLBACK_INLINE_NODE);
        expect(inline).toHaveLength(1);
        expect(inline[0].getAttribute(SOURCE_KIND_ATTR)).toBe("inline_extension");
        await expectRoundTrip("Text with {{macro:value}} inside.\n");
    });

    it("preserves a fence whose info string carries more than a language", async () => {
        const { root } = await mount(
            `${ANCHOR}\`\`\`js title=x\nconst a = 1;\n\`\`\`\n`,
        );
        const block = nodesOfType(root, SOURCE_FALLBACK_NODE);
        expect(block).toHaveLength(1);
        expect(block[0].getAttribute(SOURCE_KIND_ATTR)).toBe("fence_meta");
        await expectRoundTrip("```js title=x\nconst a = 1;\n```\n");
    });

    // A backtick fence's info string may not contain a backtick, so a line
    // opening with three of them can still be a paragraph whose first span is
    // inline code. Reading it as an unclosed fence would swallow the prose
    // after it into an opaque source block.
    it("does not read inline code at the start of a line as a fence", async () => {
        const { root } = await mount(`${ANCHOR}\`\`\`x\`\`\` starts a line\n`);
        expect(nodesOfType(root, SOURCE_FALLBACK_NODE)).toHaveLength(0);
        expect(root.querySelector("code")?.textContent).toBe("x");
    });

    it("preserves an unknown inline extension that swallowed a subtree", async () => {
        // `{{` and `}}` land in two different text nodes once remark has read
        // the emphasis between them, so nothing matching a single value can
        // see the run at all.
        const { root } = await mount(`${ANCHOR}a {{*x*_y_[z]}} b\n`);
        const inline = nodesOfType(root, SOURCE_FALLBACK_INLINE_NODE);
        expect(inline).toHaveLength(1);
        expect(inline[0].getAttribute(SOURCE_KIND_ATTR)).toBe(
            "inline_extension",
        );
        expect(root.querySelector("em")).toBeNull();
        await expectRoundTrip("a {{*x*_y_[z]}} b\n");
    });

    it("preserves two spanning extensions in one paragraph", async () => {
        const { root } = await mount(
            `${ANCHOR}a {{*x*[1]}} b {{*y*[2]}} c\n`,
        );
        expect(nodesOfType(root, SOURCE_FALLBACK_INLINE_NODE)).toHaveLength(2);
        await expectRoundTrip("a {{*x*[1]}} b {{*y*[2]}} c\n");
    });

    it("leaves an unterminated brace pair as prose", async () => {
        const { root } = await mount(`${ANCHOR}a {{*x* b\n`);
        expect(nodesOfType(root, SOURCE_FALLBACK_INLINE_NODE)).toHaveLength(0);
        expect(root.querySelector("em")).not.toBeNull();
    });

    it("keeps adjacent fallback blocks apart", async () => {
        const markdown = ":::one\nfirst\n:::\n\n:::two\nsecond\n:::\n";
        const { root } = await mount(`${ANCHOR}${markdown}`);
        const blocks = nodesOfType(root, SOURCE_FALLBACK_NODE);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].getAttribute(SOURCE_ID_ATTR)).not.toBe(
            blocks[1].getAttribute(SOURCE_ID_ATTR),
        );
        await expectRoundTrip(markdown);
    });

    it("does not read a fallback block's content as Markdown", async () => {
        const markdown = ":::note\n**bold** and [link](url) and [[wiki]]\n:::\n";
        const { root } = await mount(`${ANCHOR}${markdown}`);
        const block = nodesOfType(root, SOURCE_FALLBACK_NODE)[0];
        expect(block.querySelector("strong")).toBeNull();
        expect(block.querySelector("a")).toBeNull();
        expect(block.querySelector("code")?.textContent).toBe(
            ":::note\n**bold** and [link](url) and [[wiki]]\n:::",
        );
        await expectRoundTrip(markdown);
    });

    it("preserves a CRLF fallback block", async () => {
        const markdown = ":::keep\r\nwindows line endings\r\n:::\r\n";
        const { host } = await mount(`Anchor.\r\n\r\n${markdown}`);
        expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
        host.flush();
        // The slice itself is stored with `\n`, like everything else in the
        // document; the file's own ending goes back on once, where the
        // serializer's output leaves the host. Storing the raw `\r\n` here
        // instead would write it twice.
        expect(host.getMarkdown()).toBe(
            "XAnchor.\r\n\r\n:::keep\r\nwindows line endings\r\n:::\r\n",
        );
        expect(host.getMarkdown()).not.toContain("\r\r");
    });
});

describe("script execution probes are inert", () => {
    it("the inertness detector can observe execution at all", async () => {
        // Control. Without this, "the flag is undefined" would be equally true
        // of a test harness that can never observe a payload running, and every
        // assertion below would be worthless.
        clearPwned();
        const template = document.createElement("template");
        template.innerHTML = "<script>window.__pwned = true;</script>";
        document.body.append(template.content.cloneNode(true));
        await settle();
        expect(pwned()).toBe(true);
        clearPwned();
    });

    for (const probe of scriptExecutionProbes) {
        it(`does not execute ${probe}`, async () => {
            clearPwned();
            const { host, root } = await mount(`${ANCHOR}${probe}\n`);
            await settle();

            expect(pwned()).toBeUndefined();
            expect(root.querySelectorAll("script")).toHaveLength(0);
            expect(eventHandlerAttributes(root)).toEqual([]);
            for (const preview of previews(root)) {
                expect(preview.querySelectorAll("script")).toHaveLength(0);
                expect(eventHandlerAttributes(preview)).toEqual([]);
                for (const url of urlAttributeValues(preview)) {
                    expect(url.toLowerCase()).not.toContain("javascript:");
                }
                expect(preview.querySelectorAll("iframe")).toHaveLength(0);
                expect(preview.querySelectorAll("object")).toHaveLength(0);
                expect(preview.querySelectorAll("embed")).toHaveLength(0);
                expect(preview.querySelectorAll("base")).toHaveLength(0);
                expect(preview.querySelectorAll("style")).toHaveLength(0);
                expect(preview.querySelectorAll("meta")).toHaveLength(0);
                expect(preview.querySelector("[srcdoc]")).toBeNull();
            }
            expect(host.hasFailed()).toBe(false);
        });

        it(`keeps ${probe} in the source it came from`, async () => {
            expect(await serializeAfterAnchorEdit(`${probe}\n`)).toBe(
                `X${ANCHOR}${probe}\n`,
            );
        });
    }

    it("keeps an svg script payload out of the preview", async () => {
        const { root } = await mount(
            `${ANCHOR}<svg><script>window.__pwned = true;</script></svg>\n`,
        );
        await settle();
        expect(pwned()).toBeUndefined();
        expect(root.querySelectorAll("script")).toHaveLength(0);
        expect(root.querySelectorAll("svg")).toHaveLength(0);
    });

    it("keeps a meta refresh out of the preview", async () => {
        const { root } = await mount(
            `${ANCHOR}<meta http-equiv="refresh" content="0;url=https://evil.test">\n`,
        );
        expect(root.querySelectorAll("meta")).toHaveLength(0);
        for (const preview of previews(root)) {
            expect(preview.querySelector("[http-equiv]")).toBeNull();
        }
    });

    it("keeps style and inline css out of the preview", async () => {
        const { root } = await mount(
            `${ANCHOR}<div style="background:url(javascript:alert(1))"><style>@import "evil.css";</style>x</div>\n`,
        );
        for (const preview of previews(root)) {
            expect(preview.querySelectorAll("style")).toHaveLength(0);
            expect(preview.querySelector("[style]")).toBeNull();
            expect(preview.textContent).not.toContain("@import");
        }
    });
});

describe("the preview is chrome, not content", () => {
    it("shows only the HTML table while preserving and updating its source", async () => {
        const markdown = '<table class="confluenceTable">\n  <tbody>\n    <tr><th>指标</th><th>说明</th></tr>\n    <tr><td><strong>基本介绍</strong></td><td>来源各自官网。</td></tr>\n  </tbody>\n</table>\n';
        const { host, root } = await mount(`${ANCHOR}${markdown}`);
        const block = nodesOfType(root, HTML_SOURCE_NODE)[0];
        const source = block.querySelector<HTMLPreElement>("pre");
        const preview = previews(block)[0];

        expect(source?.hidden).toBe(true);
        expect(preview.closest("[hidden]")).toBeNull();
        expect(preview.querySelectorAll("table")).toHaveLength(1);
        expect(preview.querySelectorAll("tr")).toHaveLength(2);
        expect(preview.querySelector("strong")?.textContent).toBe("基本介绍");

        expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
        host.flush();
        expect(host.getMarkdown()).toBe(`X${ANCHOR}${markdown}`);

        const offset = host.getMarkdown().indexOf("来源各自官网。");
        expect(host.replaceSourceRange({ anchor: offset, head: offset }, "说明：")).toBe(true);
        host.flush();
        expect(preview.textContent).toContain("说明：来源各自官网。");
        expect(source?.hidden).toBe(true);
        expect(host.getMarkdown()).toBe(`X${ANCHOR}${markdown.replace("来源各自官网。", "说明：来源各自官网。")}`);
    });

    it("renders a sanitized preview beside the source", async () => {
        const { root } = await mount(
            `${ANCHOR}<div class="note">\n  <p>Hello.</p>\n</div>\n`,
        );
        const preview = previews(root);
        expect(preview).toHaveLength(1);
        expect(preview[0].getAttribute(PREVIEW_ATTR)).toBe(HTML_SOURCE_NODE);
        expect(preview[0].getAttribute("contenteditable")).toBe("false");
        expect(preview[0].querySelector("div.note p")?.textContent).toBe("Hello.");
    });

    it("keeps the preview out of the serialized Markdown", async () => {
        const markdown = '<div class="note">\n  <p>Hello.</p>\n</div>\n';
        const serialized = await serializeAfterAnchorEdit(markdown);
        expect(serialized).toBe(`X${ANCHOR}${markdown}`);
        expect(occurrences(serialized, "Hello.")).toBe(1);
    });

    it("keeps the preview out of the node's text content", async () => {
        const { root } = await mount(
            `${ANCHOR}<div class="note">\n  <p>Hello.</p>\n</div>\n`,
        );
        const block = nodesOfType(root, HTML_SOURCE_NODE)[0];
        const source = block.querySelector("code");
        expect(source?.textContent).toBe(
            '<div class="note">\n  <p>Hello.</p>\n</div>',
        );
        expect(previews(block)[0].contains(source)).toBe(false);
    });
});

describe("editing raw source re-runs classification", () => {
    it("emits the user's new bytes for a block", async () => {
        const markdown = "<div>safe</div>\n";
        const { host } = await mount(`${ANCHOR}${markdown}`);
        const offset = `${ANCHOR}<div>`.length;
        expect(
            host.replaceSourceRange({ anchor: offset, head: offset }, "MORE "),
        ).toBe(true);
        host.flush();
        expect(host.getMarkdown()).toBe(`${ANCHOR}<div>MORE safe</div>\n`);
    });

    it("keeps a newly typed script inert", async () => {
        const markdown = "<div>safe</div>\n";
        const { host, root } = await mount(`${ANCHOR}${markdown}`);
        clearPwned();
        const offset = `${ANCHOR}<div>`.length;
        expect(
            host.replaceSourceRange(
                { anchor: offset, head: offset },
                "<script>window.__pwned = true;</script>",
            ),
        ).toBe(true);
        host.flush();
        await settle();

        expect(host.getMarkdown()).toBe(
            `${ANCHOR}<div><script>window.__pwned = true;</script>safe</div>\n`,
        );
        expect(pwned()).toBeUndefined();
        expect(root.querySelectorAll("script")).toHaveLength(0);
        const preview = previews(root)[0];
        expect(preview.querySelectorAll("script")).toHaveLength(0);
        expect(preview.textContent).not.toContain("__pwned");
    });

    it("emits new bytes when inline html source is edited", async () => {
        const { host, root } = await mount(`${ANCHOR}Press <kbd>Cmd</kbd>.\n`);
        const input = root.querySelector<HTMLInputElement>(
            `[${NODE_TYPE_ATTR}="${HTML_SOURCE_INLINE_NODE}"] input`,
        );
        expect(input?.value).toBe("<kbd>");
        input!.value = '<b onclick="window.__pwned = true">';
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        host.flush();
        await settle();

        expect(host.getMarkdown()).toBe(
            `${ANCHOR}Press <b onclick="window.__pwned = true">Cmd</kbd>.\n`,
        );
        expect(pwned()).toBeUndefined();
        expect(eventHandlerAttributes(root)).toEqual([]);
    });
});

describe("preview failure is local", () => {
    const deep = `${"<div>".repeat(150)}x${"</div>".repeat(150)}`;

    it("reports the failure without throwing or blanking the document", async () => {
        const { host, root } = await mount(`${ANCHOR}${deep}\n`);
        const preview = previews(root)[0];
        expect(preview.hasAttribute(PREVIEW_ERROR_ATTR)).toBe(true);
        expect(preview.textContent).toContain("Preview unavailable");
        expect(host.hasFailed()).toBe(false);
        expect(root.textContent).toContain("Anchor.");
    });

    it("leaves the source editable and byte-exact", async () => {
        const { host, root } = await mount(`${ANCHOR}${deep}\n`);
        const block = nodesOfType(root, HTML_SOURCE_NODE)[0];
        expect(block.querySelector("code")?.textContent).toBe(deep);
        expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
        host.flush();
        expect(host.getMarkdown()).toBe(`X${ANCHOR}${deep}\n`);
    });
});

describe("clipboard html cannot rehydrate structured syntax", () => {
    it("strips forged product metadata from pasted html", () => {
        for (const payload of forgedClipboardPayloads) {
            const sanitized = sanitizePastedHtml(payload, document);
            expect(sanitized, payload).not.toContain("data-mdx-");
            expect(sanitized.toLowerCase(), payload).not.toContain("onclick");
            expect(sanitized, payload).toContain("x");
        }
    });

    it("keeps this session's own metadata", () => {
        const payload = `<div ${NODE_TYPE_ATTR}="${HTML_SOURCE_NODE}" ${SOURCE_TOKEN_ATTR}="${SESSION_TOKEN}"><pre><code data-mdx-source="">hi</code></pre></div>`;
        const sanitized = sanitizePastedHtml(payload, document);
        expect(sanitized).toContain(`${NODE_TYPE_ATTR}="${HTML_SOURCE_NODE}"`);
        expect(sanitized).toContain(SESSION_TOKEN);
    });

    it("strips script, handlers and javascript urls from pasted html", () => {
        const sanitized = sanitizePastedHtml(
            '<div><script>window.__pwned = true;</script><img src="x" onerror="window.__pwned = true"><a href="javascript:window.__pwned=true">go</a></div>',
            document,
        );
        expect(sanitized).not.toContain("script");
        expect(sanitized).not.toContain("onerror");
        expect(sanitized.toLowerCase()).not.toContain("javascript:");
    });

    for (const payload of forgedClipboardPayloads) {
        it(`does not build a node from ${payload}`, async () => {
            clearPwned();
            const { host, root } = await mount("Anchor.\n");
            dispatchPaste(root, payload, "x");
            host.flush();
            await settle();

            expect(pwned()).toBeUndefined();
            expect(nodesOfType(root, SOURCE_FALLBACK_NODE)).toHaveLength(0);
            expect(nodesOfType(root, SOURCE_FALLBACK_INLINE_NODE)).toHaveLength(0);
            expect(nodesOfType(root, HTML_SOURCE_NODE)).toHaveLength(0);
            expect(eventHandlerAttributes(root)).toEqual([]);
            expect(host.getMarkdown()).not.toContain("data-mdx");
        });
    }

    it("rehydrates a node only when the metadata carries this session's token", async () => {
        // The two payloads differ only in the token. What that difference
        // actually decides on this path is whether the *sanitizer* keeps the
        // `data-mdx-` attributes: without them the schema's `tag` selector
        // never matches, so the node cannot be built whatever the rule would
        // have said. The rule's own check is pinned separately below.
        const stamp = `${SOURCE_TOKEN_ATTR}="${SESSION_TOKEN}"`;
        const body = (token: string) =>
            `<pre ${token}><code data-mdx-source="" ${token}>&lt;b&gt;hi&lt;/b&gt;</code></pre>`;
        const forged = `<div ${NODE_TYPE_ATTR}="${HTML_SOURCE_NODE}">${body("")}</div>`;
        const genuine = `<div ${NODE_TYPE_ATTR}="${HTML_SOURCE_NODE}" ${stamp}>${body(stamp)}</div>`;

        expect(sanitizePastedHtml(forged, document)).not.toContain(
            NODE_TYPE_ATTR,
        );
        expect(sanitizePastedHtml(genuine, document)).toContain(NODE_TYPE_ATTR);

        const forgedMount = await mount("Anchor.\n");
        dispatchPaste(forgedMount.root, forged, "hi");
        forgedMount.host.flush();
        expect(nodesOfType(forgedMount.root, HTML_SOURCE_NODE)).toHaveLength(0);

        const genuineMount = await mount("Anchor.\n");
        dispatchPaste(genuineMount.root, genuine, "hi");
        genuineMount.host.flush();
        expect(nodesOfType(genuineMount.root, HTML_SOURCE_NODE)).toHaveLength(1);
    });

    // The schema rules are the second gate, and the only one left if markup
    // ever reaches ProseMirror without passing the sanitizer first. Parsing the
    // DOM directly is the only way to ask them on their own.
    it("builds no node from metadata that reaches the schema unstamped", async () => {
        const schema = await mountedSchema();
        const parse = (token: string) =>
            parseSliceOfHtml(
                schema,
                `<div ${NODE_TYPE_ATTR}="${HTML_SOURCE_NODE}" ${token}><pre><code data-mdx-source="">hi</code></pre></div>`,
            );

        expect(countNodes(parse(""), HTML_SOURCE_NODE)).toBe(0);
        expect(
            countNodes(
                parse(`${SOURCE_TOKEN_ATTR}="not-this-session"`),
                HTML_SOURCE_NODE,
            ),
        ).toBe(0);
        expect(
            countNodes(
                parse(`${SOURCE_TOKEN_ATTR}="${SESSION_TOKEN}"`),
                HTML_SOURCE_NODE,
            ),
        ).toBe(1);
    });

    it("builds no inline node from metadata that reaches the schema unstamped", async () => {
        const schema = await mountedSchema();
        const parse = (token: string) =>
            parseSliceOfHtml(
                schema,
                `<p><span ${NODE_TYPE_ATTR}="${HTML_SOURCE_INLINE_NODE}" data-mdx-source-value="&lt;b&gt;" ${token}>x</span></p>`,
            );

        expect(countNodes(parse(""), HTML_SOURCE_INLINE_NODE)).toBe(0);
        expect(
            countNodes(
                parse(`${SOURCE_TOKEN_ATTR}="${SESSION_TOKEN}"`),
                HTML_SOURCE_INLINE_NODE,
            ),
        ).toBe(1);
    });
});

describe("escaping elsewhere in the document is untouched", () => {
    it("still escapes a literal bracket in ordinary text", async () => {
        // `[a](b)` as literal text must not come back as a link, which is what
        // switching off escaping for the whole document would cause. The raw
        // handlers this layer registers name four node types of their own and
        // leave the `text` handler exactly as it was.
        const serialized = await serializeAfterAnchorEdit(
            "Literal \\[a](b) text.\n",
        );
        expect(serialized).toContain("\\[a]");
        expect(serialized).not.toContain(" [a](b)");
        expect(await serializeAfterAnchorEdit("Literal \\[a]\\(b) text.\n")).toBe(
            `X${ANCHOR}Literal \\[a]\\(b) text.\n`,
        );
    });

    it("still escapes a leading bracket in ordinary text", async () => {
        expect(await serializeAfterAnchorEdit("\\[x] stays escaped.\n")).toBe(
            `X${ANCHOR}\\[x] stays escaped.\n`,
        );
    });

    it("leaves a real link alone", async () => {
        await expectRoundTrip("A [real link](https://example.test) here.\n");
    });

    it("leaves emphasis and code alone", async () => {
        await expectRoundTrip("Some *em*, **strong** and `code` here.\n");
    });
});
