import { ParserState } from "@milkdown/kit/transformer";
import type { MarkdownNode, RemarkParser } from "@milkdown/kit/transformer";
import type { Node as ProseMirrorNode, Schema } from "prosemirror-model";

import type { DocumentSelectionRange } from "./types";

/**
 * Which side of surrounding Markdown syntax a position binds to.
 *
 * A caret between `Plain ` and `*emphasis*` can honestly be reported as the
 * offset before the `*` or after it. Selection starts and collapsed carets bind
 * forward so they sit on the first character of the text that follows them;
 * selection ends bind backward so they sit just past the last selected
 * character.
 */
export type SourceOffsetAffinity = "forward" | "backward";

/** Why a whole map could not be built. */
export type SourceOffsetMapFailure = "parse_failed" | "document_mismatch";

/**
 * Maps between ProseMirror document positions and UTF-16 offsets into the
 * canonical Markdown. The map is derived state, rebuilt whenever the serialized
 * Markdown changes; it is never a second copy of the content.
 *
 * Offsets come from the Markdown parser, not from comparing strings. The
 * canonical Markdown is re-parsed with the editor's own pipeline while the
 * parser is instrumented, which records the mdast node behind every run of text
 * the document contains. Each mdast node carries its exact source span, so a
 * run's offsets are read out of the parse rather than guessed from a scan.
 *
 * Every query returns `null` rather than a plausible-looking number when the
 * answer is not known. A caller that writes at a returned offset can trust it.
 */
export interface SourceOffsetMap {
    /** Canonical Markdown this map was built against. */
    readonly markdown: string;
    /** Set when no part of the document could be mapped. */
    readonly failure: SourceOffsetMapFailure | null;
    /** Source offset for a ProseMirror position, or null when unmappable. */
    sourceOffsetForPosition(
        position: number,
        affinity?: SourceOffsetAffinity,
    ): number | null;
    /** ProseMirror position for a source offset, always inside a text block. */
    positionForSourceOffset(offset: number): number | null;
    sourceRangeForSelection(
        anchor: number,
        head: number,
    ): DocumentSelectionRange | null;
}

export interface SourceOffsetMapOptions {
    /** The live document the returned positions address. */
    doc: ProseMirrorNode;
    /** The serializer's own output for `doc`. */
    markdown: string;
    /** The editor's schema, used to re-parse `markdown` exactly as it was parsed. */
    schema: Schema;
    /** The editor's remark instance, carrying every plugin's syntax extensions. */
    remark: RemarkParser;
}

/**
 * A run of document text that came from one contiguous stretch of Markdown.
 *
 * `offsets` is null when the run is a verbatim copy of the source, which is the
 * common case; character `i` then sits at `srcFrom + i`. It is an explicit table
 * when the source spends more units than the text does, as escapes, character
 * references and block continuation markers do.
 */
interface SourceRun {
    pmFrom: number;
    length: number;
    srcFrom: number;
    srcTo: number;
    offsets: Int32Array | null;
    mapped: boolean;
}

/** A ProseMirror position whose exact source offset is known. */
interface SourceAnchor {
    pm: number;
    src: number;
}

interface TextEvent {
    text: string;
    srcFrom: number;
    srcTo: number;
    offsets: Int32Array | null;
    mapped: boolean;
}

interface NodeSpan {
    from: number;
    to: number;
}

interface MdastPosition {
    start?: { offset?: number | undefined } | undefined;
    end?: { offset?: number | undefined } | undefined;
}

const BACKSLASH = 0x5c;
const AMPERSAND = 0x26;
const SEMICOLON = 0x3b;
const NUMBER_SIGN = 0x23;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const GREATER_THAN = 0x3e;
/** Longest character reference remark will decode, plus its delimiters. */
const MAX_REFERENCE_LENGTH = 34;

function isAsciiPunctuation(code: number): boolean {
    return (
        (code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e)
    );
}

function isAlphanumeric(code: number): boolean {
    return (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a)
    );
}

/**
 * Source span of an mdast node.
 *
 * A transformer that merges raw source into one node can leave the span
 * covering only the piece it started from. When the node's own value is present
 * in the source at the span's start and runs past its end, the span is widened
 * to fit it — a correction the source itself proves, not one inferred.
 */
