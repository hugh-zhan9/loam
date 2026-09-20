import type { EditorSourceSelection } from "../../../packages/mdx-editor";

export type FileTreeNode = FileTreeFileNode | FileTreeFolderNode;

export interface FileTreeFileNode {
    kind: "file";
    name: string;
    path: string;
}

export interface FileTreeFolderNode {
    kind: "folder";
    name: string;
    path: string;
    children: FileTreeNode[];
}

export interface HighlightSegment {
    text: string;
    highlighted: boolean;
}

export type FilteredFileTreeNode =
    | (FileTreeFileNode & {
          nameSegments?: HighlightSegment[];
      })
    | (Omit<FileTreeFolderNode, "children"> & {
          children: FilteredFileTreeNode[];
          nameSegments?: HighlightSegment[];
      });

export interface MarkdownOutlineHeading {
    id: string;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    text: string;
    line: number;
    /**
     * The heading text's span in the Markdown source, as UTF-16 offsets.
     *
     * Navigation reveals this range through the editor adapter. It is the only
     * coordinate the outline hands across a module boundary: no rendered
     * element, no editor position.
     */
    range: EditorSourceSelection;
}

export interface WorkspaceTab {
    tabId: string;
    path: string;
    title: string;
    dirty: boolean;
    needsRenameOnFirstSave: boolean;
    markdown?: string;
    baseFingerprint?: string | null;
}

export interface CliSelectionSnapshot {
    has_selection: boolean;
    selected_text: string;
    before: string;
    after: string;
    before_truncated: boolean;
    after_truncated: boolean;
}

export interface CliWorkspaceTabSnapshot {
    tab_id: string;
    path: string;
    title: string;
    dirty: boolean;
}

export interface CliWorkspaceSnapshot {
    root_path: string | null;
    active_tab_id: string | null;
    tabs: CliWorkspaceTabSnapshot[];
}

export interface CliWorkspaceSyncPayload {
    workspace: CliWorkspaceSnapshot;
    tab_contents: Record<string, string>;
    tab_selections: Record<string, CliSelectionSnapshot | null>;
}

export interface CliFrontendHeartbeatPayload {
    root_path: string | null;
    has_workspace: boolean;
    root_present: boolean;
    visibility_state: string | null;
    location_href: string | null;
}

export interface CliEditorSnapshot {
    tabId: string;
    markdown: string;
    selection: CliSelectionSnapshot | null;
}

export interface PendingCliEditorCommand {
    id: string;
    kind: "focus" | "insert" | "scrollToLine";
    tabId: string;
    text?: string;
    lineNumber?: number;
}

export interface CliOpenFileEvent {
    path: string;
}

export interface CliTabEvent {
    tabId?: string;
}

export interface CliInsertEvent {
    tabId?: string;
    text: string;
}

export interface CliCloseEvent {
    tabId?: string;
    force: boolean;
}

export interface CliFileCreatedEvent {
    path: string;
    name: string;
    needsRenameOnFirstSave: boolean;
}

export interface CliFolderCreatedEvent {
    path: string;
    name: string;
}

export interface CliFileUpdatedEvent {
    path: string;
}

export interface CliPathRenamedEvent {
    oldPath: string;
    newPath: string;
    affectedPrefix?: AffectedPrefix | null;
}

export interface AffectedPrefix {
    oldPrefix: string;
    newPrefix: string;
}

export interface PathChangeResult {
    oldPath: string;
    newPath: string;
    affectedPrefix?: AffectedPrefix | null;
}

export interface WorkspacePanelState {
    /** Whether the navigator — rail and list together — is hidden. */
    navigatorCollapsed: boolean;
    /**
     * The two navigator columns, each with its own width.
     *
     * Independent rather than a total and a split: widening the folder tree
     * widens the navigator and takes the room from the editor, instead of
     * squeezing the note list, which is not what dragging a tree's edge is
     * asking for.
     */
    listWidth: number;
    railWidth: number;
    rightCollapsed: boolean;
    rightWidth: number;
}

export interface WorkspaceFileTreeActions {
    createFolder: () => Promise<void>;
    createMarkdownFile: () => Promise<void>;
    renameSelection: () => Promise<void>;
    deleteSelection: () => Promise<void>;
    /**
     * Moves one named file to the trash, wherever it was asked for.
     *
     * The tree owns deleting: it confirms, moves the file, closes the tabs that
     * were showing it and refreshes itself. Anything else that lists files — the
     * note list — asks for the same thing to happen rather than repeating it,
     * because a second copy of that sequence is a second chance to forget the
     * open tab.
     */
    trashFile: (path: string, name: string) => Promise<void>;
    refreshTree: () => Promise<void>;
}

/**
 * What the native File menu can ask this window to do.
 *
 * The tree's half is optional because the tree is a panel: it unmounts when the
 * sidebar is collapsed and in every view that is not the editor. Saving and
 * closing the active tab are not the tree's work and must not leave with it —
 * ⌘S means the same thing whether or not a folder list is on screen.
 */
export interface WorkspaceMenuActions
    extends Partial<WorkspaceFileTreeActions> {
    saveActiveTab: () => Promise<void>;
    closeActiveTab: () => Promise<void>;
}

export type WorkspaceSearchStatus =
    | "idle"
    | "typing"
    | "searching"
    | "complete"
    | "error";

export interface WorkspaceSearchResultItem {
    path: string;
    lineNumber: number;
    columnStart: number;
    columnEnd: number;
    line: string;
    before?: string | null;
    after?: string | null;
    dirty: boolean;
}

