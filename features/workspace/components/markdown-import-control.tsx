import { useEffect, useRef, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { FileDown, FileText, FolderOpen, Loader2, Paperclip, X } from "lucide-react";
import {
    Chip, DialogHeader, DialogOverlay, DialogSurface, FactRows, IconButton, PanelText,
    PrimaryTextControlButton, SearchField, TextControlButton, Toast,
} from "@/common/components/ui-controls";
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

type Preview = { view: "preview"; source: string; plan: ReturnType<typeof planMarkdownImport> };
type ImportDialog = Preview | { view: "outcome"; result: Outcome; collisions: number };

const categories = [
    { key: "add", label: "将导入" },
    { key: "collisions", label: "路径冲突" },
    { key: "blocked", label: "受阻笔记" },
    { key: "missing", label: "缺失附件" },
] as const;
type Category = typeof categories[number]["key"];

function formatImportError(error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).trim().replace(/^(?:Error:\s*)+/i, "");
    if (message.includes("Choose a source outside the current workspace")) return "请选择当前工作区之外的文件夹。";
    if (message.includes("Source and workspace are identical")) return "不能导入当前正在打开的工作区本身。";
    if (message.includes("Source contains too many files")) return "所选文件夹中的文件数量超过上限（最多 20,000 个）。";
    if (message.includes("Source Markdown exceeds preview limit")) return "所选文件夹中的 Markdown 正文总大小超过预览上限（24 MB）。";
    if (message.includes("Workspace changed; open a new import preview")) return "工作区已切换，请重新选择文件夹进行预览。";
    return message;
}

function isMarkdown(path: string) {
    return /\.(?:md|markdown)$/i.test(path);
}

