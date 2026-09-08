import {
  Fragment,
  type Node as ProseMirrorNode,
} from "@milkdown/kit/prose/model";
import { parseFragment, serializeOuter } from "parse5";
import { writeCellNode } from "./formatting";
import type { CellSource, RowSource, TableSource } from "./remark";

export interface HtmlCellState {
  source: CellSource;
  initial: ReturnType<Fragment["toJSON"]>;
}

function sameShape(left: Fragment, right: Fragment): boolean {
  if (left.childCount !== right.childCount) return false;
  for (let index = 0; index < left.childCount; index += 1) {
    const a = left.child(index),
      b = right.child(index);
    if (!a.sameMarkup(b) || !sameShape(a.content, b.content)) return false;
  }
  return true;
}

function patchText(
  cell: ProseMirrorNode,
  initial: Fragment,
  stored: HtmlCellState,
  table: TableSource,
): string | null {
  if (!sameShape(initial, cell.content)) return null;
  const oldText: string[] = [],
    newText: string[] = [];
  initial.descendants((node) => {
    if (node.isText) oldText.push(node.text!);
  });
  cell.descendants((node) => {
    if (node.isText) newText.push(node.text!);
  });
  const spans = stored.source.text;
  if (
    oldText.length !== spans.length ||
    oldText.some((text, index) => text !== spans[index].value)
  )
    return null;
  let raw = table.source.slice(stored.source.innerFrom, stored.source.innerTo);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (newText[index] === oldText[index]) continue;
    const span = spans[index];
    const escaped = newText[index]
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    raw =
      raw.slice(0, span.from - stored.source.innerFrom) +
      escaped +
      raw.slice(span.to - stored.source.innerFrom);
  }
  return raw;
}

function cellContent(cell: ProseMirrorNode, table: TableSource): string {
  const stored = cell.attrs.htmlCell as HtmlCellState | null;
  if (stored) {
    const initial = Fragment.fromJSON(cell.type.schema, stored.initial);
    if (cell.content.eq(initial))
      return table.source.slice(stored.source.innerFrom, stored.source.innerTo);
    const patched = patchText(cell, initial, stored, table);
    if (patched !== null) return patched;
  }
  let content = "";
  cell.forEach((child) => {
    content += writeCellNode(child);
  });
  const original = stored
    ? table.source.slice(stored.source.innerFrom, stored.source.innerTo)
    : "";
  if (
    !/^\s*<p[\s>]/i.test(original) &&
    cell.childCount === 1 &&
    cell.firstChild?.type.name === "paragraph" &&
    !cell.firstChild.attrs.htmlTag
  ) {
    return content.slice(3, -4);
  }
  return content;
}

function cellOpening(cell: ProseMirrorNode): string {
  const stored = cell.attrs.htmlCell as HtmlCellState | null;
  const tag = cell.type.name === "table_header" ? "th" : "td";
  const raw = stored?.source.opening ?? `<${tag}>`;
  const fragment = parseFragment(`<table><tr>${raw}</${tag}></tr></table>`);
  const table = fragment.childNodes.find(
    (node) => "tagName" in node && node.tagName === "table",
  );
  if (!table || !("childNodes" in table))
    throw new Error("Invalid HTML table cell");
  const group = table.childNodes.find(
    (node) => "tagName" in node && node.tagName === "tbody",
  );
  const row = group && "childNodes" in group ? group.childNodes[0] : null;
  const parsed = row && "childNodes" in row ? row.childNodes[0] : null;
  if (!parsed || !("tagName" in parsed))
    throw new Error("Invalid HTML table cell");
  parsed.tagName = tag;
  for (const name of ["colspan", "rowspan"] as const) {
    const existing = parsed.attrs.find((attr) => attr.name === name);
    if (existing) existing.value = String(cell.attrs[name]);
    else if (cell.attrs[name] !== 1)
      parsed.attrs.push({ name, value: String(cell.attrs[name]) });
  }
  return serializeOuter(parsed).replace(new RegExp(`</${tag}>$`), "");
}

export function writeHtmlTable(node: ProseMirrorNode): string {
  const table = node.attrs.htmlTable as TableSource;
  const cells: ProseMirrorNode[] = [];
  node.forEach((row) => row.forEach((cell) => cells.push(cell)));
  const unchangedStructure =
    node.childCount === table.rowCells.length &&
    table.rowCells.every(
      (count, index) => node.child(index).childCount === count,
    ) &&
    cells.length === table.cells.length &&
    cells.every((cell, index) => {
      const stored = cell.attrs.htmlCell as HtmlCellState | null;
      return (
        stored?.source.index === index &&
        cell.attrs.colspan === stored.source.colspan &&
        cell.attrs.rowspan === stored.source.rowspan &&
        (cell.type.name === "table_header") ===
          /^<th[\s>]/i.test(stored.source.opening)
      );
    });
  if (unchangedStructure) {
    let raw = table.source;
    // Patch from the end so earlier source offsets remain valid.
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const source = table.cells[index];
      raw =
        raw.slice(0, source.innerFrom) +
        cellContent(cells[index], table) +
        raw.slice(source.innerTo);
    }
    return raw;
  }

  // Row/column commands still use the preset's table model. Rebuild only the
  // table whose structure changed, retaining original row/group attributes.
  let result = table.opening;
  let groupId: number | null = null;
  let groupClosing = "";
  for (let rowIndex = 0; rowIndex < node.childCount; rowIndex += 1) {
    const row = node.child(rowIndex);
    const source = row.attrs.htmlRow as RowSource | null;
    const nextGroup = source?.group ?? null;
    if (groupId !== (nextGroup?.id ?? null)) {
      result += groupClosing;
      result += nextGroup?.opening ?? "";
      groupId = nextGroup?.id ?? null;
      groupClosing = nextGroup?.closing ?? "";
    }
    result += source?.opening ?? "<tr>";
    row.forEach((cell) => {
      result +=
        cellOpening(cell) +
        cellContent(cell, table) +
        (cell.type.name === "table_header" ? "</th>" : "</td>");
    });
    result += source?.closing ?? "</tr>";
  }
  return result + groupClosing + table.closing;
}
