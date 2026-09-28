"use client";

import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import type {
    ClipboardEvent,
    DragEvent,
    KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
    MarkdownEditorAdapter,
    selectionSnapshotFromMarkdownOffsets,
} from "../../../packages/mdx-editor";
import type {
    EditorAdapterDiagnostic,
    EditorChangeEvent,
    EditorCommandFailureCode,
    EditorCommandResult,
    EditorDocumentSnapshot,
    EditorLinkActivation,
    EditorSourceSelection,
    EditorSurfaceMode,
    EditorSurfaceServices,
    EditorWikilinkActivation,
    MarkdownEditorAdapterHandle,
    PinnedEditorCommand,
} from "../../../packages/mdx-editor";
import type { PendingCliEditorCommand } from "../../workspace/lib/types";
import type {
    EditorChangeVerdict,
    EditorSessionBinding,
} from "../lib/editor-session-binding";
import {
    advancePinnedSelection,
    pinnedCommandForCliRequest,
} from "../lib/editor-command-pin";
import {
    isEditorFindShortcut,
    isEditorReplaceShortcut,
    isEditorSourceModeShortcut,
} from "../lib/editor-shortcuts";
import {
    dataTransferHasImage,
    imageFilesFromDataTransfer,
} from "../lib/image-transfer";
import { useAdapterFindReplace } from "../hooks/use-adapter-find-replace";
import type { AdapterFindHost } from "../hooks/use-adapter-find-replace";
import { EditorFindBar } from "./editor-find-bar";

/**
 * What the visual surface's link editor calls its parts.
 *
 * The editor package holds no human-language text of its own, so the product
 * names everything it puts on screen — including, for anyone hearing the
 * interface rather than seeing it, the address field itself.
 */
const LINK_EDITOR_LABELS = {
    address: "链接地址",
    open: "打开",
    remove: "移除链接",
};

/**
 * How long a batch of images runs before it is shown as running.
 *
 * A local save finishes in a few milliseconds and should not flash a bar; an
 * upload takes seconds, and without one the user pastes again.
 */
const IMAGE_PROGRESS_DELAY_MS = 300;

/** Why an image did not land, in words; the store is the caller's, so its error says why. */
function describeImageStoreError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error.length > 0) return error;
    if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.length > 0
    ) {
        return error.message;
    }
    return "未知错误";
}

function describeImageRefusal(code: EditorCommandFailureCode): string {
    switch (code) {
        case "stale_document":
            return "粘贴时的文档已不在编辑器中";
        case "stale_revision":
            return "文档已被重新加载或替换";
        default:
            return `编辑器拒绝了插入（${code}）`;
    }
}

/**
 * What the failure bar says: why, and — for a batch — how much of it is missing.
 * The count includes the image that failed and every one after it.
 */
function imageFailureMessage(
    reason: string,
    notInserted: number,
    total: number,
): string {
    return total > 1
        ? `图片未插入：${reason}（本次共 ${notInserted} 张未插入）`
        : `图片未插入：${reason}`;
}

/** Why a pinned command did not run. */
export interface EditorCommandRefusal {
    commandId: string;
    kind: PinnedEditorCommand["kind"];
    code: EditorCommandFailureCode;
}

export interface MarkdownEditorSurfaceHandle {
    /**
     * Reveals a Markdown source range, reporting whether it applied.
     *
     * The range is expressed in the same UTF-16 source offsets everything else
     * crossing this boundary uses, so a caller never needs an element, a
     * heading index or any knowledge of which surface is mounted.
     */
    reveal(range: EditorSourceSelection): Promise<EditorCommandResult>;
    /**
     * Asks for a surface mode, resolving once the request has settled.
     *
     * A view change, not an edit: it decides which surface draws the document,
     * never what the document says. The adapter may refuse — an unsafe visual
     * parse — and the surface reports that itself, so a caller gets no verdict
     * to mishandle and no way to force a switch the editor rejected.
     */
    setMode(mode: EditorSurfaceMode): Promise<void>;
}

