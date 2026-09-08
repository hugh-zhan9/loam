import { buildLineSequenceDiff } from "@/features/recovery/lib/line-diff";

interface Edit {
  from: number;
  to: number;
  text: string;
}

/** Three-way source merge. Null means that choosing a version needs the user. */
export function mergeExternalMarkdown(
  base: string,
  local: string,
  disk: string,
): string | null {
  if (local === disk || local === base) return disk;
  if (disk === base) return local;

  const localEdits = editsFrom(base, local);
  const diskEdits = editsFrom(base, disk);
  const merged: Edit[] = [];
  let localIndex = 0;
  let diskIndex = 0;
  while (localIndex < localEdits.length || diskIndex < diskEdits.length) {
    const left = localEdits[localIndex];
    const right = diskEdits[diskIndex];
    if (!left) {
      merged.push(right);
      diskIndex += 1;
    } else if (!right) {
      merged.push(left);
      localIndex += 1;
    } else if (
      left.from === right.from &&
      left.to === right.to &&
      left.text === right.text
    ) {
      merged.push(left);
      localIndex += 1;
      diskIndex += 1;
    } else if (overlaps(left, right)) {
      return null;
    } else if (left.from < right.from) {
      merged.push(left);
      localIndex += 1;
    } else {
      merged.push(right);
      diskIndex += 1;
    }
  }

  const parts: string[] = [];
  let offset = 0;
  for (const edit of merged) {
    parts.push(base.slice(offset, edit.from), edit.text);
    offset = edit.to;
  }
  parts.push(base.slice(offset));
  return parts.join("");
}

function overlaps(left: Edit, right: Edit) {
  // Inserts at a replacement boundary have ambiguous ordering. Do not guess.
  if (left.from === left.to || right.from === right.to) {
    return left.from <= right.to && right.from <= left.to;
  }
  return left.from < right.to && right.from < left.to;
}

function editsFrom(base: string, changed: string): Edit[] {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const diff = buildLineSequenceDiff(lines(base), lines(changed));
  return collectEdits(diff).flatMap((edit) => {
    // Refine each changed block at Unicode character boundaries. Multiple
    // edits to one table row must not turn its untouched cells into conflicts.
    const characters = buildLineSequenceDiff(
      Array.from(base.slice(edit.from, edit.to)),
      Array.from(edit.text),
    );
    return collectEdits(characters, edit.from);
  });
}

function collectEdits(
  diff: ReturnType<typeof buildLineSequenceDiff>,
  start = 0,
): Edit[] {
  const edits: Edit[] = [];
  let offset = start;
  let pending: Edit | null = null;
  for (const line of diff) {
    if (line.kind === "equal") {
      if (pending) edits.push(pending);
      pending = null;
      offset += line.text.length;
    } else {
      pending ??= { from: offset, to: offset, text: "" };
      if (line.kind === "removed") {
        offset += line.text.length;
        pending.to = offset;
      } else {
        pending.text += line.text;
      }
    }
  }
  if (pending) edits.push(pending);
  return edits;
}
