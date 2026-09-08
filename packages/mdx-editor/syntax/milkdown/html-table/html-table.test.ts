// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { addRowAfter } from "@milkdown/kit/prose/tables";
import { DOMParser, Slice } from "@milkdown/kit/prose/model";
import { splitBlock } from "@milkdown/kit/prose/commands";
import { sanitizePastedHtml } from "../source-preservation/clipboard-guard";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createMdxMilkdownPlugins } from "..";
import {
  createMilkdownEditorHost,
  type MilkdownEditorHost,
} from "../../../milkdown/editor-host";

const mounted: MilkdownEditorHost[] = [];
afterEach(async () => {
  while (mounted.length) await mounted.pop()?.destroy();
  document.body.innerHTML = "";
});

async function mount(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  let view!: EditorView;
  const changes: string[] = [];
  const capture = $prose(
    () =>
      new Plugin({
        view: (current) => {
          view = current;
          return {};
        },
      }),
  );
  const host = await createMilkdownEditorHost({
    root,
    markdown,
    editable: true,
    plugins: [...createMdxMilkdownPlugins(), capture],
    onMarkdownChange: (value) => changes.push(value),
    onSelectionChange: () => {},
  });
  mounted.push(host);
  return { root, host, view, changes };
}

const table = `<table class="confluenceTable">
  <tbody>
    <tr><th>指标</th><th>说明</th></tr>
    <tr><td colspan="1" class="confluenceTd"><strong>基本介绍</strong></td><td><p>来源<a href="https://example.com" rel="nofollow">官网</a>。</p></td></tr>
  </tbody>
</table>`;