export interface WorkspaceSearchSummary {
    skippedLargeFiles: number;
    skippedUnreadableFiles: number;
    truncated: boolean;
    searchedFiles: number;
}

export interface WorkspaceSearchResponse {
    requestId: string;
    results: WorkspaceSearchResultItem[];
    skippedLargeFiles: number;
    skippedUnreadableFiles: number;
    truncated: boolean;
    searchedFiles: number;
}

export interface DirtySearchOverride {
    path: string;
    markdown: string;
}

export interface WorkspaceSearchState {
    query: string;
    caseSensitive?: boolean;
    status?: WorkspaceSearchStatus;
    requestId?: string | null;
    results?: WorkspaceSearchResultItem[];
    summary?: WorkspaceSearchSummary;
    error?: string | null;
}

export interface WorkspaceFullTextSearchState extends WorkspaceSearchState {
    caseSensitive: boolean;
    status: WorkspaceSearchStatus;
    requestId: string | null;
    results: WorkspaceSearchResultItem[];
    summary: WorkspaceSearchSummary;
    error: string | null;
}

export interface WorkspaceState {
    rootPath: string;
    fileTree: FileTreeNode[];
    tabs: Record<string, WorkspaceTab>;
    tabOrder: string[];
    activeTabId: string | null;
    panel: WorkspacePanelState;
    treeFilterQuery?: string;
    /**
     * The folder the file tree is showing, or null for the whole workspace.
     *
     * A workspace can hold directories the app itself manages — generated wiki
     * output, indexes, assets — and someone working in one subtree should not
     * have to look past them. This narrows the tree without hiding anything:
     * nothing is excluded from the workspace, one folder is being looked at.
     */
    treeFocusPath?: string | null;
    search: WorkspaceSearchState;
}

/** Which edge is being dragged: the note list's, the folder tree's, or the old right panel's. */
export type WorkspacePanelSide = "list" | "rail" | "right";

export interface PersistedAppState {
    stateVersion: number;
    recentWorkspaceRoot: string | null;
    preferences: AppPreferences;
    workspaces: PersistedWorkspaceState[];
    /** The size a window with no workspace bound to it opens at. */
    windowSize: PersistedWindowSize;
    /**
     * The roots that were open when the app last ran.
     *
     * Written by the Rust window registry, never by a window: only the
     * registry knows about every window.
     */
    openWorkspaceRoots: string[];
}

export interface AppPreferences {
    fileTreeExcludeDirs: string[];
    fileWatchEnabled: boolean;
    searchMaxFileBytes: number;
    searchMaxResults: number;
    searchMaxMatchesPerFile: number;
}

export interface PersistedWorkspaceState {
    rootPath: string;
    tabs: PersistedWorkspaceTab[];
    activeTabId: string | null;
    panels: WorkspacePanelState;
    /** The folder the tree was left showing, or null for the whole workspace. */
    treeFocusPath?: string | null;
    /**
     * This workspace's own window size.
     *
     * Absent until a window showing this root is resized; the top-level
     * windowSize is used until then.
     */
    windowSize?: PersistedWindowSize;
}

export interface PersistedWorkspaceTab {
    tabId: string;
    path: string;
    title: string;
    dirty: boolean;
    needsRenameOnFirstSave: boolean;
}

export interface PersistedWindowSize {
    width: number;
    height: number;
}

export type WorkspaceAction =
    | {
          type: "workspace/rootChanged";
          rootPath: string;
          fileTree?: FileTreeNode[];
      }
    | {
          type: "tree/loaded";
          fileTree: FileTreeNode[];
      }
    | {
          type: "tab/opened";
          tab: WorkspaceTab;
      }
    | {
          type: "tab/activated";
          tabId: string | null;
      }
    | {
          type: "tab/closed";
          tabId: string;
      }
    | {
          type: "tab/pathRemapped";
          fromPath: string;
          toPath: string;
      }
    | {
          type: "tab/prefixRemapped";
          affectedPrefix: AffectedPrefix;
      }
    | {
          type: "tab/closedByPath";
          path: string;
      }
    | {
          type: "tab/closedByPrefix";
          prefix: string;
      }
    | {
          type: "tab/contentChanged";
          tabId: string;
          markdown: string;
      }
    | {
          type: "tab/saved";
          tabId: string;
          markdown?: string;
          fingerprint?: string;
      }
    | {
          type: "tab/savedIfUnchanged";
          tabId: string;
          markdown: string;
          fingerprint?: string;
      }
    | {
          type: "tab/renamed";
          tabId: string;
          path: string;
          title?: string;
          needsRenameOnFirstSave?: boolean;
      }
    | {
          type: "panel/resized";
          side: WorkspacePanelSide;
          width: number;
      }
    | {
          type: "panel/collapsedChanged";
          side: WorkspacePanelSide;
          collapsed: boolean;
      }
    | {
          type: "tree/focusChanged";
          /** A folder inside the workspace, or null to show the whole tree. */
          path: string | null;
      }
    | {
          type: "treeFilter/queryChanged";
          query: string;
      }
    | {
          type: "search/queryChanged";
          query: string;
      }
    | {
          type: "search/caseSensitivityToggled";
      }
    | {
          type: "search/requestStarted";
          requestId: string;
      }
    | {
          type: "search/requestCompleted";
          requestId: string;
          results: WorkspaceSearchResultItem[];
          summary: WorkspaceSearchSummary;
      }
    | {
          type: "search/requestFailed";
          requestId: string;
          error: string;
      };
