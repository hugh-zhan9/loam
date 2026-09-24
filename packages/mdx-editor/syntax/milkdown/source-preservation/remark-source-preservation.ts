import type { RemarkPluginRaw } from "@milkdown/kit/transformer";

/**
 * Structural view of an mdast node, narrower than remark's own unions, which
 * cannot describe node types they do not know about.
 */
export interface MdastNode {
    type: string;
    value?: unknown;
    /** A fenced code block's info string beyond its language. */
    meta?: unknown;
    /** Milkdown marks soft line breaks introduced by its remark transformer. */
    data?: { isInline?: boolean };
    children?: MdastNode[];
    position?: {
        start: { line: number; column: number; offset?: number | undefined };
        end: { line: number; column: number; offset?: number | undefined };
    };
}

/** mdast types this layer produces and writes back verbatim. */
export const HTML_SOURCE_MDAST = "mdxHtmlSource";
export const HTML_SOURCE_INLINE_MDAST = "mdxHtmlSourceInline";
export const SOURCE_FALLBACK_MDAST = "mdxSourceFallback";
export const SOURCE_FALLBACK_INLINE_MDAST = "mdxSourceFallbackInline";

/** Syntax families the fallback node can stand in for. */
export type SourceFallbackKind =
    | "unclosed_fence"
    | "fence_meta"
    | "directive"
    | "inline_extension"
    | "reference_definition"
    | "reference_link";

export interface PreservedMdastNode extends MdastNode {
    value: string;
    kind?: SourceFallbackKind;
}

/**
 * Every preserved slice is stored with `\n` line endings, like the rest of the
 * document.
 *
 * The host hands the parser text that already holds `\n` throughout, so this is
 * normally a no-op; it is what makes the promise hold for any caller. A slice
 * that kept a raw `\r\n` would be written twice on a CRLF file — once by the
 * slice and once by the single translation the host applies to the serializer's
 * whole output — which is how an earlier attempt grew a carriage return inside
 * fenced code on every keystroke.
 */
function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, "\n");
}

/**
 * Builds a matcher for the container decoration a node's continuation lines
 * carry, given the text preceding the node on its own first line.
 *
 * Inside a blockquote or a list item, `source.slice()` returns the `> ` markers
 * and indentation that belong to the container, not to the node. Storing them
 * makes the serializer write them a second time when it re-wraps the node, so
 * `> :::note\n> body` comes back as `> :::note\n> > body`. Blockquote markers
 * are matched literally; every other column is matched as optional whitespace,
 * which is what list indentation and lazy continuation lines actually carry.
 */
function containerPrefixMatcher(prefix: string): RegExp | null {
    if (prefix.length === 0) return null;
    let pattern = "";
    for (const character of prefix) {
        pattern += character === ">" ? ">" : "[ \\t]?";
    }
    return new RegExp(`^${pattern}`);
}

/** Raw source for a node, or `null` when remark did not record its position. */
function rawSlice(node: MdastNode, source: string): string | null {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;

    // Trailing blank lines belong to the block separator the serializer writes,
    // not to the slice; keeping them would double up on the way out.
    const raw = normalizeLineEndings(source.slice(start, end)).replace(
        /\n+$/,
        "",
    );

    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const matcher = containerPrefixMatcher(source.slice(lineStart, start));
    if (matcher === null) return raw;

    // The first line of the slice begins at the node, so it carries no prefix.
    const lines = raw.split("\n");
    return lines
        .map((line, index) => (index === 0 ? line : line.replace(matcher, "")))
        .join("\n");
}

/**
 * Fence markers a block may open with: CommonMark's two code fences and the
 * math family's `$$`.
 */
const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,}|\${2,})/;

/** The marker character as a regular expression atom. */
function fenceAtom(marker: string): string {
    return marker === "$" ? "\\$" : marker;
}

/**
 * The raw source of a fenced block that never closes, or `null`.
 *
 * An unclosed fence runs to the end of the file, and CommonMark says so: the
 * block simply ends where the document does. Whichever family claimed it —
 * `code`, a Mermaid diagram, a math block — writes it back out with a closing
 * fence the author never typed, and, for a fence whose content is itself
 * Markdown, with the rest of the file now inside it. So this is asked of every
 * block, not only of the ones commonmark left as `code`.
 */
