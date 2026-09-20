export type AppWindowSession =
    | {
          kind: "workspace";
          /**
           * The root this window was opened for, or null when it has to pick
           * one itself.
           */
          rootPath: string | null;
          /**
           * Roots the app could not restore at launch, handed to the first
           * window that asks so it can say so. Empty for every other window.
           */
          skippedRoots: string[];
      }
    | {
          kind: "document";
          fileName: string;
          displayPath: string;
          realPath: string;
          workspaceDirty?: boolean;
      }
    | {
          kind: "documentError";
          message: string;
          path: string | null;
      };

const DOCUMENT_OPEN_ERROR_MESSAGE = "无法打开文档。";

function emptyWorkspaceSession(): AppWindowSession {
    return { kind: "workspace", rootPath: null, skippedRoots: [] };
}

export function normalizeAppWindowSession(input: unknown): AppWindowSession {
    if (!input || typeof input !== "object" || !("kind" in input)) {
        return emptyWorkspaceSession();
    }

    const raw = input as Record<string, unknown>;

    if (raw.kind === "workspace") {
        return {
            kind: "workspace",
            rootPath: typeof raw.rootPath === "string" && raw.rootPath
                ? raw.rootPath
                : null,
            skippedRoots: Array.isArray(raw.skippedRoots)
                ? raw.skippedRoots.filter(
                      (root): root is string =>
                          typeof root === "string" && root.length > 0,
                  )
                : [],
        };
    }

    if (
        raw.kind === "document" &&
        typeof raw.fileName === "string" &&
        typeof raw.displayPath === "string" &&
        typeof raw.realPath === "string"
    ) {
        return {
            kind: "document",
            fileName: raw.fileName,
            displayPath: raw.displayPath,
            realPath: raw.realPath,
            workspaceDirty: raw.workspaceDirty === true,
        };
    }

    if (raw.kind === "documentError") {
        return {
            kind: "documentError",
            message:
                typeof raw.message === "string"
                    ? raw.message
                    : DOCUMENT_OPEN_ERROR_MESSAGE,
            path: typeof raw.path === "string" ? raw.path : null,
        };
    }

    return {
        kind: "documentError",
        message: DOCUMENT_OPEN_ERROR_MESSAGE,
        path: null,
    };
}