function spanOf(
    markdown: string,
    node: MarkdownNode | undefined,
): NodeSpan | null {
    const position = node?.position as MdastPosition | undefined;
    const from = position?.start?.offset;
    const to = position?.end?.offset;
    if (typeof from !== "number" || typeof to !== "number") return null;
    if (from > to) return null;
    const value = node?.value;
    if (
        typeof value === "string" &&
        from + value.length > to &&
        markdown.startsWith(value, from)
    ) {
        return { from, to: from + value.length };
    }
    return { from, to };
}

/**
 * End of the character reference starting at `start`, or 0 when there is none.
 */
function referenceEnd(
    markdown: string,
    start: number,
    limit: number,
): number {
    const max = Math.min(limit, start + MAX_REFERENCE_LENGTH);
    for (let index = start + 1; index < max; index += 1) {
        const code = markdown.charCodeAt(index);
        if (code === SEMICOLON) {
            return index > start + 1 ? index + 1 : 0;
        }
        if (!isAlphanumeric(code) && code !== NUMBER_SIGN) return 0;
    }
    return 0;
}

/**
 * How many UTF-16 units a character reference decodes to.
 *
 * Asks the editor's own parser rather than carrying an entity table, so the
 * answer is by construction the one the document was built from. Reference
 * tokens repeat, so the answers are memoized.
 */
function createReferenceLength(
    remark: RemarkParser,
): (token: string) => number {
    const cache = new Map<string, number>();
    return (token) => {
        const cached = cache.get(token);
        if (cached !== undefined) return cached;
        let length = 0;
        try {
            const root = remark.parse(token) as unknown as MarkdownNode;
            const paragraph = root.children?.[0];
            const text = paragraph?.children?.[0];
            const value = text?.type === "text" ? text.value : undefined;
            if (typeof value === "string" && value !== token) {
                length = value.length;
            }
        } catch {
            length = 0;
        }
        cache.set(token, length);
        return length;
    };
}

/**
 * Aligns `value` against `markdown[from, to)`, one source construct at a time.
 *
 * Only differences the Markdown parser itself introduces are consumed: a
 * backslash escape, a character reference, a CRLF that the parser reports as a
 * newline, and the `>` or indentation a container repeats at the head of a
 * continuation line. Anything else fails the alignment outright, so a run whose
 * source cannot be accounted for is reported as unmappable rather than guessed
 * at.
 */
function alignValue(
    markdown: string,
    from: number,
    to: number,
    value: string,
    referenceLength: (token: string) => number,
): Int32Array | null {
    const offsets = new Int32Array(value.length + 1);
    let index = 0;
    let cursor = from;
    let atLineStart = from === 0 || markdown.charCodeAt(from - 1) === LINE_FEED;

    while (index < value.length) {
        if (cursor >= to) return null;
        const source = markdown.charCodeAt(cursor);
        const wanted = value.charCodeAt(index);

        // `&amp;` starts with the same character it decodes to. Consume the
        // reference as a unit before accepting that first ampersand literally.
        const reference = source === AMPERSAND ? referenceEnd(markdown, cursor, to) : 0;
        const referenceUnits = reference > 0 ? referenceLength(markdown.slice(cursor, reference)) : 0;
        if (referenceUnits > 0 && index + referenceUnits <= value.length) {
            for (let unit = 0; unit < referenceUnits; unit += 1) offsets[index + unit] = cursor;
            index += referenceUnits;
            cursor = reference;
            atLineStart = false;
            continue;
        }
        if (source === wanted) {
            offsets[index] = cursor;
            index += 1;
            cursor += 1;
            atLineStart = source === LINE_FEED;
            continue;
        }
        if (
            source === BACKSLASH &&
            cursor + 1 < to &&
            markdown.charCodeAt(cursor + 1) === wanted &&
            isAsciiPunctuation(wanted)
        ) {
            offsets[index] = cursor;
            index += 1;
            cursor += 2;
            atLineStart = false;
            continue;
        }
        if (source === CARRIAGE_RETURN && wanted === LINE_FEED) {
            offsets[index] = cursor;
            index += 1;
            cursor += markdown.charCodeAt(cursor + 1) === LINE_FEED ? 2 : 1;
            atLineStart = true;
            continue;
        }
        if (
            atLineStart &&
            (source === SPACE || source === TAB || source === GREATER_THAN)
        ) {
            cursor += 1;
            continue;
        }
        return null;
    }

    offsets[value.length] = cursor;
    return offsets;
}

