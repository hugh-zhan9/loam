import type { DocumentFileResult, LoadedDocumentState } from "./types";
import { mergeExternalMarkdown } from "./merge-external-markdown";

export function createLoadedDocumentState(
  file: DocumentFileResult,
): LoadedDocumentState {
  return {
    fileName: file.fileName,
    displayPath: file.displayPath,
    realPath: file.realPath,
    markdown: file.content,
    savedMarkdown: file.content,
    fingerprint: file.fingerprint,
    dirty: false,
    outlineCollapsed: false,
  };
}

export function updateDocumentMarkdown(
  state: LoadedDocumentState,
  markdown: string,
): LoadedDocumentState {
  return {
    ...state,
    markdown,
    dirty: markdown !== state.savedMarkdown,
  };
}

export function markDocumentSaved(
  state: LoadedDocumentState,
  fingerprint: string,
  savedMarkdown = state.markdown,
): LoadedDocumentState {
  return {
    ...state,
    savedMarkdown,
    fingerprint,
    dirty: state.markdown !== savedMarkdown,
    deletedOnDisk: false,
  };
}

export function applyRecoveredDraft(
  state: LoadedDocumentState,
  markdown: string,
): LoadedDocumentState {
  return {
    ...state,
    markdown,
    dirty: markdown !== state.savedMarkdown,
    deletedOnDisk: false,
  };
}

export function applyExternalDocumentReload(
  state: LoadedDocumentState,
  file: { content: string; fingerprint: string },
): LoadedDocumentState {
  return {
    ...state,
    markdown: file.content,
    savedMarkdown: file.content,
    fingerprint: file.fingerprint,
    dirty: false,
    deletedOnDisk: false,
  };
}

export function mergeExternalDocumentChange(
  state: LoadedDocumentState,
  file: { content: string; fingerprint: string },
): LoadedDocumentState | null {
  const markdown = mergeExternalMarkdown(state.savedMarkdown, state.markdown, file.content);
  if (markdown === null) return null;
  return {
    ...state,
    markdown,
    savedMarkdown: file.content,
    fingerprint: file.fingerprint,
    dirty: markdown !== file.content,
    deletedOnDisk: false,
  };
}

export function createDocumentExternalConflict(
  state: LoadedDocumentState,
  file: { content: string; fingerprint: string },
) {
  return {
    path: state.realPath,
    currentMarkdown: state.markdown,
    diskMarkdown: file.content,
    diskFingerprint: file.fingerprint,
  };
}

export function markDocumentDeleted(
  state: LoadedDocumentState,
): LoadedDocumentState {
  return {
    ...state,
    deletedOnDisk: true,
  };
}

export function documentWindowTitle(state: LoadedDocumentState) {
  return `${state.dirty ? "● " : ""}${state.fileName} - Loam`;
}

export function canCloseDocumentWithoutPrompt(state: LoadedDocumentState) {
  return !state.dirty;
}
