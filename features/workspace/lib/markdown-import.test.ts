import { describe, expect, it } from "vitest";
import { planMarkdownImport } from "../components/markdown-import-control";

describe("Markdown folder import preview", () => {
    it("resolves nested, encoded and reference-style images without rewriting Markdown", () => {
        const markdown = "![photo][picture]\n\n[picture]: ../.assets/photo%20one.png\n\n![remote](https://example.test/image.png)\n\n`![example](missing.png)`";
        const notes = [
            { path: "notes/entry.md", note: markdown, collision: false },
            { path: ".assets/photo one.png", note: null, collision: false },
            { path: "assets/unreferenced.png", note: null, collision: false },
        ];
        expect(planMarkdownImport(notes)).toEqual({
            add: ["notes/entry.md", ".assets/photo one.png"], collisions: [], missing: [], blocked: [],
            dependencies: { "notes/entry.md": [".assets/photo one.png"] },
        });
        expect(notes[0].note).toBe(markdown);
    });

    it("lists note and attachment collisions, plus unresolved local references", () => {
        expect(planMarkdownImport([
            { path: "draft.md", note: "![dupe](assets/dupe.jpg)\n\n![missing](missing.png)\n\n![outside](../outside.png)", collision: false },
            { path: "existing.md", note: "", collision: true },
            { path: "assets/dupe.jpg", note: null, collision: true },
        ])).toEqual({
            add: [],
            collisions: ["existing.md", "assets/dupe.jpg"],
            dependencies: {},
            blocked: [{ note: "draft.md", url: "assets/dupe.jpg" }],
            missing: [{ note: "draft.md", url: "missing.png" }, { note: "draft.md", url: "../outside.png" }],
        });
    });

    it("includes linked local files but not other Markdown links or unrelated assets", () => {
        expect(planMarkdownImport([
            { path: "log.md", note: "[Receipt](files/a.pdf) [Missing](files/b.pdf) [Note](other.md)", collision: false },
            { path: "files/a.pdf", note: null, collision: false },
            { path: "files/c.pdf", note: null, collision: false },
        ])).toEqual({
            add: ["log.md", "files/a.pdf"], collisions: [], blocked: [],
            dependencies: { "log.md": ["files/a.pdf"] },
            missing: [{ note: "log.md", url: "files/b.pdf" }],
        });
    });
});
