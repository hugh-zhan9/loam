"use client";

import {
  BookOpen,
  Brain,
  Code2,
  FileText,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { nanoid } from "nanoid";
import { tauriCore } from "@/common/lib/tauri";
import { useFileWatch } from "@/features/file-watch/hooks/use-file-watch";
import { DocumentStatusBar } from "@/features/editor/components/document-status-bar";
import { createEditorSessionBinding } from "@/features/editor/lib/editor-session-binding";
import type {
  EditorReplaceReason,
  EditorSurfaceMode,
} from "../../../packages/mdx-editor";
import {
  decideWorkspaceExternalChange,
  documentFingerprint,
} from "@/features/file-watch/lib/external-change";
import { LlmWikiPanel, useLlmWikiWorkspace } from "@/features/llm-wiki";
import { MemoryPanel } from "@/features/memory";
import { DiffViewer } from "@/features/recovery/components/diff-viewer";
import { RecoveryBanner } from "@/features/recovery/components/recovery-banner";
import { useDraftAutosave } from "@/features/recovery/hooks/use-draft-autosave";
import {
  draftCleanupExpired,
  draftDelete,
  draftGet,
  draftListForWorkspace,
  draftSave,
} from "@/features/recovery/lib/draft-client";
import {
  IconButton,
  SegmentedControl,
} from "../../../common/components/ui-controls";
import { usePanelResize } from "../hooks/use-panel-resize";
import { syncCliWorkspaceSnapshot } from "../lib/cli-sync";
import { refreshCleanOpenTabFromDisk } from "../lib/cli-file-updated";
import { parseMarkdownOutline } from "../lib/outline";
import { useNotePages } from "../hooks/use-note-pages";
import type { NoteGroup } from "../lib/note-index";
import { calculateWorkspacePanelLayout } from "../lib/panel-layout";
import {
  isMarkdownFilePath,
  normalizeWorkspacePath,
  workspaceRelativePath,
} from "../lib/path";
import {
  buildWorkspaceViewToggles,
  type WorkspaceView,
} from "../lib/workspace-views";
import type { MarkdownEditorSurfaceHandle } from "@/features/editor/components/markdown-editor-surface";
import {
  collectDirtySearchOverrides,
  ensureWorkspaceSearchState,
  normalizeSearchQuery,
  queueWorkspaceSearchCancellation,
  shouldAcceptSearchResponse,
} from "../lib/workspace-search";
import { createTabSaveQueue, dirname } from "../lib/workspace-save";
import { dirtyWorkspacePaths } from "../lib/dirty-paths";
import { workspaceReducer } from "../lib/workspace-reducer";
import { resolveWikilinkFile } from "../lib/wikilink";
import type { DraftRecord, DraftSummary } from "@/features/recovery/lib/types";
import type {
  CliCloseEvent,
  CliFileCreatedEvent,
  CliFileUpdatedEvent,
  CliFolderCreatedEvent,
  CliInsertEvent,
  CliOpenFileEvent,
  CliPathRenamedEvent,
  CliSelectionSnapshot,
  CliTabEvent,
  FileTreeNode,
  AppPreferences,
  MarkdownOutlineHeading,
  PendingCliEditorCommand,
  WorkspaceFileTreeActions,
  WorkspaceMenuActions,
  WorkspaceAction,
  WorkspaceSearchResponse,
  WorkspaceSearchResultItem,
  WorkspaceState,
  WorkspaceTab,
} from "../lib/types";
import type { SaveQueue } from "../lib/workspace-save";
import { EditorStage } from "./editor-stage";
import { FileTreePanel } from "./file-tree-panel";
import { useAppDialogs } from "./app-dialogs";
import { WorkspaceNavigator } from "./workspace-navigator";
import type { NavigatorTab } from "./workspace-navigator";
import { AppearanceButton } from "./appearance-button";
import { SettingsButton } from "./settings-button";
import { TabStrip } from "./tab-strip";
import type {
  FrontendFileWatchEvent,
  SelfWriteMarker,
  WatchErrorPayload,
} from "@/features/file-watch/lib/types";
import { stopListening } from "@/common/lib/tauri-events";

interface WorkspaceShellProps {
  workspace: WorkspaceState;
  dispatch: (action: WorkspaceAction) => void;
  onChooseWorkspace: () => void;
  canChooseWorkspace: boolean;
  message?: string | null;
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => Promise<void>;
  onActionsChange: (actions: WorkspaceMenuActions | null) => void;
}

interface ScanWorkspaceResult {
  rootPath: string;
  nodes: FileTreeNode[];
}

interface CreateMarkdownFileResult {
  path: string;
  name: string;
  needsRenameOnFirstSave?: boolean;
}

interface ActiveDraftRecovery {
  tabId: string;
  path: string;
  draft: DraftRecord;
  fileExists: boolean;
}

interface ExternalWorkspaceConflict {
  tabId: string;
  path: string;
  diskMarkdown: string;
}

interface ExternalDeletedPrompt {
  tabId: string;
  path: string;
  dirty: boolean;
}

const WORKSPACE_VIEW_TOGGLES = buildWorkspaceViewToggles();

/**
 * The two surfaces, named the way the editor's own refusals name them.
 *
 * Short labels on purpose: this control sits in a title bar next to the
 * document's name, and the pair only has to be told apart from each other.
 */
const EDITOR_MODE_OPTIONS: ReadonlyArray<{
  value: EditorSurfaceMode;
  label: string;
  icon: ReactNode;
}> = [
  { value: "wysiwyg", label: "可视模式", icon: <FileText /> },
  { value: "source", label: "源码模式", icon: <Code2 /> },
];

export function WorkspaceShell({
  workspace,
  dispatch,
  onChooseWorkspace,
  canChooseWorkspace,
  message,
  preferences,
  onPreferencesChange,
  onActionsChange,
}: WorkspaceShellProps) {
  const dialogs = useAppDialogs();
  // The workspace session owns editor revisions for every tab it holds. The
  // binding decides nothing about files: it only stamps revisions on outgoing
  // snapshots and judges the identity and revision of incoming changes.
  const [editorSession] = useState(createEditorSessionBinding);
  const workspaceRef = useRef(workspace);
  const saveQueueRef = useRef<SaveQueue | null>(null);
  const workspaceRootRef = useRef<string | null>(null);
  const syncedCliWorkspaceRootRef = useRef<string | null>(null);
  const autosaveCreateFlushTaskRef = useRef<() => () => Promise<void>>(
    () => async () => {},
  );
  const draftMutationByPathRef = useRef<Record<string, Promise<void>>>({});
  const pendingSaveAsDraftByTabRef = useRef<Record<string, DraftSummary>>({});
  const editorSurfaceRef = useRef<MarkdownEditorSurfaceHandle | null>(null);
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const selectionByTabRef = useRef<Record<string, CliSelectionSnapshot | null>>(
    {},
  );
  const selfWriteMarkerRef = useRef<SelfWriteMarker | null>(null);
  const selfWriteMarkerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [fileTreeActions, setFileTreeActions] =
    useState<WorkspaceFileTreeActions | null>(null);
  const [pendingCliCommand, setPendingCliCommand] =
    useState<PendingCliEditorCommand | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
    "editor",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Outlives the editor stage, which the Memory and LLM Wiki views replace.
  const [imageFailure, setImageFailure] = useState<string | null>(null);
  /**
   * Which surface the editor settled on, as reported by the editor.
   *
   * Never set by the control that changes it: the adapter can refuse a switch,
   * and a toolbar that moved on its own would then be showing a mode the
   * document is not in.
   */
  const [editorMode, setEditorMode] = useState<EditorSurfaceMode>("wysiwyg");
  /** Which notes the navigator is listing, and what has been typed to narrow them. */
  const [noteGroup, setNoteGroup] = useState<NoteGroup>("all");
  const [noteQuery, setNoteQuery] = useState("");
  /**
   * The filter as the backend is asked about it.
   *
   * Behind what is typed, because answering it means walking the workspace: at
   * a keystroke each, a long word would ask twenty-seven thousand questions to
   * get to the one that mattered.
   */
  const [settledNoteQuery, setSettledNoteQuery] = useState("");
  /** Whether the navigator's second column is the note list or the outline. */
  const [navigatorTab, setNavigatorTab] = useState<NavigatorTab>("notes");
  /**
   * The clock a note's age is measured against.
   *
   * Held rather than read while rendering, so every row in one paint agrees on
   * what "now" is, and stepped once a minute because "41分钟前" stops being true.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [workspaceBodyWidth, setWorkspaceBodyWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [initialEditorLoadSettled, setInitialEditorLoadSettled] =
    useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [activeDraftRecovery, setActiveDraftRecovery] =
    useState<ActiveDraftRecovery | null>(null);
  const [activeDraftDetailsOpen, setActiveDraftDetailsOpen] = useState(true);
  const [activeDraftDiffOpen, setActiveDraftDiffOpen] = useState(false);
  const [externalConflict, setExternalConflict] =
    useState<ExternalWorkspaceConflict | null>(null);
  const [externalConflictDiffOpen, setExternalConflictDiffOpen] =
    useState(false);
  const [externalDeletedPrompt, setExternalDeletedPrompt] =
    useState<ExternalDeletedPrompt | null>(null);
  const externalConflictRef = useRef<ExternalWorkspaceConflict | null>(null);
  const externalDeletedPromptRef = useRef<ExternalDeletedPrompt | null>(null);
  const externalPathVersionsRef = useRef<Record<string, number>>({});
  const activeSearchRequestIdRef = useRef<string | null>(null);
  const searchCancellationRef = useRef<Promise<void>>(Promise.resolve());
  const [orphanDrafts, setOrphanDrafts] = useState<DraftSummary[]>([]);
  const [postponedOrphanDraftIds, setPostponedOrphanDraftIds] = useState<
    Set<string>
  >(() => new Set());
  const llmWiki = useLlmWikiWorkspace(workspace.rootPath, {
    canAutoProcess: initialEditorLoadSettled,
  });
  const handleRawFileSavedRef = useRef(llmWiki.handleRawFileSaved);
  const treeFilterQuery = workspace.treeFilterQuery ?? "";
  const fullTextSearchState = ensureWorkspaceSearchState(workspace.search);
  const tabs = workspace.tabOrder
    .map((tabId) => workspace.tabs[tabId])
    .filter((tab): tab is WorkspaceTab => Boolean(tab));
  const activeTab = workspace.activeTabId
    ? (workspace.tabs[workspace.activeTabId] ?? null)
    : null;
  const activeTabId = activeTab?.tabId ?? null;
  const activeTabPath = activeTab?.path ?? null;
  const activeTabMarkdownLoaded = activeTab?.markdown !== undefined;
  const activeHeadings = useMemo(
    () =>
      activeTab?.markdown === undefined
        ? []
        : parseMarkdownOutline(activeTab.markdown),
    [activeTab],
  );
  const activeTabIsLoadedMarkdown = Boolean(
    activeTabPath &&
    isMarkdownFilePath(activeTabPath) &&
    activeTabMarkdownLoaded,
  );
  const handleDraftAutosaveError = useCallback((error: unknown) => {
    console.warn("Failed to autosave workspace draft.", error);
  }, []);
  const draftAutosave = useDraftAutosave({
    enabled: isTauriRuntime(),
    realPath: activeTabIsLoadedMarkdown ? activeTabPath : null,
    displayPath: activeTabIsLoadedMarkdown ? activeTabPath : null,
    markdown: activeTabIsLoadedMarkdown ? (activeTab?.markdown ?? null) : null,
    dirty: activeTabIsLoadedMarkdown ? (activeTab?.dirty ?? false) : false,
    baseFingerprint: activeTabIsLoadedMarkdown
      ? (activeTab?.baseFingerprint ?? null)
      : null,
    mode: "workspace",
    onError: handleDraftAutosaveError,
  });
  const visibleOrphanDrafts = useMemo(
    () =>
      orphanDrafts.filter(
        (draft) => !postponedOrphanDraftIds.has(draft.draftId),
      ),
    [orphanDrafts, postponedOrphanDraftIds],
  );
  const activeExternalConflict =
    externalConflict?.tabId === activeTabId ? externalConflict : null;
  const activeExternalDeletedPrompt =
    externalDeletedPrompt?.tabId === activeTabId
      ? externalDeletedPrompt
      : null;
  const isMemoryView = workspaceView === "memory";
  const isLlmWikiView = workspaceView === "llmWiki";
  /**
   * Whether the editor is what the window is showing.
   *
   * Memory and LLM Wiki are full-window views that replace it, so everything
   * that acts on a document — the panels, the outline, PDF export — is asking
   * this rather than naming any one of them.
   */
  /**
   * How many times the file tree has been replaced.
   *
   * A counter rather than a serialisation of the tree: the tree can hold a
   * hundred thousand entries, and every mutation hands back a new array, so its
   * identity is already the signal. The first render's tree is not a change.
   */
  const [noteIndexFileTreeVersion, setNoteIndexFileTreeVersion] = useState(0);
  const seenFileTreeRef = useRef(workspace.fileTree);

  useEffect(() => {
    if (seenFileTreeRef.current === workspace.fileTree) {
      return;
    }

    seenFileTreeRef.current = workspace.fileTree;
    setNoteIndexFileTreeVersion((version) => version + 1);
  }, [workspace.fileTree]);

  const isEditorView = workspaceView === "editor";
  /**
   * What makes the note list stale.
   *
   * The set of files, and any tab going from unsaved to saved: a save changes a
   * note's opening lines and its time without changing the tree, so the tree
   * alone would leave the row showing what the note used to say.
   */
  const noteIndexRevalidateKey = useMemo(
    () =>
      [
        noteIndexFileTreeVersion,
        ...tabs.map((tab) => `${tab.path}:${tab.dirty ? 1 : 0}`),
      ].join("|"),
    [noteIndexFileTreeVersion, tabs],
  );
  const notePages = useNotePages(workspace.rootPath, isTauriRuntime(), {
    group: noteGroup,
    query: settledNoteQuery,
    // The same folder the tree is showing: looking at one folder means looking
    // at its notes, not at the whole workspace's.
    focusPath: workspace.treeFocusPath ?? null,
    revalidateKey: noteIndexRevalidateKey,
  });
  /** What the window is showing, for the title slot, while it is not a document. */
  const activeWorkspaceViewLabel =
    WORKSPACE_VIEW_TOGGLES.find((toggle) => toggle.view === workspaceView)
      ?.openLabel ?? "";

  useEffect(() => {
    externalConflictRef.current = externalConflict;
  }, [externalConflict]);

  useEffect(() => {
    externalDeletedPromptRef.current = externalDeletedPrompt;
  }, [externalDeletedPrompt]);

  useEffect(() => {
    setWorkspaceView("editor");
    externalPathVersionsRef.current = {};
    setInitialEditorLoadSettled(false);
    setPostponedOrphanDraftIds(new Set());
    setExternalConflict(null);
    setExternalConflictDiffOpen(false);
    setExternalDeletedPrompt(null);
  }, [workspace.rootPath]);

  useEffect(() => {
    if (
      !activeTab ||
      activeTab.markdown !== undefined ||
      !isMarkdownFilePath(activeTab.path)
    ) {
      setInitialEditorLoadSettled(true);
    }
  }, [activeTab]);

  useEffect(() => {
    autosaveCreateFlushTaskRef.current = draftAutosave.createFlushTask;
  }, [draftAutosave.createFlushTask]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void draftCleanupExpired(30).catch((error) => {
      console.warn("Failed to clean expired drafts.", error);
    });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setDraftMessage(null);
      setOrphanDrafts([]);
      setPostponedOrphanDraftIds(new Set());
      return;
    }

    let cancelled = false;
    const rootPath = workspace.rootPath;

    async function loadWorkspaceDrafts() {
      try {
        const result = await draftListForWorkspace(rootPath);

        if (cancelled || workspaceRef.current.rootPath !== rootPath) {
          return;
        }

        const orphanedDrafts = result.drafts.filter(
          (draft) => !draft.fileExists,
        );
        setOrphanDrafts(orphanedDrafts);
        setDraftMessage(
          result.drafts.length > 0
            ? `发现 ${result.drafts.length} 个未保存草稿`
            : null,
        );
      } catch (error) {
        if (!cancelled && workspaceRef.current.rootPath === rootPath) {
          console.warn("Failed to list workspace drafts.", error);
          setDraftMessage(null);
          setOrphanDrafts([]);
        }
      }
    }

    void loadWorkspaceDrafts();

    return () => {
      cancelled = true;
    };
  }, [workspace.rootPath]);

  useEffect(() => {
    if (
      !isTauriRuntime() ||
      !activeTabIsLoadedMarkdown ||
      !activeTabId ||
      !activeTabPath
    ) {
      setActiveDraftRecovery(null);
      setActiveDraftDiffOpen(false);
      return;
    }

    let cancelled = false;
    const tabId = activeTabId;
    const path = activeTabPath;
    setActiveDraftRecovery((current) =>
      current && (current.tabId !== tabId || current.path !== path)
        ? null
        : current,
    );
    setActiveDraftDiffOpen(false);

    async function loadActiveDraft() {
      try {
        const result = await draftGet(path);

        if (
          cancelled ||
          workspaceRef.current.activeTabId !== tabId ||
          workspaceRef.current.tabs[tabId]?.path !== path
        ) {
          return;
        }

        setActiveDraftRecovery((current) => {
          if (!result.draft) {
            return current?.tabId === tabId && current.path === path
              ? null
              : current;
          }

          if (
            current?.tabId === tabId &&
            current.path === path &&
            current.draft.draftId === result.draft.draftId
          ) {
            return {
              ...current,
              draft: result.draft,
              fileExists: result.fileExists,
            };
          }

          return {
            tabId,
            path,
            draft: result.draft,
            fileExists: result.fileExists,
          };
        });
        if (result.draft) {
          setActiveDraftDetailsOpen(true);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to load active workspace draft.", error);
        }
      }
    }

    void loadActiveDraft();

    return () => {
      cancelled = true;
    };
  }, [
    activeTabId,
    activeTabIsLoadedMarkdown,
    activeTabMarkdownLoaded,
    activeTabPath,
  ]);

  useLayoutEffect(() => {
    workspaceRef.current = workspace;
    handleRawFileSavedRef.current = llmWiki.handleRawFileSaved;
    if (workspaceRootRef.current !== workspace.rootPath) {
      workspaceRootRef.current = workspace.rootPath;
      saveQueueRef.current = null;
    }
  }, [llmWiki.handleRawFileSaved, workspace]);

  // A closed tab is not a document any more, so a late change carrying its id
  // has nowhere to land. Dropping it here also keeps the tracked Markdown from
  // outliving the tabs of a long session.
  useEffect(() => {
    editorSession.retain(workspace.tabOrder);
  }, [editorSession, workspace.tabOrder]);

  useEffect(() => {
    if (
      syncedCliWorkspaceRootRef.current === workspace.rootPath ||
      !isTauriRuntime()
    ) {
      return;
    }

    syncedCliWorkspaceRootRef.current = workspace.rootPath;
    void syncCliWorkspaceSnapshot(workspace, selectionByTabRef.current).catch(
      (error) => {
        console.warn("Failed to sync CLI workspace snapshot.", error);
      },
    );
  }, [workspace]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const paths = dirtyWorkspacePaths(workspace);
    void tauriCore()
      .then(({ invoke }) => invoke("update_workspace_dirty_paths", { paths }))
      .catch((error) => {
        console.warn("Failed to update workspace dirty paths.", error);
      });
  }, [workspace]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    return () => {
      void tauriCore()
        .then(({ invoke }) =>
          invoke("update_workspace_dirty_paths", { paths: [] }),
        )
        .catch((error) => {
          console.warn("Failed to clear workspace dirty paths.", error);
        });
    };
  }, []);

  const enqueueWorkspaceDraftMutation = useCallback(
    (realPath: string, mutation: () => Promise<void>) => {
      const key = normalizeWorkspacePath(realPath);
      const previous = draftMutationByPathRef.current[key] ?? Promise.resolve();
      const next = previous.then(mutation);
      const stored = next.catch(() => undefined);

      draftMutationByPathRef.current = {
        ...draftMutationByPathRef.current,
        [key]: stored,
      };
      stored.then(() => {
        if (draftMutationByPathRef.current[key] !== stored) {
          return;
        }

        const remaining = { ...draftMutationByPathRef.current };
        delete remaining[key];
        draftMutationByPathRef.current = remaining;
      });

      return next;
    },
    [],
  );
  const deleteWorkspaceDraftForPath = useCallback(
    async (realPath: string, draftId?: string) => {
      await enqueueWorkspaceDraftMutation(realPath, async () => {
        if (draftId) {
          await draftDelete({ draftId, realPath });
          return;
        }

        await draftDelete({ realPath });
      });
    },
    [enqueueWorkspaceDraftMutation],
  );
  const flushWorkspaceDraftForTab = useCallback(
    async (tab: WorkspaceTab | undefined) => {
      if (!shouldSaveWorkspaceTabDraft(tab)) {
        return;
      }

      try {
        const flushTask =
          tab.tabId === workspaceRef.current.activeTabId
            ? autosaveCreateFlushTaskRef.current()
            : async () => {
                await draftSave({
                  realPath: tab.path,
                  displayPath: tab.path,
                  markdown: tab.markdown,
                  baseFingerprint: tab.baseFingerprint ?? null,
                  mode: "workspace",
                });
              };

        await enqueueWorkspaceDraftMutation(tab.path, flushTask);
      } catch (error) {
        console.warn("Failed to flush workspace draft.", error);
      }
    },
    [enqueueWorkspaceDraftMutation],
  );
  const deleteWorkspaceDraftForTab = useCallback(
    async (tab: WorkspaceTab | undefined) => {
      if (!isTauriRuntime() || !tab || !isMarkdownFilePath(tab.path)) {
        return;
      }

      try {
        await deleteWorkspaceDraftForPath(tab.path);
      } catch (error) {
        console.warn("Failed to delete discarded workspace draft.", error);
      }
    },
    [deleteWorkspaceDraftForPath],
  );

  const dispatchAndMirror = useCallback(
    (action: WorkspaceAction, options?: { skipDraftFlush?: boolean }) => {
      if (!options?.skipDraftFlush) {
        const tabsToFlush = draftTabsForAction(workspaceRef.current, action);
        for (const tab of tabsToFlush) {
          void flushWorkspaceDraftForTab(tab);
        }
      }

      workspaceRef.current = workspaceReducer(workspaceRef.current, action);
      dispatch(action);
      if (isTauriRuntime()) {
        void syncCliWorkspaceSnapshot(
          workspaceRef.current,
          selectionByTabRef.current,
        ).catch((error) => {
          console.warn("Failed to sync CLI workspace snapshot.", error);
        });
      }
    },
    [dispatch, flushWorkspaceDraftForTab],
  );

  /**
   * Dispatches content the session itself authored — a disk reload, a conflict
   * resolution, a restored draft — and tells the editor binding so the surface
   * is replaced deliberately instead of being asked to accept content it never
   * produced.
   */
  const dispatchEditorReplace = useCallback(
    (
      declaration: { tabId: string; markdown: string; reason: EditorReplaceReason },
      action: WorkspaceAction,
      options?: { skipDraftFlush?: boolean },
    ) => {
      editorSession.declareReplace({
        documentId: declaration.tabId,
        markdown: declaration.markdown,
        reason: declaration.reason,
      });
      dispatchAndMirror(action, options);
    },
    [dispatchAndMirror, editorSession],
  );

  const refreshCurrentTree = useCallback(async () => {
    await refreshTree(
      workspaceRef.current.rootPath,
      () => workspaceRef.current.rootPath,
      dispatchAndMirror,
      preferences,
    );
  }, [dispatchAndMirror, preferences]);

  const readWorkspaceMarkdown = useCallback(async (path: string) => {
    const { invoke } = await tauriCore();

    return invoke<string>("read_markdown_file", {
      rootPath: workspaceRef.current.rootPath,
      path,
    });
  }, []);

  const cancelWorkspaceSearchRequest = useCallback(
    async (requestId: string | null) => {
      if (!requestId || !isTauriRuntime()) {
        return;
      }

      try {
        const { invoke } = await tauriCore();
        await invoke("workspace_search_cancel", {
          requestId,
        });
      } catch (error) {
        if (!isSearchRequestNotFoundError(error)) {
          console.warn("Failed to cancel workspace search request.", error);
        }
      } finally {
        if (activeSearchRequestIdRef.current === requestId) {
          activeSearchRequestIdRef.current = null;
        }
      }
    },
    [],
  );

  const clearSelfWriteMarker = useCallback(() => {
    selfWriteMarkerRef.current = null;

    if (selfWriteMarkerTimerRef.current) {
      clearTimeout(selfWriteMarkerTimerRef.current);
      selfWriteMarkerTimerRef.current = null;
    }
  }, []);

  const rememberSelfWrite = useCallback(
    (path: string, markdown: string) => {
      clearSelfWriteMarker();
      selfWriteMarkerRef.current = {
        path,
        markdown,
        fingerprint: documentFingerprint(markdown),
      };
      selfWriteMarkerTimerRef.current = setTimeout(() => {
        selfWriteMarkerRef.current = null;
        selfWriteMarkerTimerRef.current = null;
      }, 5_000);
    },
    [clearSelfWriteMarker],
  );

  const clearSavedExternalPrompts = useCallback(
    (savedTabId: string | undefined, savedPath: string) => {
      const normalizedSavedPath = normalizeWorkspacePath(savedPath);
      const matchesSavedPath = (tabId: string, path: string) =>
        (savedTabId !== undefined && tabId === savedTabId) ||
        normalizeWorkspacePath(path) === normalizedSavedPath;

      const conflict = externalConflictRef.current;

      if (conflict && matchesSavedPath(conflict.tabId, conflict.path)) {
        externalConflictRef.current = null;
        setExternalConflict(null);
        setExternalConflictDiffOpen(false);
      }

      const deletedPrompt = externalDeletedPromptRef.current;

      if (
        deletedPrompt &&
        matchesSavedPath(deletedPrompt.tabId, deletedPrompt.path)
      ) {
        externalDeletedPromptRef.current = null;
        setExternalDeletedPrompt(null);
      }
    },
    [],
  );

  const externalPathVersion = useCallback((path: string) => {
    return externalPathVersionsRef.current[normalizeWorkspacePath(path)] ?? 0;
  }, []);

  const bumpExternalPathVersion = useCallback((path: string) => {
    const normalizedPath = normalizeWorkspacePath(path);
    const nextVersion =
      (externalPathVersionsRef.current[normalizedPath] ?? 0) + 1;

    externalPathVersionsRef.current = {
      ...externalPathVersionsRef.current,
      [normalizedPath]: nextVersion,
    };

    return nextVersion;
  }, []);

  const isCurrentExternalPathVersion = useCallback(
    (path: string, version: number) => {
      return externalPathVersion(path) === version;
    },
    [externalPathVersion],
  );

  const bumpSavedExternalPaths = useCallback(
    (path: string, previousPath?: string) => {
      bumpExternalPathVersion(path);
      if (
        previousPath &&
        normalizeWorkspacePath(previousPath) !== normalizeWorkspacePath(path)
      ) {
        bumpExternalPathVersion(previousPath);
      }
    },
    [bumpExternalPathVersion],
  );

  const clearExternalDeletedPromptForTab = useCallback((tabId: string) => {
    setExternalDeletedPrompt((prompt) =>
      prompt?.tabId === tabId ? null : prompt,
    );
  }, []);

  const clearExternalPromptsForPathPrefix = useCallback((path: string) => {
    const conflict = externalConflictRef.current;

    if (conflict && isPathUnderPrefix(conflict.path, path)) {
      externalConflictRef.current = null;
      setExternalConflict(null);
      setExternalConflictDiffOpen(false);
    }

    const deletedPrompt = externalDeletedPromptRef.current;

    if (deletedPrompt && isPathUnderPrefix(deletedPrompt.path, path)) {
      externalDeletedPromptRef.current = null;
      setExternalDeletedPrompt(null);
    }
  }, []);

  const reloadCleanWorkspaceTab = useCallback(
    async (tabId: string, path: string, pathVersion: number) => {
      try {
        const markdown = await readWorkspaceMarkdown(path);
        const current = workspaceRef.current.tabs[tabId];

        if (
          isCurrentExternalPathVersion(path, pathVersion) &&
          current &&
          !current.dirty &&
          normalizeWorkspacePath(current.path) === normalizeWorkspacePath(path)
        ) {
          dispatchEditorReplace(
            { tabId, markdown, reason: "clean-reload" },
            {
              type: "tab/saved",
              tabId,
              markdown,
              fingerprint: documentFingerprint(markdown),
            },
          );
          setExternalConflict((conflict) =>
            conflict?.tabId === tabId ? null : conflict,
          );
          clearExternalDeletedPromptForTab(tabId);
        }
      } catch (error) {
        console.warn("Failed to reload externally changed file.", error);
      }
    },
    [
      clearExternalDeletedPromptForTab,
      dispatchEditorReplace,
      isCurrentExternalPathVersion,
      readWorkspaceMarkdown,
    ],
  );

  const showExternalConflict = useCallback(
    async (tabId: string, path: string, pathVersion: number) => {
      try {
        const diskMarkdown = await readWorkspaceMarkdown(path);
        const current = workspaceRef.current.tabs[tabId];

        if (
          isCurrentExternalPathVersion(path, pathVersion) &&
          current &&
          current.dirty &&
          normalizeWorkspacePath(current.path) === normalizeWorkspacePath(path)
        ) {
          setExternalConflict({
            tabId,
            path: normalizeWorkspacePath(path),
            diskMarkdown,
          });
          setExternalConflictDiffOpen(true);
          clearExternalDeletedPromptForTab(tabId);
        }
      } catch (error) {
        console.warn("Failed to load externally changed file.", error);
      }
    },
    [
      clearExternalDeletedPromptForTab,
      isCurrentExternalPathVersion,
      readWorkspaceMarkdown,
    ],
  );

  const showExternalDeletedPrompt = useCallback(
    async (
      tabId: string,
      path: string,
      dirty: boolean,
      pathVersion: number,
    ) => {
      let diskMarkdown: string | null = null;

      try {
        diskMarkdown = await readWorkspaceMarkdown(path);
      } catch {
        diskMarkdown = null;
      }

      const current = workspaceRef.current.tabs[tabId];

      if (
        !isCurrentExternalPathVersion(path, pathVersion) ||
        !current ||
        normalizeWorkspacePath(current.path) !== normalizeWorkspacePath(path)
      ) {
        return;
      }

        if (diskMarkdown !== null) {
        if (current.dirty) {
          setExternalConflict({
            tabId,
            path: normalizeWorkspacePath(path),
            diskMarkdown,
          });
          setExternalConflictDiffOpen(true);
          clearExternalDeletedPromptForTab(tabId);
        } else {
          dispatchEditorReplace(
            { tabId, markdown: diskMarkdown, reason: "clean-reload" },
            {
              type: "tab/saved",
              tabId,
              markdown: diskMarkdown,
              fingerprint: documentFingerprint(diskMarkdown),
            },
          );
          clearExternalDeletedPromptForTab(tabId);
        }
        return;
      }

      setExternalDeletedPrompt({
        tabId,
        path,
        dirty,
      });
      setExternalConflict((conflict) =>
        conflict?.tabId === tabId ? null : conflict,
      );
    },
    [
      clearExternalDeletedPromptForTab,
      dispatchEditorReplace,
      isCurrentExternalPathVersion,
      readWorkspaceMarkdown,
    ],
  );

  const handleFileWatchEvent = useCallback(
    (event: FrontendFileWatchEvent) => {
      const pathVersion = bumpExternalPathVersion(event.path);
      if (event.kind === "renamed") {
        bumpExternalPathVersion(event.newPath);
      }
      const decision = decideWorkspaceExternalChange({
        workspace: workspaceRef.current,
        event,
        selfWrite: selfWriteMarkerRef.current,
      });

      switch (decision.kind) {
        case "ignore":
          return;
        case "refreshTree":
          void refreshCurrentTree().catch((error) => {
            console.warn("Failed to refresh workspace after file watch event.", error);
          });
          return;
        case "remapPath":
          clearExternalPromptsForPathPrefix(decision.fromPath);
          clearExternalPromptsForPathPrefix(decision.toPath);
          dispatchAndMirror({
            type: "tab/pathRemapped",
            fromPath: decision.fromPath,
            toPath: decision.toPath,
          });
          void refreshCurrentTree().catch((error) => {
            console.warn("Failed to refresh workspace after file rename.", error);
          });
          return;
        case "remapPathAndPrefix":
          clearExternalPromptsForPathPrefix(decision.fromPath);
          clearExternalPromptsForPathPrefix(decision.toPath);
          dispatchAndMirror({
            type: "tab/pathRemapped",
            fromPath: decision.fromPath,
            toPath: decision.toPath,
          });
          dispatchAndMirror({
            type: "tab/prefixRemapped",
            affectedPrefix: {
              oldPrefix: decision.oldPrefix,
              newPrefix: decision.newPrefix,
            },
          });
          void refreshCurrentTree().catch((error) => {
            console.warn("Failed to refresh workspace after file rename.", error);
          });
          return;
        case "reloadCleanTab":
          void reloadCleanWorkspaceTab(
            decision.tabId,
            decision.path,
            pathVersion,
          );
          if (event.kind === "created") {
            void refreshCurrentTree().catch((error) => {
              console.warn("Failed to refresh workspace after file creation.", error);
            });
          }
          return;
        case "showConflict":
          void showExternalConflict(
            decision.tabId,
            decision.path,
            pathVersion,
          );
          if (event.kind === "created") {
            void refreshCurrentTree().catch((error) => {
              console.warn("Failed to refresh workspace after file creation.", error);
            });
          }
          return;
        case "showDeletedPrompt":
          void showExternalDeletedPrompt(
            decision.tabId,
            decision.path,
            decision.dirty,
            pathVersion,
          );
          void refreshCurrentTree().catch((error) => {
            console.warn("Failed to refresh workspace after file deletion.", error);
          });
          return;
      }
    },
    [
      bumpExternalPathVersion,
      clearExternalPromptsForPathPrefix,
      dispatchAndMirror,
      refreshCurrentTree,
      reloadCleanWorkspaceTab,
      showExternalConflict,
      showExternalDeletedPrompt,
    ],
  );

  const handleFileWatchError = useCallback((error: WatchErrorPayload) => {
    console.warn("Workspace file watch error.", error);
  }, []);

  useFileWatch({
    mode: "workspace",
    rootPath: workspace.rootPath,
    preferences,
    onEvent: handleFileWatchEvent,
    onError: handleFileWatchError,
  });

  useEffect(() => {
    const normalizedQuery = normalizeSearchQuery(fullTextSearchState.query);
    const previousRequestId = activeSearchRequestIdRef.current;
    activeSearchRequestIdRef.current = null;

    if (!isTauriRuntime()) {
      return;
    }

    searchCancellationRef.current = queueWorkspaceSearchCancellation(
      searchCancellationRef.current,
      previousRequestId
        ? () => cancelWorkspaceSearchRequest(previousRequestId)
        : null,
    );

    if (normalizedQuery.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const requestId = nanoid(8);
      activeSearchRequestIdRef.current = requestId;
      dispatchAndMirror({
        type: "search/requestStarted",
        requestId,
      });

      void (async () => {
        await searchCancellationRef.current;

        if (activeSearchRequestIdRef.current !== requestId) {
          return;
        }

        try {
          const { invoke } = await tauriCore();

          if (activeSearchRequestIdRef.current !== requestId) {
            return;
          }

          const response = await invoke<WorkspaceSearchResponse>(
            "workspace_search",
            {
              request: {
                rootPath: workspace.rootPath,
                query: normalizedQuery,
                caseSensitive: fullTextSearchState.caseSensitive,
                maxFileBytes: preferences.searchMaxFileBytes,
                maxResults: preferences.searchMaxResults,
                maxMatchesPerFile: preferences.searchMaxMatchesPerFile,
                dirtyOverrides: collectDirtySearchOverrides(
                  workspaceRef.current,
                ),
                requestId,
              },
            },
          );

          if (
            !shouldAcceptSearchResponse(
              activeSearchRequestIdRef.current,
              response,
            )
          ) {
            return;
          }

          activeSearchRequestIdRef.current = null;
          dispatchAndMirror({
            type: "search/requestCompleted",
            requestId: response.requestId,
            results: response.results,
            summary: {
              skippedLargeFiles: response.skippedLargeFiles,
              skippedUnreadableFiles: response.skippedUnreadableFiles,
              truncated: response.truncated,
              searchedFiles: response.searchedFiles,
            },
          });
        } catch (error) {
          if (activeSearchRequestIdRef.current !== requestId) {
            return;
          }

          activeSearchRequestIdRef.current = null;
          dispatchAndMirror({
            type: "search/requestFailed",
            requestId,
            error: formatError(error, "工作区搜索失败。"),
          });
        }
      })();
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    cancelWorkspaceSearchRequest,
    dispatchAndMirror,
    preferences.searchMaxFileBytes,
    preferences.searchMaxMatchesPerFile,
    preferences.searchMaxResults,
    fullTextSearchState.caseSensitive,
    fullTextSearchState.query,
    workspace.rootPath,
  ]);

  useEffect(() => {
    return () => {
      const activeRequestId = activeSearchRequestIdRef.current;
      clearSelfWriteMarker();
      searchCancellationRef.current = queueWorkspaceSearchCancellation(
        searchCancellationRef.current,
        activeRequestId
          ? () => cancelWorkspaceSearchRequest(activeRequestId)
          : null,
      );
    };
  }, [cancelWorkspaceSearchRequest, clearSelfWriteMarker]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledNoteQuery(noteQuery), 200);

    return () => window.clearTimeout(timer);
  }, [noteQuery]);

  /** The note list — and, through it, whether the navigator is showing at all. */
  const listPanel = usePanelResize({
    side: "list",
    panel: workspace.panel,
    dispatch: dispatchAndMirror,
  });
  /** The rail inside the navigator: the groups and the folder tree. */
  const railPanel = usePanelResize({
    side: "rail",
    panel: workspace.panel,
    dispatch: dispatchAndMirror,
  });

  const removeOrphanDraft = useCallback((draftId: string) => {
    setOrphanDrafts((current) =>
      current.filter((draft) => draft.draftId !== draftId),
    );
    setPostponedOrphanDraftIds((current) => {
      if (!current.has(draftId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(draftId);
      return next;
    });
  }, []);

  const recoverActiveDraft = useCallback(() => {
    const recovery = activeDraftRecovery;

    if (!recovery) {
      return;
    }

    dispatchEditorReplace(
      {
        tabId: recovery.tabId,
        markdown: recovery.draft.markdown,
        reason: "restore",
      },
      {
        type: "tab/contentChanged",
        tabId: recovery.tabId,
        markdown: recovery.draft.markdown,
      },
    );
    setActiveDraftRecovery(null);
    setActiveDraftDiffOpen(false);
  }, [activeDraftRecovery, dispatchEditorReplace]);

  const keepActiveDiskVersion = useCallback(() => {
    const recovery = activeDraftRecovery;

    if (!recovery) {
      return;
    }

    setActiveDraftRecovery(null);
    setActiveDraftDiffOpen(false);
    void deleteWorkspaceDraftForPath(
      recovery.draft.realPath,
      recovery.draft.draftId,
    ).catch((error) => {
      console.warn("Failed to delete workspace draft.", error);
    });
  }, [activeDraftRecovery, deleteWorkspaceDraftForPath]);

  const postponeActiveDraftRecovery = useCallback(() => {
    setActiveDraftDetailsOpen(false);
    setActiveDraftDiffOpen(false);
  }, []);

  const saveOrphanDraftAs = useCallback(
    async (summary: DraftSummary) => {
      try {
        const result = await draftGet(summary.realPath);
        const draft = result.draft;

        if (!draft) {
          removeOrphanDraft(summary.draftId);
          return;
        }

        const { invoke } = await tauriCore();
        const parentDir = findExistingParentPath(
          workspaceRef.current.rootPath,
          summary.realPath,
          workspaceRef.current.fileTree,
        );
        const created = await invoke<CreateMarkdownFileResult>(
          "create_markdown_file",
          {
            rootPath: workspaceRef.current.rootPath,
            parentDir,
            name: null,
            temporaryUntitled: true,
          },
        );
        const tabId = nanoid(8);
        pendingSaveAsDraftByTabRef.current = {
          ...pendingSaveAsDraftByTabRef.current,
          [tabId]: summary,
        };
        dispatchAndMirror({
          type: "tab/opened",
          tab: {
            tabId,
            path: created.path,
            title: created.name,
            dirty: true,
            needsRenameOnFirstSave: created.needsRenameOnFirstSave ?? true,
            markdown: draft.markdown,
            baseFingerprint: documentFingerprint(""),
          },
        });
      } catch (error) {
        console.warn("Failed to open orphan draft for save-as.", error);
        void dialogs.alert({
          title: "恢复草稿",
          message: formatError(error, "无法另存草稿。"),
        });
      }
    },
    [dialogs, dispatchAndMirror, removeOrphanDraft],
  );

  const restoreOrphanDraftOriginalPath = useCallback(
    async (summary: DraftSummary) => {
      if (
        !parentExistsInWorkspace(
          workspaceRef.current.rootPath,
          summary.realPath,
          workspaceRef.current.fileTree,
        )
      ) {
        return;
      }

      try {
        const result = await draftGet(summary.realPath);
        const draft = result.draft;

        if (!draft) {
          removeOrphanDraft(summary.draftId);
          return;
        }

        const { invoke } = await tauriCore();
        await invoke("write_markdown_file", {
          rootPath: workspaceRef.current.rootPath,
          path: summary.realPath,
          content: draft.markdown,
        });
        await deleteWorkspaceDraftForPath(draft.realPath, draft.draftId);
        removeOrphanDraft(draft.draftId);
        dispatchAndMirror({
          type: "tab/opened",
          tab: {
            tabId: nanoid(8),
            path: summary.realPath,
            title: pathTitle(summary.realPath),
            dirty: false,
            needsRenameOnFirstSave: false,
            markdown: draft.markdown,
            baseFingerprint: documentFingerprint(draft.markdown),
          },
        });
        await refreshTree(
          workspaceRef.current.rootPath,
          () => workspaceRef.current.rootPath,
          dispatchAndMirror,
          preferences,
        );
      } catch (error) {
        console.warn("Failed to restore orphan draft original path.", error);
        void dialogs.alert({
          title: "恢复草稿",
          message: formatError(error, "无法恢复原路径。"),
        });
      }
    },
    [
      deleteWorkspaceDraftForPath,
      dialogs,
      dispatchAndMirror,
      preferences,
      removeOrphanDraft,
    ],
  );

  const deleteOrphanDraft = useCallback(
    (summary: DraftSummary) => {
      removeOrphanDraft(summary.draftId);
      void deleteWorkspaceDraftForPath(summary.realPath, summary.draftId).catch(
        (error) => {
          console.warn("Failed to delete orphan workspace draft.", error);
        },
      );
    },
    [deleteWorkspaceDraftForPath, removeOrphanDraft],
  );

  const postponeOrphanDraft = useCallback((summary: DraftSummary) => {
    setPostponedOrphanDraftIds((current) => {
      const next = new Set(current);
      next.add(summary.draftId);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const element = workspaceBodyRef.current;

    if (!element) {
      return;
    }

    const updateWidth = () => {
      setWorkspaceBodyWidth(Math.round(element.getBoundingClientRect().width));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);

      return () => {
        window.removeEventListener("resize", updateWidth);
      };
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const saveTab = useCallback(
    async (tabId: string) => {
      await flushWorkspaceDraftForTab(workspaceRef.current.tabs[tabId]);

      saveQueueRef.current ??= createTabSaveQueue({
        getWorkspace: () => workspaceRef.current,
        dispatch: dispatchAndMirror,
        invoke: async (command, args) => {
          const { invoke } = await tauriCore();
          return invoke(command, args);
        },
        promptName: async (title) =>
          dialogs.prompt({
            title: "保存文件",
            label: "文件名",
            initialValue: title,
            confirmLabel: "保存",
          }),
        alert: (text) =>
          void dialogs.alert({
            title: "保存文件",
            message: text,
          }),
        warn: (text, error) => console.warn(text, error),
        refreshTree: (rootPath) =>
          refreshTree(
            rootPath,
            () => workspaceRef.current.rootPath,
            dispatchAndMirror,
            preferences,
          ),
        afterSave: async (event) => {
          if (event.rootPath !== workspaceRef.current.rootPath) {
            return;
          }

          const savedTabId = findTabIdByPath(workspaceRef.current, event.path);
          const saveAsDraft = savedTabId
            ? pendingSaveAsDraftByTabRef.current[savedTabId]
            : undefined;
          const savedTab = savedTabId
            ? workspaceRef.current.tabs[savedTabId]
            : undefined;
          bumpSavedExternalPaths(event.path, event.previousPath);
          clearSavedExternalPrompts(savedTabId, event.path);
          if (
            event.previousPath &&
            normalizeWorkspacePath(event.previousPath) !==
              normalizeWorkspacePath(event.path)
          ) {
            clearSavedExternalPrompts(savedTabId, event.previousPath);
          }
          if (savedTab?.markdown !== undefined) {
            rememberSelfWrite(event.path, savedTab.markdown);
          }

          try {
            await deleteWorkspaceDraftForPath(event.path);
            if (
              event.previousPath &&
              normalizeWorkspacePath(event.previousPath) !==
                normalizeWorkspacePath(event.path)
            ) {
              await deleteWorkspaceDraftForPath(event.previousPath);
            }
            if (saveAsDraft) {
              await deleteWorkspaceDraftForPath(
                saveAsDraft.realPath,
                saveAsDraft.draftId,
              );
              removeOrphanDraft(saveAsDraft.draftId);
              if (savedTabId) {
                const nextPending = {
                  ...pendingSaveAsDraftByTabRef.current,
                };
                delete nextPending[savedTabId];
                pendingSaveAsDraftByTabRef.current = nextPending;
              }
            }
            setActiveDraftRecovery((current) =>
              current &&
              normalizeWorkspacePath(current.path) ===
                normalizeWorkspacePath(event.path)
                ? null
                : current,
            );
          } catch (error) {
            console.warn("Failed to delete saved workspace draft.", error);
          }

          handleRawFileSavedRef.current(event.path);
        },
      });

      return saveQueueRef.current.saveTab(tabId);
    },
    [
      dialogs,
      deleteWorkspaceDraftForPath,
      dispatchAndMirror,
      flushWorkspaceDraftForTab,
      bumpSavedExternalPaths,
      clearSavedExternalPrompts,
      rememberSelfWrite,
      preferences,
      removeOrphanDraft,
    ],
  );
  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = workspaceRef.current.tabs[tabId];

      if (!tab) {
        return;
      }

      if (!tab.dirty) {
        dispatchAndMirror({
          type: "tab/closed",
          tabId,
        });
        return;
      }

      await flushWorkspaceDraftForTab(tab);

      const choice = await dialogs.choice({
        title: "未保存更改",
        message: `“${tab.title}” 有未保存更改。请选择保存、丢弃或取消。`,
        choices: [
          { label: "保存", value: "save" },
          { label: "丢弃", value: "discard", destructive: true },
        ],
        cancelLabel: "取消",
      });

      if (choice === "discard") {
        await deleteWorkspaceDraftForTab(tab);
        dispatchAndMirror(
          {
            type: "tab/closed",
            tabId,
          },
          { skipDraftFlush: true },
        );
        return;
      }

      if (choice !== "save") {
        return;
      }

      const saved = await saveTab(tabId);

      if (saved) {
        dispatchAndMirror(
          {
            type: "tab/closed",
            tabId,
          },
          { skipDraftFlush: true },
        );
      }
    },
    [
      deleteWorkspaceDraftForTab,
      dialogs,
      dispatchAndMirror,
      flushWorkspaceDraftForTab,
      saveTab,
    ],
  );

  const keepExternalConflictEdits = useCallback(async () => {
    const conflict = externalConflict;

    if (!conflict) {
      return;
    }

    const saved = await saveTab(conflict.tabId);

    if (saved) {
      setExternalConflict(null);
      setExternalConflictDiffOpen(false);
    }
  }, [externalConflict, saveTab]);

  const reloadExternalConflictDiskVersion = useCallback(async () => {
    const conflict = externalConflict;

    if (!conflict) {
      return;
    }

    try {
      const markdown = await readWorkspaceMarkdown(conflict.path);
      const current = workspaceRef.current.tabs[conflict.tabId];

      if (
        current &&
        normalizeWorkspacePath(current.path) === normalizeWorkspacePath(conflict.path)
      ) {
        dispatchEditorReplace(
          {
            tabId: conflict.tabId,
            markdown,
            reason: "conflict-resolution",
          },
          {
            type: "tab/saved",
            tabId: conflict.tabId,
            markdown,
            fingerprint: documentFingerprint(markdown),
          },
          { skipDraftFlush: true },
        );
        await deleteWorkspaceDraftForPath(conflict.path);
      }
      setExternalConflict(null);
      setExternalConflictDiffOpen(false);
    } catch (error) {
      void dialogs.alert({
        title: "重新加载失败",
        message: formatError(error, "无法重新加载磁盘版本。"),
      });
    }
  }, [deleteWorkspaceDraftForPath, dialogs, dispatchEditorReplace, externalConflict, readWorkspaceMarkdown]);

  const postponeExternalConflict = useCallback(() => {
    setExternalConflictDiffOpen(false);
  }, []);

  const copyExternalConflictMarkdown = useCallback(() => {
    const conflict = externalConflict;
    const markdown = conflict
      ? (workspaceRef.current.tabs[conflict.tabId]?.markdown ?? "")
      : "";
    setExternalConflictDiffOpen(false);

    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(markdown).catch((error) => {
        console.warn("Failed to copy current workspace markdown.", error);
      });
    }
  }, [externalConflict]);

  /**
   * Shows a file where it lives, without opening it.
   *
   * By path, because both places that offer it — a tab and a note row — have a
   * path and nothing else in common. The backend does the revealing: only it can
   * say whether that path is inside the workspace it was asked about.
   */
  const revealPathInFileManager = useCallback(
    (path: string) => {
      void (async () => {
        try {
          const { invoke } = await tauriCore();
          await invoke("reveal_path_in_file_manager", {
            rootPath: workspaceRef.current.rootPath,
            path,
          });
        } catch (error) {
          void dialogs.alert({
            title: "在 Finder 中显示",
            message: formatError(error, "无法在 Finder 中显示这个文件。"),
          });
        }
      })();
    },
    [dialogs],
  );

  const copyPathToClipboard = useCallback((path: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    void navigator.clipboard.writeText(path).catch((error) => {
      console.warn("Failed to copy a path.", error);
    });
  }, []);

  /**
   * Closes tabs one at a time, in order.
   *
   * Sequentially because closing an unsaved tab asks the user what to do with
   * it: several of those at once would be several dialogs at once, and the
   * answer to one decides whether the file is still there for the next.
   */
  const closeTabs = useCallback(
    async (tabIds: string[]) => {
      for (const tabId of tabIds) {
        await closeTab(tabId);
      }
    },
    [closeTab],
  );

  const closeOtherTabs = useCallback(
    (keptTabId: string) => {
      void closeTabs(
        workspaceRef.current.tabOrder.filter((tabId) => tabId !== keptTabId),
      );
    },
    [closeTabs],
  );

  const closeAllTabs = useCallback(() => {
    void closeTabs([...workspaceRef.current.tabOrder]);
  }, [closeTabs]);

  /**
   * Prints the document, which is also how it is exported as a PDF.
   *
   * What prints is what the window is rendering, so a document being read as
   * Markdown source is switched to the visual surface first: a PDF of the source
   * is a picture of the markup, not the document. The adapter may refuse that
   * switch — an unsafe visual parse — and then what is on screen is what prints,
   * which is the honest outcome rather than a blank page.
   */
  const printActiveDocument = useCallback(() => {
    void (async () => {
      if (editorMode === "source") {
        await editorSurfaceRef.current?.setMode("wysiwyg");
      }

      // One frame, so a surface built by that switch is in the document before
      // the print snapshot is taken.
      window.requestAnimationFrame(() => window.print());
    })();
  }, [editorMode]);

  const closeDeletedWorkspaceTab = useCallback(
    async (tabId: string, options?: { discardDirty?: boolean }) => {
      const tab = workspaceRef.current.tabs[tabId];

      if (options?.discardDirty) {
        await deleteWorkspaceDraftForTab(tab);
        dispatchAndMirror(
          {
            type: "tab/closed",
            tabId,
          },
          { skipDraftFlush: true },
        );
        setExternalDeletedPrompt((prompt) =>
          prompt?.tabId === tabId ? null : prompt,
        );
        return;
      }

      await closeTab(tabId);
      setExternalDeletedPrompt((prompt) =>
        prompt?.tabId === tabId && !workspaceRef.current.tabs[tabId]
          ? null
          : prompt,
      );
    },
    [closeTab, deleteWorkspaceDraftForTab, dispatchAndMirror],
  );

  const openDeletedWorkspaceTabSaveAs = useCallback(
    async (prompt: ExternalDeletedPrompt) => {
      const tab = workspaceRef.current.tabs[prompt.tabId];

      if (!tab) {
        setExternalDeletedPrompt((current) =>
          current?.tabId === prompt.tabId ? null : current,
        );
        return;
      }

      try {
        const { invoke } = await tauriCore();
        const parentDir = findExistingParentPath(
          workspaceRef.current.rootPath,
          prompt.path,
          workspaceRef.current.fileTree,
        );
        const created = await invoke<CreateMarkdownFileResult>(
          "create_markdown_file",
          {
            rootPath: workspaceRef.current.rootPath,
            parentDir,
            name: null,
            temporaryUntitled: true,
          },
        );
        dispatchAndMirror({
          type: "tab/opened",
          tab: {
            tabId: nanoid(8),
            path: created.path,
            title: created.name,
            dirty: true,
            needsRenameOnFirstSave: created.needsRenameOnFirstSave ?? true,
            markdown: tab.markdown ?? "",
            baseFingerprint: documentFingerprint(""),
          },
        });
        await deleteWorkspaceDraftForTab(tab);
        dispatchAndMirror(
          {
            type: "tab/closed",
            tabId: prompt.tabId,
          },
          { skipDraftFlush: true },
        );
        setExternalDeletedPrompt((current) =>
          current?.tabId === prompt.tabId ? null : current,
        );
        await refreshCurrentTree();
      } catch (error) {
        void dialogs.alert({
          title: "另存为",
          message: formatError(error, "无法创建另存文件。"),
        });
      }
    },
    [deleteWorkspaceDraftForTab, dialogs, dispatchAndMirror, refreshCurrentTree],
  );

  const restoreDeletedWorkspaceTabOriginalPath = useCallback(
    async (prompt: ExternalDeletedPrompt) => {
      const tab = workspaceRef.current.tabs[prompt.tabId];

      if (!tab || tab.markdown === undefined) {
        return;
      }

      try {
        const { invoke } = await tauriCore();
        await invoke("write_markdown_file", {
          rootPath: workspaceRef.current.rootPath,
          path: prompt.path,
          content: tab.markdown,
          expectedFingerprint: null,
        });
        rememberSelfWrite(prompt.path, tab.markdown);
        dispatchAndMirror(
          {
            type: "tab/saved",
            tabId: prompt.tabId,
            markdown: tab.markdown,
            fingerprint: documentFingerprint(tab.markdown),
          },
          { skipDraftFlush: true },
        );
        await deleteWorkspaceDraftForTab(tab);
        setExternalDeletedPrompt((current) =>
          current?.tabId === prompt.tabId ? null : current,
        );
        await refreshCurrentTree();
      } catch (error) {
        void dialogs.alert({
          title: "恢复原路径",
          message: formatError(error, "无法恢复原路径。"),
        });
      }
    },
    [
      deleteWorkspaceDraftForTab,
      dialogs,
      dispatchAndMirror,
      refreshCurrentTree,
      rememberSelfWrite,
    ],
  );
  const saveActiveTab = useCallback(async () => {
    const tabId = workspaceRef.current.activeTabId;

    if (tabId) {
      await saveTab(tabId);
    }
  }, [saveTab]);

  const closeActiveTab = useCallback(async () => {
    const tabId = workspaceRef.current.activeTabId;

    if (tabId) {
      await closeTab(tabId);
    }
  }, [closeTab]);
  const workspaceActions = useMemo<WorkspaceMenuActions>(
    () => ({
      ...fileTreeActions,
      saveActiveTab,
      closeActiveTab,
    }),
    [closeActiveTab, fileTreeActions, saveActiveTab],
  );

  useEffect(() => {
    onActionsChange(workspaceActions);

    return () => onActionsChange(null);
  }, [onActionsChange, workspaceActions]);
  const handleSelectionChange = useCallback(
    (tabId: string, selection: Record<string, unknown> | null) => {
      selectionByTabRef.current = {
        ...selectionByTabRef.current,
        [tabId]: selection as CliSelectionSnapshot | null,
      };
      if (isTauriRuntime()) {
        void syncCliWorkspaceSnapshot(
          workspaceRef.current,
          selectionByTabRef.current,
        ).catch((error) => {
          console.warn("Failed to sync CLI workspace snapshot.", error);
        });
      }
    },
    [],
  );
  const handlePendingCliCommandHandled = useCallback((commandId: string) => {
    setPendingCliCommand((current) =>
      current?.id === commandId ? null : current,
    );
  }, []);
  const queuePendingCliCommand = useCallback(
    (command: PendingCliEditorCommand) => {
      setPendingCliCommand(command);
    },
    [],
  );
  const openWorkspacePathTab = useCallback(
    (path: string) => {
      const currentWorkspace = workspaceRef.current;
      const existingTabId = findTabIdByPath(currentWorkspace, path);

      if (existingTabId) {
        dispatchAndMirror({
          type: "tab/activated",
          tabId: existingTabId,
        });
        return existingTabId;
      }

      const tabId = nanoid(8);
      dispatchAndMirror({
        type: "tab/opened",
        tab: {
          tabId,
          path,
          title: pathTitle(path),
          dirty: false,
          needsRenameOnFirstSave: false,
          baseFingerprint: null,
        },
      });
      return tabId;
    },
    [dispatchAndMirror],
  );
  /**
   * The navigator's plus button, when the tree has told us how to create a file.
   *
   * Undefined until then, so the button is disabled rather than silently doing
   * nothing: the tree owns file creation, including where the new file lands.
   */
  const trashFile = fileTreeActions?.trashFile;
  const deleteNoteFromNavigator = useMemo(
    () =>
      trashFile
        ? (path: string, title: string) => {
            void trashFile(path, title);
          }
        : undefined,
    [trashFile],
  );
  const createMarkdownFile = fileTreeActions?.createMarkdownFile;
  const createNoteFromNavigator = useMemo(
    () =>
      createMarkdownFile
        ? () => {
            void createMarkdownFile();
          }
        : undefined,
    [createMarkdownFile],
  );
  const handleWorkspaceSearchResultClick = useCallback(
    (result: WorkspaceSearchResultItem) => {
      const tabId = openWorkspacePathTab(result.path);
      queuePendingCliCommand({
        id: nanoid(8),
        kind: "scrollToLine",
        tabId,
        lineNumber: result.lineNumber,
      });
    },
    [openWorkspacePathTab, queuePendingCliCommand],
  );
  const openWikilink = useCallback(
    (target: string, sourcePath: string) => {
      const currentWorkspace = workspaceRef.current;
      const resolvedPath = resolveWikilinkFile(
        currentWorkspace.rootPath,
        sourcePath,
        currentWorkspace.fileTree,
        target,
      );

      if (!resolvedPath) {
        console.warn(`Unable to resolve wikilink: ${target}`);
        return;
      }

      openWorkspacePathTab(resolvedPath);
    },
    [openWorkspacePathTab],
  );
  /**
   * A link the reader activated in the rendered document.
   *
   * A web address goes to the browser, through a command that opens `http` and
   * `https` and refuses everything else — a document is text from somewhere, and
   * the operating system would launch an application for any scheme it was
   * handed. Anything else is treated as pointing at something in this workspace,
   * which is the same question a wikilink asks, so it is answered in the same
   * place rather than twice.
   */
  const openLink = useCallback(
    (href: string, sourcePath: string) => {
      if (!/^https?:\/\//i.test(href.trim())) {
        openWikilink(href, sourcePath);
        return;
      }

      void (async () => {
        try {
          const { invoke } = await tauriCore();
          await invoke("open_external_url", { url: href.trim() });
        } catch (error) {
          void dialogs.alert({
            title: "打开链接",
            message: formatError(error, "无法打开这个链接。"),
          });
        }
      })();
    },
    [dialogs, openWikilink],
  );

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const subscribe = async () => {
      const { listen } = await import("@tauri-apps/api/event");

      const nextUnlisteners = await Promise.all([
        listen<CliOpenFileEvent>("cli-open-file", (event) => {
          void handleCliOpenFile(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
            queuePendingCliCommand,
          );
        }),
        listen<CliInsertEvent>("cli-insert", (event) => {
          handleCliInsert(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
            queuePendingCliCommand,
          );
        }),
        listen<CliTabEvent>("cli-focus-tab", (event) => {
          handleCliFocusTab(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
            queuePendingCliCommand,
          );
        }),
        listen<CliCloseEvent>("cli-close-tab", (event) => {
          handleCliCloseTab(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
          );
        }),
        listen<CliTabEvent>("cli-save-tab", (event) => {
          void handleCliSaveTab(event.payload, workspaceRef.current, saveTab);
        }),
        listen<CliFileCreatedEvent>("cli-file-created", (event) => {
          void handleCliFileCreated(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
            queuePendingCliCommand,
            preferences,
          );
        }),
        listen<CliFileUpdatedEvent>("cli-file-updated", (event) => {
          void handleCliFileUpdated(
            event.payload,
            workspaceRef.current,
            // Refreshing a clean tab from disk replaces editor content the same
            // way a watcher reload does, so it is declared the same way.
            (action) => {
              if (action.type === "tab/saved" && action.markdown !== undefined) {
                dispatchEditorReplace(
                  {
                    tabId: action.tabId,
                    markdown: action.markdown,
                    reason: "clean-reload",
                  },
                  action,
                );
                return;
              }

              dispatchAndMirror(action);
            },
          );
        }),
        listen<CliFolderCreatedEvent>("cli-folder-created", (event) => {
          void handleCliFolderCreated(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
            preferences,
          );
        }),
        listen<CliPathRenamedEvent>("cli-path-renamed", (event) => {
          void handleCliPathRenamed(
            event.payload,
            workspaceRef.current,
            dispatchAndMirror,
            preferences,
          );
        }),
      ]);
      unlisteners.push(...nextUnlisteners);

      if (disposed) {
        unlisteners.forEach(stopListening);
      }
    };

    void subscribe().catch((error) => {
      console.warn("Failed to subscribe to CLI events.", error);
    });

    return () => {
      disposed = true;
      unlisteners.forEach(stopListening);
    };
  }, [
    dispatchAndMirror,
    dispatchEditorReplace,
    preferences,
    queuePendingCliCommand,
    saveTab,
  ]);

  // The editing surface is navigated by the heading's own Markdown source
  // range, so nothing here reads rendered output to find a heading.
  const scrollToHeading = useCallback((heading: MarkdownOutlineHeading) => {
    void editorSurfaceRef.current?.reveal(heading.range);
  }, []);
  const panelLayout = calculateWorkspacePanelLayout({
    containerWidth: workspaceBodyWidth,
    navigatorCollapsed: !isEditorView || listPanel.isCollapsed,
    railWidth: railPanel.width,
    listWidth: listPanel.width,
  });
  const gridTemplateColumns = [
    `${panelLayout.navigatorWidth}px`,
    "minmax(0, 1fr)",
  ].join(" ");

  return (
    <div
      data-mdx-window-layout=""
      className="grid h-full min-h-0 grid-rows-[var(--mdx-window-toolbar-height)_minmax(0,1fr)] bg-[var(--mdx-content-bg)]"
    >
      <header
        data-mdx-workspace-toolbar=""
        // The whole toolbar drags the window. The title bar is an overlay with
        // no native bar behind it, so anything not marked here is dead space
        // the window cannot be moved by — and with the controls pushed to
        // either end, that dead space was most of the toolbar.
        //
        // Safe to put on the container: the drag only starts when the mousedown
        // target *is* this element, so a click that lands on a button inside it
        // is a click on that button.
        data-tauri-drag-region
        className="flex min-w-0 items-center justify-between border-b border-[var(--mdx-separator)] bg-[var(--mdx-chrome-bg)] px-3"
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 items-center gap-2 pl-[var(--mdx-traffic-light-inset)]"
        >
          <IconButton
            onClick={listPanel.toggleCollapsed}
            label={listPanel.isCollapsed ? "展开侧栏" : "收起侧栏"}
            title={listPanel.isCollapsed ? "展开侧栏" : "收起侧栏"}
            icon={
              listPanel.isCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />
            }
            disabled={!isEditorView}
          />
          {/*
           * This side says what the window is showing — a document's name, or a
           * full-window view's. Only this side uses words: everything on the
           * right is an icon, so a control that spelled itself out over there
           * read as a different kind of control from its neighbours.
           */}
          {!isEditorView ? (
            <div
              data-tauri-drag-region
              className="min-w-0 truncate text-[13px] font-semibold text-base-content"
            >
              {activeWorkspaceViewLabel}
            </div>
          ) : null}
          {/*
           * What document this window is on, which is what a title bar is for.
           * The tab strip names the file too, but only its name — the second
           * line is where in the workspace that name lives, so two files both
           * called index.md are told apart without opening a tooltip.
           */}
          {isEditorView && activeTab ? (
            <div
              data-tauri-drag-region
              className="flex min-w-0 flex-col justify-center leading-tight"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-[13px] font-semibold text-base-content">
                  {activeTab.title}
                </span>
                {activeTab.dirty ? (
                  <>
                    <span
                      aria-hidden="true"
                      title="未保存"
                      className="h-[6px] w-[6px] shrink-0 rounded-full bg-base-content/40"
                    />
                    <span className="sr-only">（未保存）</span>
                  </>
                ) : null}
              </div>
              {/*
               * A file outside the workspace keeps its whole path, so this can
               * be the root's own name only when the relative path is empty.
               */}
              <span className="min-w-0 truncate text-[11px] text-base-content/50">
                {workspaceRelativePath(workspace.rootPath, activeTab.path) ||
                  activeTab.title}
              </span>
            </div>
          ) : null}
        </div>

        <div
          data-tauri-drag-region
          className="flex min-w-0 shrink-0 items-center gap-2"
        >
          {message ? (
            <div className="max-w-64 truncate text-xs text-warning">
              {message}
            </div>
          ) : null}
          {/*
           * Which surface is editing, as a control rather than a secret. The
           * ⌘⇧M chord was the only way to reach the Markdown source, so the
           * window never said which of the two you were looking at — and the
           * control asks the editor rather than deciding, because the adapter
           * is allowed to refuse a switch it cannot make safely.
           */}
          <SegmentedControl
            label="编辑模式"
            value={editorMode}
            options={EDITOR_MODE_OPTIONS}
            disabled={!isEditorView || !activeTabIsLoadedMarkdown}
            onChange={(next) => {
              void editorSurfaceRef.current?.setMode(next);
            }}
          />
          <div
            aria-hidden="true"
            className="h-5 w-px shrink-0 bg-[var(--mdx-separator)]"
          />
          {/*
           * Icons, not labelled buttons. Five sets of words across a title bar
           * read as a web page's navigation and crowded out the document's own
           * name; each action keeps its words as its accessible name and its
           * tooltip, which is where a desktop toolbar keeps them.
           */}
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              onClick={onChooseWorkspace}
              disabled={!canChooseWorkspace}
              label="打开文件夹"
              icon={<FolderOpen />}
            />
            <IconButton
              onClick={printActiveDocument}
              disabled={!isEditorView || !activeTabIsLoadedMarkdown}
              label="打印 / 存为 PDF"
              icon={<Printer />}
            />
            {/*
             * One button per full-window view, each toggling back to the
             * editor. They are separate rather than one cycling control so the
             * toolbar shows what is available without the user clicking to find
             * out. The pressed state says which one is open; the way out of it
             * is on the left, where the window says what you are looking at.
             */}
            {WORKSPACE_VIEW_TOGGLES.map((toggle) => {
              const active = workspaceView === toggle.view;
              return (
                <IconButton
                  key={toggle.view}
                  active={active}
                  aria-pressed={active}
                  label={active ? toggle.closeLabel : toggle.openLabel}
                  icon={
                    active ? (
                      <X />
                    ) : toggle.view === "memory" ? (
                      <Brain />
                    ) : (
                      <BookOpen />
                    )
                  }
                  onClick={() =>
                    setWorkspaceView((current) =>
                      current === toggle.view ? "editor" : toggle.view,
                    )
                  }
                />
              );
            })}
            <AppearanceButton />
            <SettingsButton
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              workspaceRoot={workspace.rootPath}
              preferences={preferences}
              onPreferencesChange={onPreferencesChange}
              onLlmConfigSaved={llmWiki.refresh}
            />
          </div>
        </div>
      </header>

      <div
        ref={workspaceBodyRef}
        data-mdx-window-layout=""
        className="grid min-h-0 bg-[var(--mdx-content-bg)]"
        style={{ gridTemplateColumns }}
      >
        <div
          className="min-h-0 overflow-hidden bg-[var(--mdx-sidebar-bg)]"
          style={{ gridColumn: 1 }}
        >
          {!isEditorView || listPanel.isCollapsed ? null : (
            <WorkspaceNavigator
              rows={notePages.rows}
              counts={notePages.counts}
              matched={notePages.matched}
              hasMore={notePages.hasMore}
              onLoadMore={notePages.loadMore}
              notesLoading={notePages.loading}
              notesError={notePages.error}
              group={noteGroup}
              onGroupChange={setNoteGroup}
              query={noteQuery}
              onQueryChange={setNoteQuery}
              activePath={activeTab?.path ?? null}
              onOpenNote={(path) => {
                openWorkspacePathTab(path);
              }}
              onCreateNote={createNoteFromNavigator}
              onDeleteNote={deleteNoteFromNavigator}
              onRevealNote={revealPathInFileManager}
              onCopyNotePath={copyPathToClipboard}
              nowMs={nowMs}
              tab={navigatorTab}
              onTabChange={setNavigatorTab}
              headings={activeHeadings}
              onHeadingClick={scrollToHeading}
              resizeHandleProps={listPanel.resizeHandleProps}
              railWidth={panelLayout.railWidth}
              railResizeHandleProps={railPanel.resizeHandleProps}
              tree={
                <FileTreePanel
                  rootPath={workspace.rootPath}
                  fileTree={workspace.fileTree}
                  treeFilterQuery={treeFilterQuery}
                  focusPath={workspace.treeFocusPath ?? null}
                  onFocusChange={(path) =>
                    dispatchAndMirror({ type: "tree/focusChanged", path })
                  }
                  searchState={fullTextSearchState}
                  collapsed={false}
                  dispatch={dispatchAndMirror}
                  preferences={preferences}
                  activeTabPath={activeTab?.path ?? null}
                  onActionsChange={setFileTreeActions}
                  onSearchQueryChange={(query) =>
                    dispatchAndMirror({
                      type: "search/queryChanged",
                      query,
                    })
                  }
                  onSearchCaseSensitiveToggle={() =>
                    dispatchAndMirror({
                      type: "search/caseSensitivityToggled",
                    })
                  }
                  onSearchResultClick={handleWorkspaceSearchResultClick}
                  resizeHandleProps={{}}
                />
              }
            />
          )}
        </div>

        <main
          className="flex min-h-0 min-w-0 flex-col bg-[var(--mdx-content-bg)]"
          style={{ gridColumn: 2 }}
        >
          {isMemoryView ? (
            <div className="min-h-0 flex-1 overflow-hidden bg-[var(--mdx-content-bg)]">
              <MemoryPanel rootPath={workspace.rootPath} />
            </div>
          ) : isLlmWikiView ? (
            <div className="min-h-0 flex-1 overflow-hidden bg-[var(--mdx-content-bg)]">
              <LlmWikiPanel
                llmWiki={llmWiki}
                onConfigureLlm={() => setSettingsOpen(true)}
              />
            </div>
          ) : (
            <>
          <TabStrip
            tabs={tabs}
            activeTabId={workspace.activeTabId}
            dispatch={dispatchAndMirror}
            onCloseTab={closeTab}
            onRevealTab={(tab) => revealPathInFileManager(tab.path)}
            onCopyTabPath={(tab) => copyPathToClipboard(tab.path)}
            onCloseOtherTabs={closeOtherTabs}
            onCloseAllTabs={closeAllTabs}
          />
          {draftMessage ? (
            <div className="border-b border-[var(--mdx-separator)] bg-[var(--mdx-chrome-bg)] px-3 py-1.5 text-xs text-base-content/65">
              {draftMessage}
            </div>
          ) : null}
          {activeDraftRecovery ? (
            <RecoveryBanner
              title="发现未保存草稿"
              path={
                activeDraftDetailsOpen
                  ? displayPath(activeDraftRecovery.draft)
                  : null
              }
              message={
                activeDraftDetailsOpen
                  ? "这个文件有一个自动保存的草稿。"
                  : "自动保存的草稿仍可恢复。"
              }
              priority={activeDraftRecovery.fileExists ? "normal" : "high"}
              actions={[
                {
                  label: "恢复草稿",
                  primary: true,
                  onClick: recoverActiveDraft,
                },
                {
                  label: "查看差异",
                  onClick: () => setActiveDraftDiffOpen(true),
                },
                {
                  label: "保留磁盘版本",
                  onClick: keepActiveDiskVersion,
                },
                {
                  label: "稍后",
                  onClick: postponeActiveDraftRecovery,
                },
              ]}
            />
          ) : null}
          {visibleOrphanDrafts.map((draft) => {
            const canRestoreOriginal = parentExistsInWorkspace(
              workspace.rootPath,
              draft.realPath,
              workspace.fileTree,
            );

            return (
              <RecoveryBanner
                key={draft.draftId}
                title="发现孤立草稿"
                path={displayPath(draft)}
                message={
                  canRestoreOriginal
                    ? "原文件不存在，可以恢复到原路径或另存为新文件。"
                    : "原文件不存在，原路径父文件夹也不存在。"
                }
                priority="high"
                actions={[
                  {
                    label: "另存为",
                    primary: true,
                    onClick: () => void saveOrphanDraftAs(draft),
                  },
                  {
                    label: canRestoreOriginal
                      ? "恢复原路径"
                      : "恢复原路径不可用",
                    disabled: !canRestoreOriginal,
                    onClick: () => void restoreOrphanDraftOriginalPath(draft),
                  },
                  {
                    label: "删除",
                    destructive: true,
                    onClick: () => deleteOrphanDraft(draft),
                  },
                  {
                    label: "稍后",
                    onClick: () => postponeOrphanDraft(draft),
                  },
                ]}
              />
            );
          })}
          {activeExternalConflict ? (
            <RecoveryBanner
              title="文件已被外部修改"
              path={activeExternalConflict.path}
              message="磁盘内容已变化，请选择保留当前编辑或重新加载磁盘版本。"
              priority="high"
              actions={[
                {
                  label: "查看差异",
                  primary: true,
                  onClick: () => setExternalConflictDiffOpen(true),
                },
                {
                  label: "保留我的编辑",
                  onClick: () => void keepExternalConflictEdits(),
                },
                {
                  label: "重新加载磁盘",
                  destructive: true,
                  onClick: () => void reloadExternalConflictDiskVersion(),
                },
                {
                  label: "稍后",
                  onClick: postponeExternalConflict,
                },
              ]}
            />
          ) : null}
          {activeExternalDeletedPrompt ? (
            <RecoveryBanner
              title="文件已被外部删除"
              path={activeExternalDeletedPrompt.path}
              message={
                activeExternalDeletedPrompt.dirty
                  ? "已从磁盘删除，当前标签页还有未保存编辑。"
                  : "已从磁盘删除。"
              }
              priority={activeExternalDeletedPrompt.dirty ? "high" : "normal"}
              actions={
                activeExternalDeletedPrompt.dirty
                  ? [
                      {
                        label: "另存为",
                        primary: true,
                        onClick: () =>
                          void openDeletedWorkspaceTabSaveAs(
                            activeExternalDeletedPrompt,
                          ),
                      },
                      {
                        label: "恢复原路径",
                        onClick: () =>
                          void restoreDeletedWorkspaceTabOriginalPath(
                            activeExternalDeletedPrompt,
                          ),
                      },
                      {
                        label: "不保存并关闭",
                        destructive: true,
                        onClick: () =>
                          void closeDeletedWorkspaceTab(
                            activeExternalDeletedPrompt.tabId,
                            { discardDirty: true },
                          ),
                      },
                    ]
                  : [
                      {
                        label: "关闭",
                        primary: true,
                        onClick: () =>
                          void closeDeletedWorkspaceTab(
                            activeExternalDeletedPrompt.tabId,
                          ),
                      },
                      {
                        label: "另存为",
                        onClick: () =>
                          void openDeletedWorkspaceTabSaveAs(
                            activeExternalDeletedPrompt,
                          ),
                      },
                    ]
              }
            />
          ) : null}
          <EditorStage
            rootPath={workspace.rootPath}
            activeTab={activeTab}
            dispatch={dispatchAndMirror}
            editorSession={editorSession}
            editorSurfaceRef={editorSurfaceRef}
            pendingCliCommand={pendingCliCommand}
            onOpenWikilink={openWikilink}
            onOpenLink={openLink}
            onCreateMarkdownFile={fileTreeActions?.createMarkdownFile}
            onInitialMarkdownLoadSettled={() =>
              setInitialEditorLoadSettled(true)
            }
            onPendingCliCommandHandled={handlePendingCliCommandHandled}
            onSelectionChange={handleSelectionChange}
            onModeChange={setEditorMode}
            imageFailure={imageFailure}
            onImageFailure={setImageFailure}
          />
          {/*
           * Only for a document whose text is actually in hand: a tab still
           * loading, an image, a PDF has no words to count, and a bar reading
           * "0 词" over it would be a count rather than a blank.
           */}
          {activeTabIsLoadedMarkdown ? (
            <DocumentStatusBar markdown={activeTab?.markdown ?? ""} />
          ) : null}
            </>
          )}
        </main>

      </div>
      {externalConflictDiffOpen && activeExternalConflict ? (
        <DiffViewer
          open={externalConflictDiffOpen}
          title="文件已被外部修改"
          leftTitle="磁盘版本"
          rightTitle="我的编辑"
          leftText={activeExternalConflict.diskMarkdown}
          rightText={activeTab?.markdown ?? ""}
          primaryAction={{
            label: "保留我的编辑",
            onClick: () => void keepExternalConflictEdits(),
          }}
          secondaryActions={[
            {
              label: "重新加载磁盘",
              destructive: true,
              onClick: () => void reloadExternalConflictDiskVersion(),
            },
            {
              label: "复制当前内容",
              onClick: copyExternalConflictMarkdown,
            },
            {
              label: "稍后",
              onClick: postponeExternalConflict,
            },
          ]}
          onClose={postponeExternalConflict}
        />
      ) : null}
      {activeDraftRecovery && activeTab ? (
        <DiffViewer
          open={activeDraftDiffOpen}
          title="草稿差异"
          leftTitle="磁盘版本"
          rightTitle="草稿"
          leftText={activeTab.markdown ?? ""}
          rightText={activeDraftRecovery.draft.markdown}
          primaryAction={{
            label: "恢复草稿",
            onClick: recoverActiveDraft,
          }}
          secondaryActions={[
            {
              label: "保留磁盘版本",
              onClick: keepActiveDiskVersion,
            },
            {
              label: "稍后",
              onClick: postponeActiveDraftRecovery,
            },
          ]}
          onClose={postponeActiveDraftRecovery}
        />
      ) : null}
    </div>
  );
}

