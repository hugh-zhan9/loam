// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownImportControl } from "../components/markdown-import-control";

const mock = vi.hoisted(() => ({
    open: vi.fn(async () => "/source"),
    invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@/common/lib/tauri", () => ({
    tauriCore: async () => ({ invoke: mock.invoke }),
    tauriDialog: async () => ({ open: mock.open }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let trigger: HTMLButtonElement;
const refresh = vi.fn(async () => {});

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mock.open.mockReset().mockResolvedValue("/source");
    mock.invoke.mockReset().mockResolvedValue([{ path: "entry.md", note: "# Entry", collision: false }]);
    refresh.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<MarkdownImportControl rootPath="/workspace" refresh={refresh} />));
    trigger = host.querySelector<HTMLButtonElement>('button[aria-label="导入 Markdown 文件夹"]')!;
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

function dialog() {
    return host.querySelector<HTMLElement>('[role="dialog"]');
}

function button(scope: ParentNode, label: string) {
    return [...scope.querySelectorAll("button")].find((button) => button.textContent === label)!;
}

it("canceling the import preview restores focus without a write or refresh", async () => {
    trigger.focus();
    await act(async () => trigger.click());
    const preview = dialog()!;
    expect(preview.querySelector("h2")?.textContent).toBe("预览 Markdown 导入");
    expect(preview.textContent).toContain("entry.md");
    expect(document.activeElement).toBe(button(preview, "关闭"));

    await act(async () => button(preview, "取消").click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mock.invoke.mock.calls).toEqual([
        ["preview_markdown_import", { source: "/source", rootPath: "/workspace" }],
    ]);
    expect(refresh).not.toHaveBeenCalled();
});

it("shows notes and attachments, switches problem tabs, and filters paths", async () => {
    mock.invoke.mockResolvedValueOnce([
        { path: "notes/travel.MARKDOWN", note: "![Photo](../assets/lake.png) ![Missing](missing.png)", collision: false },
        { path: "assets/lake.png", note: null, collision: false },
        { path: "draft.md", note: "![Dupe](assets/dupe.jpg)", collision: false },
        { path: "assets/dupe.jpg", note: null, collision: true },
        { path: "existing.md", note: "", collision: true },
        ...Array.from({ length: 7 }, (_, index) => ({ path: `entry-${index}.md`, note: "# Entry", collision: false })),
    ]);
    await act(async () => trigger.click());
    const preview = dialog()!;
    const tabs = preview.querySelector('[role="tablist"]')!;
    const list = preview.querySelector('[role="tabpanel"]')!;
    expect(preview.querySelector('dd[title="/source"]')?.textContent).toBe("/source");
    expect(preview.querySelector('dd[title="/workspace"]')?.textContent).toBe("/workspace");
    expect([...tabs.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["将导入9", "路径冲突2", "受阻笔记1", "缺失附件1"]);
    expect(button(tabs, "将导入9").getAttribute("aria-selected")).toBe("true");
    expect(list.querySelectorAll("li")).toHaveLength(9);
    expect(list.textContent).toContain("notes/travel.MARKDOWN");
    expect(list.textContent).toContain("assets/lake.png");
    expect(list.querySelector("li:first-child .lucide-file-text")).not.toBeNull();
    expect(list.querySelector("li:nth-child(2) .lucide-paperclip")).not.toBeNull();
    expect(preview.textContent).toContain("有 1 处本地附件缺失，相关笔记仍会按原文导入");

    const filter = preview.querySelector<HTMLInputElement>('input[aria-label="筛选导入列表"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
        setValue.call(filter, "ASSETS/LAKE");
        filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["assets/lake.png"]);
    await act(async () => {
        setValue.call(filter, "unmatched");
        filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(list.textContent).toBe("没有匹配的路径");

    await act(async () => button(tabs, "路径冲突2").click());
    expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["assets/dupe.jpg", "existing.md"]);
    expect(preview.querySelector('input[type="search"]')).toBeNull();
    await act(async () => button(tabs, "受阻笔记1").click());
    expect(list.textContent).toContain("draft.md");
    expect(list.textContent).toContain("引用附件冲突：assets/dupe.jpg");
    await act(async () => button(tabs, "缺失附件1").click());
    expect(list.textContent).toContain("notes/travel.MARKDOWN");
    expect(list.textContent).toContain("本地附件缺失：missing.png");
});

it("shows an empty state without categories when there are no Markdown notes", async () => {
    mock.invoke.mockResolvedValueOnce([{ path: "assets/lake.png", note: null, collision: false }]);
    await act(async () => trigger.click());
    const preview = dialog()!;
    expect(preview.textContent).toContain("未找到可导入的 Markdown 笔记");
    expect(preview.textContent).toContain("所选文件夹中没有 .md 或 .markdown 文件。");
    expect(preview.querySelector('[role="tablist"]')).toBeNull();
    expect(button(preview, "导入 0 个文件").disabled).toBe(true);
});

it("defaults to the conflict tab when no files can be imported", async () => {
    mock.invoke.mockResolvedValueOnce([{ path: "existing.md", note: "", collision: true }]);
    await act(async () => trigger.click());
    const preview = dialog()!;
    expect(button(preview, "路径冲突1").getAttribute("aria-selected")).toBe("true");
    expect(preview.querySelector('[role="tabpanel"]')?.textContent).toContain("existing.md");
    expect(preview.textContent).toContain("没有可导入的文件");
    expect(preview.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(button(preview, "导入 0 个文件").disabled).toBe(true);
});

it("refreshes the workspace and shows a success toast when all selected files are imported", async () => {
    mock.invoke
        .mockResolvedValueOnce([
            { path: "entry.md", note: "![Lake](assets/lake.png)", collision: false },
            { path: "assets/lake.png", note: null, collision: false },
        ])
        .mockResolvedValueOnce({ added: ["assets/lake.png", "entry.md"], skipped: [], failed: [] });
    await act(async () => trigger.click());
    const preview = dialog()!;
    expect(preview.textContent).toContain("将导入 1 篇笔记（含 1 个附件）");
    expect(preview.textContent).toContain("无冲突");
    expect(preview.querySelector('[role="tablist"]')).toBeNull();
    await act(async () => button(preview, "导入 2 个文件").click());

    expect(mock.invoke).toHaveBeenNthCalledWith(2, "apply_markdown_import", {
        source: "/source", rootPath: "/workspace", paths: ["entry.md", "assets/lake.png"],
        dependencies: { "entry.md": ["assets/lake.png"] },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("已导入 1 篇笔记、1 个附件");
});

it("blocks dismissal while importing and keeps skipped and failed paths in the result dialog", async () => {
    const result = { added: ["entry.md"], skipped: ["notes/skipped.md"], failed: ["notes/failed.md"] };
    const pending = Promise.withResolvers<typeof result>();
    mock.invoke
        .mockResolvedValueOnce([...result.added, ...result.skipped, ...result.failed, "existing.md"].map((path) => ({
            path, note: "# Entry", collision: path === "existing.md",
        })))
        .mockReturnValueOnce(pending.promise);
    await act(async () => trigger.click());
    const preview = dialog()!;
    await act(async () => button(preview, "导入 3 个文件").click());
    expect(button(preview, "正在导入…").disabled).toBe(true);
    expect(button(preview, "关闭").disabled).toBe(true);
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        preview.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog()).toBe(preview);

    await act(async () => pending.resolve(result));
    const outcome = dialog()!;
    expect(outcome).toBe(preview);
    expect(outcome.querySelector("h2")?.textContent).toBe("导入已完成（部分未导入）");
    expect(outcome.textContent).toContain("已添加 1");
    expect(outcome.textContent).toContain("导入时跳过 1");
    expect(outcome.textContent).toContain("失败 1");
    expect(outcome.textContent).toContain("原有冲突跳过 1");
    expect([...outcome.querySelectorAll("section")].map((section) => [
        section.querySelector("h3")?.textContent, section.querySelector("li")?.textContent,
    ])).toEqual([["失败", "notes/failed.md"], ["导入时跳过", "notes/skipped.md"]]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => button(outcome, "完成").click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
});

it("shows scanning feedback and a dismissible localized preview error", async () => {
    const pending = Promise.withResolvers<never>();
    mock.open.mockResolvedValueOnce("/workspace/inside");
    mock.invoke.mockReturnValueOnce(pending.promise);
    await act(async () => trigger.click());
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("正在扫描要导入的文件夹…");
    expect(trigger.querySelector("svg.animate-spin")).not.toBeNull();

    await act(async () => pending.reject("Error: preview failed: Choose a source outside the current workspace"));
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.querySelector("p")?.textContent).toBe("请选择当前工作区之外的文件夹。");
    expect(trigger.disabled).toBe(false);
    expect(dialog()).toBeNull();
    expect(button(alert, "重新选择")).toBeDefined();
    await act(async () => button(alert, "关闭").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
});