function unclosedFenceSource(node: MdastNode, source: string): string | null {
    const raw = rawSlice(node, source);
    if (raw === null) return null;
    const lines = raw.split("\n");
    const opening = FENCE_OPENING.exec(lines[0] ?? "");
    // No opening fence means an indented code block, which always closes.
    if (!opening) return null;
    const fence = opening[1];
    const marker = fenceAtom(fence[0]);
    const closing = new RegExp(`^ {0,3}${marker}{${fence.length},}[ \\t]*$`);
    for (let index = 1; index < lines.length; index += 1) {
        if (closing.test(lines[index])) return null;
    }
    return raw;
}

/**
 * The raw source of a fenced code block whose info string carries more than a
 * language, or `null`.
 *
 * The code block node has one attribute for the whole info string, so ` ```js
 * title=x ` comes back as ` ```js `, and no family below claims the difference:
 * Mermaid declines such a fence precisely because it has nowhere to keep it.
 */
function metaFenceSource(node: MdastNode, source: string): string | null {
    if (node.type !== "code") return null;
    const meta = node.meta;
    if (typeof meta !== "string" || meta.length === 0) return null;
    return rawSlice(node, source);
}

/**
 * The raw source of a paragraph that is really an unknown container directive.
 *
 * `:::name … :::` has no CommonMark meaning, so remark reads it as a paragraph
 * of text. Round-tripping it as text is not safe: the body would be re-read as
 * Markdown on the next open, and any `[`, `*` or `_` in it would come back
 * escaped.
 */
function directiveSource(node: MdastNode, source: string): string | null {
    const raw = rawSlice(node, source);
    if (raw === null || !/^:{3,}/.test(raw)) return null;
    return raw;
}

/**
 * The raw HTML of a paragraph containing only HTML and separating whitespace.
 *
 * CommonMark splits standalone inline tags such as `<a id="x"></a>` into
 * siblings. Preview them together, just like a wrapped block-level HTML node,
 * rather than exposing a separate source control for each tag. Paragraphs
 * containing Markdown prose keep their inline structure.
 */
function blockHtmlSource(node: MdastNode, source: string): string | null {
    const children = node.children;
    if (!children || children.length === 0) return null;
    if (children.length > 1) {
        const onlyHtml = children.every(
            (child) =>
                (child.type === "html" && typeof child.value === "string") ||
                (child.type === "text" &&
                    typeof child.value === "string" &&
                    /^[\t\n\r ]*$/.test(child.value)) ||
                (child.type === "break" && child.data?.isInline === true),
        );
        return onlyHtml && children.some((child) => child.type === "html")
            ? rawSlice(node, source)
            : null;
    }
    const child = children[0];
    if (child.type !== "html" || typeof child.value !== "string") return null;
    if (
        node.position?.start.offset !== child.position?.start.offset ||
        node.position?.end.offset !== child.position?.end.offset
    ) {
        return null;
    }
    return normalizeLineEndings(child.value);
}

/** Unknown inline extension: `{{anything}}` on a single line. */
const INLINE_EXTENSION = /\{\{[^{}\n\r]*\}\}/g;

/** The same run, anchored, for reading one out of the source directly. */
const INLINE_EXTENSION_HERE = /^\{\{[^{}\n\r]*\}\}/;

function preserved(
    type: string,
    value: string,
    kind: SourceFallbackKind | undefined,
    position: MdastNode["position"],
): PreservedMdastNode {
    const node: PreservedMdastNode = { type, value, position };
    if (kind) node.kind = kind;
    return node;
}

function splitInlineExtensions(node: MdastNode): MdastNode[] | null {
    const value = node.value;
    if (typeof value !== "string") return null;
    INLINE_EXTENSION.lastIndex = 0;
    const matches = Array.from(value.matchAll(INLINE_EXTENSION));
    if (matches.length === 0) return null;

    const pieces: MdastNode[] = [];
    let cursor = 0;
    for (const match of matches) {
        const start = match.index ?? 0;
        if (start > cursor) {
            pieces.push({ type: "text", value: value.slice(cursor, start) });
        }
        pieces.push(
            preserved(
                SOURCE_FALLBACK_INLINE_MDAST,
                match[0],
                "inline_extension",
                undefined,
            ),
        );
        cursor = start + match[0].length;
    }
    if (cursor < value.length) {
        pieces.push({ type: "text", value: value.slice(cursor) });
    }
    return pieces;
}