async function refreshTree(
  rootPath: string,
  getCurrentRootPath: () => string,
  dispatch: (action: WorkspaceAction) => void,
  preferences: AppPreferences,
) {
  const { invoke } = await tauriCore();
  const scanned = await invoke<ScanWorkspaceResult>("scan_workspace", {
    rootPath,
    options: {
      excludeDirs: preferences.fileTreeExcludeDirs,
    },
  });

  if (getCurrentRootPath() !== rootPath) {
    return;
  }

  dispatch({
    type: "tree/loaded",
    fileTree: scanned.nodes,
  });
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}


function draftTabsForAction(
  workspace: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceTab[] {
  const activeTab = workspace.activeTabId
    ? workspace.tabs[workspace.activeTabId]
    : undefined;

  switch (action.type) {
    case "tab/activated":
      return action.tabId !== workspace.activeTabId &&
        shouldSaveWorkspaceTabDraft(activeTab)
        ? [activeTab]
        : [];
    case "tab/opened":
      return action.tab.tabId !== workspace.activeTabId &&
        shouldSaveWorkspaceTabDraft(activeTab)
        ? [activeTab]
        : [];
    case "tab/closed":
      return filterDraftTabs([workspace.tabs[action.tabId]]);
    case "tab/closedByPath": {
      const path = normalizeWorkspacePath(action.path);

      return filterDraftTabs(
        workspace.tabOrder
          .map((tabId) => workspace.tabs[tabId])
          .filter(
            (tab): tab is WorkspaceTab =>
              Boolean(tab) && normalizeWorkspacePath(tab.path) === path,
          ),
      );
    }
    case "tab/closedByPrefix": {
      return filterDraftTabs(
        workspace.tabOrder
          .map((tabId) => workspace.tabs[tabId])
          .filter(
            (tab): tab is WorkspaceTab =>
              Boolean(tab) && isPathUnderPrefix(tab.path, action.prefix),
          ),
      );
    }
    default:
      return [];
  }
}

function filterDraftTabs(tabs: Array<WorkspaceTab | undefined>) {
  return tabs.filter(shouldSaveWorkspaceTabDraft);
}

function shouldSaveWorkspaceTabDraft(
  tab: WorkspaceTab | undefined,
): tab is WorkspaceTab & { markdown: string } {
  return Boolean(
    isTauriRuntime() &&
    tab?.dirty &&
    isMarkdownFilePath(tab.path) &&
    tab.markdown !== undefined,
  );
}

function findTabIdByPath(workspace: WorkspaceState, path: string) {
  const normalizedPath = normalizeWorkspacePath(path);

  return workspace.tabOrder.find(
    (tabId) =>
      workspace.tabs[tabId] &&
      normalizeWorkspacePath(workspace.tabs[tabId].path) === normalizedPath,
  );
}

function displayPath(draft: Pick<DraftRecord, "displayPath" | "realPath">) {
  return draft.displayPath?.trim() || draft.realPath;
}

function pathTitle(path: string) {
  const normalizedPath = normalizeWorkspacePath(path);

  return normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;
}

function findExistingParentPath(
  rootPath: string,
  path: string,
  fileTree: FileTreeNode[],
) {
  let candidate = dirname(path);
  const normalizedRootPath = normalizeWorkspacePath(rootPath);

  while (candidate && isPathUnderPrefix(candidate, normalizedRootPath)) {
    if (candidate === normalizedRootPath || folderExists(fileTree, candidate)) {
      return candidate;
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  return normalizedRootPath;
}

function parentExistsInWorkspace(
  rootPath: string,
  path: string,
  fileTree: FileTreeNode[],
) {
  const parent = dirname(path);
  const normalizedRootPath = normalizeWorkspacePath(rootPath);

  return (
    parent === normalizedRootPath ||
    (isPathUnderPrefix(parent, normalizedRootPath) &&
      folderExists(fileTree, parent))
  );
}

function folderExists(nodes: FileTreeNode[], path: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path);

  for (const node of nodes) {
    if (node.kind !== "folder") {
      continue;
    }

    if (normalizeWorkspacePath(node.path) === normalizedPath) {
      return true;
    }

    if (folderExists(node.children, normalizedPath)) {
      return true;
    }
  }

  return false;
}

function isPathUnderPrefix(path: string, prefix: string) {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedPrefix = normalizeWorkspacePath(prefix);

  if (!normalizedPath || !normalizedPrefix) {
    return false;
  }

  if (normalizedPath === normalizedPrefix) {
    return true;
  }

  const prefixWithSlash = normalizedPrefix.endsWith("/")
    ? normalizedPrefix
    : `${normalizedPrefix}/`;

  return normalizedPath.startsWith(prefixWithSlash);
}

function formatError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return `${fallback} ${error.message}`;
  }

  if (typeof error === "string" && error.length > 0) {
    return `${fallback} ${error}`;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return `${fallback} ${error.message}`;
  }

  return fallback;
}

