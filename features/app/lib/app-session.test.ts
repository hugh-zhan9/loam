import { describe, expect, it } from "vitest";

import { normalizeAppWindowSession } from "./app-session";

describe("normalizeAppWindowSession", () => {
    it("normalizes workspace sessions", () => {
        expect(normalizeAppWindowSession({ kind: "workspace" })).toEqual({
            kind: "workspace",
            rootPath: null,
            skippedRoots: [],
        });
    });

    it("carries the root a workspace window was opened for", () => {
        expect(
            normalizeAppWindowSession({
                kind: "workspace",
                rootPath: "/tmp/notes",
                skippedRoots: ["/Volumes/ext/blog"],
            }),
        ).toEqual({
            kind: "workspace",
            rootPath: "/tmp/notes",
            skippedRoots: ["/Volumes/ext/blog"],
        });
    });

    it("drops malformed roots rather than passing them on", () => {
        expect(
            normalizeAppWindowSession({
                kind: "workspace",
                rootPath: "",
                skippedRoots: ["/tmp/gone", "", 7, null],
            }),
        ).toEqual({
            kind: "workspace",
            rootPath: null,
            skippedRoots: ["/tmp/gone"],
        });
    });

    it("normalizes document sessions", () => {
        expect(
            normalizeAppWindowSession({
                kind: "document",
                fileName: "Note.md",
                displayPath: "/tmp/link.md",
                realPath: "/tmp/Note.md",
                workspaceDirty: true,
            }),
        ).toEqual({
            kind: "document",
            fileName: "Note.md",
            displayPath: "/tmp/link.md",
            realPath: "/tmp/Note.md",
            workspaceDirty: true,
        });
    });

    it("normalizes missing document workspace dirty flags to false", () => {
        expect(
            normalizeAppWindowSession({
                kind: "document",
                fileName: "Note.md",
                displayPath: "/tmp/Note.md",
                realPath: "/tmp/Note.md",
            }),
        ).toEqual({
            kind: "document",
            fileName: "Note.md",
            displayPath: "/tmp/Note.md",
            realPath: "/tmp/Note.md",
            workspaceDirty: false,
        });
    });

    it("falls back to document error for malformed document sessions", () => {
        expect(normalizeAppWindowSession({ kind: "document" })).toEqual({
            kind: "documentError",
            message: "无法打开文档。",
            path: null,
        });
    });
});