/**
 * A text node whose value is its own source, character for character.
 *
 * Only such a node lets a match found in the value be translated into a source
 * offset: everything remark resolves while parsing — `\{`, `&amp;` — moves the
 * two out of step, and a slice cut at the wrong offset would be the wrong
 * bytes.
 */
function verbatimTextSpan(
    node: MdastNode,
    source: string,
): { start: number; end: number } | null {
    if (node.type !== "text" || typeof node.value !== "string") return null;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    return source.slice(start, end) === node.value ? { start, end } : null;
}

/** A `{{…}}` run that opens in one child and closes in a later one. */
interface SpanningRun {
    /** Source offsets of the run itself. */
    from: number;
    to: number;
    /** Indices of the children the two delimiters landed in. */
    open: number;
    close: number;
    /** Where those two children begin and end in the source. */
    openStart: number;
    closeEnd: number;
}

/**
 * Finds the `{{…}}` runs whose delimiters ended up in different children.
 *
 * `{{*x*_y_[z]}}` is one extension, but remark reads the emphasis inside it
 * first, so `{{` and `}}` arrive in two separate `text` nodes with parsed nodes
 * between them. Matching a single value can never see that, and the fragments
 * left over are written as prose — which escapes the `[` the author typed.
 *
 * A run contained in one child is left out: {@link splitInlineExtensions}
 * already claims those, and does so for text nodes carrying no position at all.
 */
function spanningExtensionRuns(
    children: MdastNode[],
    source: string,
): SpanningRun[] {
    const runs: SpanningRun[] = [];
    // Nothing before this offset is scanned again: it is inside a claimed run.
    let resume = 0;

    for (let index = 0; index < children.length; index += 1) {
        const span = verbatimTextSpan(children[index], source);
        if (span === null) continue;
        const value = children[index].value as string;

        let at = Math.max(0, resume - span.start);
        while (at < value.length) {
            const open = value.indexOf("{{", at);
            if (open === -1) break;
            const from = span.start + open;
            const match = INLINE_EXTENSION_HERE.exec(source.slice(from));
            if (match === null) {
                at = open + 2;
                continue;
            }
            const to = from + match[0].length;
            if (to <= span.end) {
                at = open + match[0].length;
                continue;
            }
            let close = -1;
            let closeEnd = 0;
            for (let after = index + 1; after < children.length; after += 1) {
                const other = verbatimTextSpan(children[after], source);
                if (other === null || other.start >= to || to > other.end) {
                    continue;
                }
                close = after;
                closeEnd = other.end;
                break;
            }
            // The `}}` fell inside something this cannot cut — an inline code
            // span, a node remark rewrote — so the run stays unclaimed.
            if (close === -1) {
                at = open + 2;
                continue;
            }
            runs.push({
                from,
                to,
                open: index,
                close,
                openStart: span.start,
                closeEnd,
            });
            resume = to;
            // Everything left in this child is inside the run.
            break;
        }
    }

    return runs;
}

/**
 * Replaces each spanning run, and everything it covers, with one verbatim slice.
 *
 * At most one run opens and at most one run closes in any single child: a run
 * only qualifies by crossing a boundary, so the one that opens where another
 * closed has to close later still.
 */
function claimSpanningExtensions(
    children: MdastNode[],
    source: string,
): MdastNode[] | null {
    const runs = spanningExtensionRuns(children, source);
    if (runs.length === 0) return null;

    const rewritten: MdastNode[] = [];
    for (let index = 0; index < children.length; index += 1) {
        const opening = runs.find((run) => run.open === index);
        const closing = runs.find((run) => run.close === index);
        if (!opening && !closing) {
            const covered = runs.some(
                (run) => run.open < index && index < run.close,
            );
            if (!covered) rewritten.push(children[index]);
            continue;
        }

        const from = closing ? closing.to : (opening?.openStart ?? 0);
        const to = opening ? opening.from : (closing?.closeEnd ?? 0);
        if (to > from) {
            rewritten.push({ type: "text", value: source.slice(from, to) });
        }
        if (opening) {
            rewritten.push(
                preserved(
                    SOURCE_FALLBACK_INLINE_MDAST,
                    source.slice(opening.from, opening.to),
                    "inline_extension",
                    undefined,
                ),
            );
        }
    }

    return rewritten;
}

/**
 * mdast inline types for a reference-style link or image.
 *
 * Both keep their bytes rather than becoming a structural link: inlining
 * `[ref][1]` into `[ref](http://x)` copies a destination the author wrote once
 * into every place that referenced it, and there is no way back.
 */