export interface MarkdownEditorSurfaceProps {
    /** Owned by the file session; decides revisions and applies verdicts. */
    session: EditorSessionBinding;
    /** Stable identity of the file this surface is editing. */
    documentId: string;
    /** The session's canonical Markdown for `documentId`. */
    markdown: string;
    editable?: boolean;
    /** Which surface this document opens on. Not persisted, not a preference. */
    initialMode?: EditorSurfaceMode;
    /**
     * The surface the editor settled on.
     *
     * Reported, not controlled: the adapter decides whether a switch happens,
     * so chrome that draws the current mode has to be told what it became
     * rather than what was asked for.
     */
    onModeChange?: (mode: EditorSurfaceMode) => void;
    /**
     * Called only for changes the session accepted. `documentId` is the
     * document the change belongs to, which is not necessarily the document
     * the caller is currently showing.
     */
    onMarkdownChange: (documentId: string, markdown: string) => void;
    onRejectedChange?: (verdict: Extract<EditorChangeVerdict, { kind: "reject" }>) => void;
    onDiagnostic?: (diagnostic: EditorAdapterDiagnostic) => void;
    onOpenWikilink?: (activation: EditorWikilinkActivation) => void;
    /**
     * Fires when an ordinary link is activated in the rendered document.
     *
     * The href arrives as the Markdown wrote it, so deciding between a browser,
     * a note in this workspace and a refusal is the caller's.
     */
    onOpenLink?: (activation: EditorLinkActivation) => void;
    /**
     * Stores an asset and returns the Markdown target to insert. File access
     * stays with the caller; this surface only decides where the result lands.
     */
    storeImage?: (file: File) => Promise<{ url: string; altText: string }>;
    /**
     * Receives why the images last pasted or dropped did not all land, and
     * `null` when a new paste starts and that is no longer the latest news.
     *
     * The caller shows it, not this surface: an image is most often refused
     * because its tab was closed or switched away from while it was stored,
     * and by then this surface is no longer mounted to show anything. A caller
     * that passes `storeImage` should pass this too.
     */
    onImageFailure?: (message: string | null) => void;
    /**
     * What the rendered document needs the product to do for it: resolve the
     * relative path an image was written with, tokenize a fenced language.
     * Neither is something the editor can answer on its own, and neither
     * changes what the document is — only how it is drawn.
     */
    services?: EditorSurfaceServices;
    /** A CLI request already narrowed to this document by the caller. */
    pendingCliCommand?: PendingCliEditorCommand | null;
    onPendingCliCommandHandled?: (commandId: string) => void;
    onCommandRefused?: (refusal: EditorCommandRefusal) => void;
    /**
     * Reports the selection as the CLI context the product already serves:
     * selected text plus surrounding source, derived from source offsets.
     */
    onSelectionChange?: (
        documentId: string,
        selection: Record<string, unknown> | null,
    ) => void;
}

/**
 * Mounts the Markdown editor adapter against a real file session.
 *
 * This component is the whole of the product's editing capability boundary: it
 * hands the adapter a controlled snapshot and takes changes back. It cannot
 * read or write files, clear dirty state, delete drafts, or decide whether an
 * external version wins — those stay with the session, which is why every
 * change is routed by the `documentId` the adapter reports rather than by
 * whichever document happens to be on screen when the callback lands.
 *
 * Every product integration that used to reach into rendered output — the
 * outline's heading scan, the wikilink hit-test, the image insertion point, the
 * CLI's focus and insert — is expressed here as a command in Markdown source
 * offsets, pinned to the document and revision it was aimed at.
 */
export const MarkdownEditorSurface = forwardRef<
    MarkdownEditorSurfaceHandle,
    MarkdownEditorSurfaceProps
