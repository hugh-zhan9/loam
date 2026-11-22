// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownImportControl } from "../components/markdown-import-control";

const mock = vi.hoisted(() => ({
    open: vi.fn(async () => "/source"),
    invoke: vi.fn(async () => [{ path: "entry.md", note: "# Entry", collision: false }]),
}));

vi.mock("@/common/lib/tauri", () => ({
    tauriCore: async () => ({ invoke: mock.invoke }),
    tauriDialog: async () => ({ open: mock.open }),
}));

it("canceling the import preview never invokes a write or refresh", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const method = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    if (!method) {
        Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
            configurable: true, value(this: HTMLDialogElement) { this.open = true; },
        });
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const refresh = vi.fn(async () => {});
    try {
        await act(async () => root.render(<MarkdownImportControl rootPath="/workspace" refresh={refresh} />));
        const open = host.querySelector<HTMLButtonElement>('button[aria-label="导入 Markdown 文件夹"]')!;
        await act(async () => open.click());
        expect(host.querySelector("dialog")?.open).toBe(true);
        expect(host.textContent).toContain("entry.md");
        const cancel = [...host.querySelectorAll("dialog button")].find((button) => button.textContent === "取消") as HTMLButtonElement;
        await act(async () => cancel.click());
        expect(host.querySelector("dialog")).toBeNull();
        expect(mock.invoke.mock.calls).toEqual([
            ["preview_markdown_import", { source: "/source", rootPath: "/workspace" }],
        ]);
        expect(refresh).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        if (!method) Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
        vi.unstubAllGlobals();
    }
});