const REFERENCE_INLINE = new Set(["linkReference", "imageReference"]);

/**
 * The source of the run of link reference definitions starting at `index`, and
 * the index of the last one it covers.
 *
 * Adjacent definitions are taken as one slice because they really are adjacent
 * in the file: preserved one per block, the serializer would write its block
 * separator between them and turn `[1]: a\n[2]: b` into `[1]: a\n\n[2]: b`.
 * A blank line the author *did* write falls inside the span and is kept, so the
 * run reproduces whatever spacing it arrived with.
 */
function definitionRun(
    children: MdastNode[],
    index: number,
    source: string,
): { value: string; last: number; position: MdastNode["position"] } | null {
    if (children[index].type !== "definition") return null;
    let last = index;
    while (
        last + 1 < children.length &&
        children[last + 1].type === "definition"
    ) {
        last += 1;
    }
    const start = children[index].position?.start;
    const end = children[last].position?.end;
    if (!start || !end) return null;
    const position = { start, end };
    const value = rawSlice({ type: "definition", position }, source);
    return value === null ? null : { value, last, position };
}

/**
 * mdast types whose children are blocks. A fence is a block construct, so the
 * fence checks below are only asked of a node that stands where a block stands.
 */
const BLOCK_CONTAINERS = new Set([
    "root",
    "blockquote",
    "listItem",
    "footnoteDefinition",
]);

/**
 * True for a block that carries its whole content as opaque text.
 *
 * A fence's body is never parsed, so every node that can stand for one — a code
 * block, a Mermaid diagram, a math block — holds it in `value`. Requiring that
 * keeps a paragraph out: a line may open with three backticks and still be
 * prose, because a backtick fence's info string may not contain a backtick, and
 * `` ```x``` starts a line `` is a paragraph beginning with an inline code span.
 */
function isFenceableBlock(node: MdastNode): boolean {
    return typeof node.value === "string" && node.children === undefined;
}

/** A block replacement for `node`, or `null` to leave it in place. */
function replaceBlock(
    node: MdastNode,
    source: string,
    inBlockContainer: boolean,
): MdastNode | null {
    if (inBlockContainer && isFenceableBlock(node)) {
        const unclosed = unclosedFenceSource(node, source);
        if (unclosed !== null) {
            return preserved(
                SOURCE_FALLBACK_MDAST,
                unclosed,
                "unclosed_fence",
                node.position,
            );
        }
        const meta = metaFenceSource(node, source);
        if (meta !== null) {
            return preserved(
                SOURCE_FALLBACK_MDAST,
                meta,
                "fence_meta",
                node.position,
            );
        }
    }
    if (node.type !== "paragraph") return null;

    const html = blockHtmlSource(node, source);
    if (html !== null) {
        return preserved(HTML_SOURCE_MDAST, html, undefined, node.position);
    }
    const directive = directiveSource(node, source);
    return directive === null
        ? null
        : preserved(SOURCE_FALLBACK_MDAST, directive, "directive", node.position);
}

/**
 * Elements whose content the HTML parser reads as raw text rather than markup.
 *
 * remark has no such notion inline: it emits the opening tag, the body as
 * ordinary Markdown text, and the closing tag as three siblings. Writing that
 * body back out escapes whatever Markdown punctuation it contains — a script
 * body's `__` comes back as `\_\_` — so the whole run is captured as one slice
 * of source instead.
 */
const RAW_TEXT_OPENING =
    /^<(script|style|textarea|title|xmp|noscript|noembed|noframes|plaintext)\b/i;

function rawTextTag(node: MdastNode): string | null {
    if (node.type !== "html" || typeof node.value !== "string") return null;
    const match = RAW_TEXT_OPENING.exec(node.value);
    return match ? match[1].toLowerCase() : null;
}

/** Index of the sibling closing `tag`, or `-1`. */
function findClosingTag(
    children: MdastNode[],
    from: number,
    tag: string,
): number {
    const closing = new RegExp(`^</${tag}\\s*>$`, "i");
    for (let index = from; index < children.length; index += 1) {
        const child = children[index];
        if (
            child.type === "html" &&
            typeof child.value === "string" &&
            closing.test(child.value.trim())
        ) {
            return index;
        }
    }
    return -1;
}