function isSearchRequestNotFoundError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "errorCode" in error &&
    error.errorCode === "search_request_not_found"
  ) {
    return true;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.includes("search_request_not_found");
  }

  return false;
}

async function handleCliOpenFile(
  payload: CliOpenFileEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  queuePendingCommand: (command: PendingCliEditorCommand) => void,
) {
  const normalizedPath = payload.path;
  const existingTab = workspace.tabOrder
    .map((tabId) => workspace.tabs[tabId])
    .find((tab) => tab?.path === normalizedPath);

  if (existingTab) {
    dispatch({
      type: "tab/activated",
      tabId: existingTab.tabId,
    });
    queuePendingCommand({
      id: nanoid(8),
      kind: "focus",
      tabId: existingTab.tabId,
    });
    return;
  }

  const tabId = nanoid(8);
  const title = normalizedPath.split("/").pop() ?? normalizedPath;
  dispatch({
    type: "tab/opened",
    tab: {
      tabId,
      path: normalizedPath,
      title,
      dirty: false,
      needsRenameOnFirstSave: false,
    },
  });
  queuePendingCommand({
    id: nanoid(8),
    kind: "focus",
    tabId,
  });
}

function handleCliInsert(
  payload: CliInsertEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  queuePendingCommand: (command: PendingCliEditorCommand) => void,
) {
  const tabId = payload.tabId ?? workspace.activeTabId ?? null;

  if (!tabId || !workspace.tabs[tabId]) {
    return;
  }

  if (workspace.activeTabId !== tabId) {
    dispatch({
      type: "tab/activated",
      tabId,
    });
  }

  queuePendingCommand({
    id: nanoid(8),
    kind: "insert",
    tabId,
    text: payload.text,
  });
}

