import "prosemirror-view/style/prosemirror.css";

import {
    Editor,
    defaultValueCtx,
    editorViewCtx,
    editorViewOptionsCtx,
    remarkCtx,
    remarkStringifyOptionsCtx,
    rootCtx,
    schemaCtx,
    serializerCtx,
} from "@milkdown/kit/core";
import { $prose, callCommand, replaceAll } from "@milkdown/kit/utils";
import { redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { StepMap } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";

import {
    MIXED_LINE_ENDINGS_DIAGNOSTIC,
    fromLineFeeds,
    fromNormalizedOffset,
    readLineEndingStyle,
    toLineFeeds,
    toNormalizedOffset,
    type LineEndingStyle,
} from "../adapter/line-endings";
import {
    findScrollableAncestor,
    scrollTargetIntoComfortableView,
} from "../adapter/reveal-scroll";
import { findSemanticMatches } from "../adapter/semantic-find";
import {
    alignOffsetToCharacterBoundary,
    createSourceOffsetMap,
    type SourceOffsetMap,
} from "../adapter/source-offsets";
import type {
    DocumentSelectionRange,
    EditorAdapterDiagnostic,
    EditorFindRequest,
    EditorImageInsertion,
} from "../adapter/types";
import { createBaseMilkdownPlugins } from "./base-plugins";
import {
    createFindHighlightPlugin,
    findHighlightKey,
    type FindHighlightRange,
} from "./find-highlight";

/**
 * How many emitted document states stay mappable for pinned commands.
 *
 * A pin is only ever mapped from a state the session has not confirmed yet, and
 * the revision guard keeps exactly that many unconfirmed emissions, so matching
 * its budget means the surface can answer for every pin the guard will admit.
 */
const PIN_CHECKPOINT_LIMIT = 64;

/** Which edge of a pinned range a position is, for deletion tracking. */
type PinEdge = "point" | "start" | "end";

/** A document state a pinned range may be mapped forward from. */
interface PinCheckpoint {
    /** The Markdown this document serialized to, in the session's line ending. */
    markdown: string;
    /** The same Markdown with `\n` line breaks, which is what a parse is given. */
    documentMarkdown: string;
    /** The document itself. ProseMirror documents are immutable, so this is a copy in name only. */
    doc: ProseMirrorNode;
    /** Position in the step stream at which this state began. */
    stepIndex: number;
}

export interface MilkdownEditorHostOptions {
    root: HTMLElement;
    markdown: string;
    editable: boolean;
    plugins?: MilkdownPlugin[];
    /**
     * Fires once per batch of Markdown-changing transactions. Synchronous
     * transactions may be merged, but emissions stay in transaction order and
     * always carry the Markdown of the last transaction in the batch.
     */
    onMarkdownChange(markdown: string): void;
    /** Fires when the selection moves without changing the Markdown. */
    onSelectionChange(): void;
    /** Structured failure reports. Never carries document text. */
    onDiagnostic?(diagnostic: EditorAdapterDiagnostic): void;
    /**
     * Defers change emission off the input path. Defaults to a microtask.
     * `flush()` always drains pending work synchronously regardless.
     */
    scheduleChangeEmission?: (emit: () => void) => void;
}

/**
 * Framework-agnostic wrapper around a single Milkdown editor instance.
 *
 * It owns the ProseMirror view and the derived source-offset map. Callers only
 * ever see Markdown strings and Markdown UTF-16 source offsets; the Milkdown
 * context and ProseMirror view stay inside this module.
 *
 * Change emission is owned here rather than delegated to Milkdown's listener
 * plugin. The listener debounces by 200 ms and cancels pending work when the
 * view is destroyed, which would silently drop edits made just before a tab
 * switch or unmount. This host coalesces instead, and `flush()` guarantees
 * every pending edit reaches the session before the surface goes away.
 */
export interface MilkdownEditorHost {
    getMarkdown(): string;
    getSelection(): DocumentSelectionRange | null;
    /** Applies a selection, reporting whether the range resolved to text. */
    setSelection(range: DocumentSelectionRange): boolean;
    /**
     * Applies a selection and scrolls to it, reporting whether the range
     * resolved to text. For jumps the user asked for, where landing at the very
     * bottom edge of the window reads as having missed.
     */
    revealRange(range: DocumentSelectionRange): boolean;
    /**
     * Paints the find matches, marking one of them as current.
     *
     * Purely visual: the highlights are decorations, so they never enter the
     * document, the Markdown, or the clipboard. An empty list clears them.
     */
    setFindHighlights(
        ranges: DocumentSelectionRange[],
        activeIndex: number | null,
    ): void;
    /**
     * Replaces the whole document for an explicit external replace, reporting
     * whether it applied. History is rebuilt, so the replaced content cannot be
     * recovered with undo and then written back over the version that replaced
     * it. Content the visual surface cannot build is refused, not thrown: the
     * surface keeps what it had so the caller can report and offer source mode.
     */
    replaceMarkdown(markdown: string): boolean;
    setEditable(editable: boolean): void;
    focus(): void;
    /**
     * Replaces a source range, reporting whether the edit applied. The change
     * is emitted through the normal coalescing path, exactly as a keystroke
     * would be, so callers needing the new Markdown immediately should call
     * `getMarkdown()` or `flush()`.
     */
    replaceSourceRange(range: DocumentSelectionRange, text: string): boolean;
    /**
     * Replaces a source range with a real image node, reporting whether it
     * applied.
     *
     * An image is a node, not a run of characters: written as text the
     * serializer would escape its brackets and the document would hold a
     * literal `!\[alt](src)` that never renders. The caller says what it wants
     * inserted and the surface decides how its own document holds it.
     */
    insertImage(
        range: DocumentSelectionRange,
        image: EditorImageInsertion,
    ): boolean;
    /**
     * Every match for `request`, in document order, as source ranges.
     *
     * The search runs over the document's semantic text, so preview chrome —
     * rendered diagrams, KaTeX output, NodeView buttons — is neither matched nor
     * counted, and text the document really holds is counted exactly once.
     */
    findMatches(request: EditorFindRequest): DocumentSelectionRange[];
    /**
     * Maps a range pinned against `baseMarkdown` onto the document as it stands
     * now, or null when no faithful mapping exists.
     *
     * The mapping is ProseMirror's own: the pinned offsets are resolved against
     * the document that produced `baseMarkdown`, carried forward through the
     * step maps of every local transaction since, and read back out as source
     * offsets. A pin whose text was deleted, or whose base state this surface
     * never held — because an external replace discarded the history, or the
     * surface was rebuilt — has no faithful answer and gets null rather than a
     * nearby guess.
     */
    mapPinnedRange(
        baseMarkdown: string,
        range: DocumentSelectionRange,
    ): DocumentSelectionRange | null;
    /** Steps back through edit history. Returns false when there is nothing to undo. */
    undo(): boolean;
    /** Steps forward through edit history. Returns false when there is nothing to redo. */
    redo(): boolean;
    /** Emits any pending change synchronously. Safe to call when idle. */
    flush(): void;
    /**
     * True when the most recent serialization attempt failed, meaning the
     * session has not seen what the surface currently holds. It clears as soon
     * as an attempt succeeds.
     */
    hasFailed(): boolean;
    isDestroyed(): boolean;
    destroy(): Promise<void>;
}

export async function createMilkdownEditorHost(
    options: MilkdownEditorHostOptions,
): Promise<MilkdownEditorHost> {
    const {
        root,
        markdown: initialMarkdown,
        editable,
        plugins = createBaseMilkdownPlugins(),
        onMarkdownChange,
        onSelectionChange,
        onDiagnostic,
        scheduleChangeEmission = (emit) => queueMicrotask(emit),
    } = options;

    function report(diagnostic: EditorAdapterDiagnostic): void {
        onDiagnostic?.(diagnostic);
    }

    /**
     * The line ending this document is written with.
     *
     * remark normalizes every line ending while parsing, so the document, its
     * preserved slices and its code blocks all hold `\n` whatever the file
     * arrived with. The file's own ending is put back once, where the
     * serializer's output leaves this module — never inside the document, where
     * a carriage return would survive into the next serialization and be
     * written again.
     */
    let lineEnding: LineEndingStyle = "lf";

    function adoptLineEnding(markdown: string): void {
        const reading = readLineEndingStyle(markdown);
        lineEnding = reading.style;
        if (reading.mixed) report({ ...MIXED_LINE_ENDINGS_DIAGNOSTIC });
    }

    adoptLineEnding(initialMarkdown);

    /** The Markdown the session holds, in the file's own line ending. */
    let currentMarkdown = initialMarkdown;
    /** The same content with `\n` line breaks: what is parsed and serialized. */
    let documentMarkdown = toLineFeeds(initialMarkdown);
    let currentEditable = editable;
    let destroyed = false;
    let failed = false;
    let offsetMap: SourceOffsetMap | null = null;
    /** Suppresses change callbacks while the host itself replaces content. */
    let applyingExternalReplace = false;
    let changePending = false;
    let emissionScheduled = false;
    /** Step maps of local transactions, in order, since `stepBase`. */
    let stepMaps: StepMap[] = [];
    /** Stream position of `stepMaps[0]`, so trimming never renumbers a checkpoint. */
    let stepBase = 0;
    /** Seeded once the editor exists; until then no pin can be mapped. */
    let checkpoints: PinCheckpoint[] = [];

    /**
     * The document and its Markdown, read together.
     *
     * A pin checkpoint is only usable when its Markdown is the serialization of
     * its document, so both come out of one action rather than two reads that a
     * transaction could land between.
     */
    function serializeCurrentDoc(): {
        markdown: string;
        doc: ProseMirrorNode;
    } | null {
        try {
            return editor.action((ctx) => {
                const serialize = ctx.get(serializerCtx);
                const doc = ctx.get(editorViewCtx).state.doc;
                return { markdown: serialize(doc), doc };
            });
        } catch {
            return null;
        }
    }

    /** Starts the pin history over at `markdown`, discarding what came before. */
    function resetPinHistory(markdown: string, doc: ProseMirrorNode): void {
        stepMaps = [];
        stepBase = 0;
        checkpoints = [
            {
                markdown,
                documentMarkdown: toLineFeeds(markdown),
                doc,
                stepIndex: 0,
            },
        ];
    }

    function recordCheckpoint(markdown: string, doc: ProseMirrorNode): void {
        checkpoints.push({
            markdown,
            documentMarkdown: toLineFeeds(markdown),
            doc,
            stepIndex: stepBase + stepMaps.length,
        });
        if (checkpoints.length <= PIN_CHECKPOINT_LIMIT) return;
        checkpoints = checkpoints.slice(-PIN_CHECKPOINT_LIMIT);
        const oldest = checkpoints[0].stepIndex;
        stepMaps = stepMaps.slice(oldest - stepBase);
        stepBase = oldest;
    }

    function emitPendingChange(): void {
        emissionScheduled = false;
        if (!changePending || destroyed) return;
        const serialized = serializeCurrentDoc();
        if (serialized === null) {
            // Leave `changePending` set: the surface still holds edits the
            // session has not seen, and clearing it would let the canonical
            // Markdown diverge from what the user sees.
            //
            // Every later attempt still runs. A document is usually
            // unserializable only in passing — mid-edit, between two
            // keystrokes — and latching the failure would discard every
            // keystroke after it, permanently and in silence, on the strength
            // of one transient error.
            if (!failed) {
                failed = true;
                report({
                    code: "editor_serialize_failed",
                    message: "the document could not be serialized to Markdown",
                });
            }
            return;
        }
        if (failed) {
            failed = false;
            report({
                code: "editor_serialize_recovered",
                message: "the document can be serialized again",
            });
        }
        changePending = false;
        const next = serialized.markdown;
        if (next === documentMarkdown) return;
        documentMarkdown = next;
        // The one place a line ending is written. The serializer's output holds
        // `\n` throughout, so this can never double a carriage return the
        // document was already carrying — the document never carries one.
        currentMarkdown = fromLineFeeds(next, lineEnding);
        offsetMap = null;
        recordCheckpoint(currentMarkdown, serialized.doc);
        onMarkdownChange(currentMarkdown);
    }

    function noteDocChanged(): void {
        if (applyingExternalReplace) return;
        changePending = true;
        offsetMap = null;
        if (emissionScheduled) return;
        emissionScheduled = true;
        scheduleChangeEmission(emitPendingChange);
    }

    // Draws the find matches. It holds no document state of its own — the match
    // list arrives as transaction metadata — so it cannot change what the
    // document is, only what it looks like.
    const findHighlighter = $prose(() => createFindHighlightPlugin());

    // The observer runs from the plugin's view, not from `state.apply`. By the
    // time `update` fires the new state is installed, so reading the selection
    // here reports where the caret actually is rather than where it was.
    const changeObserver = $prose(
        () =>
            new Plugin({
                key: new PluginKey("mdx-change-observer"),
                view: () => ({
                    update(view: EditorView, previous) {
                        if (!previous.doc.eq(view.state.doc)) {
                            noteDocChanged();
                            return;
                        }
                        if (
                            !previous.selection.eq(view.state.selection) &&
                            !applyingExternalReplace
                        ) {
                            onSelectionChange();
                        }
                    },
                }),
            }),
    );

    /**
     * Records the step maps of every local transaction, in the order they were
     * applied, so a pinned position can be carried across them later.
     *
     * `appendTransaction` is the hook that sees transactions after they have
     * been applied and exactly once each; it appends nothing of its own. The
     * change observer above cannot do this job — it runs from the view, which is
     * handed states, not the transactions that produced them.
     */
    const transactionObserver = $prose(
        () =>
            new Plugin({
                key: new PluginKey("mdx-transaction-observer"),
                appendTransaction(transactions) {
                    if (applyingExternalReplace) return null;
                    for (const transaction of transactions) {
                        if (!transaction.docChanged) continue;
                        stepMaps.push(...transaction.mapping.maps);
                    }
                    return null;
                },
            }),
    );

    const editor = Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            // The parser is handed `\n` line breaks, so nothing inside the
            // document — a preserved slice, a code block's content — ever holds
            // a carriage return.
            ctx.set(defaultValueCtx, documentMarkdown);
            ctx.update(editorViewOptionsCtx, (prev) => ({
                ...prev,
                editable: () => currentEditable,
                handleDOMEvents: {
                    ...prev.handleDOMEvents,
                    keydown(view, event) {
                        // WebKit can send the confirming Enter after
                        // compositionend. Its IME marker remains meaningful
                        // even after ProseMirror's composition grace period.
                        // Skip editor commands without cancelling IME commit.
                        if (
                            event.key === "Enter" &&
                            (event.isComposing || event.keyCode === 229)
                        ) return true;
                        return prev.handleDOMEvents?.keydown?.(view, event) ?? false;
                    },
                },
            }));
            // Every edit re-serializes the whole document, so the serializer's
            // defaults decide how much untouched text a single keystroke
            // rewrites. These pick the conventions ordinary Markdown files
            // already use, which keeps that rewriting to a minimum. Constructs
            // the serializer cannot express in their original form still
            // normalize; preserving those is the source-preservation layer's job.
            //
            // The `text` handler is left to the plugins: whichever syntax
            // family owns it by the time this runs already writes the text, and
            // how much of it is escaped is the escapes family's decision, taken
            // against the source the author wrote.
            ctx.update(remarkStringifyOptionsCtx, (prev) => ({
                ...prev,
                bullet: "-" as const,
                emphasis: "*" as const,
                strong: "*" as const,
                fences: true,
                listItemIndent: "one" as const,
            }));
            // `rule` deliberately keeps the serializer's `***`. Emitting `---`
            // would make a thematic break at the top of a document parse back
            // as a frontmatter delimiter on the next open.
        })
        .use(plugins)
        .use(changeObserver)
        .use(transactionObserver)
        .use(findHighlighter);

    await editor.create();

    function withView<T>(run: (view: EditorView) => T): T | null {
        if (destroyed) return null;
        try {
            return editor.action((ctx) => run(ctx.get(editorViewCtx)));
        } catch {
            return null;
        }
    }

    // The document the surface opened with, paired with the Markdown it was
    // built from: the first state a pin can be mapped forward from.
    {
        const seed = withView((view) => view.state.doc);
        if (seed) resetPinHistory(currentMarkdown, seed);
    }

    function buildOffsetMap(
        doc: ProseMirrorNode,
        markdown: string,
    ): SourceOffsetMap | null {
        if (destroyed) return null;
        try {
            return editor.action((ctx) =>
                createSourceOffsetMap({
                    doc,
                    markdown,
                    schema: ctx.get(schemaCtx),
                    remark: ctx.get(remarkCtx),
                }),
            );
        } catch {
            return null;
        }
    }

    function currentOffsetMap(): SourceOffsetMap | null {
        if (destroyed) return null;
        // Built against the `\n` text, which is what the parser reads and what
        // the document's own positions correspond to. Callers speak the
        // session's coordinate space and are translated at the edges.
        if (offsetMap && offsetMap.markdown === documentMarkdown) return offsetMap;
        const built = (() => {
            const doc = withView((view) => view.state.doc);
            if (!doc) return null;
            return buildOffsetMap(doc, documentMarkdown);
        })();
        if (!built) {
            report({
                code: "editor_offset_map_unavailable",
                message: "the markdown offset map could not be built",
            });
            return null;
        }
        offsetMap = built;
        if (built.failure) {
            report({
                code: "editor_offset_map_unavailable",
                message: `the markdown offset map is not usable: ${built.failure}`,
            });
        }
        return built;
    }

    /** Reports that a caller-visible position had no faithful counterpart. */
    function reportUnmapped(): void {
        report({
            code: "editor_position_unmapped",
            message: "no faithful mapping exists between this position and the markdown",
        });
    }

    /**
     * Places the selection, optionally scrolling to it, reporting whether the
     * range resolved to text.
     *
     * `keep-viewport` moves the caret and leaves the view where it is;
     * `bring-into-view` puts the target a comfortable way down the viewport,
     * which is what a jump the user asked for should look like.
     */
    function applySelection(
        range: DocumentSelectionRange,
        placement: "keep-viewport" | "bring-into-view",
    ): boolean {
        flush();
        const map = currentOffsetMap();
        if (!map) return false;
        const anchorOffset = toDocumentOffset(range.anchor);
        const headOffset = toDocumentOffset(range.head);
        if (anchorOffset === null || headOffset === null) {
            reportUnmapped();
            return false;
        }
        const anchor = map.positionForSourceOffset(anchorOffset);
        const head = map.positionForSourceOffset(headOffset);
        if (anchor === null || head === null) {
            reportUnmapped();
            return false;
        }
        const applied = withView((view) => {
            const { doc, tr } = view.state;
            // `TextSelection.create` warns rather than throws when handed a
            // position outside inline content, so the resolved positions are
            // checked here instead of relying on an exception.
            if (
                !doc.resolve(anchor).parent.inlineContent ||
                !doc.resolve(head).parent.inlineContent
            ) {
                return false;
            }
            view.dispatch(tr.setSelection(TextSelection.create(doc, anchor, head)));
            if (placement === "bring-into-view") {
                // Read after the dispatch, so the coordinates describe the
                // document as it now stands. ProseMirror throws for a position
                // it cannot place — mid-composition, or before the view has
                // laid out — and a jump that cannot be measured is one that
                // simply does not scroll, not one that fails.
                try {
                    scrollTargetIntoComfortableView(
                        findScrollableAncestor(view.dom),
                        view.coordsAtPos(anchor).top,
                    );
                } catch {
                    // Left where it is; the selection still moved.
                }
            }
            return true;
        });
        return applied === true;
    }

    /**
     * A session offset as an offset into the `\n` text the offset map is built
     * against, or null when it names no position there.
     *
     * On a CRLF document the two spaces differ by one unit per line break
     * before the offset, and an offset landing between a `\r` and its `\n`
     * names nothing at all. Both are the line-ending module's business; the
     * only thing added here is surrogate alignment, which has to happen in the
     * space the caller's offset came from.
     */
    function toDocumentOffset(sourceOffset: number): number | null {
        return toNormalizedOffset(
            currentMarkdown,
            alignOffsetToCharacterBoundary(currentMarkdown, sourceOffset),
        );
    }

    /** An offset into the `\n` text as an offset into what the session holds. */
    function toSessionOffset(documentOffset: number): number {
        return alignOffsetToCharacterBoundary(
            currentMarkdown,
            fromNormalizedOffset(currentMarkdown, documentOffset),
        );
    }

    function flush(): void {
        if (destroyed) return;
        emitPendingChange();
    }

    /**
     * Carries `position` through every step recorded since `from`.
     *
     * Steps are applied in turn rather than composed into one mapping, so a
     * position whose content an intervening edit removed is caught at the step
     * that removed it, instead of vanishing into a net effect that no longer
     * shows the deletion. `edge` says which side of the pinned range this
     * position is, so only the content the range actually covered is tracked: a
     * bare insertion point has no text to lose and is never refused.
     */
    function mapThroughSteps(
        from: number,
        position: number,
        assoc: number,
        edge: PinEdge,
    ): number | null {
        const start = from - stepBase;
        if (start < 0 || start > stepMaps.length) return null;
        let mapped = position;
        for (let index = start; index < stepMaps.length; index += 1) {
            const result = stepMaps[index].mapResult(mapped, assoc);
            if (edge === "start" && result.deletedAfter) return null;
            if (edge === "end" && result.deletedBefore) return null;
            mapped = result.pos;
        }
        return mapped;
    }

    /** The newest recorded state whose Markdown is `markdown`. */
    function checkpointFor(markdown: string): PinCheckpoint | null {
        for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
            if (checkpoints[index].markdown === markdown) {
                return checkpoints[index];
            }
        }
        return null;
    }

    return {
        getMarkdown() {
            flush();
            return currentMarkdown;
        },

        getSelection() {
            flush();
            const map = currentOffsetMap();
            if (!map) return null;
            const resolved = withView((view) => {
                const { anchor, head } = view.state.selection;
                return map.sourceRangeForSelection(anchor, head);
            });
            if (!resolved) {
                reportUnmapped();
                return null;
            }
            return {
                anchor: toSessionOffset(resolved.anchor),
                head: toSessionOffset(resolved.head),
            };
        },

        setSelection(range) {
            return applySelection(range, "keep-viewport");
        },

        revealRange(range) {
            return applySelection(range, "bring-into-view");
        },

        setFindHighlights(ranges, activeIndex) {
            // Not flushed first, unlike a selection change: this only paints,
            // so a pending keystroke is neither read nor disturbed by it. The
            // match list is about to be recomputed against that keystroke
            // anyway, which is what replaces these highlights.
            const map = currentOffsetMap();
            if (!map) return;
            const mapped: FindHighlightRange[] = [];
            for (const range of ranges) {
                const fromOffset = toDocumentOffset(range.anchor);
                const toOffset = toDocumentOffset(range.head);
                if (fromOffset === null || toOffset === null) continue;
                const from = map.positionForSourceOffset(fromOffset);
                const to = map.positionForSourceOffset(toOffset);
                // A match that has no faithful position is dropped silently:
                // this is decoration, and reporting a diagnostic per unmappable
                // match would turn a cosmetic gap into a stream of noise.
                if (from === null || to === null) continue;
                mapped.push({ from: Math.min(from, to), to: Math.max(from, to) });
            }
            withView((view) => {
                view.dispatch(
                    view.state.tr.setMeta(findHighlightKey, {
                        ranges: mapped,
                        activeIndex,
                    }),
                );
            });
        },

        replaceMarkdown(markdown) {
            if (destroyed) return false;
            // Hand any unemitted keystroke to the session before overwriting it,
            // so the edit is never lost without the session having seen it —
            // and so the no-op check below compares against what the surface
            // actually holds. Comparing against a stale value would skip the
            // replace and leave the local edit standing, which is exactly the
            // discard a clean reload is asking for.
            emitPendingChange();
            if (markdown === currentMarkdown) return true;
            const previousLineEnding = lineEnding;
            adoptLineEnding(markdown);
            applyingExternalReplace = true;
            try {
                // `flush` rebuilds the editor state, which clears history. An
                // external replace must not be undoable back to the content it
                // replaced, or a clean reload could be reverted and saved.
                editor.action(replaceAll(toLineFeeds(markdown), true));
                currentMarkdown = markdown;
                documentMarkdown = toLineFeeds(markdown);
                offsetMap = null;
                changePending = false;
                // An external replace is a new document state the session
                // declared, not an edit anything can be mapped across: a pin
                // taken before it describes text that is gone.
                const replaced = withView((view) => view.state.doc);
                if (replaced) resetPinHistory(markdown, replaced);
            } catch (error) {
                // `replaceAll` parses, so content this surface cannot build
                // throws here. Letting it escape tears down the whole editor
                // tree from inside a React effect, leaving no surface at all
                // and no way back to source.
                //
                // The surface still holds the content it had, so it still has
                // that content's line ending: adopting the refused document's
                // would rewrite every line of the kept one on its next edit.
                lineEnding = previousLineEnding;
                report({
                    code: "unsafe_visual_parse",
                    message:
                        error instanceof Error
                            ? error.message
                            : "the document could not be opened visually",
                });
                return false;
            } finally {
                applyingExternalReplace = false;
            }
            return true;
        },

        setEditable(nextEditable) {
            currentEditable = nextEditable;
            withView((view) => {
                view.updateState(view.state);
                return true;
            });
        },

        focus() {
            withView((view) => {
                view.focus();
                return true;
            });
        },

        replaceSourceRange(range, text) {
            // Drain first so the offset map is built against Markdown that
            // reflects every earlier edit.
            flush();
            const map = currentOffsetMap();
            if (!map || failed) return false;
            const from = toDocumentOffset(Math.min(range.anchor, range.head));
            const to = toDocumentOffset(Math.max(range.anchor, range.head));
            if (from === null || to === null) {
                reportUnmapped();
                return false;
            }
            const pmFrom = map.positionForSourceOffset(from);
            const pmTo = map.positionForSourceOffset(to);
            if (pmFrom === null || pmTo === null) {
                reportUnmapped();
                return false;
            }
            const applied = withView((view) => {
                const { doc } = view.state;
                if (
                    !doc.resolve(pmFrom).parent.inlineContent ||
                    !doc.resolve(pmTo).parent.inlineContent
                ) {
                    return false;
                }
                // Inserted text joins a document that holds `\n` throughout: a
                // carriage return let in here would survive every later
                // serialization and be written again on the way out.
                view.dispatch(
                    view.state.tr.insertText(toLineFeeds(text), pmFrom, pmTo),
                );
                return true;
            });
            return applied === true;
        },

        insertImage(range, image) {
            flush();
            const map = currentOffsetMap();
            if (!map || failed) return false;
            const from = toDocumentOffset(Math.min(range.anchor, range.head));
            const to = toDocumentOffset(Math.max(range.anchor, range.head));
            if (from === null || to === null) {
                reportUnmapped();
                return false;
            }
            const pmFrom = map.positionForSourceOffset(from);
            const pmTo = map.positionForSourceOffset(to);
            if (pmFrom === null || pmTo === null) {
                reportUnmapped();
                return false;
            }
            const applied = withView((view) => {
                const { doc, schema } = view.state;
                const type = schema.nodes.image;
                if (!type) return false;
                const parent = doc.resolve(pmFrom).parent;
                if (!parent.inlineContent) return false;
                if (!doc.resolve(pmTo).parent.inlineContent) return false;
                // A block whose content is plain text — a code fence, a math or
                // Mermaid block — cannot hold an image node. Writing one there
                // as text is what produced escaped literals in the first place,
                // so the insert is refused instead.
                if (parent.type.contentMatch.matchType(type) === null) {
                    return false;
                }
                view.dispatch(
                    view.state.tr.replaceWith(
                        pmFrom,
                        pmTo,
                        type.create({
                            src: image.src,
                            alt: image.alt ?? "",
                            title: image.title ?? "",
                        }),
                    ),
                );
                return true;
            });
            return applied === true;
        },

        findMatches(request) {
            if (destroyed) return [];
            flush();
            const map = currentOffsetMap();
            if (!map) return [];
            const doc = withView((view) => view.state.doc);
            if (!doc) return [];
            const { ranges, unplaced } = findSemanticMatches(doc, map, request);
            // A match the map cannot place is dropped, never reported at a
            // guessed offset — and the caller is told the result is short.
            if (unplaced) reportUnmapped();
            return ranges.map((range) => ({
                anchor: toSessionOffset(range.anchor),
                head: toSessionOffset(range.head),
            }));
        },

        mapPinnedRange(baseMarkdown, range) {
            if (destroyed) return null;
            flush();
            const checkpoint = checkpointFor(baseMarkdown);
            if (!checkpoint) return null;
            // Nothing has happened since the pin was taken, so it still names
            // what it named. Both halves matter: a transaction can leave the
            // Markdown unchanged and still move every position after it.
            const unchanged =
                baseMarkdown === currentMarkdown &&
                checkpoint.stepIndex === stepBase + stepMaps.length;
            if (unchanged) return { anchor: range.anchor, head: range.head };

            const base = buildOffsetMap(
                checkpoint.doc,
                checkpoint.documentMarkdown,
            );
            if (!base || base.failure) return null;
            // The pin's offsets are into the Markdown the session held at that
            // point, which is the checkpoint's own line ending.
            const anchorBase = toNormalizedOffset(baseMarkdown, range.anchor);
            const headBase = toNormalizedOffset(baseMarkdown, range.head);
            if (anchorBase === null || headBase === null) {
                reportUnmapped();
                return null;
            }
            const anchorPm = base.positionForSourceOffset(anchorBase);
            const headPm = base.positionForSourceOffset(headBase);
            if (anchorPm === null || headPm === null) {
                reportUnmapped();
                return null;
            }

            // A collapsed pin is an insertion point: it has no text to lose, so
            // it maps wherever the steps carry it, and text typed at that exact
            // spot lands after it rather than dragging it along — the pin names
            // where the caller pointed, not where the caret has got to. A pin
            // with a range must still cover its own text, so each edge tracks
            // the deletion of the content inside it.
            const collapsed = anchorPm === headPm;
            const forward = anchorPm < headPm;
            const anchor = mapThroughSteps(
                checkpoint.stepIndex,
                anchorPm,
                collapsed ? -1 : forward ? 1 : -1,
                collapsed ? "point" : forward ? "start" : "end",
            );
            const head = mapThroughSteps(
                checkpoint.stepIndex,
                headPm,
                collapsed ? -1 : forward ? -1 : 1,
                collapsed ? "point" : forward ? "end" : "start",
            );
            if (anchor === null || head === null) return null;
            // An edge that overtook the other no longer describes the pin.
            if (forward ? anchor > head : head > anchor) return null;

            const map = currentOffsetMap();
            if (!map) return null;
            const resolved = map.sourceRangeForSelection(anchor, head);
            if (!resolved) {
                reportUnmapped();
                return null;
            }
            return {
                anchor: toSessionOffset(resolved.anchor),
                head: toSessionOffset(resolved.head),
            };
        },

        undo() {
            if (destroyed) return false;
            flush();
            try {
                return editor.action(callCommand(undoCommand.key)) === true;
            } catch {
                return false;
            }
        },

        redo() {
            if (destroyed) return false;
            flush();
            try {
                return editor.action(callCommand(redoCommand.key)) === true;
            } catch {
                return false;
            }
        },

        flush,

        hasFailed() {
            return failed;
        },

        isDestroyed() {
            return destroyed;
        },

        async destroy() {
            if (destroyed) return;
            // Drain pending edits before the view goes away so a tab switch
            // never loses the last keystrokes.
            emitPendingChange();
            destroyed = true;
            offsetMap = null;
            await editor.destroy(true);
        },
    };
}
