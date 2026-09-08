import type { DiffLine } from "./types";

const MAX_LCS_CELLS = 1_000_000;
const FALLBACK_SYNC_WINDOW = 32;

export function buildLineDiff(leftText: string, rightText: string): DiffLine[] {
    return buildLineSequenceDiff(splitLines(leftText), splitLines(rightText));
}

/** Also accepts lines with terminators when exact source bytes matter. */
export function buildLineSequenceDiff(leftLines: string[], rightLines: string[]): DiffLine[] {
    const commonPrefixLength = countCommonPrefix(leftLines, rightLines);
    const commonSuffix = findCommonSuffix(
        leftLines,
        rightLines,
        commonPrefixLength,
    );
    const diffLines: DiffLine[] = [];

    appendEqualLines(
        diffLines,
        leftLines,
        commonPrefixLength,
        0,
        0,
    );

    const middleLeftLines = leftLines.slice(
        commonPrefixLength,
        commonSuffix.leftStart,
    );
    const middleRightLines = rightLines.slice(
        commonPrefixLength,
        commonSuffix.rightStart,
    );
    const middleDiffLines =
        (middleLeftLines.length + 1) * (middleRightLines.length + 1) >
        MAX_LCS_CELLS
            ? buildFallbackLineDiff(
                  middleLeftLines,
                  middleRightLines,
                  commonPrefixLength,
                  commonPrefixLength,
              )
            : buildLcsLineDiff(
                  middleLeftLines,
                  middleRightLines,
                  commonPrefixLength,
                  commonPrefixLength,
              );

    diffLines.push(...middleDiffLines);
    appendEqualLines(
        diffLines,
        leftLines.slice(commonSuffix.leftStart),
        leftLines.length - commonSuffix.leftStart,
        commonSuffix.leftStart,
        commonSuffix.rightStart,
    );

    return diffLines;
}

function buildLcsLineDiff(
    leftLines: string[],
    rightLines: string[],
    leftLineOffset: number,
    rightLineOffset: number,
): DiffLine[] {
    const lcs = buildLcsTable(leftLines, rightLines);
    const diffLines: DiffLine[] = [];

    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < leftLines.length && rightIndex < rightLines.length) {
        if (leftLines[leftIndex] === rightLines[rightIndex]) {
            diffLines.push({
                kind: "equal",
                leftLine: leftLineOffset + leftIndex + 1,
                rightLine: rightLineOffset + rightIndex + 1,
                text: leftLines[leftIndex],
            });
            leftIndex += 1;
            rightIndex += 1;
            continue;
        }

        if (lcs[leftIndex + 1][rightIndex] >= lcs[leftIndex][rightIndex + 1]) {
            diffLines.push({
                kind: "removed",
                leftLine: leftLineOffset + leftIndex + 1,
                rightLine: null,
                text: leftLines[leftIndex],
            });
            leftIndex += 1;
            continue;
        }

        diffLines.push({
            kind: "added",
            leftLine: null,
            rightLine: rightLineOffset + rightIndex + 1,
            text: rightLines[rightIndex],
        });
        rightIndex += 1;
    }

    while (leftIndex < leftLines.length) {
        diffLines.push({
            kind: "removed",
            leftLine: leftLineOffset + leftIndex + 1,
            rightLine: null,
            text: leftLines[leftIndex],
        });
        leftIndex += 1;
    }

    while (rightIndex < rightLines.length) {
        diffLines.push({
            kind: "added",
            leftLine: null,
            rightLine: rightLineOffset + rightIndex + 1,
            text: rightLines[rightIndex],
        });
        rightIndex += 1;
    }

    return diffLines;
}

function splitLines(value: string) {
    const lines = value.split(/\r?\n/);
    if (lines.at(-1) === "") {
        lines.pop();
    }
    return lines;
}

function buildLcsTable(leftLines: string[], rightLines: string[]): number[][] {
    const lcs = Array.from({ length: leftLines.length + 1 }, () =>
        Array<number>(rightLines.length + 1).fill(0),
    );

    for (let leftIndex = leftLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
        for (
            let rightIndex = rightLines.length - 1;
            rightIndex >= 0;
            rightIndex -= 1
        ) {
            lcs[leftIndex][rightIndex] =
                leftLines[leftIndex] === rightLines[rightIndex]
                    ? lcs[leftIndex + 1][rightIndex + 1] + 1
                    : Math.max(
                          lcs[leftIndex + 1][rightIndex],
                          lcs[leftIndex][rightIndex + 1],
                      );
        }
    }

    return lcs;
}

