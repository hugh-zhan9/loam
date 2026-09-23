// @vitest-environment jsdom
import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it } from "vitest";

import {
    createMilkdownEditorHost,
    type MilkdownEditorHost,
} from "../../milkdown/editor-host";
import { createMdxMilkdownPlugins } from "./index";

const mounted: MilkdownEditorHost[] = [];
afterEach(async () => {
    while (mounted.length) await mounted.pop()?.destroy();
    document.body.innerHTML = "";
});

async function mount(markdown: string) {
    const root = document.createElement("div");
    document.body.append(root);
    let view!: EditorView;
    const capture = $prose(() => new Plugin({
        view(editorView) {
            view = editorView;
            return {};
        },
    }));
    const host = await createMilkdownEditorHost({
        root, markdown, editable: true,
        plugins: [...createMdxMilkdownPlugins(), capture],
        onMarkdownChange: () => {},
        onSelectionChange: () => {},
    });
    mounted.push(host);
    return { host, view };
}

function press(view: EditorView, key: string) {
    view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true,
    }));
}

const markdown = "前面的内容\n\n## 标题\n\n后文\n";

describe("deleting a selection next to a heading", () => {
    for (const key of ["Backspace", "Delete"]) {
        for (const backwards of [false, true]) {
            it(`${key} preserves a heading with no selected text (${backwards ? "backward" : "forward"} selection)`, async () => {
                const { host, view } = await mount(markdown);
                const end = markdown.indexOf("标题");
                host.setSelection(backwards ? { anchor: end, head: 2 } : { anchor: 2, head: end });
                press(view, key);
                expect(host.getMarkdown()).toBe("前面\n\n## 标题\n\n后文\n");
                expect(view.state.selection.empty).toBe(true);
                expect(host.undo()).toBe(true);
                expect(host.getMarkdown()).toBe(markdown);
                expect(host.redo()).toBe(true);
                expect(host.getMarkdown()).toBe("前面\n\n## 标题\n\n后文\n");
            });
        }
    }

    it("can delete all preceding text without demoting the heading", async () => {
        const { host, view } = await mount(markdown);
        host.setSelection({ anchor: 0, head: markdown.indexOf("标题") });
        press(view, "Backspace");
        expect(host.getMarkdown()).toBe("## 标题\n\n后文\n");
    });

    it("keeps ordinary deletion inside the neighbouring paragraph", async () => {
        const { host, view } = await mount(markdown);
        host.setSelection({ anchor: 2, head: 5 });
        press(view, "Backspace");
        expect(host.getMarkdown()).toBe("前面\n\n## 标题\n\n后文\n");
    });

    it("deletes intervening paragraphs and leaves the caret at the surviving prefix", async () => {
        const source = "前面的内容\n\n中间段落\n\n## 标题\n\n后文\n";
        const { host, view } = await mount(source);
        host.setSelection({ anchor: 2, head: source.indexOf("标题") });
        press(view, "Backspace");
        view.dispatch(view.state.tr.insertText("随波逐流"));
        expect(host.getMarkdown()).toBe("前面随波逐流\n\n## 标题\n\n后文\n");
    });

    it("does not consume heading text when only the boundary is selected", async () => {
        const { host, view } = await mount(markdown);
        host.setSelection({ anchor: 5, head: markdown.indexOf("标题") });
        press(view, "Delete");
        expect(host.getMarkdown()).toBe(markdown);
        expect(view.state.selection.empty).toBe(true);
    });

    it("still merges blocks when heading text is actually selected", async () => {
        const { host, view } = await mount(markdown);
        host.setSelection({ anchor: 2, head: markdown.indexOf("标题") + 1 });
        press(view, "Delete");
        expect(host.getMarkdown()).toBe("前面题\n\n后文\n");
    });

    it("still lets Backspace at the start of a heading downgrade it", async () => {
        const { host, view } = await mount("## 标题\n");
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
        press(view, "Backspace");
        expect(host.getMarkdown()).toBe("# 标题\n");
    });
});
