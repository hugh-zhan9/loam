// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownEditorSurface } from "./markdown-editor-surface";
import { createEditorSessionBinding } from "../lib/editor-session-binding";

/**
 * The join between the stylesheet and the DOM the editor actually renders.
 *
 * This file exists because that join broke silently and completely. The
 * stylesheet addressed the previous editor's DOM contract — a
 * `[data-mdx-editor-root]` element containing `[data-mdx-node-type="heading"]`
 * nodes — and when that editor was replaced by one emitting ordinary `<h1>`
 * inside `[data-mdx-markdown-editor]`, every typography rule stopped matching
 * anything. Headings, paragraphs, lists and quotes rendered as undifferentiated
 * text, and the whole suite stayed green throughout, because nothing anywhere
 * compared the selectors being written against the elements being produced.
 *
 * So that is what these assert, in both directions: the rule is in the
 * stylesheet, and the element it addresses is in the document. Deleting either
 * side fails here.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const STYLESHEET = readFileSync("app/globals.css", "utf8");

/** The editor package's public styling root, per the boundary audit. */
const ROOT = "[data-mdx-markdown-editor]";

const FIXTURE = `# 一级标题

## 二级标题

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

普通段落，包含 **加粗**、*斜体* 与 \`行内代码\`。

\`Message\` 是那 4 种标准的；\`CustomAgentMessages[keyof CustomAgentMessages]\` 是应用注册了什么就是什么。**注册是可加的**：上面那段 \`declare module\` 只是往 \`CustomAgentMessages\` 这个接口里加字段。

混合样式：**加粗中的 \`code\`** 与 *斜体中的 \`code\`*。

- 项一
- 项二

1. 第一
2. 第二

> 引用文字

| A | B |
|---|---|
| 1 | 2 |

\`\`\`js
const a = 1;
\`\`\`

---

[百度](https://baidu.com) 与 [[目标页面|别名]]

> [!NOTE]
> 提示体
`;

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

function Host() {
    const [binding] = useState(createEditorSessionBinding);
    const [markdown, setMarkdown] = useState(FIXTURE);
    return (
        <MarkdownEditorSurface
            session={binding}
            documentId="doc"
            markdown={markdown}
            onMarkdownChange={(_, next) => setMarkdown(next)}
        />
    );
}

async function mountFixture(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
        root.render(<Host />);
    });
    return container;
}

/**
 * Element selectors the stylesheet styles under the editor root, each paired
 * with what it is responsible for looking like. If the editor stops emitting
 * one of these, the rule addressing it becomes dead and the construct silently
 * loses its formatting — which is the failure this file is here to catch.
 */
const STYLED_ELEMENTS: Array<{ selector: string; renders: string }> = [
    { selector: "h1", renders: "一级标题" },
    { selector: "h2", renders: "二级标题" },
    { selector: "h3", renders: "三级标题" },
    { selector: "h4", renders: "四级标题" },
    { selector: "h5", renders: "五级标题" },
    { selector: "h6", renders: "六级标题" },
    { selector: "p", renders: "段落" },
    { selector: ":not(pre) > code", renders: "行内代码" },
    { selector: "ul", renders: "无序列表" },
    { selector: "ol", renders: "有序列表" },
    { selector: "li", renders: "列表项" },
    { selector: "blockquote", renders: "引用" },
    { selector: "a[href]", renders: "链接" },
    { selector: "a.mdx-wikilink", renders: "wikilink" },
    { selector: "table", renders: "表格" },
    { selector: "th", renders: "表头单元格" },
    { selector: "td", renders: "表格单元格" },
    { selector: "hr", renders: "分隔线" },
    { selector: ".mdx-callout", renders: "callout" },
];

describe("editor style contract", () => {
    it("targets inline code, including nested marks, without styling fenced code as inline", async () => {
        const container = await mountFixture();
        const inlineCode = Array.from(
            container.querySelectorAll(`${ROOT} :not(pre) > code`),
            (element) => element.textContent,
        );
        expect(inlineCode).toEqual([
            "行内代码",
            "Message",
            "CustomAgentMessages[keyof CustomAgentMessages]",
            "declare module",
            "CustomAgentMessages",
            "code",
            "code",
        ]);
        expect(container.querySelector(`${ROOT} pre > code`)?.textContent)
            .toContain("const a = 1;");
    });

    it("renders every element the stylesheet styles", async () => {
        const container = await mountFixture();
        const root = container.querySelector(ROOT);
        expect(root).not.toBeNull();

        const missing = STYLED_ELEMENTS.filter(
            ({ selector }) => root?.querySelector(selector) === null,
        ).map(({ selector, renders }) => `${selector} (${renders})`);

        expect(missing).toEqual([]);
    });

    it("styles every element it renders, under the public root", () => {
        // The other direction: a rule that no longer names the root the editor
        // actually mounts is a rule that styles nothing.
        const unstyled = STYLED_ELEMENTS.filter(
            ({ selector }) =>
                !STYLESHEET.includes(`${ROOT} ${selector}`) &&
                // Heading sizes are per level; the shared rule groups them.
                !(
                    /^h[1-6]$/.test(selector) &&
                    STYLESHEET.includes(`${ROOT} :is(h1,h2,h3,h4,h5,h6)`)
                ),
        ).map(({ selector }) => selector);

        expect(unstyled).toEqual([]);
    });

    it("keeps the editor its own scroll container", () => {
        // A contenteditable grows with its content; without this the bottom of
        // a long document is unreachable, which is exactly what happened when
        // the self-drawn surface that scrolled itself was replaced.
        const rootRule = STYLESHEET.slice(
            STYLESHEET.indexOf(`${ROOT} {`),
            STYLESHEET.indexOf("}", STYLESHEET.indexOf(`${ROOT} {`)),
        );
        expect(rootRule).toContain("overflow-y: auto");
    });

    it("addresses no element the previous editor's contract defined", () => {
        // The stale selectors this file was written for. They matched nothing
        // and cost the product every block-level style it had.
        expect(STYLESHEET).not.toContain("data-mdx-editor-root");
        expect(STYLESHEET).not.toContain("data-mdx-node-type=");
        expect(STYLESHEET).not.toContain("data-mdx-heading-level");
    });
});
