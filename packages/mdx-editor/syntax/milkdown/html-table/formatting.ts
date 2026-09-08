import {
  paragraphSchema,
  strongSchema,
  emphasisSchema,
  linkSchema,
  inlineCodeSchema,
  hardbreakSchema,
} from "@milkdown/kit/preset/commonmark";
import { strikethroughSchema } from "@milkdown/kit/preset/gfm";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import {
  DOMSerializer,
  type DOMOutputSpec,
  type Node as ProseMirrorNode,
} from "@milkdown/kit/prose/model";
import type { TableMdast } from "./remark";

type HtmlTag = NonNullable<TableMdast["htmlTag"]>;
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const wrap = (tag: HtmlTag, content: string) =>
  `<${tag.name}${tag.attrs.map(({ name, value }) => ` ${name}="${escape(value)}"`).join("")}>${content}</${tag.name}>`;

/** Authored attributes only reach serialized source, never the live DOM. */
export function htmlTableFormatting(): MilkdownPlugin[] {
  const nodes = [paragraphSchema, hardbreakSchema].map((schema) =>
    schema.extendSchema((previous) => (ctx) => {
      const base = previous(ctx);
      return {
        ...base,
        attrs: { ...base.attrs, htmlTag: { default: null } },
        parseMarkdown: {
          ...base.parseMarkdown,
          runner: (state, node, type) => {
            const tag = (node as TableMdast).htmlTag;
            if (!tag) return base.parseMarkdown.runner(state, node, type);
            if (node.type === "break") {
              state.addNode(type, { htmlTag: tag, isInline: false });
              return;
            }
            state
              .openNode(type, { htmlTag: tag })
              .next(node.children)
              .closeNode();
          },
        },
      };
    }),
  );
  const marks = [
    strongSchema,
    emphasisSchema,
    linkSchema,
    strikethroughSchema,
    inlineCodeSchema,
  ].map((schema) =>
    schema.extendSchema((previous) => (ctx) => {
      const base = previous(ctx);
      return {
        ...base,
        attrs: { ...base.attrs, htmlTag: { default: null } },
        // Link's preset spreads mark attrs; omit preservation metadata.
        toDOM: (mark, inline) => {
          const spec = base.toDOM!(mark, inline);
          if (
            Array.isArray(spec) &&
            spec[1] &&
            typeof spec[1] === "object" &&
            !Array.isArray(spec[1])
          ) {
            const attrs = { ...spec[1] };
            delete attrs.htmlTag;
            return [spec[0], attrs, ...spec.slice(2)] as DOMOutputSpec;
          }
          return spec;
        },
        parseMarkdown: {
          ...base.parseMarkdown,
          runner: (state, node, type) => {
            const tag = (node as TableMdast).htmlTag;
            if (!tag) return base.parseMarkdown.runner(state, node, type);
            state.openMark(type, {
              htmlTag: tag,
              ...(node.type === "link"
                ? { href: node.url, title: node.title }
                : {}),
            });
            if (node.type === "inlineCode")
              state.addText(String(node.value ?? ""));
            else state.next(node.children);
            state.closeMark(type);
          },
        },
      };
    }),
  );
  return [...nodes, ...marks].flat();
}

export function writeCellNode(node: ProseMirrorNode): string {
  let content = "";
  if (node.isText) content = escape(node.text!);
  else if (node.type.name === "hardbreak") {
    content = wrap(node.attrs.htmlTag ?? { name: "br", attrs: [] }, "").replace(
      /<\/br>$/,
      "",
    );
  } else if (node.type.name === "paragraph") {
    node.forEach((child) => {
      content += writeCellNode(child);
    });
    content = wrap(node.attrs.htmlTag ?? { name: "p", attrs: [] }, content);
  } else {
    // Non-text insertions keep the existing syntax owner's HTML output.
    const doc = document.implementation.createHTMLDocument();
    const holder = doc.createElement("div");
    holder.append(
      DOMSerializer.fromSchema(node.type.schema).serializeNode(node.mark([]), {
        document: doc,
      }),
    );
    content = holder.innerHTML;
  }
  for (const mark of [...node.marks].reverse()) {
    if (mark.type.name === "mdx_authored_escape") continue;
    let tag = mark.attrs.htmlTag as HtmlTag | null;
    if (tag) {
      tag = { ...tag, attrs: tag.attrs.map((attr) => ({ ...attr })) };
      if (mark.type.name === "link") {
        for (const [name, value] of [
          ["href", mark.attrs.href],
          ["title", mark.attrs.title],
        ]) {
          tag.attrs = tag.attrs.filter((attr) => attr.name !== name);
          if (value !== null && value !== undefined)
            tag.attrs.push({ name, value: String(value) });
        }
      }
      content = wrap(tag, content);
    } else {
      const doc = document.implementation.createHTMLDocument();
      const spec = DOMSerializer.marksFromSchema(node.type.schema)[
        mark.type.name
      ](mark, true);
      const rendered = DOMSerializer.renderSpec(doc, spec);
      const holder = doc.createElement("div");
      holder.append(rendered.dom);
      // A placeholder avoids parsing authored markup into a live DOM.
      const marker = "<mdx-html-content></mdx-html-content>";
      (rendered.contentDOM ?? rendered.dom).appendChild(
        doc.createElement("mdx-html-content"),
      );
      content = holder.innerHTML.replace(marker, () => content);
    }
  }
  return content;
}