describe("editable HTML tables", () => {
  it("edits a rendered cell through the main editor and saves HTML", async () => {
    const { root, host, view, changes } = await mount(`Before.\n\n${table}\n`);
    const cell = root.querySelector("td")!;
    expect(cell).not.toBeNull();
    expect(cell.closest('[contenteditable="false"]')).toBeNull();
    expect(root.querySelector(".mdx-html-source-code")).toBeNull();
    let position = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "基本介绍") position = pos;
    });
    expect(position).toBeGreaterThan(0);
    view.dispatch(view.state.tr.insertText("新", position));
    host.flush();
    expect(cell.textContent).toContain("新基本介绍");
    expect(host.getMarkdown()).toContain("<strong>新基本介绍</strong>");
    expect(host.getMarkdown()).toContain('class="confluenceTd"');
    expect(host.getMarkdown()).toContain(
      '<a href="https://example.com" rel="nofollow">官网</a>',
    );
    expect(changes.at(-1)).toBe(host.getMarkdown());
    const reopened = await mount(host.getMarkdown());
    expect(reopened.root.querySelector("td")?.textContent).toBe("新基本介绍");
    expect(host.undo()).toBe(true);
    host.flush();
    expect(host.getMarkdown()).toBe(`Before.\n\n${table}\n`);
    expect(host.redo()).toBe(true);
    host.flush();
    expect(host.getMarkdown()).toContain("新基本介绍");
  });

  it("keeps an unedited table byte-exact after a neighbouring edit", async () => {
    const { host } = await mount(`Before.\n\n${table}\n`);
    expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
    host.flush();
    expect(host.getMarkdown()).toBe(`XBefore.\n\n${table}\n`);
  });

  it("maps visible text rather than identical text in HTML attributes", async () => {
    const markdown =
      '<table><tr><td title="same">same &amp; more</td></tr></table>\n';
    const { host, root } = await mount(markdown);
    const offset = markdown.indexOf("same &amp;");
    expect(
      host.findMatches({
        query: "same",
        caseSensitive: true,
        wholeWord: false,
      }),
    ).toEqual([{ anchor: offset, head: offset + 4 }]);
    expect(
      host.replaceSourceRange({ anchor: offset, head: offset + 4 }, "edited"),
    ).toBe(true);
    host.flush();
    expect(root.querySelector("td")?.textContent).toBe("edited & more");
    expect(host.getMarkdown()).toContain('title="same"');
  });

  it("preserves merged cells and supports empty cells and multiple paragraphs", async () => {
    const markdown =
      '<table><tr><th colspan="2">Title</th></tr><tr><td rowspan="2"></td><td><p>One</p><p>Two</p></td></tr><tr><td>End</td></tr></table>\n';
    const { host, root } = await mount(markdown);
    expect(root.querySelector("th")?.colSpan).toBe(2);
    expect(root.querySelector("td")?.rowSpan).toBe(2);
    expect(root.querySelectorAll("td")).toHaveLength(3);
    expect(root.querySelectorAll("td p")).toHaveLength(4);
    const offset = markdown.indexOf("One");
    expect(
      host.replaceSourceRange({ anchor: offset, head: offset + 3 }, "Changed"),
    ).toBe(true);
    host.flush();
    expect(host.getMarkdown()).toContain('rowspan="2"');
    expect(host.getMarkdown()).toContain('colspan="2"');
    expect(host.getMarkdown()).toContain("<p>Changed</p><p>Two</p>");
  });

  it("does not interpret fenced HTML as an editable table", async () => {
    const { root } = await mount(`\`\`\`html\n${table}\n\`\`\`\n`);
    expect(root.querySelector("table")).toBeNull();
    expect(root.querySelector("pre")?.textContent).toContain("<table");
  });

  it("keeps unsafe markup out of the live editor", async () => {
    const { root, host } = await mount(
      '<table onclick="alert(1)"><tr><td><a href="javascript:alert(1)">Label</a><script>alert(1)</script></td></tr></table>\n',
    );
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("[onclick]")).toBeNull();
    expect(root.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.hasFailed()).toBe(false);
  });

  it("keeps ordinary Markdown tables editable and saves them as Markdown", async () => {
    const { host, root, view } = await mount(
      "| A | B |\n| --- | --- |\n| One | Two |\n",
    );
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "One") at = pos;
    });
    view.dispatch(view.state.tr.insertText("New ", at));
    host.flush();
    expect(root.querySelector("td")?.textContent).toBe("New One");
    expect(host.getMarkdown()).toContain("| New One");
    expect(host.getMarkdown()).not.toContain("<table");
  });

  it("saves rows inserted with the existing table commands", async () => {
    const { host, view } = await mount(`${table}\n`);
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "基本介绍") at = pos;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at)),
    );
    expect(addRowAfter(view.state, view.dispatch)).toBe(true);
    host.flush();
    const reopened = await mount(host.getMarkdown());
    expect(reopened.root.querySelectorAll("tr")).toHaveLength(3);
    expect(reopened.root.querySelectorAll("td")).toHaveLength(4);
    expect(host.getMarkdown()).toContain('class="confluenceTable"');
  });

  it("does not repair a malformed table while saving a neighbouring edit", async () => {
    const raw =
      "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>";
    const { host, root } = await mount(`Before.\n\n${raw}\n`);
    expect(root.querySelector(".mdx-html-source-code")).not.toBeNull();
    expect(host.replaceSourceRange({ anchor: 0, head: 0 }, "X")).toBe(true);
    host.flush();
    expect(host.getMarkdown()).toBe(`XBefore.\n\n${raw}\n`);
  });

  it("escapes typed markup and reopens it as text", async () => {
    const { host, view } = await mount(
      "<table><tr><td>Text</td></tr></table>\n",
    );
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "Text") at = pos;
    });
    view.dispatch(view.state.tr.insertText("<script>alert(1)</script>", at));
    host.flush();
    expect(host.getMarkdown()).toContain("&lt;script&gt;");
    const reopened = await mount(host.getMarkdown());
    expect(reopened.root.querySelector("script")).toBeNull();
    expect(reopened.root.querySelector("td")?.textContent).toBe(
      "<script>alert(1)</script>Text",
    );
  });

  it("preserves neighbouring attributes when deleting a formatted text run", async () => {
    const { host, view } = await mount(
      '<table><tr><td><p class="meaning"><strong>A</strong><a href="https://example.com" rel="nofollow">B</a></p></td></tr></table>\n',
    );
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "A") at = pos;
    });
    view.dispatch(view.state.tr.delete(at, at + 1));
    host.flush();
    expect(host.getMarkdown()).toContain('<p class="meaning">');
    expect(host.getMarkdown()).toContain('rel="nofollow"');
    const reopened = await mount(host.getMarkdown());
    expect(reopened.root.querySelector("td")?.textContent).toBe("B");
  });

  it("preserves code and break attributes without leaking editor metadata", async () => {
    const { host, view } = await mount(
      '<table><tr><td><strong>A</strong><code class="language-go">B</code><br class="break">C</td></tr></table>\n',
    );
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "A") at = pos;
    });
    view.dispatch(view.state.tr.delete(at, at + 1));
    host.flush();
    expect(host.getMarkdown()).toContain('<code class="language-go">B</code>');
    expect(host.getMarkdown()).toContain('<br class="break">');
    expect(host.getMarkdown()).not.toContain("data-type");
    expect(host.getMarkdown()).not.toContain("data-is-inline");
  });

  it("preserves HTML and merged cells through the trusted clipboard path", async () => {
    const { host, view } = await mount(
      '<table class="copied"><tr><th colspan="2">Title</th></tr><tr><td>A</td><td>B</td></tr></table>\n',
    );
    const original = view.state.doc.firstChild!;
    const clipboard = view.serializeForClipboard(
      new Slice(view.state.doc.content, 0, 0),
    );
    const holder = document.createElement("div");
    holder.innerHTML = sanitizePastedHtml(clipboard.dom.innerHTML, document);
    const copied = DOMParser.fromSchema(view.state.schema).parse(
      holder,
    ).firstChild!;
    expect(copied.attrs.htmlTable).not.toBeNull();
    expect(copied.firstChild?.firstChild?.attrs.colspan).toBe(2);
    view.dispatch(view.state.tr.replaceWith(0, original.nodeSize, copied));
    host.flush();
    expect(host.getMarkdown()).toContain('class="copied"');
    expect(host.getMarkdown()).toContain('colspan="2"');
    expect(host.getMarkdown()).not.toContain("data-mdx");
  });

  it("keeps the existing single-paragraph constraint on GFM cells", async () => {
    const { view } = await mount("| A | B |\n| --- | --- |\n| One | Two |\n");
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.text === "One") at = pos + 1;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at)),
    );
    const before = view.state.doc;
    splitBlock(view.state, view.dispatch);
    expect(view.state.doc.eq(before)).toBe(true);
  });
});
