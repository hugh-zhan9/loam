import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import type {
    EditorView,
    NodeView,
    NodeViewConstructor,
    ViewMutationRecord,
} from "@milkdown/kit/prose/view";

import { SanitizeError, sanitizeToFragment } from "./sanitize";
import {
    NODE_TYPE_ATTR,
    PREVIEW_ATTR,
    PREVIEW_ERROR_ATTR,
    SOURCE_ELEMENT_ATTR,
    SOURCE_ID_ATTR,
    SOURCE_KIND_ATTR,
} from "./session";

function describeFailure(error: unknown): string {
    if (error instanceof SanitizeError) return error.message;
    if (error instanceof Error) return error.message;
    return "the preview could not be built";
}

/**
 * Rebuilds `container` from `raw`, or reports the failure inside it.
 *
 * Nothing here is allowed to propagate: a NodeView that throws takes the whole
 * editor view down with it, and the source the user is editing is the only copy
 * of their content. A rejected preview costs the preview; it must never cost
 * the document.
 */
function renderPreview(container: HTMLElement, raw: string): void {
    const doc = container.ownerDocument;
    container.removeAttribute(PREVIEW_ERROR_ATTR);
    try {
        const fragment = sanitizeToFragment(raw, doc);
        container.replaceChildren(fragment);
    } catch (error) {
        const message = doc.createElement("span");
        message.className = "mdx-source-preview-error";
        message.textContent = `Preview unavailable — ${describeFailure(error)}`;
        container.replaceChildren(message);
        container.setAttribute(PREVIEW_ERROR_ATTR, "");
    }
}

/**
 * Stops a sanitized preview from navigating the app.
 *
 * A sanitized `href` is still a link, and a preview that could move the
 * surrounding app off the document would not be inert in any useful sense.
 * Both button paths are covered: `click` alone leaves middle-click, whose
 * default is to open the target in a new tab or window.
 */
function installPreviewNavigationGuard(
    host: HTMLElement,
    previewOf: () => HTMLElement | null,
): () => void {
    const block = (event: MouseEvent): void => {
        const preview = previewOf();
        const target = event.target;
        if (preview && target instanceof Node && preview.contains(target)) {
            event.preventDefault();
        }
    };
    host.addEventListener("click", block);
    host.addEventListener("auxclick", block);
    return () => {
        host.removeEventListener("click", block);
        host.removeEventListener("auxclick", block);
    };
}

function createPreview(doc: Document, nodeType: string): HTMLElement {
    const preview = doc.createElement("div");
    preview.className = "mdx-source-preview";
    preview.setAttribute(PREVIEW_ATTR, nodeType);
    // Chrome, not content: it is outside `contentDOM`, so it is not part of the
    // node's text and never reaches the serializer or the clipboard.
    preview.setAttribute("contenteditable", "false");
    return preview;
}

/**
 * An inert preview backed by preserved raw HTML. Source editing is available
 * through the document's source mode.
 */
class HtmlSourceNodeView implements NodeView {
    readonly dom: HTMLElement;
    readonly contentDOM: HTMLElement;

    private node: ProseMirrorNode;
    private readonly preview: HTMLElement;
    private readonly removeNavigationGuard: () => void;

    constructor(node: ProseMirrorNode) {
        this.node = node;
        const doc = document;

        this.dom = doc.createElement("div");
        this.dom.className = "mdx-html-source";
        this.dom.setAttribute(NODE_TYPE_ATTR, node.type.name);

        const source = doc.createElement("pre");
        source.className = "mdx-html-source-code";
        // Retain contentDOM for source mapping and serialization without showing
        // a second copy of the HTML above its rendered content.
        source.hidden = true;
        this.contentDOM = doc.createElement("code");
        this.contentDOM.setAttribute(SOURCE_ELEMENT_ATTR, "");
        this.contentDOM.setAttribute("spellcheck", "false");
        source.append(this.contentDOM);

        this.preview = createPreview(doc, node.type.name);
        this.dom.append(source, this.preview);
        this.removeNavigationGuard = installPreviewNavigationGuard(
            this.dom,
            () => this.preview,
        );
        this.sync();
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type !== this.node.type) return false;
        this.node = node;
        this.sync();
        return true;
    }

    /** Preview mutations are this view's own work; content mutations are not. */
    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return !this.contentDOM.contains(mutation.target);
    }

    stopEvent(event: Event): boolean {
        const target = event.target;
        return target instanceof Node && this.preview.contains(target);
    }

    destroy(): void {
        this.removeNavigationGuard();
    }

    /**
     * Re-derives everything downstream of the source text.
     *
     * The preview is rebuilt from the current bytes on every update rather than
     * patched, so source the user just typed is classified and sanitized by the
     * same path as source that arrived from a file.
     */
    private sync(): void {
        this.dom.setAttribute(SOURCE_ID_ATTR, String(this.node.attrs.sourceId ?? ""));
        renderPreview(this.preview, this.node.textContent);
    }
}