export function MarkdownImportControl({ rootPath, refresh }: { rootPath: string; refresh: () => Promise<void> }) {
    const [phase, setPhase] = useState<"idle" | "scanning" | "applying">("idle");
    const [dialog, setDialog] = useState<ImportDialog | null>(null);
    const [category, setCategory] = useState<Category>("add");
    const [query, setQuery] = useState("");
    const [previewError, setPreviewError] = useState("");
    const [dialogError, setDialogError] = useState("");
    const [success, setSuccess] = useState("");
    const triggerHostRef = useRef<HTMLSpanElement>(null);
    const mountedRef = useRef(false);
    const locked = useRef(false);
    const busy = phase !== "idle";
    const dialogOpen = dialog !== null;

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
        if (!dialogOpen) return;
        const trigger = triggerHostRef.current?.querySelector("button");
        return () => { trigger?.focus(); };
    }, [dialogOpen]);

    async function choose() {
        if (locked.current) return;
        locked.current = true;
        setPhase("scanning");
        setPreviewError("");
        setDialogError("");
        setSuccess("");
        try {
            const { open } = await tauriDialog();
            if (!mountedRef.current) return;
            const source = await open({ directory: true, multiple: false, title: "选择要导入的 Markdown 文件夹" });
            if (typeof source !== "string" || !mountedRef.current) return;
            const { invoke } = await tauriCore();
            const entries = await invoke<ImportEntry[]>("preview_markdown_import", { source, rootPath });
            if (!mountedRef.current) return;
            const plan = planMarkdownImport(entries);
            setCategory(categories.find(({ key }) => plan[key].length)?.key ?? "add");
            setQuery("");
            setDialog({ view: "preview", source, plan });
        } catch (error) {
            if (mountedRef.current) {
                if (dialog) setDialogError(formatImportError(error));
                else setPreviewError(formatImportError(error));
            }
        } finally {
            locked.current = false;
            if (mountedRef.current) setPhase("idle");
        }
    }

    function closeDialog() {
        if (locked.current) return;
        setDialog(null);
    }

    async function apply(preview: Preview) {
        if (locked.current) return;
        locked.current = true;
        setPhase("applying");
        setDialogError("");
        try {
            const { invoke } = await tauriCore();
            if (!mountedRef.current) return;
            const result = await invoke<Outcome>("apply_markdown_import", {
                source: preview.source, rootPath, paths: preview.plan.add, dependencies: preview.plan.dependencies,
            });
            if (!mountedRef.current) return;
            if (result.added.length) {
                await refresh().catch((error: unknown) => console.error("Markdown import completed, but workspace refresh failed", error));
            }
            if (!mountedRef.current) return;
            const collisions = preview.plan.collisions.length;
            if (result.skipped.length || result.failed.length) {
                setDialog({ view: "outcome", result, collisions });
            } else {
                const notes = result.added.filter(isMarkdown).length;
                const assets = result.added.length - notes;
                setDialog(null);
                setSuccess(`已导入 ${notes} 篇笔记${assets ? `、${assets} 个附件` : ""}${collisions ? `，已跳过 ${collisions} 个原有冲突` : ""}`);
            }
        } catch (error) {
            if (mountedRef.current) setDialogError(formatImportError(error));
        } finally {
            locked.current = false;
            if (mountedRef.current) setPhase("idle");
        }
    }

    const preview = dialog?.view === "preview" ? dialog : null;
    const plan = preview?.plan;
    const noteCount = plan?.add.filter(isMarkdown).length ?? 0;
    const assetCount = (plan?.add.length ?? 0) - noteCount;
    const empty = plan && !plan.add.length && !plan.collisions.length && !plan.blocked.length;
    const hasAnomalies = plan && (plan.collisions.length > 0 || plan.blocked.length > 0 || plan.missing.length > 0);
    const items = plan?.[category] ?? [];
    const keyword = query.trim().toLowerCase();
    const visibleItems = keyword ? items.filter((item) => typeof item === "string"
        ? item.toLowerCase().includes(keyword)
        : item.note.toLowerCase().includes(keyword) || item.url.toLowerCase().includes(keyword)) : items;
    const outcome = dialog?.view === "outcome" ? dialog : null;

    return <>
        <span ref={triggerHostRef} className="inline-flex">
            <IconButton label="导入 Markdown 文件夹"
                title={phase === "scanning" ? "正在扫描要导入的文件夹…" : undefined}
                icon={phase === "scanning" ? <Loader2 className="animate-spin" /> : <FileDown />}
                disabled={busy} onClick={() => void choose()} />
        </span>
        {success ? <Toast onDismiss={() => setSuccess("")}>{success}</Toast> : null}
        {previewError ? <div role="alert"
            className="fixed bottom-6 left-1/2 z-40 flex w-max max-w-[min(90vw,560px)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-[var(--mdx-panel-radius)] bg-base-100 px-4 py-2 shadow-[var(--mdx-panel-shadow)] ring-1 ring-error/25">
            <p className="min-w-0 flex-1 break-words text-xs text-error">{previewError}</p>
            <TextControlButton onClick={() => void choose()}>重新选择</TextControlButton>
            <TextControlButton onClick={() => setPreviewError("")}>关闭</TextControlButton>
        </div> : null}
        {dialogOpen ? <DialogOverlay onDismiss={phase === "idle" ? closeDialog : undefined}>
            <DialogSurface labelledBy="markdown-import-title" className="w-[min(92vw,680px)] max-h-[min(720px,84dvh)]">
                <DialogHeader actions={<>
                    {preview ? <TextControlButton disabled={busy} onClick={() => void choose()}>
                        <FolderOpen aria-hidden="true" />换个文件夹
                    </TextControlButton> : null}
                    <TextControlButton autoFocus disabled={busy} onClick={closeDialog}>
                        <X aria-hidden="true" />关闭
                    </TextControlButton>
                </>}>
                    <h2 id="markdown-import-title">{outcome ? "导入已完成（部分未导入）" : "预览 Markdown 导入"}</h2>
                </DialogHeader>
                {preview ? <>
                    <div className="shrink-0 border-b border-[var(--mdx-separator)] px-5 py-3.5">
                        <FactRows className="max-w-none" items={[
                            { label: "来源", value: preview.source, title: preview.source },
                            { label: "目标", value: rootPath, title: rootPath },
                        ]} />
                        <PanelText tone="meta">保留原目录结构与 Markdown 原文，不会覆盖现有文件；缺少的附件不会自动创建。</PanelText>
                    </div>
                    {!empty ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--mdx-separator)] px-5 py-2">
                        {hasAnomalies ? <div role="tablist" aria-label="导入分类"
                            className="flex flex-wrap items-center gap-0.5 rounded-[var(--mdx-control-radius)] bg-[var(--mdx-track-bg)] p-0.5">
                            {categories.filter(({ key }) => key === "add" || preview.plan[key].length > 0).map(({ key, label }) =>
                                <TextControlButton key={key} role="tab" id={`markdown-import-${key}`} aria-selected={category === key}
                                    aria-controls="markdown-import-list" className={category === key ? "bg-base-100 text-base-content shadow-[var(--mdx-raised-shadow)]" : undefined}
                                    onClick={() => { setCategory(key); setQuery(""); }}>
                                    {label}<Chip tone={key === "add" ? "neutral" : "warning"}>{preview.plan[key].length}</Chip>
                                </TextControlButton>
                            )}
                        </div> : <div className="flex items-center gap-2">
                            <PanelText tone="meta">将导入 {noteCount} 篇笔记{assetCount ? `（含 ${assetCount} 个附件）` : ""}</PanelText>
                            <Chip tone="success">无冲突</Chip>
                        </div>}
                        {items.length > 8 ? <SearchField value={query} onChange={setQuery} placeholder="筛选路径…"
                            label="筛选导入列表" className="w-44" /> : null}
                    </div> : null}
                    <div id="markdown-import-list" role={hasAnomalies ? "tabpanel" : undefined}
                        aria-labelledby={hasAnomalies ? `markdown-import-${category}` : undefined}
                        className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                        {empty ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-center">
                            <h3 className="text-sm font-medium">未找到可导入的 Markdown 笔记</h3>
                            <PanelText tone="meta">所选文件夹中没有 <code>.md</code> 或 <code>.markdown</code> 文件。</PanelText>
                            <TextControlButton disabled={busy} onClick={() => void choose()}>换个文件夹</TextControlButton>
                        </div> : <>
                            {!preview.plan.add.length ? <PanelText tone="meta" className="mb-2">没有可导入的文件，笔记或引用的附件与目标路径冲突。</PanelText> : null}
                            {visibleItems.length ? <ul className="divide-y divide-[var(--mdx-separator)]">
                                {visibleItems.map((item) => typeof item === "string"
                                    ? <ImportFileRow key={item} path={item} />
                                    : <ImportFileRow key={JSON.stringify([item.note, item.url])} path={item.note}
                                        detail={`${category === "blocked" ? "引用附件冲突" : "本地附件缺失"}：${item.url}`} />)}
                            </ul> : keyword ? <PanelText tone="meta">没有匹配的路径</PanelText> : null}
                        </>}
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--mdx-separator)] px-5 py-3">
                        {dialogError ? <p role="alert" className="min-w-0 flex-1 text-xs text-error">{dialogError}</p>
                            : <PanelText tone="meta" className="min-w-0 flex-1">
                                {preview.plan.missing.length && preview.plan.add.length
                                    ? `有 ${preview.plan.missing.length} 处本地附件缺失，相关笔记仍会按原文导入`
                                    : preview.plan.add.length
                                      ? `共 ${noteCount} 篇笔记${assetCount ? `、${assetCount} 个附件` : ""}`
                                      : ""}
                            </PanelText>}
                        <div className="flex shrink-0 items-center gap-2">
                            <TextControlButton disabled={busy} onClick={closeDialog}>取消</TextControlButton>
                            <PrimaryTextControlButton disabled={busy || !preview.plan.add.length} onClick={() => void apply(preview)}>
                                {phase === "applying" ? <><Loader2 aria-hidden="true" className="animate-spin" />正在导入…</>
                                    : `导入 ${preview.plan.add.length} 个文件`}
                            </PrimaryTextControlButton>
                        </div>
                    </div>
                </> : null}
                {outcome ? <>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--mdx-separator)] px-5 py-3.5">
                        <Chip tone="success">已添加 {outcome.result.added.length}</Chip>
                        <Chip tone="warning">导入时跳过 {outcome.result.skipped.length}</Chip>
                        <Chip tone="error">失败 {outcome.result.failed.length}</Chip>
                        {outcome.collisions ? <Chip tone="warning">原有冲突跳过 {outcome.collisions}</Chip> : null}
                    </div>
                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-3">
                        {([
                            { label: "失败", tone: "error", paths: outcome.result.failed },
                            { label: "导入时跳过", tone: "warning", paths: outcome.result.skipped },
                        ] as const).filter(({ paths }) => paths.length).map(({ label, tone, paths }) => <section key={tone}>
                            <h3><Chip tone={tone}>{label}</Chip></h3>
                            <ul className="mt-1 divide-y divide-[var(--mdx-separator)]">
                                {paths.map((path) => <ImportFileRow key={path} path={path} />)}
                            </ul>
                        </section>)}
                    </div>
                    <div className="flex shrink-0 justify-end border-t border-[var(--mdx-separator)] px-5 py-3">
                        <PrimaryTextControlButton autoFocus onClick={closeDialog}>完成</PrimaryTextControlButton>
                    </div>
                </> : null}
            </DialogSurface>
        </DialogOverlay> : null}
    </>;
}

function ImportFileRow({ path, detail }: { path: string; detail?: string }) {
    const Icon = isMarkdown(path) ? FileText : Paperclip;
    const filenameStart = path.lastIndexOf("/") + 1;
    return <li className="flex items-start gap-2 py-2">
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-base-content/55" />
        <div className="min-w-0 break-all font-mono text-xs">
            <span className="text-base-content/50">{path.slice(0, filenameStart)}</span>
            <span className="font-medium text-base-content">{path.slice(filenameStart)}</span>
            {detail ? <p className="mt-1 text-base-content/65">{detail}</p> : null}
        </div>
    </li>;
}
