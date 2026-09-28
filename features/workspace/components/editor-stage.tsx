"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { loadImage, storeImageForWorkspace } from "@/common/lib/image-storage";
import { tokenize } from "@/common/lib/prism";
import { tauriCore } from "@/common/lib/tauri";
import { ImageFailureBar } from "@/features/editor/components/image-failure-bar";
import { MarkdownEditorSurface } from "@/features/editor/components/markdown-editor-surface";
import type {
  EditorCommandRefusal,
  MarkdownEditorSurfaceHandle,
} from "@/features/editor/components/markdown-editor-surface";
import type { EditorSessionBinding } from "@/features/editor/lib/editor-session-binding";
import type { EditorSurfaceMode } from "../../../packages/mdx-editor";
import { documentFingerprint } from "@/features/file-watch/lib/external-change";
import { EmptyState } from "../../../common/components/ui-controls";
import { HtmlPreview } from "./html-preview";
import { createEditorEmptyState } from "../lib/empty-state-copy";
import {
  isImageFilePath,
  isMarkdownFilePath,
  isPdfFilePath,
  isPlainTextFilePath,
  isRenderableHtmlFilePath,
} from "../lib/path";
import type {
  PendingCliEditorCommand,
  WorkspaceAction,
  WorkspaceTab,
} from "../lib/types";

interface EditorStageProps {
  rootPath: string;
  activeTab: WorkspaceTab | null;
  dispatch: (action: WorkspaceAction) => void;
  /**
   * Revision and identity bookkeeping for the controlled editor surface. The
   * workspace session owns it; the stage only reads snapshots out of it.
   */
  editorSession: EditorSessionBinding;
  /**
   * Reaches the adapter surface for source-range navigation. It carries no
   * editing capability of its own: the only thing a holder can ask for is that
   * a Markdown range be revealed.
   */
  editorSurfaceRef?: RefObject<MarkdownEditorSurfaceHandle | null>;
  pendingCliCommand: PendingCliEditorCommand | null;
  onOpenWikilink?: (target: string, sourcePath: string) => void;
  /** Called with a link's href exactly as the Markdown wrote it. */
  onOpenLink?: (href: string, sourcePath: string) => void;
  onCreateMarkdownFile?: () => Promise<void> | void;
  onInitialMarkdownLoadSettled?: () => void;
  onPendingCliCommandHandled: (commandId: string) => void;
  onSelectionChange: (
    tabId: string,
    selection: Record<string, unknown> | null,
  ) => void;
  /** Passed straight through: which surface the editor settled on. */
  onModeChange?: (mode: EditorSurfaceMode) => void;
  /**
   * Why the images last pasted did not all land, shown above whatever the
   * stage is showing.
   *
   * Held by the caller, not here: the Memory and LLM Wiki views replace this
   * whole stage, and an image refused while one of them is open must still be
   * reported when the editor comes back.
   */
  imageFailure: string | null;
  onImageFailure: (message: string | null) => void;
}