/** Skips one line ending plus the container prefix that follows it. */
function skipLineBreak(markdown: string, from: number, to: number): number {
    let cursor = from;
    while (cursor < to) {
        const code = markdown.charCodeAt(cursor);
        if (code === SPACE || code === TAB) {
            cursor += 1;
            continue;
        }
        break;
    }
    if (cursor < to && markdown.charCodeAt(cursor) === CARRIAGE_RETURN) {
        cursor += 1;
    } else if (cursor >= to || markdown.charCodeAt(cursor) !== LINE_FEED) {
        return from;
    }
    if (cursor < to && markdown.charCodeAt(cursor) === LINE_FEED) cursor += 1;
    while (cursor < to) {
        const code = markdown.charCodeAt(cursor);
        if (code === SPACE || code === TAB || code === GREATER_THAN) {
            cursor += 1;
            continue;
        }
        break;
    }
    return cursor;
}

interface ResolvedRun {
    srcFrom: number;
    srcTo: number;
    offsets: Int32Array | null;
}

/**
 * The value fills its node's span exactly, so it is a verbatim copy of it.
 */
function resolveByFill(
    markdown: string,
    span: NodeSpan,
    value: string,
): ResolvedRun | null {
    if (span.to - span.from !== value.length) return null;
    if (markdown.slice(span.from, span.to) !== value) return null;
    return { srcFrom: span.from, srcTo: span.to, offsets: null };
}

/**
 * The value occupies whole lines between the first and last line of its span.
 *
 * This is the shape of every fenced construct — code fences, math blocks,
 * frontmatter — whose payload starts on the line after the opening delimiter
 * and ends on the line before the closing one. Both delimiters are recomputed
 * from the span rather than assumed, so a fence whose payload happens to repeat
 * the delimiter still lands on the payload.
 */
function resolveByLine(
    markdown: string,
    span: NodeSpan,
    value: string,
): ResolvedRun | null {
    const firstBreak = markdown.indexOf("\n", span.from);
    if (firstBreak === -1 || firstBreak >= span.to) return null;
    const start = firstBreak + 1;
    const stop = start + value.length;
    if (stop >= span.to) return null;
    if (!markdown.startsWith(value, start)) return null;
    if (markdown.charCodeAt(stop) !== LINE_FEED) return null;
    const nextBreak = markdown.indexOf("\n", stop + 1);
    if (nextBreak !== -1 && nextBreak < span.to) return null;
    return { srcFrom: start, srcTo: stop, offsets: null };
}

/** The value is a verbatim substring of the window, found at or after `from`. */
function resolveBySearch(
    markdown: string,
    from: number,
    to: number,
    value: string,
): ResolvedRun | null {
    const at = markdown.indexOf(value, from);
    if (at === -1 || at + value.length > to) return null;
    return { srcFrom: at, srcTo: at + value.length, offsets: null };
}

function resolveByAlignment(
    markdown: string,
    from: number,
    to: number,
    value: string,
    referenceLength: (token: string) => number,
): ResolvedRun | null {
    const offsets = alignValue(markdown, from, to, value, referenceLength);
    if (!offsets) return null;
    return {
        srcFrom: offsets[0],
        srcTo: offsets[value.length],
        offsets,
    };
}

/**
 * Locates one run of text in the canonical Markdown.
 *
 * `span` is the run's own mdast span when it has one. Transformers that split a
 * text node — Milkdown's line-break splitter, the wikilink and callout
 * rewriters — produce fragments with no span of their own, so those fall back to
 * the innermost enclosing span and are located inside it.
 */
