import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import {
  tableSchema,
  tableRowSchema,
  tableHeaderRowSchema,
  tableCellSchema,
  tableHeaderSchema,
} from "@milkdown/kit/preset/gfm";
import { ParserState, type MarkdownNode } from "@milkdown/kit/transformer";
import { $prose, $remark } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { HTML_SOURCE_MDAST } from "../source-preservation/remark-source-preservation";
import { htmlTableRemark, type TableMdast } from "./remark";
import { writeHtmlTable } from "./serialize";
import { htmlTableFormatting } from "./formatting";
import { readHtmlTable } from "./remark";
import type { DOMOutputSpec } from "@milkdown/kit/prose/model";
import {
  isProductMetadata,
  SOURCE_TOKEN_ATTR,
} from "../source-preservation/session";

const CLIPBOARD_TABLE = "data-mdx-html-table";
function clipboardTable(dom: HTMLElement | string): TableMdast | null {
  if (
    typeof dom === "string" ||
    !isProductMetadata(dom.getAttribute(SOURCE_TOKEN_ATTR))
  )
    return null;
  const raw = dom.getAttribute(CLIPBOARD_TABLE);
  return raw ? readHtmlTable(raw, 0) : null;
}

// GFM has no representation for multiple paragraphs in a cell. The schema is
// shared with HTML tables, so retain the preset's restriction at transactions.
const gfmCellContent = $prose(
  () =>
    new Plugin({
      filterTransaction: (transaction, state) => {
        if (!transaction.docChanged) return true;
        const from = state.doc.content.findDiffStart(transaction.doc.content);
        if (from === null) return true;
        const end = state.doc.content.findDiffEnd(transaction.doc.content);
        let valid = true;
        transaction.doc.nodesBetween(
          from,
          Math.max(from, end?.b ?? from),
          (node) => {
            if (node.type.name !== "table") return true;
            if (!node.attrs.htmlTable)
              node.forEach((row) =>
                row.forEach((cell) => {
                  if (cell.childCount !== 1) valid = false;
                }),
              );
            return false;
          },
        );
        return valid;
      },
    }),
);

/** Extends the existing table owner; no nested editor or second save state. */
export function htmlTablePlugins(): MilkdownPlugin[] {
  const table = tableSchema.extendSchema((previous) => (ctx) => {
    const base = previous(ctx);
    return {
      ...base,
      content: "(table_header_row | table_row)+",
      attrs: { ...base.attrs, htmlTable: { default: null } },
      parseDOM: [
        {
          tag: `table[${CLIPBOARD_TABLE}]`,
          priority: 75,
          getAttrs: (dom) => {
            const node = clipboardTable(dom);
            return node ? { htmlTable: node.htmlTable } : false;
          },
          getContent: (dom, schema) => {
            const node = clipboardTable(dom as HTMLElement);
            if (!node)
              throw new Error("Untrusted HTML table clipboard metadata");
            return new ParserState(schema)
              .next({ type: "root", children: [node] } as MarkdownNode)
              .toDoc().firstChild!.content;
          },
        },
        ...(base.parseDOM ?? []),
      ],
      toDOM: (node) => {
        const spec = base.toDOM!(node);
        if (!node.attrs.htmlTable || !Array.isArray(spec)) return spec;
        const hasAttrs =
          spec[1] && typeof spec[1] === "object" && !Array.isArray(spec[1]);
        return [
          spec[0],
          {
            ...(hasAttrs ? spec[1] : {}),
            [CLIPBOARD_TABLE]: writeHtmlTable(node),
          },
          ...spec.slice(hasAttrs ? 2 : 1),
        ] as DOMOutputSpec;
      },
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          const raw = (node as TableMdast).htmlTable;
          if (!raw) return base.parseMarkdown.runner(state, node, type);
          state
            .openNode(type, { htmlTable: raw })
            .next(node.children)
            .closeNode();
        },
      },
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          if (!node.attrs.htmlTable) return base.toMarkdown.runner(state, node);
          state.addNode(HTML_SOURCE_MDAST, undefined, writeHtmlTable(node));
        },
      },
    };
  });
  const rows = [tableRowSchema, tableHeaderRowSchema].map((schema) =>
    schema.extendSchema((previous) => (ctx) => {
      const base = previous(ctx);
      return {
        ...base,
        content: "(table_cell | table_header)*",
        attrs: { ...base.attrs, htmlRow: { default: null } },
        parseMarkdown: {
          ...base.parseMarkdown,
          runner: (state, node, type) => {
            const raw = (node as TableMdast).htmlRow;
            if (!raw) return base.parseMarkdown.runner(state, node, type);
            state
              .openNode(type, { htmlRow: raw })
              .next(node.children)
              .closeNode();
          },
        },
      };
    }),
  );
  const cells = [tableCellSchema, tableHeaderSchema].map((schema) =>
    schema.extendSchema((previous) => (ctx) => {
      const base = previous(ctx);
      return {
        ...base,
        content: "paragraph+",
        attrs: { ...base.attrs, htmlCell: { default: null } },
        parseMarkdown: {
          ...base.parseMarkdown,
          runner: (state, node, type) => {
            const raw = (node as TableMdast).htmlCell;
            if (!raw) return base.parseMarkdown.runner(state, node, type);
            const initial = new ParserState(state.schema)
              .next({ type: "root", children: node.children } as MarkdownNode)
              .toDoc()
              .content.toJSON();
            state
              .openNode(type, {
                colspan: raw.colspan,
                rowspan: raw.rowspan,
                htmlCell: { source: raw, initial },
              })
              .next(node.children)
              .closeNode();
          },
        },
      };
    }),
  );
  return [
    $remark("mdxHtmlTable", () => htmlTableRemark),
    table,
    ...rows,
    ...cells,
    ...htmlTableFormatting(),
    gfmCellContent,
  ].flat();
}