export function EditorStage({
  rootPath,
  activeTab,
  dispatch,
  editorSession,
  editorSurfaceRef,
  pendingCliCommand,
  onOpenWikilink,
  onOpenLink,
  onCreateMarkdownFile,
  onInitialMarkdownLoadSettled,
  onPendingCliCommandHandled,
  onSelectionChange,
  onModeChange,
  imageFailure,
  onImageFailure,
}: EditorStageProps) {
  const [loadError, setLoadError] = useState<{
    tabId: string;
    text: string;
  } | null>(null);
  // Shown by the stage rather than the editor surface, which is unmounted
  // when the last tab closes or a non-Markdown tab is shown — the very moments
  // an image still being stored is refused.
  const imageFailureBar = (
    <ImageFailureBar
      message={imageFailure}
      onDismiss={() => onImageFailure(null)}
    />
  );

  useEffect(() => {
    if (
      !activeTab ||
      activeTab.markdown !== undefined ||
      !isMarkdownFilePath(activeTab.path)
    ) {
      return;
    }

    let cancelled = false;
    const loadingTab = activeTab;

    async function loadMarkdown() {
      try {
        const { invoke } = await tauriCore();
        const markdown = await invoke<string>("read_markdown_file", {
          rootPath,
          path: loadingTab.path,
        });

        if (cancelled) {
          return;
        }

        dispatch({
          type: "tab/saved",
          tabId: loadingTab.tabId,
          markdown,
          fingerprint: documentFingerprint(markdown),
        });
        setLoadError((current) =>
          current?.tabId === loadingTab.tabId ? null : current,
        );
        onInitialMarkdownLoadSettled?.();
      } catch (error) {
        if (!cancelled) {
          setLoadError({
            tabId: loadingTab.tabId,
            text: formatError(error, "加载文件失败。"),
          });
          onInitialMarkdownLoadSettled?.();
        }
      }
    }

    void loadMarkdown();

    return () => {
      cancelled = true;
    };
  }, [activeTab, dispatch, onInitialMarkdownLoadSettled, rootPath]);

  const handleMarkdownChange = useCallback(
    (tabId: string, markdown: string) => {
      dispatch({
        type: "tab/contentChanged",
        tabId,
        markdown,
      });
    },
    [dispatch],
  );

  if (!activeTab) {
    const emptyState = createEditorEmptyState({
      canCreateMarkdownFile: Boolean(onCreateMarkdownFile),
    });

    return (
      <section
        data-mdx-content-surface=""
        className="flex min-h-0 flex-1 flex-col bg-base-100"
      >
        {imageFailureBar}
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <EmptyState
            title={emptyState.title}
            description={emptyState.description}
            actionLabel={emptyState.actionLabel}
            onAction={onCreateMarkdownFile}
          />
        </div>
      </section>
    );
  }

  const activeLoadError =
    loadError?.tabId === activeTab.tabId ? loadError.text : null;
  const activeTabKind = getTabKind(activeTab.path);
  const activePendingCliCommand =
    pendingCliCommand?.tabId === activeTab.tabId ? pendingCliCommand : null;

  return (
    <section
      data-mdx-editor-column=""
      data-mdx-content-surface=""
      className="flex min-h-0 flex-1 flex-col bg-base-100"
    >
      {imageFailureBar}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTabKind === "pdf" ? (
          <BinaryBlobPreview
            rootPath={rootPath}
            path={activeTab.path}
            mimeType="application/pdf"
            loadingText="正在加载 PDF..."
            errorPrefix="加载 PDF 失败。"
            render={(source) => (
              <iframe
                title="PDF 预览"
                src={source}
                className="h-full w-full border-0 bg-base-100"
              />
            )}
          />
        ) : activeTabKind === "image" ? (
          <BinaryBlobPreview
            rootPath={rootPath}
            path={activeTab.path}
            mimeType={imageMimeType(activeTab.path)}
            loadingText="正在加载图片..."
            errorPrefix="加载图片失败。"
            render={(source) => (
              <div className="flex h-full items-center justify-center overflow-auto bg-base-100 p-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={source}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            )}
          />
        ) : activeTabKind === "text" ? (
          <TextPreview rootPath={rootPath} path={activeTab.path} />
        ) : activeTabKind === "html" ? (
          <HtmlPreview rootPath={rootPath} path={activeTab.path} />
        ) : activeTabKind === "unsupported" ? (
          <UnsupportedPreview title={activeTab.title} />
        ) : activeTab.markdown === undefined ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-base-content/70">
            {activeLoadError ?? "正在加载文件..."}
          </div>
        ) : (
          <MarkdownEditorSurface
            ref={editorSurfaceRef}
            session={editorSession}
            documentId={activeTab.tabId}
            markdown={activeTab.markdown}
            onMarkdownChange={handleMarkdownChange}
            onOpenWikilink={(activation) =>
              onOpenWikilink?.(activation.target, activeTab.path)
            }
            onOpenLink={(activation) =>
              onOpenLink?.(activation.href, activeTab.path)
            }
            storeImage={(file) =>
              storeImageForWorkspace(file, {
                rootPath,
                currentFilePath: activeTab.path,
              })
            }
            onImageFailure={onImageFailure}
            services={{
              // A relative asset is relative to the file that names it, which
              // is a fact about the workspace and not about the editor.
              imageLoader: (src) =>
                loadImage(src, {
                  rootPath,
                  currentFilePath: activeTab.path,
                }),
              codeTokenizer: tokenize,
            }}
            pendingCliCommand={activePendingCliCommand}
            onPendingCliCommandHandled={onPendingCliCommandHandled}
            onCommandRefused={reportRefusedEditorCommand}
            onSelectionChange={onSelectionChange}
            onModeChange={onModeChange}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Surfaces a command the editor refused.
 *
 * A refusal means the position the request was aimed at no longer describes the
 * document, so the action is over: it is reported and the user repeats it, and
 * nothing is written at a substitute position.
 */
function reportRefusedEditorCommand(refusal: EditorCommandRefusal) {
  console.warn(
    `Editor refused ${refusal.kind} command ${refusal.commandId}: ${refusal.code}`,
  );
}

function BinaryBlobPreview({
  rootPath,
  path,
  mimeType,
  loadingText,
  errorPrefix,
  render,
}: {
  rootPath: string;
  path: string;
  mimeType: string;
  loadingText: string;
  errorPrefix: string;
  render: (source: string) => ReactNode;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function loadSource() {
      try {
        const { invoke } = await tauriCore();
        const bytes = await invoke<number[]>("read_preview_binary_file", {
          rootPath,
          path,
        });

        if (cancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: mimeType }),
        );
        setSource(objectUrl);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) {
          setLoadError(formatError(error, errorPrefix));
        }
      }
    }

    void loadSource();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [errorPrefix, mimeType, path, rootPath]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-base-content/70">
        {loadError}
      </div>
    );
  }

  if (!source) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-base-content/70">
        {loadingText}
      </div>
    );
  }

  return render(source);
}

