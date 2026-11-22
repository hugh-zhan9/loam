import { useEffect, useRef, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { FileDown } from "lucide-react";
import { tauriCore, tauriDialog } from "@/common/lib/tauri";

export type ImportEntry = { path: string; note: string | null; collision: boolean };
type Problem = { note: string; url: string };
type Outcome = { added: string[]; skipped: string[]; failed: string[] };
type SyntaxNode = { type: string; url?: string; identifier?: string; children?: SyntaxNode[] };

const attachmentExtension = /\.(?:png|jpe?g|gif|webp|avif|svg|heic|heif|bmp|tiff?|ico|pdf|docx?|pptx?|xlsx?|txt|rtf|csv|json|zip|mp3|m4a|wav|ogg|flac|mp4|mov|webm)$/i;

function attachmentReferences(markdown: string): { url: string; image: boolean }[] {
    const root: SyntaxNode = fromMarkdown(markdown);
    const definitions = new Map<string, string>();
    const references: { key: string; image: boolean }[] = [];
    const direct: { url: string; image: boolean }[] = [];
    const walk = (node: SyntaxNode) => {
        if ((node.type === "image" || node.type === "link") && node.url !== undefined) {
            direct.push({ url: node.url, image: node.type === "image" });
        }
        if ((node.type === "imageReference" || node.type === "linkReference") && node.identifier) {
            references.push({ key: node.identifier, image: node.type === "imageReference" });
        }
        if (node.type === "definition" && node.identifier && node.url !== undefined && !definitions.has(node.identifier)) {
            definitions.set(node.identifier, node.url);
        }
        node.children?.forEach(walk);
    };
    walk(root);
    return [...direct, ...references.flatMap(({ key, image }) => {
        const value = definitions.get(key);
        return value === undefined ? [] : [{ url: value, image }];
    })];
}

function relativeImage(note: string, url: string): string | null | undefined {
    if (!url || url.startsWith("/") || url.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(url)) return undefined;
    const result = note.split("/").slice(0, -1);
    let path: string;
    try { path = decodeURIComponent(url.split(/[?#]/, 1)[0]); }
    catch { return null; }
    if (path.startsWith("/")) return null;
    for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (!result.length) return null;
            result.pop();
        } else result.push(part);
    }
    return result.join("/") || null;
}

export function planMarkdownImport(entries: ImportEntry[]) {
    const index = new Map(entries.map((entry) => [entry.path, entry]));
    const selected = new Set<string>();
    const collisions = new Set<string>();
    const blocked: Problem[] = [];
    const requirements: [string, string[]][] = [];
    const missing: Problem[] = [];
    for (const entry of entries) {
        if (entry.note === null) continue;
        if (entry.collision) { collisions.add(entry.path); continue; }
        const reported = new Set<string>();
        const assets = new Set<string>();
        let blockedByAttachment = false;
        for (const { url, image } of attachmentReferences(entry.note)) {
            const relative = relativeImage(entry.path, url);
            if (relative === undefined) continue;
            if (!image && !attachmentExtension.test(relative ?? url.split(/[?#]/, 1)[0])) continue;
            if (reported.has(url)) continue;
            reported.add(url);
            const attachment = relative ? index.get(relative) : undefined;
            if (attachment?.note === null) {
                if (attachment.collision) {
                    collisions.add(attachment.path);
                    blocked.push({ note: entry.path, url });
                    blockedByAttachment = true;
                } else assets.add(attachment.path);
            } else missing.push({ note: entry.path, url });
        }
        if (!blockedByAttachment) {
            selected.add(entry.path);
            for (const asset of assets) selected.add(asset);
            if (assets.size) requirements.push([entry.path, [...assets]]);
        }
    }
    return {
        add: entries.filter((entry) => selected.has(entry.path)).map((entry) => entry.path),
        collisions: entries.filter((entry) => collisions.has(entry.path)).map((entry) => entry.path),
        dependencies: Object.fromEntries(requirements),
        blocked,
        missing,
    };
}

export function MarkdownImportControl({ rootPath, refresh }: { rootPath: string; refresh: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<null | { source: string; plan: ReturnType<typeof planMarkdownImport> }>(null);
    const [status, setStatus] = useState("");
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const locked = useRef(false);

    useEffect(() => {
        if (preview && dialog.current && !dialog.current.open) dialog.current.showModal();
    }, [preview]);

    async function choose() {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        setStatus("");
        try {
            const { open } = await tauriDialog();
            const source = await open({ directory: true, multiple: false, title: "选择要导入的 Markdown 文件夹" });
            if (typeof source !== "string") return;
            const { invoke } = await tauriCore();
            const entries = await invoke<ImportEntry[]>("preview_markdown_import", { source, rootPath });
            setPreview({ source, plan: planMarkdownImport(entries) });
        } catch (error) {
            setStatus(`无法预览导入：${String(error)}`);
        } finally {
            locked.current = false;
            setBusy(false);
        }
    }

    function cancel() {
        if (locked.current) return;
        setPreview(null);
        queueMicrotask(() => trigger.current?.focus());
    }

    async function apply() {
        if (!preview || locked.current || !preview.plan.add.length) return;
        locked.current = true;
        setBusy(true);
        try {
            const { invoke } = await tauriCore();
            const result = await invoke<Outcome>("apply_markdown_import", {
                source: preview.source, rootPath, paths: preview.plan.add, dependencies: preview.plan.dependencies,
            });
            setPreview(null);
            const affected = [...result.skipped, ...result.failed];
            const details = affected.length ? `：${affected.slice(0, 8).join("、")}${affected.length > 8 ? "等" : ""}` : "。";
            setStatus(`已添加 ${result.added.length} 个文件；${preview.plan.collisions.length} 个原有冲突未导入；导入时跳过 ${result.skipped.length} 个、失败 ${result.failed.length} 个${details}`);
            if (result.added.length) await refresh().catch(() => {});
        } catch (error) {
            setStatus(`无法导入：${String(error)}`);
        } finally {
            locked.current = false;
            setBusy(false);
        }
    }

    return <>
        <button ref={trigger} type="button" aria-label="导入 Markdown 文件夹" title="导入 Markdown 文件夹"
            className="btn btn-ghost btn-sm btn-square" disabled={busy} onClick={() => void choose()}>
            <FileDown aria-hidden="true" className="h-4 w-4" />
        </button>
        {status && !preview ? <div role="status" className="absolute right-2 top-full z-50 max-w-md rounded border bg-base-100 p-2 text-xs">
            {status} <button type="button" className="btn btn-ghost btn-xs" onClick={() => setStatus("")}>关闭</button>
        </div> : null}
        {preview ? <dialog ref={dialog} aria-labelledby="markdown-import-title"
            className="m-auto w-[min(42rem,90vw)] max-h-[85vh] overflow-auto rounded-lg border bg-base-100 p-5 text-base-content shadow-xl backdrop:bg-black/40"
            onCancel={(event) => { event.preventDefault(); cancel(); }}>
            <h2 id="markdown-import-title" className="text-lg font-semibold">预览 Markdown 导入</h2>
            <div className="mt-2 break-all text-sm">从 {preview.source} 导入到 {rootPath}</div>
            <p className="my-2 text-sm">保留目录结构和 Markdown 原文。不会覆盖现有文件；缺少的附件不会创建。</p>
            <ImportList title="将添加" items={preview.plan.add} />
            <ImportList title="冲突（跳过）" items={preview.plan.collisions} />
            <ImportList title="因附件冲突跳过的笔记" items={preview.plan.blocked.map(({ note, url }) => `${note} → ${url}`)} />
            <ImportList title="缺少的本地附件" items={preview.plan.missing.map(({ note, url }) => `${note} → ${url}`)} />
            {status ? <p role="status" className="my-2 text-sm">{status}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={cancel}>取消</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !preview.plan.add.length}
                    onClick={() => void apply()}>{busy ? "正在导入…" : `导入 ${preview.plan.add.length} 个文件`}</button>
            </div>
        </dialog> : null}
    </>;
}

function ImportList({ title, items }: { title: string; items: string[] }) {
    return <details open={items.length > 0} className="my-2 rounded border p-2 text-sm">
        <summary>{title}（{items.length}）</summary>
        <ul className="mt-2 max-h-32 overflow-auto font-mono text-xs">
            {items.map((item, i) => <li className="break-all" key={i}>{item}</li>)}
        </ul>
    </details>;
}