function resolveRun(
    markdown: string,
    value: string,
    span: NodeSpan | null,
    bound: NodeSpan | null,
    cursor: number,
    referenceLength: (token: string) => number,
): ResolvedRun | null {
    if (span && span.from >= cursor) {
        const filled = resolveByFill(markdown, span, value);
        if (filled) return filled;
        const lined = resolveByLine(markdown, span, value);
        if (lined) return lined;
        const aligned = resolveByAlignment(
            markdown,
            span.from,
            span.to,
            value,
            referenceLength,
        );
        if (aligned) return aligned;
    }

    const window = span ?? bound;
    const from = Math.max(cursor, window ? window.from : 0);
    const to = window ? window.to : markdown.length;
    if (from > to) return null;

    const found = resolveBySearch(markdown, from, to, value);
    if (found) return found;
    const aligned = resolveByAlignment(
        markdown,
        from,
        to,
        value,
        referenceLength,
    );
    if (aligned) return aligned;
    const afterBreak = skipLineBreak(markdown, from, to);
    if (afterBreak === from) return null;
    return resolveByAlignment(markdown, afterBreak, to, value, referenceLength);
}

interface InstrumentedParse {
    doc: ProseMirrorNode;
    events: TextEvent[];
    spans: Map<ProseMirrorNode, NodeSpan>;
    /** Spans of the marks the parse applied, in no particular order. */
    markSpans: NodeSpan[];
    /**
     * Spans a text run had to be located inside because the node that produced
     * it carries no span of its own. Whatever they hold beyond their runs is
     * syntax the transform consumed.
     */
    boundSpans: NodeSpan[];
}

/**
 * Re-parses `markdown` with the editor's own parser, recording where every run
 * of text and every structural node came from.
 *
 * The parser is driven through `ParserState` directly so that `next`, `addText`,
 * `addNode` and `closeNode` can be observed. `next` is what walks the mdast
 * tree, so wrapping it keeps an exact stack of the mdast nodes being converted;
 * every text the schema's runners emit is therefore attributed to the node that
 * produced it, whatever node types the active plugins contribute.
 */
function instrumentedParse(
    markdown: string,
    schema: Schema,
    remark: RemarkParser,
    referenceLength: (token: string) => number,
): InstrumentedParse | null {
    let tree: MarkdownNode;
    try {
        tree = remark.runSync(remark.parse(markdown), markdown) as MarkdownNode;
    } catch {
        return null;
    }

    const state = new ParserState(schema);
    const runNext = state.next;
    const runAddText = state.addText;
    const runAddNode = state.addNode;
    const runCloseNode = state.closeNode;

    const runOpenMark = state.openMark;

    const stack: MarkdownNode[] = [];
    const events: TextEvent[] = [];
    const spans = new Map<ProseMirrorNode, NodeSpan>();
    const markSpans: NodeSpan[] = [];
    const boundSpans: NodeSpan[] = [];
    let cursor = 0;

    /**
     * Innermost ancestor span, and whether it is narrower than the whole tree.
     *
     * The root's span covers the document, so it bounds nothing useful and must
     * not be mistaken for a construct that owns its own syntax.
     */
    function enclosingSpan(): { span: NodeSpan; nested: boolean } | null {
        for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
            const span = spanOf(markdown, stack[depth]);
            if (span) return { span, nested: depth > 0 };
        }
        return null;
    }

    function captureCreatedNode(): void {
        const span = spanOf(markdown, stack[stack.length - 1]);
        if (!span) return;
        const created = state.top()?.content.at(-1);
        if (!created || created.isText) return;
        if (spans.has(created)) return;
        spans.set(created, span);
    }

    state.next = ((nodes?: MarkdownNode | MarkdownNode[]) => {
        const list = nodes === undefined ? [] : [nodes].flat();
        for (const node of list) {
            stack.push(node);
            runNext(node);
            stack.pop();
        }
        return state;
    }) as typeof state.next;

    state.addText = ((text: string) => {
        if (text.length === 0) return state;
        const node = stack[stack.length - 1];
        const own = spanOf(markdown, node);
        const enclosing = own ? null : enclosingSpan();
        if (enclosing?.nested) boundSpans.push(enclosing.span);
        const resolved = resolveRun(
            markdown,
            text,
            own,
            enclosing?.span ?? null,
            cursor,
            referenceLength,
        );
        if (resolved) {
            cursor = resolved.srcTo;
            events.push({
                text,
                srcFrom: resolved.srcFrom,
                srcTo: resolved.srcTo,
                offsets: resolved.offsets,
                mapped: true,
            });
        } else {
            events.push({
                text,
                srcFrom: cursor,
                srcTo: cursor,
                offsets: null,
                mapped: false,
            });
        }
        return runAddText(text);
    }) as typeof state.addText;

    state.addNode = ((...args: Parameters<typeof state.addNode>) => {
        const result = runAddNode(...args);
        captureCreatedNode();
        return result;
    }) as typeof state.addNode;

    state.closeNode = (() => {
        const result = runCloseNode();
        captureCreatedNode();
        return result;
    }) as typeof state.closeNode;

    state.openMark = ((...args: Parameters<typeof state.openMark>) => {
        const span = spanOf(markdown, stack[stack.length - 1]);
        if (span) markSpans.push(span);
        return runOpenMark(...args);
    }) as typeof state.openMark;

    try {
        state.next(tree);
        return { doc: state.toDoc(), events, spans, markSpans, boundSpans };
    } catch {
        return null;
    }
}