function buildFallbackLineDiff(
    leftLines: string[],
    rightLines: string[],
    leftLineOffset: number,
    rightLineOffset: number,
): DiffLine[] {
    const diffLines: DiffLine[] = [];
    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < leftLines.length && rightIndex < rightLines.length) {
        if (leftLines[leftIndex] === rightLines[rightIndex]) {
            diffLines.push({
                kind: "equal",
                leftLine: leftLineOffset + leftIndex + 1,
                rightLine: rightLineOffset + rightIndex + 1,
                text: leftLines[leftIndex],
            });
            leftIndex += 1;
            rightIndex += 1;
            continue;
        }

        const sync = findFallbackSync(leftLines, rightLines, leftIndex, rightIndex);

        if (sync?.kind === "added") {
            while (rightIndex < sync.rightIndex) {
                diffLines.push({
                    kind: "added",
                    leftLine: null,
                    rightLine: rightLineOffset + rightIndex + 1,
                    text: rightLines[rightIndex],
                });
                rightIndex += 1;
            }
            continue;
        }

        if (sync?.kind === "removed") {
            while (leftIndex < sync.leftIndex) {
                diffLines.push({
                    kind: "removed",
                    leftLine: leftLineOffset + leftIndex + 1,
                    rightLine: null,
                    text: leftLines[leftIndex],
                });
                leftIndex += 1;
            }
            continue;
        }

        diffLines.push({
            kind: "removed",
            leftLine: leftLineOffset + leftIndex + 1,
            rightLine: null,
            text: leftLines[leftIndex],
        });
        diffLines.push({
            kind: "added",
            leftLine: null,
            rightLine: rightLineOffset + rightIndex + 1,
            text: rightLines[rightIndex],
        });
        leftIndex += 1;
        rightIndex += 1;
    }

    while (leftIndex < leftLines.length) {
        diffLines.push({
            kind: "removed",
            leftLine: leftLineOffset + leftIndex + 1,
            rightLine: null,
            text: leftLines[leftIndex],
        });
        leftIndex += 1;
    }

    while (rightIndex < rightLines.length) {
        diffLines.push({
            kind: "added",
            leftLine: null,
            rightLine: rightLineOffset + rightIndex + 1,
            text: rightLines[rightIndex],
        });
        rightIndex += 1;
    }

    return diffLines;
}

function countCommonPrefix(leftLines: string[], rightLines: string[]) {
    const maxPrefixLength = Math.min(leftLines.length, rightLines.length);
    let prefixLength = 0;

    while (
        prefixLength < maxPrefixLength &&
        leftLines[prefixLength] === rightLines[prefixLength]
    ) {
        prefixLength += 1;
    }

    return prefixLength;
}

function findCommonSuffix(
    leftLines: string[],
    rightLines: string[],
    commonPrefixLength: number,
) {
    let leftStart = leftLines.length;
    let rightStart = rightLines.length;

    while (
        leftStart > commonPrefixLength &&
        rightStart > commonPrefixLength &&
        leftLines[leftStart - 1] === rightLines[rightStart - 1]
    ) {
        leftStart -= 1;
        rightStart -= 1;
    }

    return { leftStart, rightStart };
}

function appendEqualLines(
    diffLines: DiffLine[],
    lines: string[],
    lineCount: number,
    leftLineOffset: number,
    rightLineOffset: number,
) {
    for (let index = 0; index < lineCount; index += 1) {
        diffLines.push({
            kind: "equal",
            leftLine: leftLineOffset + index + 1,
            rightLine: rightLineOffset + index + 1,
            text: lines[index],
        });
    }
}

function findFallbackSync(
    leftLines: string[],
    rightLines: string[],
    leftIndex: number,
    rightIndex: number,
) {
    const maxAddedLookahead = Math.min(
        FALLBACK_SYNC_WINDOW,
        rightLines.length - rightIndex - 1,
    );
    const maxRemovedLookahead = Math.min(
        FALLBACK_SYNC_WINDOW,
        leftLines.length - leftIndex - 1,
    );

    for (let offset = 1; offset <= FALLBACK_SYNC_WINDOW; offset += 1) {
        if (
            offset <= maxAddedLookahead &&
            leftLines[leftIndex] === rightLines[rightIndex + offset]
        ) {
            return {
                kind: "added" as const,
                rightIndex: rightIndex + offset,
            };
        }

        if (
            offset <= maxRemovedLookahead &&
            leftLines[leftIndex + offset] === rightLines[rightIndex]
        ) {
            return {
                kind: "removed" as const,
                leftIndex: leftIndex + offset,
            };
        }
    }

    return null;
}