>(function MarkdownEditorSurface(
    {
        session,
        documentId,
        markdown,
        editable = true,
        initialMode = "wysiwyg",
        onModeChange,
        onMarkdownChange,
        onRejectedChange,
        onDiagnostic,
        onOpenWikilink,
        onOpenLink,
        storeImage,
        onImageFailure,
        services,
        pendingCliCommand = null,
        onPendingCliCommandHandled,
        onCommandRefused,
        onSelectionChange,
    },
    ref,
) {
    // A surface that outlives its props — the adapter flushes pending edits
    // while tearing down — must not call into a closure from a previous render.
    const sessionRef = useRef(session);
    const onMarkdownChangeRef = useRef(onMarkdownChange);
    const onRejectedChangeRef = useRef(onRejectedChange);
    const onDiagnosticRef = useRef(onDiagnostic);
    const onOpenWikilinkRef = useRef(onOpenWikilink);
    const onOpenLinkRef = useRef(onOpenLink);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const onCommandRefusedRef = useRef(onCommandRefused);
    const storeImageRef = useRef(storeImage);
    const onImageFailureRef = useRef(onImageFailure);

    const adapterRef = useRef<MarkdownEditorAdapterHandle | null>(null);
    /**
     * The last known source selection, stamped with the document it describes.
     *
     * The stamp is what makes it safe to read: an offset from a document that
     * is no longer mounted describes text that is no longer there, and a
     * command aimed at it would land somewhere plausible and wrong.
     */
    const selectionRef = useRef<{
        documentId: string | null;
        selection: EditorSourceSelection | null;
    }>({ documentId: null, selection: null });
    /** The exact snapshot the adapter is being driven with. */
    const snapshotRef = useRef<EditorDocumentSnapshot | null>(null);
    /** The Markdown the session holds for the mounted document. */
    const markdownRef = useRef(markdown);
    /** CLI request ids already dispatched, so a re-render cannot repeat one. */
    const dispatchedCommandIdRef = useRef<string | null>(null);
    /** Makes each command this surface issues its own, at-most-once request. */
    const commandSequenceRef = useRef(0);

    const [mode, setMode] = useState<EditorSurfaceMode>(initialMode);
    /**
     * Why the last requested surface switch did not happen, if it did not.
     *
     * Stamped with the exact document and revision it describes, and shown only
     * while both still hold. The surface is not remounted per document — a tab
     * switch changes the props under it — so an unstamped refusal would sit
     * over the next document; and the refusal is a statement about particular
     * Markdown, so any later content, typed here or replaced from disk,
     * retires it without anything having to remember to.
     */
    const [modeRefusal, setModeRefusal] = useState<{
        documentId: string;
        revision: number;
        message: string;
    } | null>(null);
    /** The latest running batch, once it has run long enough to be shown. */
    const [imageProgress, setImageProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);
    /** Batches still storing, in the order they started. */
    const imageBatchesRef = useRef(
        new Map<
            number,
            { documentId: string; done: number; total: number; shown: boolean }
        >(),
    );
    const imageBatchSequenceRef = useRef(0);

    const reportImageFailure = useCallback((message: string | null) => {
        const report = onImageFailureRef.current;
        if (report) {
            report(message);
        } else if (message !== null) {
            console.warn(message);
        }
    }, []);

    const refreshImageProgress = useCallback(() => {
        // Only a batch aimed at the document on screen can still land; one
        // pasted into a document the user has since switched away from will
        // be refused, and its progress over this one would say otherwise.
        const onScreen = snapshotRef.current?.documentId;
        const shown = [...imageBatchesRef.current.values()].filter(
            (batch) => batch.shown && batch.documentId === onScreen,
        );
        const latest = shown.at(-1);
        setImageProgress(
            latest ? { done: latest.done, total: latest.total } : null,
        );
    }, []);

    /** The mounted document's selection, or null when it belongs elsewhere. */
    const currentSelection = useCallback((): EditorSourceSelection | null => {
        const current = snapshotRef.current;
        const known = selectionRef.current;
        if (!current || known.documentId !== current.documentId) return null;
        return known.selection;
    }, []);

    // The binding returns the same snapshot for unchanged content, so a render
    // that changes nothing else leaves the surface untouched.
    const snapshot = useMemo(
        () => session.snapshotFor({ documentId, markdown }),
        [session, documentId, markdown],
    );

    useEffect(() => {
        snapshotRef.current = snapshot;
        markdownRef.current = markdown;
        sessionRef.current = session;
        onMarkdownChangeRef.current = onMarkdownChange;
        onRejectedChangeRef.current = onRejectedChange;
        onDiagnosticRef.current = onDiagnostic;
        onOpenWikilinkRef.current = onOpenWikilink;
        onOpenLinkRef.current = onOpenLink;
        onSelectionChangeRef.current = onSelectionChange;
        onCommandRefusedRef.current = onCommandRefused;
        storeImageRef.current = storeImage;
        onImageFailureRef.current = onImageFailure;
    });

    // Declared after the effect above so it reads the document now on screen:
    // a tab switch changes which running batches can still land.
    useEffect(() => {
        refreshImageProgress();
    }, [snapshot.documentId, refreshImageProgress]);

    const reportSelection = useCallback(
        (
            selectionDocumentId: string,
            sourceMarkdown: string,
            selection: EditorSourceSelection | null,
        ) => {
            selectionRef.current = { documentId: selectionDocumentId, selection };
            onSelectionChangeRef.current?.(
                selectionDocumentId,
                selection === null
                    ? null
                    : (selectionSnapshotFromMarkdownOffsets(
                          sourceMarkdown,
                          selection.anchor,
                          selection.head,
                      ) as unknown as Record<string, unknown>),
            );
        },
        [],
    );

    const handleChange = useCallback((event: EditorChangeEvent) => {
        const verdict = sessionRef.current.acceptChange(event);

        if (verdict.kind === "accept") {
            markdownRef.current = verdict.markdown;
            onMarkdownChangeRef.current(verdict.documentId, verdict.markdown);
            reportSelection(
                verdict.documentId,
                verdict.markdown,
                event.selection,
            );
            return;
        }

        onRejectedChangeRef.current?.(verdict);
    }, [reportSelection]);

    // The adapter reports a selection only for the document it currently holds,
    // which is the one this render was given, so the stamp comes from the prop
    // rather than from anything recorded on the way past.
    const handleSelectionChange = useCallback(
        (selection: EditorSourceSelection | null) => {
            reportSelection(documentId, markdownRef.current, selection);
        },
        [documentId, reportSelection],
    );

    const handleDiagnostic = useCallback((diagnostic: EditorAdapterDiagnostic) => {
        onDiagnosticRef.current?.(diagnostic);
    }, []);

    const handleOpenWikilink = useCallback(
        (activation: EditorWikilinkActivation) => {
            onOpenWikilinkRef.current?.(activation);
        },
        [],
    );

    const handleOpenLink = useCallback((activation: EditorLinkActivation) => {
        onOpenLinkRef.current?.(activation);
    }, []);

    /**
     * Bumped by every surface that finishes building.
     *
     * A surface is built asynchronously and replaced outright on a mode switch,
     * so anything derived from asking the editor a question — find is the only
     * one today — has to be asked again once a different editor is the one
     * answering.
     */
    const [surfaceGeneration, setSurfaceGeneration] = useState(0);

    const handleReady = useCallback(() => {
        setSurfaceGeneration((generation) => generation + 1);
    }, []);

    /**
     * Runs a pinned command, reporting a refusal rather than retrying it.
     *
     * A command the adapter refuses is finished: its offsets described a
     * document state that is gone, and the only positions left to choose from
     * are guesses.
     */
    const runCommand = useCallback(
        async (command: PinnedEditorCommand): Promise<EditorCommandResult> => {
            const handle = adapterRef.current;
            if (!handle) {
                const refused: EditorCommandResult = {
                    ok: false,
                    code: "stale_document",
                };
                onCommandRefusedRef.current?.({
                    commandId: command.commandId,
                    kind: command.kind,
                    code: refused.code,
                });
                return refused;
            }

            const result = await handle.execute(command);
            if (!result.ok) {
                onCommandRefusedRef.current?.({
                    commandId: command.commandId,
                    kind: command.kind,
                    code: result.code,
                });
            }
            return result;
        },
        [],
    );

    const revealRange = useCallback(
        (range: EditorSourceSelection): Promise<EditorCommandResult> => {
            const current = snapshotRef.current;
            if (!current) {
                return Promise.resolve({
                    ok: false as const,
                    code: "stale_document" as const,
                });
            }

            commandSequenceRef.current += 1;
            return runCommand({
                commandId: `reveal:${current.documentId}:${commandSequenceRef.current}`,
                documentId: current.documentId,
                baseRevision: current.revision,
                selection: currentSelection(),
                kind: "reveal-range",
                range,
            });
        },
        [currentSelection, runCommand],
    );

    /**
     * Replaces the source a range covers, reporting whether it applied.
     *
     * The pin is read fresh from the mounted snapshot on every call rather than
     * captured once: a replacement the session has already confirmed advances
     * the revision the next command must name, and a batch that kept naming the
     * first one would be refused halfway through.
     */
    const replaceRange = useCallback(
        async (range: EditorSourceSelection, text: string): Promise<boolean> => {
            const current = snapshotRef.current;
            if (!current) return false;

            commandSequenceRef.current += 1;
            const result = await runCommand({
                commandId: `replace:${current.documentId}:${commandSequenceRef.current}`,
                documentId: current.documentId,
                baseRevision: current.revision,
                selection: currentSelection(),
                kind: "replace-selection",
                text,
                range,
            });
            return result.ok;
        },
        [currentSelection, runCommand],
    );

    /**
     * Asks the adapter for a surface, and says why when it did not happen.
     *
     * The ⌘⇧M chord and the toolbar's mode control both come through here, so
     * a refusal reads the same however the switch was asked for, and neither
     * caller decides the mode itself.
     */
    const requestMode = useCallback(async (target: EditorSurfaceMode) => {
        const askedFor = snapshotRef.current;
        // A throw here would otherwise be an unhandled rejection that also
        // leaves the control looking dead, which is the very thing this
        // branch exists to prevent.
        const result = await adapterRef.current
            ?.setMode(target)
            .catch((error: unknown) => ({
                ok: false as const,
                code: "unsafe_visual_parse" as const,
                diagnostics: [
                    {
                        code: "unsafe_visual_parse" as const,
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                ],
            }));
        // The switch is awaited, so the document underneath may have been
        // swapped by the time it answers. A refusal describes the Markdown it
        // was asked about, and saying it over someone else's document would be
        // a lie.
        // No adapter means no switch was attempted, which is not an answer
        // about the content and must not retire an existing notice.
        if (
            result === undefined ||
            !askedFor ||
            snapshotRef.current?.documentId !== askedFor.documentId
        ) {
            return;
        }
        // A refusal keeps the request from doing anything visible, and this is
        // the only path to the other surface — silence here reads as a broken
        // editor. The surface says so itself because `onDiagnostic` is optional
        // and no window passes it.
        setModeRefusal(
            result.ok
                ? null
                : {
                      documentId: askedFor.documentId,
                      revision: askedFor.revision,
                      // A refusal always carries its diagnostic, and that
                      // diagnostic is what locates the offending source for
                      // the user.
                      message: `无法切换到可视模式：${result.diagnostics[0].message}`,
                  },
        );
    }, []);

    /**
     * Keeps this surface's mode and whatever draws it in step.
     *
     * The adapter announces the mode it reached, which is the only statement
     * either of them should be believed on.
     */
    const handleAdapterModeChange = useCallback(
        (next: EditorSurfaceMode) => {
            setMode(next);
            onModeChange?.(next);
        },
        [onModeChange],
    );

    useImperativeHandle(
        ref,
        (): MarkdownEditorSurfaceHandle => ({
            reveal: revealRange,
            setMode: requestMode,
        }),
        [requestMode, revealRange],
    );

    /**
     * Find and replace as the adapter answers them.
     *
     * The query goes to the mounted editor, which searches the document it
     * holds and returns Markdown source offsets. Nothing here reads rendered
     * output, so the same query means the same thing on the visual surface and
     * the source surface, and a replacement lands on the source the match came
     * from rather than wherever a rendered range happened to point.
     */
    const findHost = useMemo<AdapterFindHost>(
        () => ({
            find: (request) =>
                adapterRef.current?.find(request) ?? {
                    matches: [],
                    activeMatchId: null,
                },
            highlight: (ranges, activeIndex) => {
                adapterRef.current?.highlightMatches(ranges, activeIndex);
            },
            reveal: (range) => {
                void revealRange(range);
            },
            replace: replaceRange,
            focus: () => {
                adapterRef.current?.focus();
            },
        }),
        [replaceRange, revealRange],
    );

    const findReplace = useAdapterFindReplace({
        host: findHost,
        markdown,
        surfaceGeneration,
    });
    const {
        close: closeFind,
        goNext,
        goPrevious,
        openFind,
        openReplace,
        replaceAll,
        replaceCurrent,
        setQuery,
        setReplacement,
        toggleCaseSensitive,
        toggleReplaceExpanded,
    } = findReplace.actions;
    const isFindOpen = findReplace.state.isOpen;

    const handleKeyDownCapture = useCallback(
        (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (isEditorFindShortcut(event.nativeEvent)) {
                event.preventDefault();
                event.stopPropagation();
                openFind();
                return;
            }

            if (isEditorReplaceShortcut(event.nativeEvent)) {
                event.preventDefault();
                event.stopPropagation();
                openReplace();
                return;
            }

            if (isEditorSourceModeShortcut(event.nativeEvent)) {
                event.preventDefault();
                event.stopPropagation();
                // Auto-repeat asks for the mode the user is already going to,
                // and each leg rebuilds a surface. Holding the chord would
                // otherwise alternate views for as long as it is held.
                if (event.nativeEvent.repeat) return;
                // The adapter owns the switch: it drains the mounted surface,
                // refuses a target it cannot build, and announces the mode it
                // reached, so nothing here decides the mode itself.
                void requestMode(mode === "source" ? "wysiwyg" : "source");
                return;
            }

            // Enter steps through matches only while the bar is open, and only
            // for keys the editor itself received: the bar's own inputs are
            // outside this element and handle their own Enter.
            if (
                !isFindOpen ||
                event.key !== "Enter" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) {
                goPrevious();
                return;
            }
            goNext();
        },
        [goNext, goPrevious, isFindOpen, mode, openFind, openReplace, requestMode],
    );

    useEffect(() => {
        if (!pendingCliCommand) return;
        if (dispatchedCommandIdRef.current === pendingCliCommand.id) return;
        const current = snapshotRef.current;
        if (!current) return;

        dispatchedCommandIdRef.current = pendingCliCommand.id;
        const settle = () =>
            onPendingCliCommandHandled?.(pendingCliCommand.id);

        const command = pinnedCommandForCliRequest(
            pendingCliCommand,
            {
                documentId: current.documentId,
                baseRevision: current.revision,
                selection: currentSelection(),
            },
            markdownRef.current,
        );

        if (!command) {
            settle();
            return;
        }

        // A CLI request that moves the caret is also a request for the editor
        // to be the thing receiving keystrokes afterwards.
        adapterRef.current?.focus();
        void runCommand(command).then(settle, settle);
    }, [currentSelection, pendingCliCommand, onPendingCliCommandHandled, runCommand]);

    /**
     * Stores each file and inserts it at the position the user started from.
     *
     * The insertion point is fixed before the first store begins and then moves
     * only by however much the document actually grew, so a batch keeps its
     * order and its origin no matter how long the stores take. When the pin
     * stops describing the document the user was looking at — a reload, a
     * restore, a conflict resolution, a closed tab — the insert is refused. The
     * caret at that moment belongs to a different document state and is never
     * used as a substitute.
     *
     * The batch stops at the first image that cannot be stored or inserted;
     * those already inserted stay, and the user is told why and how many did
     * not land. Nothing is retried or stored anywhere else.
     */
    const storeAndInsertImages = useCallback(async (files: File[]) => {
        const store = storeImageRef.current;
        const pinned = snapshotRef.current;
        if (!store || files.length === 0 || !pinned) return;

        const pinnedDocumentId = pinned.documentId;
        let pinnedRevision = pinned.revision;
        let target = currentSelection() ?? { anchor: 0, head: 0 };
        /** What the previous insert left the document holding. */
        let expectedMarkdown: string | null = null;

        imageBatchSequenceRef.current += 1;
        const batchId = imageBatchSequenceRef.current;
        const batch = {
            documentId: pinnedDocumentId,
            done: 0,
            total: files.length,
            shown: false,
        };
        imageBatchesRef.current.set(batchId, batch);
        // A new paste is the user moving on from the last one's failure.
        reportImageFailure(null);
        const showTimer = setTimeout(() => {
            batch.shown = true;
            refreshImageProgress();
        }, IMAGE_PROGRESS_DELAY_MS);
        const fail = (index: number, reason: string) =>
            reportImageFailure(
                imageFailureMessage(reason, files.length - index, files.length),
            );

        /** The image being worked on, for a failure nothing else caught. */
        let reached = 0;
        try {
            for (const [index, file] of files.entries()) {
                reached = index;
                let stored: { url: string; altText: string };
                try {
                    stored = await store(file);
                } catch (error) {
                    fail(index, describeImageStoreError(error));
                    return;
                }
                const current = snapshotRef.current;

                if (!current || current.documentId !== pinnedDocumentId) {
                    onCommandRefusedRef.current?.({
                        commandId: `image:${pinnedDocumentId}`,
                        kind: "insert-image",
                        code: "stale_document",
                    });
                    fail(index, describeImageRefusal("stale_document"));
                    return;
                }

                if (expectedMarkdown !== null) {
                    // Only this batch's own inserts may advance the pin. Anything
                    // else that reached the document since the last file moved the
                    // text the pin was measured against.
                    if (current.markdown !== expectedMarkdown) {
                        onCommandRefusedRef.current?.({
                            commandId: `image:${pinnedDocumentId}`,
                            kind: "insert-image",
                            code: "stale_revision",
                        });
                        // The batch's own check, not the adapter's: most often the
                        // user typed while the next image was being stored.
                        fail(index, "插入过程中文档被修改");
                        return;
                    }
                    pinnedRevision = current.revision;
                }

                const before = current.markdown;
                commandSequenceRef.current += 1;
                const result = await runCommand({
                    commandId: `image:${pinnedDocumentId}:${commandSequenceRef.current}`,
                    documentId: pinnedDocumentId,
                    baseRevision: pinnedRevision,
                    selection: target,
                    kind: "insert-image",
                    image: { src: stored.url, alt: stored.altText },
                });

                if (!result.ok) {
                    fail(index, describeImageRefusal(result.code));
                    return;
                }

                expectedMarkdown = markdownRef.current;
                target = advancePinnedSelection(
                    target,
                    expectedMarkdown.length - before.length,
                );
                batch.done = index + 1;
                if (batch.shown) refreshImageProgress();
            }
        } catch (error) {
            // Nothing above expects to throw, but the handlers only `void`
            // this promise: whatever does must still reach the user.
            fail(reached, describeImageStoreError(error));
        } finally {
            clearTimeout(showTimer);
            imageBatchesRef.current.delete(batchId);
            refreshImageProgress();
        }
    }, [currentSelection, refreshImageProgress, reportImageFailure, runCommand]);

    const handlePasteCapture = useCallback(
        (event: ClipboardEvent<HTMLDivElement>) => {
            if (!storeImageRef.current) return;

            const imageFiles = imageFilesFromDataTransfer(event.clipboardData);
            if (imageFiles.length === 0) return;

            event.preventDefault();
            event.stopPropagation();
            void storeAndInsertImages(imageFiles);
        },
        [storeAndInsertImages],
    );

    const handleDragOverCapture = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            if (!storeImageRef.current || !dataTransferHasImage(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
        },
        [],
    );

    const handleDropCapture = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            if (!storeImageRef.current) return;

            const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
            if (imageFiles.length === 0) return;

            event.preventDefault();
            event.stopPropagation();
            void storeAndInsertImages(imageFiles);
        },
        [storeAndInsertImages],
    );

    return (
        <div
            data-mdx-markdown-editor-surface=""
            className="flex h-full min-h-0 w-full flex-col"
        >
            {isFindOpen ? (
                <EditorFindBar
                    caseSensitive={findReplace.state.caseSensitive}
                    countLabel={findReplace.countLabel}
                    isReplaceExpanded={findReplace.state.isReplaceExpanded}
                    matchCount={findReplace.matchCount}
                    query={findReplace.state.query}
                    replacement={findReplace.state.replacement}
                    onCaseSensitiveToggle={toggleCaseSensitive}
                    onClose={closeFind}
                    onNext={goNext}
                    onPrevious={goPrevious}
                    onQueryChange={setQuery}
                    onReplaceAll={() => {
                        void replaceAll();
                    }}
                    onReplaceCurrent={() => {
                        void replaceCurrent();
                    }}
                    onReplacementChange={setReplacement}
                    onReplaceToggle={toggleReplaceExpanded}
                />
            ) : null}
            {modeRefusal?.documentId === snapshot.documentId &&
            modeRefusal.revision === snapshot.revision ? (
                <div
                    data-mdx-editor-mode-refusal=""
                    // A standing condition rather than a one-shot event: it
                    // holds for as long as this revision cannot be shown
                    // visually, and it is re-rendered whenever the user comes
                    // back to the document. `alert` would interrupt the screen
                    // reader on every return to say something unchanged.
                    role="status"
                    className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                >
                    {modeRefusal.message}
                </div>
            ) : null}
            {imageProgress !== null ? (
                <div
                    data-mdx-image-notice="progress"
                    role="status"
                    className="shrink-0 border-b border-[var(--mdx-separator)] px-3 py-2 text-sm text-base-content/70"
                >
                    {`正在处理图片 ${Math.min(imageProgress.done + 1, imageProgress.total)}/${imageProgress.total}…`}
                </div>
            ) : null}
            <div
                data-mdx-markdown-editor-stage=""
                className="min-h-0 flex-1"
                onDragOverCapture={handleDragOverCapture}
                onDropCapture={handleDropCapture}
                onKeyDownCapture={handleKeyDownCapture}
                onPasteCapture={handlePasteCapture}
            >
                <MarkdownEditorAdapter
                    ref={adapterRef}
                    snapshot={snapshot}
                    mode={mode}
                    editable={editable}
                    services={services}
                    onChange={handleChange}
                    onSelectionChange={handleSelectionChange}
                    onModeChange={handleAdapterModeChange}
                    onDiagnostic={handleDiagnostic}
                    onOpenWikilink={handleOpenWikilink}
                    onOpenLink={handleOpenLink}
                    linkEditorLabels={LINK_EDITOR_LABELS}
                    onReady={handleReady}
                />
            </div>
        </div>
    );
});