function inlineHtml(value: string, position: MdastNode["position"]): MdastNode {
    return preserved(
        HTML_SOURCE_INLINE_MDAST,
        normalizeLineEndings(value),
        undefined,
        position,
    );
}

function visit(parent: MdastNode, source: string): void {
    if (!Array.isArray(parent.children)) return;
    // Runs first so a `{{…}}` that swallowed a parsed subtree is one node
    // before anything descends into that subtree.
    const spanning = claimSpanningExtensions(parent.children, source);
    if (spanning) parent.children = spanning;

    const children = parent.children;
    const inBlockContainer = BLOCK_CONTAINERS.has(parent.type);
    const rewritten: MdastNode[] = [];
    let changed = false;

    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];

        if (inBlockContainer && child.type === "definition") {
            const run = definitionRun(children, index, source);
            if (run) {
                rewritten.push(
                    preserved(
                        SOURCE_FALLBACK_MDAST,
                        run.value,
                        "reference_definition",
                        run.position,
                    ),
                );
                index = run.last;
                changed = true;
                continue;
            }
        }

        if (REFERENCE_INLINE.has(child.type)) {
            const raw = rawSlice(child, source);
            if (raw !== null) {
                rewritten.push(
                    preserved(
                        SOURCE_FALLBACK_INLINE_MDAST,
                        raw,
                        "reference_link",
                        child.position,
                    ),
                );
                changed = true;
                continue;
            }
        }

        const block = replaceBlock(child, source, inBlockContainer);
        if (block) {
            rewritten.push(block);
            changed = true;
            continue;
        }

        if (child.type === "html" && typeof child.value === "string") {
            const tag = rawTextTag(child);
            const close = tag === null ? -1 : findClosingTag(children, index + 1, tag);
            const start = child.position?.start.offset;
            const end = close === -1 ? undefined : children[close].position?.end.offset;
            if (start !== undefined && end !== undefined) {
                rewritten.push(inlineHtml(source.slice(start, end), child.position));
                index = close;
            } else {
                rewritten.push(inlineHtml(child.value, child.position));
            }
            changed = true;
            continue;
        }

        if (child.type === "text") {
            const pieces = splitInlineExtensions(child);
            if (pieces) {
                rewritten.push(...pieces);
                changed = true;
                continue;
            }
        }

        // Only `text` nodes are split, so an `inlineCode` or `code` payload —
        // which lives in `value`, never in children — stays literal.
        visit(child, source);
        rewritten.push(child);
    }

    if (changed) parent.children = rewritten;
}

function writeRaw(node: PreservedMdastNode): string {
    return node.value;
}

/**
 * Writes preserved slices back as the bytes they came in as.
 *
 * These handlers are the only reason the layer can promise byte fidelity:
 * remark-stringify escapes a leading `[`, a `*`, a `_` and more in any text it
 * writes, so a slice routed through the text handler comes back altered. The
 * escaping stays in force for every other node type — this extension names four
 * types of its own and touches nothing else, so `[a](b)` written as literal
 * text is still escaped exactly as before.
 */

export type SourcePreservationOptions = Record<string, never>;

/**
 * Claims every construct the editor cannot represent structurally and hands it
 * to the schema as a verbatim source slice.
 *
 * Runs after commonmark's own remark transformers, which is required rather
 * than incidental: block-level HTML only becomes recognisable once
 * `remarkHTMLTransformer` has wrapped it in a paragraph.
 */
export const remarkSourcePreservation: RemarkPluginRaw<SourcePreservationOptions> =
    function remarkSourcePreservation() {
        const data = this.data();
        const extensions = data.toMarkdownExtensions ?? [];
        // `Handlers` is keyed by mdast's own node types, and these four are
        // this plugin's. The cast asserts exactly that and nothing more: only
        // these type names are claimed, so remark-stringify's normal escaping
        // stays in force everywhere else — `[a](b)` written as literal text is
        // still escaped as before.
        extensions.push({
            handlers: {
                [HTML_SOURCE_MDAST]: writeRaw,
                [HTML_SOURCE_INLINE_MDAST]: writeRaw,
                [SOURCE_FALLBACK_MDAST]: writeRaw,
                [SOURCE_FALLBACK_INLINE_MDAST]: writeRaw,
            },
        } as Parameters<typeof extensions.push>[0]);
        data.toMarkdownExtensions = extensions;

        return (tree, file) => {
            visit(tree as MdastNode, String(file));
        };
    };