interface DocumentTextRun {
    pmFrom: number;
    text: string;
}

function collectDocumentRuns(doc: ProseMirrorNode): DocumentTextRun[] {
    const runs: DocumentTextRun[] = [];
    doc.descendants((node, pos) => {
        if (!node.isText) return true;
        const text = node.text ?? "";
        if (text.length > 0) runs.push({ pmFrom: pos, text });
        return false;
    });
    return runs;
}

function sameDocumentRuns(
    left: DocumentTextRun[],
    right: DocumentTextRun[],
): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index].pmFrom !== right[index].pmFrom) return false;
        if (left[index].text !== right[index].text) return false;
    }
    return true;
}

/** The position ranges in `doc` a text selection can occupy, in order. */
function collectInlineRanges(doc: ProseMirrorNode): NodeSpan[] {
    const ranges: NodeSpan[] = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        ranges.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
        return false;
    });
    if (ranges.length === 0) ranges.push({ from: 0, to: doc.content.size });
    return ranges;
}

/**
 * Moves `position` onto the nearest position a text selection can occupy,
 * preferring the next text block so an offset that falls between blocks lands
 * at the start of the block it precedes.
 */
function snapToInlineRange(ranges: NodeSpan[], position: number): number {
    const index = lastIndexAtOrBefore(ranges, position, (range) => range.from);
    if (index < 0) return ranges[0].from;
    const range = ranges[index];
    if (position <= range.to) return position;
    const next = ranges[index + 1];
    return next ? next.from : range.to;
}

function eventOffsetAt(event: TextEvent, index: number): number {
    return event.offsets ? event.offsets[index] : event.srcFrom + index;
}

function buildRuns(
    documentRuns: DocumentTextRun[],
    events: TextEvent[],
): SourceRun[] {
    const runs: SourceRun[] = [];
    let eventIndex = 0;
    let consumedInEvent = 0;

    for (const documentRun of documentRuns) {
        let consumed = 0;
        while (consumed < documentRun.text.length) {
            const event = events[eventIndex];
            if (!event) return runs;
            const take = Math.min(
                event.text.length - consumedInEvent,
                documentRun.text.length - consumed,
            );
            runs.push({
                pmFrom: documentRun.pmFrom + consumed,
                length: take,
                srcFrom: eventOffsetAt(event, consumedInEvent),
                srcTo: eventOffsetAt(event, consumedInEvent + take),
                offsets: event.offsets
                    ? event.offsets.slice(
                          consumedInEvent,
                          consumedInEvent + take + 1,
                      )
                    : null,
                mapped: event.mapped,
            });
            consumed += take;
            consumedInEvent += take;
            if (consumedInEvent === event.text.length) {
                eventIndex += 1;
                consumedInEvent = 0;
            }
        }
    }
    return runs;
}

