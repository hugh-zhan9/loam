import { describe, expect, it } from "vitest";
import { mergeExternalMarkdown } from "./merge-external-markdown";
import {
  createLoadedDocumentState,
  mergeExternalDocumentChange,
  updateDocumentMarkdown,
} from "./document-state";

describe("three-way external Markdown merge", () => {
  it.each([
    ["😀", "😁", "𝘀", null],
    [
      "| A | B | C |",
      "| Local | B | Other |",
      "| A | Disk | C |",
      "| Local | Disk | Other |",
    ],
    ["甲😀乙🙂丙", "甲😁乙🙂丙", "甲😀乙😉丙", "甲😁乙😉丙"],
    ["", "", "new", "new"],
    ["", "same", "same", "same"],
    ["", "left", "right", null],
    ["base", "local", "base", "local"],
    ["base", "base", "disk", "disk"],
    ["A\nB\nC\n", "Local\nB\nC\n", "A\nB\nDisk\n", "Local\nB\nDisk\n"],
    ["| A | B |\n", "| Local | B |\n", "| A | Disk |\n", "| Local | Disk |\n"],
    ["A\nB\nC\n", "B\nC\n", "A\nB\nDisk\n", "B\nDisk\n"],
    ["A\nB\nC\n", "X\nA\nB\nC\n", "A\nB\nC\nY\n", "X\nA\nB\nC\nY\n"],
    ["A\r\nB\r\n", "Local\r\nB\r\n", "A\r\nDisk\r\n", "Local\r\nDisk\r\n"],
    ["A\nB", "Local\nB", "A\nB\n", "Local\nB\n"],
    ["A\nB\nC", "Local\nB\nC", "Disk\nB\nC", null],
    ["ABC", "AXBC", "AYBC", null],
    ["ABC", "AC", "AXC", null],
    ["ABC", "AXBC", "AYC", null],
    ["A\nB\nC\nD", "X\nB\nL\nD", "X\nB\nC\nR", "X\nB\nL\nR"],
  ])("merges base %j, local %j and disk %j", (base, local, disk, expected) => {
    expect(mergeExternalMarkdown(base, local, disk)).toBe(expected);
    expect(mergeExternalMarkdown(base, disk, local)).toBe(expected);
  });

  it("moves the disk baseline while retaining local edits for subsequent refresh and save", () => {
    const state = updateDocumentMarkdown(
      createLoadedDocumentState({
        content: "A\nB\nC",
        realPath: "/note.md",
        displayPath: "/note.md",
        fileName: "note.md",
        fingerprint: "base",
      }),
      "Local\nB\nC",
    );
    const first = mergeExternalDocumentChange(state, {
      content: "A\nDisk\nC",
      fingerprint: "disk-1",
    })!;
    expect(first).toMatchObject({
      markdown: "Local\nDisk\nC",
      savedMarkdown: "A\nDisk\nC",
      fingerprint: "disk-1",
      dirty: true,
    });
    const second = mergeExternalDocumentChange(first, {
      content: "A\nDisk\nNext",
      fingerprint: "disk-2",
    });
    expect(second).toMatchObject({
      markdown: "Local\nDisk\nNext",
      savedMarkdown: "A\nDisk\nNext",
      fingerprint: "disk-2",
      dirty: true,
    });
    expect(
      mergeExternalDocumentChange(first, {
        content: first.markdown,
        fingerprint: "same",
      })?.dirty,
    ).toBe(false);
  });
});