function TextPreview({ rootPath, path }: { rootPath: string; path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadText() {
      try {
        const { invoke } = await tauriCore();
        const text = await invoke<string>("read_preview_text_file", {
          rootPath,
          path,
        });

        if (!cancelled) {
          setContent(text);
          setLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(formatError(error, "加载文本失败。"));
        }
      }
    }

    void loadText();

    return () => {
      cancelled = true;
    };
  }, [path, rootPath]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-base-content/70">
        {loadError}
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-base-content/70">
        正在加载文本...
      </div>
    );
  }

  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap break-words bg-base-100 p-5 font-mono text-sm leading-relaxed text-base-content">
      {content}
    </pre>
  );
}

function UnsupportedPreview({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-sm text-base-content/70">
      {title} 暂不支持预览。
    </div>
  );
}

function getTabKind(path: string) {
  if (isMarkdownFilePath(path)) {
    return "markdown";
  }

  if (isPdfFilePath(path)) {
    return "pdf";
  }

  if (isImageFilePath(path)) {
    return "image";
  }

  if (isRenderableHtmlFilePath(path)) {
    return "html";
  }

  if (isPlainTextFilePath(path)) {
    return "text";
  }

  return "unsupported";
}

function imageMimeType(path: string) {
    const normalized = path.toLowerCase();

  if (
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".jfif")
  ) {
    return "image/jpeg";
  }

  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }

  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }

  if (normalized.endsWith(".awebp")) {
    return "image/webp";
  }

  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (normalized.endsWith(".bmp")) {
    return "image/bmp";
  }

  if (normalized.endsWith(".avif")) {
    return "image/avif";
  }

  if (normalized.endsWith(".heic")) {
    return "image/heic";
  }

  if (normalized.endsWith(".tif") || normalized.endsWith(".tiff")) {
    return "image/tiff";
  }

  return "image/png";
}

function formatError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return `${fallback} ${error.message}`;
  }

  if (typeof error === "string" && error.length > 0) {
    return `${fallback} ${error}`;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return `${fallback} ${error.message}`;
  }

  return fallback;
}