/**
 * Inline HTML: an atom, because ProseMirror inline nodes cannot hold content.
 * The source is edited through a control rather than in the text flow.
 */
class InlineSourceNodeView implements NodeView {
    readonly dom: HTMLElement;

    private node: ProseMirrorNode;
    private readonly view: EditorView;
    private readonly getPos: () => number | undefined;
    private readonly input: HTMLInputElement;
    private readonly preview: HTMLElement | null;
    private readonly removeNavigationGuard: () => void;

    constructor(
        node: ProseMirrorNode,
        view: EditorView,
        getPos: () => number | undefined,
        options: { label: string; withPreview: boolean },
    ) {
        this.node = node;
        this.view = view;
        this.getPos = getPos;
        const doc = document;

        this.dom = doc.createElement("span");
        this.dom.className = "mdx-inline-source";
        this.dom.setAttribute(NODE_TYPE_ATTR, node.type.name);
        this.dom.setAttribute("contenteditable", "false");

        this.input = doc.createElement("input");
        this.input.className = "mdx-inline-source-input";
        this.input.type = "text";
        this.input.setAttribute("aria-label", options.label);
        this.input.setAttribute(SOURCE_ELEMENT_ATTR, "");
        this.input.addEventListener("input", this.onInput);
        this.dom.append(this.input);

        if (options.withPreview) {
            this.preview = createPreview(doc, node.type.name);
            this.dom.append(this.preview);
        } else {
            this.preview = null;
        }
        this.removeNavigationGuard = installPreviewNavigationGuard(
            this.dom,
            () => this.preview,
        );
        this.sync();
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type !== this.node.type) return false;
        this.node = node;
        this.sync();
        return true;
    }

    /** The label is written from attrs and never edited in place. */
    ignoreMutation(): boolean {
        return true;
    }

    stopEvent(): boolean {
        return true;
    }

    destroy(): void {
        this.input.removeEventListener("input", this.onInput);
        this.removeNavigationGuard();
    }

    private readonly onInput = (): void => {
        const pos = this.getPos();
        if (pos === undefined) return;
        const { tr } = this.view.state;
        this.view.dispatch(
            tr.setNodeMarkup(pos, undefined, {
                ...this.node.attrs,
                value: this.input.value,
            }),
        );
    };

    private sync(): void {
        const value = String(this.node.attrs.value ?? "");
        // Writing an unchanged value would reset the caret mid-typing.
        if (this.input.value !== value) this.input.value = value;
        this.input.size = Math.max(value.length, 1);
        this.dom.setAttribute(SOURCE_ID_ATTR, String(this.node.attrs.sourceId ?? ""));
        const kind = this.node.attrs.kind;
        if (typeof kind === "string" && kind.length > 0) {
            this.dom.setAttribute(SOURCE_KIND_ATTR, kind);
        }
        if (this.preview) renderPreview(this.preview, value);
    }
}

/** Raw source of a construct with no structural representation at all. */
class SourceFallbackNodeView implements NodeView {
    readonly dom: HTMLElement;
    readonly contentDOM: HTMLElement;

    private node: ProseMirrorNode;

    constructor(node: ProseMirrorNode) {
        this.node = node;
        const doc = document;

        this.dom = doc.createElement("div");
        this.dom.className = "mdx-source-fallback";
        this.dom.setAttribute(NODE_TYPE_ATTR, node.type.name);

        const source = doc.createElement("pre");
        source.className = "mdx-source-fallback-code";
        this.contentDOM = doc.createElement("code");
        this.contentDOM.setAttribute(SOURCE_ELEMENT_ATTR, "");
        this.contentDOM.setAttribute("spellcheck", "false");
        source.append(this.contentDOM);
        this.dom.append(source);
        this.sync();
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type !== this.node.type) return false;
        this.node = node;
        this.sync();
        return true;
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return !this.contentDOM.contains(mutation.target);
    }

    private sync(): void {
        this.dom.setAttribute(SOURCE_ID_ATTR, String(this.node.attrs.sourceId ?? ""));
        this.dom.setAttribute(SOURCE_KIND_ATTR, String(this.node.attrs.kind ?? ""));
    }
}

export function createHtmlSourceNodeView(): NodeViewConstructor {
    return (node) => new HtmlSourceNodeView(node);
}

export function createInlineHtmlNodeView(): NodeViewConstructor {
    return (node, view, getPos) =>
        new InlineSourceNodeView(node, view, getPos, {
            label: "Inline HTML source",
            withPreview: true,
        });
}

export function createSourceFallbackNodeView(): NodeViewConstructor {
    return (node) => new SourceFallbackNodeView(node);
}

export function createInlineFallbackNodeView(): NodeViewConstructor {
    return (node, view, getPos) =>
        new InlineSourceNodeView(node, view, getPos, {
            label: "Unsupported inline source",
            withPreview: false,
        });
}
