// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createMilkdownEditorHost,
    type MilkdownEditorHost,
} from "../milkdown/editor-host";
import { createMdxMilkdownPlugins } from "../syntax/milkdown";

const mounted: MilkdownEditorHost[] = [];
afterEach(async () => {
    while (mounted.length) await mounted.pop()?.destroy();
    document.body.innerHTML = "";
});

async function mount(markdown: string) {
    const root = document.createElement("div");
    document.body.append(root);
    const host = await createMilkdownEditorHost({
        root,
        markdown,
        editable: true,
        plugins: createMdxMilkdownPlugins(),
        onMarkdownChange: () => {},
        onSelectionChange: () => {},
    });
    mounted.push(host);
    const surface = root.querySelector<HTMLElement>(".ProseMirror")!;
    host.setSelection({ anchor: 4, head: 4 });
    return { host, surface };
}

function enter(surface: HTMLElement, flags: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
        ...flags,
    });
    surface.dispatchEvent(event);
    return event;
}

describe("IME confirmation Enter", () => {
    for (const [name, flags] of [
        ["composition flag", { isComposing: true }],
        ["WebKit legacy IME key code after compositionend", { keyCode: 229 }],
    ] as const) {
        it(`does not split the paragraph for ${name}`, async () => {
            const { host, surface } = await mount("随波逐流后文\n");
            // The DOM's IME marker must remain authoritative even when the
            // view's own composition state is no longer active.
            surface.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            surface.dispatchEvent(new CompositionEvent("compositionend", {
                bubbles: true, data: "随波逐流",
            }));
            // Slow serialization/rendering can delay delivery past ProseMirror's
            // 500 ms Safari grace period. The event still belongs to the IME.
            const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
            let event: KeyboardEvent;
            try {
                event = enter(surface, flags);
                expect(host.getMarkdown()).toBe("随波逐流后文\n");
                expect(surface.querySelectorAll("p")).toHaveLength(1);
                // Leave the browser's IME default action free to commit the text.
                expect(event.defaultPrevented).toBe(false);

                enter(surface);
                expect(host.getMarkdown()).toBe("随波逐流\n\n后文\n");
            } finally {
                clock.mockRestore();
            }
        });
    }

    it("keeps ordinary Shift+Enter as an explicit hard break", async () => {
        const { host, surface } = await mount("随波逐流后文\n");
        enter(surface, { shiftKey: true });
        expect(host.getMarkdown()).toBe("随波逐流\\\n后文\n");
    });
});