function buildAnchors(
    reparsed: ProseMirrorNode,
    spans: Map<ProseMirrorNode, NodeSpan>,
    runs: SourceRun[],
): SourceAnchor[] {
    const anchors: SourceAnchor[] = [];
    reparsed.descendants((node, pos) => {
        if (node.isText) return false;
        const span = spans.get(node);
        if (!span) return true;
        if (node.isLeaf) {
            anchors.push({ pm: pos, src: span.from });
            anchors.push({ pm: pos + node.nodeSize, src: span.to });
        } else {
            anchors.push({ pm: pos + 1, src: span.from });
            anchors.push({ pm: pos + node.nodeSize - 1, src: span.to });
        }
        return true;
    });
    for (const run of runs) {
        if (!run.mapped) continue;
        anchors.push({ pm: run.pmFrom, src: run.srcFrom });
        anchors.push({ pm: run.pmFrom + run.length, src: run.srcTo });
    }
    anchors.sort((a, b) => (a.pm - b.pm) || (a.src - b.src));

    // Nested spans can only ever agree, so an anchor that would walk the source
    // backwards describes a correspondence this map cannot represent; dropping
    // it keeps both coordinate orders intact instead of inventing one.
    const monotonic: SourceAnchor[] = [];
    let highest = -1;
    for (const anchor of anchors) {
        if (anchor.src < highest) continue;
        highest = anchor.src;
        monotonic.push(anchor);
    }
    return monotonic;
}

/**
 * Source regions the document holds as something other than editable text.
 *
 * A link's destination, an image's URL and alt text, a fence's info string, an
 * opaque HTML block's markup: the parse keeps these in node attributes, so no
 * document position stands for any character strictly inside them. The regions
 * are collected from the nodes that own that source — inline atoms, marks, and
 * text blocks — and merged, so an offset inside one can be refused rather than
 * silently resolved to whatever text sits nearest.
 *
 * Only the interior is opaque. Both edges stay addressable, so an offset at the
 * start of a heading or a fenced block still names the block. A text block that
 * holds no text at all is never opaque: it is exactly where a caret belongs.
 */
function buildOpaqueRegions(
    parsed: InstrumentedParse,
    mappedRuns: SourceRun[],
): NodeSpan[] {
    const interiors: NodeSpan[] = [];
    const add = (span: NodeSpan): void => {
        if (span.to - span.from > 2) {
            interiors.push({ from: span.from + 1, to: span.to - 1 });
        }
    };
    const holdsText = (span: NodeSpan): boolean => {
        const index = firstIndexAtOrAfter(
            mappedRuns,
            span.from,
            (run) => run.srcFrom,
        );
        const run = mappedRuns[index];
        return run !== undefined && run.srcFrom < span.to;
    };
    parsed.doc.descendants((node) => {
        if (node.isText) return false;
        const span = parsed.spans.get(node);
        if (!span) return true;
        if (node.isLeaf || (node.isTextblock && holdsText(span))) add(span);
        return true;
    });
    for (const span of parsed.markSpans) add(span);
    for (const span of parsed.boundSpans) add(span);

    interiors.sort((a, b) => a.from - b.from);
    const merged: NodeSpan[] = [];
    for (const interior of interiors) {
        const last = merged[merged.length - 1];
        if (last && interior.from <= last.to) {
            last.to = Math.max(last.to, interior.to);
            continue;
        }
        merged.push({ ...interior });
    }
    return merged;
}

function lastIndexAtOrBefore<T>(
    items: T[],
    value: number,
    key: (item: T) => number,
): number {
    let low = 0;
    let high = items.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (key(items[middle]) <= value) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

function firstIndexAtOrAfter<T>(
    items: T[],
    value: number,
    key: (item: T) => number,
): number {
    let low = 0;
    let high = items.length - 1;
    let found = items.length;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (key(items[middle]) >= value) {
            found = middle;
            high = middle - 1;
        } else {
            low = middle + 1;
        }
    }
    return found;
}

function runOffsetAt(run: SourceRun, index: number): number {
    return run.offsets ? run.offsets[index] : run.srcFrom + index;
}