function handleCliFocusTab(
  payload: CliTabEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  queuePendingCommand: (command: PendingCliEditorCommand) => void,
) {
  const tabId =
    payload.tabId ?? workspace.activeTabId ?? workspace.tabOrder[0] ?? null;

  if (!tabId) {
    return;
  }

  if (workspace.tabs[tabId]) {
    dispatch({
      type: "tab/activated",
      tabId,
    });
    queuePendingCommand({
      id: nanoid(8),
      kind: "focus",
      tabId,
    });
  }
}

function handleCliCloseTab(
  payload: CliCloseEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
) {
  const tabId = payload.tabId ?? workspace.activeTabId ?? null;

  if (!tabId || !workspace.tabs[tabId]) {
    return;
  }

  dispatch({
    type: "tab/closed",
    tabId,
  });
}

async function handleCliSaveTab(
  payload: CliTabEvent,
  workspace: WorkspaceState,
  saveTab: (tabId: string) => Promise<boolean>,
) {
  const tabId = payload.tabId ?? workspace.activeTabId ?? null;

  if (!tabId || !workspace.tabs[tabId]) {
    return;
  }

  await saveTab(tabId);
}

async function handleCliFileCreated(
  payload: CliFileCreatedEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  queuePendingCommand: (command: PendingCliEditorCommand) => void,
  preferences: AppPreferences,
) {
  const tabId = nanoid(8);
  dispatch({
    type: "tab/opened",
    tab: {
      tabId,
      path: payload.path,
      title: payload.name,
      dirty: false,
      needsRenameOnFirstSave: payload.needsRenameOnFirstSave,
    },
  });

  queuePendingCommand({
    id: nanoid(8),
    kind: "focus",
    tabId,
  });

  await refreshTree(
    workspace.rootPath,
    () => workspace.rootPath,
    dispatch,
    preferences,
  );
}

async function handleCliFileUpdated(
  payload: CliFileUpdatedEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
) {
  await refreshCleanOpenTabFromDisk({
    payload,
    workspace,
    dispatch,
    invoke: async (command, args) => {
      const { invoke } = await tauriCore();
      return invoke(command, args);
    },
  });
}

async function handleCliFolderCreated(
  _payload: CliFolderCreatedEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  preferences: AppPreferences,
) {
  await refreshTree(
    workspace.rootPath,
    () => workspace.rootPath,
    dispatch,
    preferences,
  );
}

async function handleCliPathRenamed(
  payload: CliPathRenamedEvent,
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  preferences: AppPreferences,
) {
  dispatch(
    payload.affectedPrefix
      ? {
          type: "tab/prefixRemapped",
          affectedPrefix: payload.affectedPrefix,
        }
      : {
          type: "tab/pathRemapped",
          fromPath: payload.oldPath,
          toPath: payload.newPath,
        },
  );

  await refreshTree(
    workspace.rootPath,
    () => workspace.rootPath,
    dispatch,
    preferences,
  );
}
