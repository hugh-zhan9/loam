import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { RemarkPluginRaw } from "@milkdown/kit/transformer";
import type { MdastNode } from "../source-preservation/remark-source-preservation";

type HtmlNode = DefaultTreeAdapterMap["childNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];
export interface CellSource {
  index: number;
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
  opening: string;
  closing: string;
  colspan: number;
  rowspan: number;
  text: { from: number; to: number; value: string }[];
}
export interface RowSource {
  opening: string;
  closing: string;
  group: { id: number; opening: string; closing: string } | null;
}
export interface TableSource {
  source: string;
  opening: string;
  closing: string;
  cells: CellSource[];
  rowCells: number[];
}
export interface TableMdast extends MdastNode {
  htmlTag?: { name: string; attrs: { name: string; value: string }[] };
  htmlTable?: TableSource;
  htmlRow?: RowSource;
  htmlCell?: CellSource;
  isHeader?: boolean;
  align?: (string | null)[];
  [key: string]: unknown;
}

const element = (node: HtmlNode): node is HtmlElement => "tagName" in node;
const meaningful = (nodes: HtmlNode[]) =>
  nodes.filter(
    (node) =>
      node.nodeName !== "#text" || ("value" in node && node.value.trim()),
  );
const attribute = (node: HtmlElement, name: string) =>
  node.attrs.find((attr) => attr.name === name)?.value;

function formatting(node: HtmlElement): TableMdast["htmlTag"] {
  const attrs = node.attrs
    .filter(
      (attr) => node.tagName !== "a" || !["href", "title"].includes(attr.name),
    )
    .map(({ name, value }) => ({ name, value }));
  if (!attrs.length && !["b", "i", "s"].includes(node.tagName))
    return undefined;
  return { name: node.tagName, attrs };
}

// Unsupported HTML stays with the existing source-preservation owner. In
// particular, no parser repair or dropped element may turn into data loss on edit.
class UnsupportedTable extends Error {}

function position(node: HtmlNode, base: number): MdastNode["position"] {
  const loc = node.sourceCodeLocation;
  if (!loc) return undefined;
  return {
    start: {
      line: loc.startLine,
      column: loc.startCol,
      offset: base + loc.startOffset,
    },
    end: {
      line: loc.endLine,
      column: loc.endCol,
      offset: base + loc.endOffset,
    },
  };
}

function inline(node: HtmlNode, base: number): TableMdast {
  const pos = position(node, base);
  if (node.nodeName === "#text" && "value" in node) {
    return { type: "text", value: node.value, position: pos };
  }
  if (!element(node)) throw new UnsupportedTable();
  const types: Record<string, string> = {
    strong: "strong",
    b: "strong",
    em: "emphasis",
    i: "emphasis",
    del: "delete",
    s: "delete",
    a: "link",
  };
  if (node.tagName === "br")
    return { type: "break", position: pos, htmlTag: formatting(node) };
  if (node.tagName === "code") {
    if (node.childNodes.some(element)) throw new UnsupportedTable();
    return {
      type: "inlineCode",
      value: node.childNodes
        .map((child) => ("value" in child ? child.value : ""))
        .join(""),
      position:
        node.childNodes.length === 1 ? position(node.childNodes[0], base) : pos,
      htmlTag: formatting(node),
    };
  }
  const type = types[node.tagName];
  if (!type) throw new UnsupportedTable();
  return {
    type,
    children: node.childNodes.map((child) => inline(child, base)),
    position: pos,
    htmlTag: formatting(node),
    ...(type === "link"
      ? {
          url: attribute(node, "href") ?? "",
          title: attribute(node, "title") ?? null,
        }
      : {}),
  };
}

function blocks(nodes: HtmlNode[], base: number): TableMdast[] {
  const result: TableMdast[] = [];
  let run: TableMdast[] = [];
  const flush = () => {
    if (run.length) result.push({ type: "paragraph", children: run });
    run = [];
  };
  for (const node of nodes) {
    if (
      node.nodeName === "#text" &&
      "value" in node &&
      !node.value.trim() &&
      !run.length
    )
      continue;
    if (element(node) && node.tagName === "p") {
      flush();
      result.push({
        type: "paragraph",
        children: node.childNodes.map((child) => inline(child, base)),
        position: position(node, base),
        htmlTag: formatting(node),
      });
    } else {
      run.push(inline(node, base));
    }
  }
  flush();
  return result.length ? result : [{ type: "paragraph", children: [] }];
}

function spanValue(cell: HtmlElement, name: string): number {
  const raw = attribute(cell, name);
  const value = raw === undefined ? 1 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw new UnsupportedTable();
  return value;
}

export function readHtmlTable(
  source: string,
  base: number,
  pos?: MdastNode["position"],
): TableMdast | null {
  if (!/^\s*<table[\s>]/i.test(source)) return null;
  try {
    let invalid = false;
    const fragment = parseFragment(source, {
      sourceCodeLocationInfo: true,
      onParseError: () => {
        invalid = true;
      },
    });
    const pending = fragment.childNodes.map((node) => ({ node, depth: 0 }));
    let count = 0;
    while (pending.length) {
      const entry = pending.pop()!;
      if (++count > 20000 || entry.depth > 100) throw new UnsupportedTable();
      if (element(entry.node)) {
        for (const node of entry.node.childNodes)
          pending.push({ node, depth: entry.depth + 1 });
      }
    }
    const top = meaningful(fragment.childNodes);
    if (
      invalid ||
      top.length !== 1 ||
      !element(top[0]) ||
      top[0].tagName !== "table"
    )
      return null;
    const table = top[0];
    const loc = table.sourceCodeLocation;
    if (!loc?.startTag || !loc.endTag) return null;
    const data: TableSource = {
      source,
      opening: source.slice(loc.startOffset, loc.startTag.endOffset),
      closing: source.slice(loc.endTag.startOffset, loc.endOffset),
      cells: [],
      rowCells: [],
    };
    const rows: TableMdast[] = [];
    for (const child of meaningful(table.childNodes)) {
      if (
        !element(child) ||
        !["tbody", "thead", "tfoot"].includes(child.tagName)
      )
        throw new UnsupportedTable();
      const groupLoc = child.sourceCodeLocation;
      const group =
        groupLoc?.startTag && groupLoc.endTag
          ? {
              id: groupLoc.startOffset,
              opening: source.slice(
                groupLoc.startOffset,
                groupLoc.startTag.endOffset,
              ),
              closing: source.slice(
                groupLoc.endTag.startOffset,
                groupLoc.endOffset,
              ),
            }
          : null;
      for (const row of meaningful(child.childNodes)) {
        if (!element(row) || row.tagName !== "tr") throw new UnsupportedTable();
        const rowLoc = row.sourceCodeLocation;
        if (!rowLoc?.startTag || !rowLoc.endTag) throw new UnsupportedTable();
        const cells: TableMdast[] = [];
        for (const cell of meaningful(row.childNodes)) {
          if (!element(cell) || !["td", "th"].includes(cell.tagName))
            throw new UnsupportedTable();
          const cellLoc = cell.sourceCodeLocation;
          if (!cellLoc?.startTag || !cellLoc.endTag)
            throw new UnsupportedTable();
          const cellSource: CellSource = {
            index: data.cells.length,
            from: cellLoc.startOffset,
            to: cellLoc.endOffset,
            innerFrom: cellLoc.startTag.endOffset,
            innerTo: cellLoc.endTag.startOffset,
            opening: source.slice(
              cellLoc.startOffset,
              cellLoc.startTag.endOffset,
            ),
            closing: source.slice(
              cellLoc.endTag.startOffset,
              cellLoc.endOffset,
            ),
            colspan: spanValue(cell, "colspan"),
            rowspan: spanValue(cell, "rowspan"),
            text: [],
          };
          const content = blocks(cell.childNodes, base);
          const captureText = (node: MdastNode) => {
            if (
              (node.type === "text" || node.type === "inlineCode") &&
              typeof node.value === "string" &&
              node.position
            ) {
              cellSource.text.push({
                from: node.position.start.offset! - base,
                to: node.position.end.offset! - base,
                value: node.value,
              });
            }
            node.children?.forEach(captureText);
          };
          content.forEach(captureText);
          data.cells.push(cellSource);
          cells.push({
            type: "tableCell",
            isHeader: cell.tagName === "th",
            htmlCell: cellSource,
            children: content,
            position: position(cell, base),
          });
        }
        if (!cells.length) throw new UnsupportedTable();
        data.rowCells.push(cells.length);
        rows.push({
          type: "tableRow",
          htmlRow: {
            opening: source.slice(
              rowLoc.startOffset,
              rowLoc.startTag.endOffset,
            ),
            closing: source.slice(rowLoc.endTag.startOffset, rowLoc.endOffset),
            group,
          },
          children: cells,
          position: position(row, base),
        });
      }
    }
    if (!rows.length) return null;
    // Decline malformed grids before tableEditing can silently repair them.
    const occupied: number[] = [];
    let width = 0;
    rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const child of row.children ?? []) {
        const cell = (child as TableMdast).htmlCell!;
        while (occupied[column] > 0) column += 1;
        if (
          column + cell.colspan > 1000 ||
          rowIndex + cell.rowspan > rows.length
        )
          throw new UnsupportedTable();
        for (let span = 0; span < cell.colspan; span += 1) {
          if (occupied[column + span] > 0) throw new UnsupportedTable();
          occupied[column + span] = cell.rowspan;
        }
        column += cell.colspan;
      }
      width ||= occupied.length;
      if (occupied.length !== width || occupied.some((remaining) => !remaining))
        throw new UnsupportedTable();
      for (let index = 0; index < width; index += 1) occupied[index] -= 1;
    });
    return {
      type: "table",
      htmlTable: data,
      children: rows,
      align: [],
      position: pos,
    };
  } catch (error) {
    if (error instanceof UnsupportedTable) return null;
    throw error;
  }
}

export const htmlTableRemark: RemarkPluginRaw<Record<string, never>> =
  function () {
    return (tree, file) => {
      const visit = (parent: MdastNode) => {
        parent.children = parent.children?.map((child) => {
          const raw =
            child.type === "html"
              ? child
              : child.type === "paragraph" &&
                  child.children?.length === 1 &&
                  child.children[0].type === "html"
                ? child.children[0]
                : null;
          if (raw && typeof raw.value === "string") {
            const from = raw.position?.start.offset;
            const to = raw.position?.end.offset;
            // Container prefixes change offsets on continuation lines.
            // Leave those with source preservation until their complete
            // source-coordinate mapping can be represented.
            const exact =
              from !== undefined &&
              to !== undefined &&
              String(file).slice(from, to) === raw.value;
            const table = exact
              ? readHtmlTable(raw.value, from, child.position)
              : null;
            if (table) return table;
          }
          visit(child);
          return child;
        });
      };
      visit(tree as MdastNode);
    };
  };
