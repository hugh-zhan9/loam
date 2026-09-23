import type { MilkdownPlugin } from "@milkdown/kit/ctx";

import {
    createBaseMilkdownPlugins,
    withoutInlineLinkTransformer,
} from "../../milkdown/base-plugins";
import { calloutPlugins } from "./callout";
import { authoredEscapePlugins } from "./escapes";
import { footnotePlugins } from "./footnote";
import { frontmatterPlugins } from "./frontmatter";
import { imagePlugins } from "./image";
import { htmlTablePlugins } from "./html-table";
import { relaxListItemContent } from "./list-item-content";
import { mathPlugins } from "./math";
import { mermaidPlugins } from "./mermaid";
import { sourcePreservationPlugins } from "./source-preservation";
import {
    wikilinkClickHandlerPlugin,
    wikilinkPlugins,
    type WikilinkClickHandler,
} from "./wikilink";

export { CALLOUT_NODE_NAME, calloutPlugins } from "./callout";
export {
    AUTHORED_ESCAPE_MARK_NAME,
    AUTHORED_ESCAPE_MDAST_TYPE,
    authoredEscapePlugins,
    readAuthoredEscapes,
    writeAuthoredEscapes,
} from "./escapes";
export {
    footnoteActivateCtx,
    footnotePlugins,
    type FootnoteActivation,
    type FootnoteActivateHandler,
} from "./footnote";
export { frontmatterPlugins } from "./frontmatter";
export {
    IMAGE_DOM_MARKER,
    IMAGE_NODE_NAME,
    IMAGE_RESOLVED_SOURCE_MARKER,
    imagePlugins,
    isDirectImageSource,
} from "./image";
export { mathPlugins } from "./math";
export {
    mermaidPlugins,
    mermaidRendererCtx,
    renderMermaidDiagram,
} from "./mermaid";
export { sourcePreservationPlugins } from "./source-preservation";
export {
    wikilinkClickCtx,
    wikilinkClickHandlerPlugin,
    wikilinkPlugins,
    type WikilinkActivation,
    type WikilinkClickHandler,
} from "./wikilink";
import { codeSelectionProsePlugin } from "./code-selection";
import { headingSelectionProsePlugin } from "./heading-selection";
import {
    linkClickHandlerPlugin,
    linkEditorLabelsPlugin,
    linkPlugins,
    type LinkClickHandler,
    type LinkEditorLabels,
} from "./link";

/**
 * Product callbacks the syntax layer fires.
 *
 * The layer parses; it never decides what the product does with what it parsed.
 * A handler left out means that activation goes nowhere, which is what a
 * composition built for a test or a preflight wants.
 */
export interface MdxMilkdownPluginOptions {
    onWikilinkActivate?: WikilinkClickHandler;
    onLinkActivate?: LinkClickHandler;
    /**
     * What the link editor's parts are called, in the product's language.
     *
     * This layer holds no human-language text of its own, so anything it puts
     * into words is named by whoever composed it. Left out means the address
     * field goes unnamed and its two actions are not offered at all, rather than
     * offered in a language the product does not speak.
     */
    linkEditorLabels?: LinkEditorLabels;
}

/**
 * The MDX syntax layer, composed in a fixed order.
 *
 * Two orderings here are load-bearing, and each is pinned by a test that fails
 * when it is swapped:
 *
 * Footnote must reach the tree before any other transformer, including the
 * presets' own, so its position in this list is not what decides it: its plugin
 * prepends to `remarkPluginsCtx` rather than appending. Every splitter — the
 * commonmark preset's soft line breaks, wikilink's brackets — leaves fragments
 * with no source `position`, and footnote decides whether a `[^x]` is genuine by
 * checking a text node's value against its own source, which no fragment can
 * satisfy.
 *
 * Source preservation runs last. It is the layer of last resort: it claims what
 * no structured family recognised, so every family that can represent a
 * construct must have had its chance first. It is also what makes dropping the
 * commonmark preset's inline-link transformer safe: `definition`,
 * `linkReference` and `imageReference` have no schema node anywhere else, so
 * the removal and the claim are one change.
 *
 * Image's position is NOT load-bearing either, and it is not a syntax family:
 * it contributes one NodeView over CommonMark's own image node and no parser,
 * schema or serializer at all, so nothing it does can change what a document
 * means or how it is written back.
 *
 * Frontmatter's position is NOT load-bearing, despite reading that way. It
 * contributes only micromark and mdast-util extensions and no tree transformer,
 * so moving it produces byte-identical output. What keeps a later `---` a
 * thematic break is that the micromark construct only fires at line 1, column 1.
 *
 * Families are meant not to overlap in what they claim: frontmatter owns
 * document-leading `---`/`+++` fences, callout owns blockquotes opening with a
 * `[!TYPE]` marker, mermaid owns fences whose info string is exactly `mermaid`,
 * math owns `$`-delimited spans and blocks, and the inline splitters own their
 * own bracket forms inside text nodes only — never inside code, whose payload
 * never appears as text. Where a family's claim and source preservation's do
 * overlap, running last is what settles it: a block whose fence never closes is
 * taken back from whichever family claimed it, because none of them can write
 * an unterminated fence, and that is why every family leaves the source position
 * on the nodes it produces.
 */
export function createMdxMilkdownPlugins(
    options: MdxMilkdownPluginOptions = {},
): MilkdownPlugin[] {
    const { onWikilinkActivate, onLinkActivate, linkEditorLabels } = options;
    return [
        // Before everything, because a keymap is answered in composition order
        // and the presets' own `Mod-a` selects the whole document.
        codeSelectionProsePlugin,
        headingSelectionProsePlugin,
        // The inline-link transformer goes out here rather than in the base
        // composition, because it is `sourcePreservationPlugins()` below that
        // supplies the three node types it was covering for.
        ...withoutInlineLinkTransformer(createBaseMilkdownPlugins()),
        ...relaxListItemContent(),
        ...imagePlugins(),
        ...frontmatterPlugins(),
        ...calloutPlugins(),
        ...mermaidPlugins(),
        ...mathPlugins(),
        ...footnotePlugins(),
        ...wikilinkPlugins(),
        ...linkPlugins(),
        ...htmlTablePlugins(),
        ...sourcePreservationPlugins(),
        // Escapes last: its writer wrapping has to sit over the final `text`
        // handler, and its reading pass registers itself both before every
        // other transformer and after them.
        ...authoredEscapePlugins(),
        // Handlers last: each writes into a context slice the plugin that owns
        // it has already contributed.
        ...(onWikilinkActivate
            ? [wikilinkClickHandlerPlugin(onWikilinkActivate)]
            : []),
        ...(onLinkActivate ? [linkClickHandlerPlugin(onLinkActivate)] : []),
        ...(linkEditorLabels
            ? [linkEditorLabelsPlugin(linkEditorLabels)]
            : []),
    ];
}