function runIndexAt(run: SourceRun, offset: number): number {
    if (!run.offsets) {
        return Math.min(Math.max(offset - run.srcFrom, 0), run.length);
    }
    let low = 0;
    let high = run.length;
    let found = 0;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (run.offsets[middle] <= offset) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

function unusableMap(
    markdown: string,
    failure: SourceOffsetMapFailure,
): SourceOffsetMap {
    return {
        markdown,
        failure,
        sourceOffsetForPosition: () => null,
        positionForSourceOffset: () => null,
        sourceRangeForSelection: () => null,
    };
}

export function createSourceOffsetMap(
    options: SourceOffsetMapOptions,
): SourceOffsetMap {
    const { doc, markdown, schema, remark } = options;

    const referenceLength = createReferenceLength(remark);
    const parsed = instrumentedParse(markdown, schema, remark, referenceLength);
    if (!parsed) return unusableMap(markdown, "parse_failed");
    return buildMap(parsed, doc, markdown);
}

/**
 * The document `markdown` builds, with the map that puts it back.
 *
 * Same machinery as {@link createSourceOffsetMap}, one parse instead of two:
 * the instrumented parse already produces a document, so a caller that has only
 * Markdown does not need to obtain one separately — and must not, because the
 * only other way to parse is a shared parser whose state does not survive an
 * input that exhausts the stack. `null` when the Markdown builds no document.
 */
export function readMarkdownDocument(options: {
    markdown: string;
    schema: Schema;
    remark: RemarkParser;
}): { doc: ProseMirrorNode; map: SourceOffsetMap } | null {
    const { markdown, schema, remark } = options;
    const referenceLength = createReferenceLength(remark);
    const parsed = instrumentedParse(markdown, schema, remark, referenceLength);
    if (!parsed) return null;
    const map = buildMap(parsed, parsed.doc, markdown);
    return map.failure ? null : { doc: parsed.doc, map };
}

function buildMap(
    parsed: InstrumentedParse,
    doc: ProseMirrorNode,
    markdown: string,
): SourceOffsetMap {
    const documentRuns = collectDocumentRuns(doc);
    const reparsedRuns = collectDocumentRuns(parsed.doc);
    if (!sameDocumentRuns(documentRuns, reparsedRuns)) {
        // The Markdown does not parse back to the document it was serialized
        // from, so no offset in it can be trusted to name a document position.
        return unusableMap(markdown, "document_mismatch");
    }
    const emitted = parsed.events.map((event) => event.text).join("");
    if (emitted !== documentRuns.map((run) => run.text).join("")) {
        return unusableMap(markdown, "document_mismatch");
    }

    const runs = buildRuns(documentRuns, parsed.events);
    const mappedRuns = runs.filter((run) => run.mapped);
    const anchors = buildAnchors(parsed.doc, parsed.spans, runs);
    const opaque = buildOpaqueRegions(parsed, mappedRuns);
    const inlineRanges = collectInlineRanges(doc);
    const lastInline = inlineRanges[inlineRanges.length - 1].to;
    const docEnd = doc.content.size;

    function sourceOffsetForPosition(
        rawPosition: number,
        affinity: SourceOffsetAffinity = "forward",
    ): number | null {
        if (!Number.isFinite(rawPosition)) return null;
        const position = Math.min(
            Math.max(Math.trunc(rawPosition), 0),
            docEnd,
        );

        const index = lastIndexAtOrBefore(runs, position, (run) => run.pmFrom);
        let starting: SourceRun | null = null;
        let ending: SourceRun | null = null;
        let containing: SourceRun | null = null;
        if (index >= 0) {
            const run = runs[index];
            if (run.pmFrom === position) {
                starting = run;
                const previous = index > 0 ? runs[index - 1] : null;
                if (previous && previous.pmFrom + previous.length === position) {
                    ending = previous;
                }
            } else if (position < run.pmFrom + run.length) {
                containing = run;
            } else if (position === run.pmFrom + run.length) {
                ending = run;
            }
        }

        if (containing) {
            if (!containing.mapped) return null;
            return runOffsetAt(containing, position - containing.pmFrom);
        }
        const ordered =
            affinity === "backward"
                ? [ending, starting]
                : [starting, ending];
        for (const run of ordered) {
            if (!run) continue;
            if (!run.mapped) return null;
            return run === starting
                ? runOffsetAt(run, 0)
                : runOffsetAt(run, run.length);
        }

        // A position no run touches: an empty block, or the space beside an
        // inline node. Its offset comes from the innermost node whose span the
        // parse recorded; past every recorded span it is the end of the source.
        if (anchors.length === 0) return markdown.length;
        if (position > anchors[anchors.length - 1].pm) return markdown.length;
        const anchorIndex = lastIndexAtOrBefore(
            anchors,
            position,
            (anchor) => anchor.pm,
        );
        return anchorIndex < 0 ? 0 : anchors[anchorIndex].src;
    }

    function positionForSourceOffset(rawOffset: number): number | null {
        if (!Number.isFinite(rawOffset)) return null;
        const offset = alignOffsetToCharacterBoundary(markdown, rawOffset);

        const index = lastIndexAtOrBefore(
            mappedRuns,
            offset,
            (run) => run.srcFrom,
        );
        if (index >= 0) {
            const run = mappedRuns[index];
            if (offset <= run.srcTo) {
                return run.pmFrom + runIndexAt(run, offset);
            }
        }

        // No run covers the offset, so it names markup. Markup the document
        // stores as attributes has no position at all; the caller is told so
        // rather than handed the nearest text.
        const opaqueIndex = lastIndexAtOrBefore(
            opaque,
            offset,
            (region) => region.from,
        );
        if (opaqueIndex >= 0 && offset <= opaque[opaqueIndex].to) return null;

        // Structural markup binds to the first recorded position at or after
        // it, so an offset on a blank line lands at the start of the block that
        // follows rather than at the end of the one before.
        if (anchors.length === 0) return lastInline;
        const following =
            anchors[firstIndexAtOrAfter(anchors, offset, (anchor) => anchor.src)];
        const position = following ? following.pm : lastInline;
        const snapped = snapToInlineRange(inlineRanges, position);

        // Refuse a position that lands in text whose source could not be
        // established, rather than report the nearest thing that could.
        const runIndex = lastIndexAtOrBefore(
            runs,
            snapped,
            (run) => run.pmFrom,
        );
        const run = runIndex < 0 ? null : runs[runIndex];
        if (run && !run.mapped && snapped < run.pmFrom + run.length) return null;
        return snapped;
    }

    function sourceRangeForSelection(
        anchorPosition: number,
        headPosition: number,
    ): DocumentSelectionRange | null {
        if (anchorPosition === headPosition) {
            const offset = sourceOffsetForPosition(anchorPosition, "forward");
            return offset === null ? null : { anchor: offset, head: offset };
        }
        // The leading edge binds forward onto its first character; the trailing
        // edge binds backward onto the character it follows.
        const forwardFirst = anchorPosition < headPosition;
        const anchor = sourceOffsetForPosition(
            anchorPosition,
            forwardFirst ? "forward" : "backward",
        );
        const head = sourceOffsetForPosition(
            headPosition,
            forwardFirst ? "backward" : "forward",
        );
        if (anchor === null || head === null) return null;
        return { anchor, head };
    }

    return {
        markdown,
        failure: null,
        sourceOffsetForPosition,
        positionForSourceOffset,
        sourceRangeForSelection,
    };
}

/** True when `offset` would split a surrogate pair in `markdown`. */
export function splitsSurrogatePair(markdown: string, offset: number): boolean {
    if (offset <= 0 || offset >= markdown.length) return false;
    const before = markdown.charCodeAt(offset - 1);
    const after = markdown.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Moves `offset` off a surrogate-pair boundary, preferring the pair's start. */
export function alignOffsetToCharacterBoundary(
    markdown: string,
    offset: number,
): number {
    const clamped = Math.min(Math.max(Math.trunc(offset), 0), markdown.length);
    return splitsSurrogatePair(markdown, clamped) ? clamped - 1 : clamped;
}

export function isValidSourceRange(
    markdown: string,
    range: DocumentSelectionRange,
): boolean {
    const { anchor, head } = range;
    if (!Number.isInteger(anchor) || !Number.isInteger(head)) return false;
    if (anchor < 0 || head < 0) return false;
    if (anchor > markdown.length || head > markdown.length) return false;
    return true;
}
