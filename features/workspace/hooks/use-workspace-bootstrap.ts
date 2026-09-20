"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { createWorkspaceState, workspaceReducer } from "../lib/workspace-reducer";
import { buildFileTree } from "../lib/file-tree";
import {
    clampListWidth,
    clampRailWidth,
    DEFAULT_LIST_WIDTH,
    MIN_RAIL_WIDTH,
    NAVIGATOR_RAIL_WIDTH,
} from "../lib/panel-layout";
import type {
    AppPreferences,
    FileTreeNode,
    PersistedAppState,
    PersistedWindowSize,
    PersistedWorkspaceState,
    PersistedWorkspaceTab,
    WorkspaceAction,
    WorkspacePanelState,
    WorkspaceState,
    WorkspaceTab,
} from "../lib/types";
import {
    isPathInsideRoot,
    normalizeWorkspacePath,
} from "../lib/path";
import { basename } from "../lib/workspace-save";
import {
    DEFAULT_WINDOW_SIZE,
    normalizePersistedWindowSize,
} from "../lib/window-size";
import { findPersistedWorkspaceForRoot } from "../lib/persisted-workspace";
import {
    appPreferencesEqual,
    createDefaultAppPreferences,
    normalizeAppPreferences,
} from "../lib/preferences";
import { stopListening } from "../../../common/lib/tauri-events";

type BootstrapStatus = "loading" | "ready" | "empty" | "error";

/** Where a folder the user picked should open. */
export type WorkspaceOpenChoice = "current" | "new";

export interface WorkspaceBootstrapOptions {
    /**
     * Ask the user which window a folder should open in, or null if they
     * backed out. Injected rather than called here so this hook stays testable
     * without a dialog in the DOM.
     */
    confirmOpenTarget?: (rootPath: string) => Promise<WorkspaceOpenChoice | null>;
    /** The root this window was opened for, and what launch could not restore. */
    session?: { rootPath: string | null; skippedRoots: string[] };
}

interface WorkspaceOpenTarget {
    canonicalPath: string;
    existing: "current" | "other" | null;
}

interface BindWorkspaceRootResult {
    bound: boolean;
    ownedByOtherWindow: boolean;
}

interface ScanWorkspaceResult {
    rootPath: string;
    nodes: FileTreeNode[];
    truncated: boolean;
    entryCount: number;
    warnings: string[];
}

interface ScanWorkspaceOptions {
    excludeDirs: string[];
}

interface BootstrapWorkspaceResult {
    workspace: WorkspaceState;
    appState: PersistedAppState;
}

const STATE_VERSION = 1;
const DEFAULT_PANEL_STATE: WorkspacePanelState = {
    navigatorCollapsed: false,
    listWidth: DEFAULT_LIST_WIDTH,
    railWidth: NAVIGATOR_RAIL_WIDTH,
    rightCollapsed: false,
    rightWidth: 300,
};

export function useWorkspaceBootstrap(options: WorkspaceBootstrapOptions = {}) {
    // Read through a ref: both are called from callbacks and effects that must
    // not be rebuilt when the caller passes a new closure.
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const [status, setStatus] = useState<BootstrapStatus>("loading");
    const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [isTauri, setIsTauri] = useState(false);
    const [preferences, setPreferences] = useState<AppPreferences>(
        createDefaultAppState().preferences,
    );
    const appStateRef = useRef<PersistedAppState>(createDefaultAppState());
    const workspaceRef = useRef<WorkspaceState | null>(null);
    const openWorkspaceRef =
        useRef<(rootPath: string) => Promise<void>>(async () => {});
    const chooseWorkspaceRef = useRef<() => Promise<void>>(async () => {});
    const preferenceRefreshSequenceRef = useRef(0);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const windowResizeSaveTimerRef =
        useRef<ReturnType<typeof setTimeout> | null>(null);
    const windowSizePersistenceReadyRef = useRef(false);

    const dispatch = useCallback((action: WorkspaceAction) => {
        setWorkspace((current) =>
            current === null ? current : workspaceReducer(current, action),
        );
    }, []);

    const openWorkspace = useCallback(async (rootPath: string) => {
        const normalizedRootPath = normalizeWorkspacePath(rootPath);

        if (!normalizedRootPath) {
            setStatus("empty");
            setMessage("请选择一个文件夹以打开工作区。");
            setWorkspace(null);
            return;
        }

        setStatus("loading");
        setMessage(null);

        try {
            const result = await bootstrapWorkspace(
                normalizedRootPath,
                appStateRef.current,
            );
            // Claim the root before showing it. Another window can take it
            // between the duplicate check and here, and a window that shows a
            // root it does not own is invisible to the registry: it is left
            // out of the restore list and its window size is written into the
            // owning window's entry.
            const bound = await bindWorkspaceRoot(normalizedRootPath);
            if (bound && !bound.bound) {
                if (bound.ownedByOtherWindow) {
                    await focusWorkspaceRoot(normalizedRootPath);
                    setWorkspace(null);
                    setStatus("empty");
                    setMessage(
                        "这个文件夹已经在另一个窗口打开了。",
                    );
                }

                return;
            }

            appStateRef.current = result.appState;
            setWorkspace(result.workspace);
            setStatus("ready");
            // Rust names a window when it builds it, but a window that picked
            // its folder itself, or switched to another one, still carries the
            // name it opened with.
            await setWorkspaceWindowTitle(result.workspace.rootPath);
        } catch (error) {
            setWorkspace(null);
            setStatus("error");
            setMessage(formatError(error, "恢复工作区失败。"));
        }
    }, []);

    const chooseWorkspace = useCallback(async () => {
        if (!isTauriRuntime()) {
            setStatus("empty");
            setMessage("文件夹选择仅在桌面版中可用。");
            return;
        }

        try {
            const selectedRoot = await chooseWorkspaceRoot();

            if (!selectedRoot) {
                setStatus((current) => (workspace ? current : "empty"));
                setMessage(
                    workspace
                        ? null
                        : "请选择一个文件夹以打开工作区。",
                );
                return;
            }

            const target = await resolveWorkspaceOpenTarget(selectedRoot);

            // A folder that is already open has no good answer to
            // "current window or new window", so it is never asked: a new
            // window would duplicate it, and the current one would leave two
            // windows on one root.
            if (target.existing === "current") {
                return;
            }

            if (target.existing === "other") {
                await focusWorkspaceRoot(target.canonicalPath);
                return;
            }

            const confirm = optionsRef.current.confirmOpenTarget;
            const choice = confirm
                ? await confirm(target.canonicalPath)
                : "current";

            if (choice === null) {
                return;
            }

            if (choice === "new") {
                await openWorkspaceInNewWindow(target.canonicalPath);
                return;
            }

            await openWorkspace(target.canonicalPath);
        } catch (error) {
            setStatus(workspace ? "ready" : "error");
            setMessage(formatError(error, "选择工作区失败。"));
        }
    }, [openWorkspace, workspace]);

    useEffect(() => {
        openWorkspaceRef.current = openWorkspace;
    }, [openWorkspace]);

    useEffect(() => {
        chooseWorkspaceRef.current = chooseWorkspace;
    }, [chooseWorkspace]);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            await Promise.resolve();

            const tauriRuntime = isTauriRuntime();

            if (cancelled) {
                return;
            }

            setIsTauri(tauriRuntime);

            if (!tauriRuntime) {
                setStatus("empty");
                setMessage("请使用桌面版选择并恢复文件夹。");
                return;
            }

            try {
                const appState = await loadAppState();

                if (cancelled) {
                    return;
                }

                windowSizePersistenceReadyRef.current = false;
                await restoreTauriWindowSize(
                    windowSizeForRoot(
                        appState,
                        optionsRef.current.session?.rootPath ?? null,
                    ),
                );

                if (cancelled) {
                    return;
                }

                windowSizePersistenceReadyRef.current = true;
                appStateRef.current = appState;
                setPreferences(appState.preferences);

                // A window opened for a specific root must open that one. It
                // comes before recentWorkspaceRoot, or a restore of several
                // windows would point every one of them at the same folder.
                const assignedRoot = optionsRef.current.session?.rootPath;
                if (assignedRoot) {
                    await openWorkspaceRef.current(assignedRoot);
                    return;
                }

                // This window exists to run the folder picker; opening the
                // recent workspace first would scan and bind a workspace the
                // user is about to be asked to replace.
                if (startupActionIsOpenFolder()) {
                    setStatus("empty");
                    setMessage(null);
                    return;
                }

                if (appStateRef.current.recentWorkspaceRoot) {
                    await openWorkspaceRef.current(
                        appStateRef.current.recentWorkspaceRoot,
                    );
                    return;
                }

                // Through chooseWorkspace, not openWorkspace: other windows
                // may already be up (a CLI `new`, or a document window opening
                // one), and this is the last folder-open path that would
                // otherwise skip the duplicate check.
                await chooseWorkspaceRef.current();
            } catch (error) {
                if (cancelled) {
                    return;
                }

                windowSizePersistenceReadyRef.current = true;
                appStateRef.current = createDefaultAppState();
                setStatus("error");
                setMessage(formatError(error, "加载应用状态失败。"));
            }
        }

        void load();

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        workspaceRef.current = workspace;
    }, [workspace]);

    useEffect(() => {
        if (!workspace || !isTauri) {
            return;
        }

        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }

        saveTimerRef.current = setTimeout(() => {
            const persisted = toPersistedWorkspace(workspace);
            appStateRef.current = upsertWorkspaceState(
                appStateRef.current,
                persisted,
            );
            void saveWorkspaceState(persisted).catch((error) => {
                setMessage(formatError(error, "保存应用状态失败。"));
            });
            saveTimerRef.current = null;
        }, 350);

        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [isTauri, workspace]);

    useEffect(() => {
        if (!isTauri) {
            return;
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;

        const clearResizeTimer = () => {
            if (windowResizeSaveTimerRef.current) {
                clearTimeout(windowResizeSaveTimerRef.current);
                windowResizeSaveTimerRef.current = null;
            }
        };

        const persistWindowSize = (windowSize: PersistedWindowSize) => {
            const rootPath = workspaceRef.current?.rootPath ?? null;
            appStateRef.current = withWindowSize(
                appStateRef.current,
                rootPath,
                windowSize,
            );
            void saveWindowSize(rootPath, windowSize).catch((error) => {
                setMessage(formatError(error, "保存应用状态失败。"));
            });
        };

        const scheduleWindowSizeSave = (windowSize: PersistedWindowSize) => {
            if (!windowSizePersistenceReadyRef.current) {
                return;
            }

            clearResizeTimer();
            windowResizeSaveTimerRef.current = setTimeout(() => {
                persistWindowSize(windowSize);
                windowResizeSaveTimerRef.current = null;
            }, 350);
        };

        const onBrowserResize = () => {
            scheduleWindowSizeSave(
                getCurrentWindowSize(currentWindowSizeFallback()),
            );
        };

        function currentWindowSizeFallback() {
            return windowSizeForRoot(
                appStateRef.current,
                workspaceRef.current?.rootPath ?? null,
            );
        }

        async function subscribeToWindowResize() {
            try {
                const { getCurrentWindow } = await import(
                    "@tauri-apps/api/window"
                );
                const currentWindow = getCurrentWindow();
                const nextUnlisten = await currentWindow.onResized(
                    ({ payload }) => {
                        void currentWindow
                            .scaleFactor()
                            .then((scaleFactor) =>
                                payload.toLogical(scaleFactor),
                            )
                            .then((logicalSize) => {
                                scheduleWindowSizeSave({
                                    width: logicalSize.width,
                                    height: logicalSize.height,
                                });
                            })
                            .catch((error) => {
                                console.warn(
                                    "Failed to convert resized window size.",
                                    error,
                                );
                            });
                    },
                );

                if (disposed) {
                    stopListening(nextUnlisten);
                    return;
                }

                unlisten = nextUnlisten;
            } catch (error) {
                console.warn(
                    "Failed to subscribe to Tauri window resize; using browser resize events.",
                    error,
                );

                if (!disposed) {
                    window.addEventListener("resize", onBrowserResize);
                }
            }
        }

        void subscribeToWindowResize();

        return () => {
            disposed = true;
            clearResizeTimer();

            if (unlisten) {
                stopListening(unlisten);
            }

            window.removeEventListener("resize", onBrowserResize);
        };
    }, [isTauri]);

    const persistCurrentWindowSize = useCallback(async () => {
        if (!isTauri) {
            return;
        }

        if (windowResizeSaveTimerRef.current) {
            clearTimeout(windowResizeSaveTimerRef.current);
            windowResizeSaveTimerRef.current = null;
        }

        const rootPath = workspaceRef.current?.rootPath ?? null;
        const windowSize = await getCurrentTauriWindowSize(
            windowSizeForRoot(appStateRef.current, rootPath),
        );
        appStateRef.current = withWindowSize(
            appStateRef.current,
            rootPath,
            windowSize,
        );
        await saveWindowSize(rootPath, windowSize);
    }, [isTauri]);

    return useMemo(
        () => ({
            status,
            workspace,
            dispatch,
            chooseWorkspace,
            isTauri,
            canChooseWorkspace: isTauri,
            message,
            preferences,
            persistCurrentWindowSize,
            updatePreferences: async (nextPreferences: AppPreferences) => {
                const normalizedPreferences =
                    normalizeAppPreferences(nextPreferences);

                if (
                    appPreferencesEqual(
                        normalizedPreferences,
                        appStateRef.current.preferences,
                    )
                ) {
                    return;
                }

                appStateRef.current = {
                    ...appStateRef.current,
                    preferences: normalizedPreferences,
                };
                setPreferences(normalizedPreferences);
                await saveAppPreferences(normalizedPreferences);

                const currentWorkspace = workspaceRef.current;
                if (currentWorkspace) {
                    const refreshSequence =
                        preferenceRefreshSequenceRef.current + 1;
                    preferenceRefreshSequenceRef.current = refreshSequence;
                    void refreshCurrentWorkspaceInBackground(
                        currentWorkspace.rootPath,
                        normalizedPreferences,
                        refreshSequence,
                        preferenceRefreshSequenceRef,
                        workspaceRef,
                        setWorkspace,
                        setMessage,
                    );
                }
            },
        }),
        [
            chooseWorkspace,
            dispatch,
            isTauri,
            message,
            persistCurrentWindowSize,
            preferences,
            status,
            workspace,
        ],
    );
}

async function bootstrapWorkspace(
    rootPath: string,
    appState: PersistedAppState,
): Promise<BootstrapWorkspaceResult> {
    const scanned = await scanWorkspace(rootPath, {
        excludeDirs: appState.preferences.fileTreeExcludeDirs,
    });
    const builtTree = buildFileTree(scanned.nodes);

    if (!builtTree.ok) {
        throw new Error(builtTree.error.message);
    }

    const restoredRootPath = normalizeWorkspacePath(scanned.rootPath || rootPath);
    const persistedWorkspace = findPersistedWorkspaceForRoot(
        appState,
        rootPath,
        restoredRootPath,
    );
    const normalizedScan = {
        ...scanned,
        nodes: builtTree.nodes,
    };
    const workspace = applyPersistedWorkspace(
        createWorkspaceState(restoredRootPath, builtTree.nodes),
        persistedWorkspace,
        normalizedScan,
    );
    return {
        workspace,
        appState: upsertWorkspaceState(appState, toPersistedWorkspace(workspace)),
    };
}

function applyPersistedWorkspace(
    workspace: WorkspaceState,
    persistedWorkspace: PersistedWorkspaceState | undefined,
    scanned: ScanWorkspaceResult,
): WorkspaceState {
    if (!persistedWorkspace) {
        return workspace;
    }

    const knownFilePaths = scanned.truncated
        ? null
        : collectFilePaths(scanned.nodes);
    const tabs = persistedWorkspace.tabs
        .filter((tab) => shouldRestoreTab(workspace.rootPath, tab, knownFilePaths))
        .map((tab): WorkspaceTab => ({ ...tab }));
    const tabMap = Object.fromEntries(tabs.map((tab) => [tab.tabId, tab]));
    const tabOrder = tabs.map((tab) => tab.tabId);
    const activeTabId =
        persistedWorkspace.activeTabId && tabMap[persistedWorkspace.activeTabId]
            ? persistedWorkspace.activeTabId
            : tabOrder[0] ?? null;

    return {
        ...workspace,
        panel: normalizePanelState(persistedWorkspace.panels),
        // The folder this workspace was left looking at. If it has since gone,
        // the reducer drops it the first time the tree is loaded.
        treeFocusPath: persistedWorkspace.treeFocusPath ?? null,
        tabs: tabMap,
        tabOrder,
        activeTabId,
    };
}

function shouldRestoreTab(
    rootPath: string,
    tab: PersistedWorkspaceTab,
    knownFilePaths: Set<string> | null,
) {
    const tabPath = normalizeWorkspacePath(tab.path);

    if (!isPathInsideRoot(rootPath, tabPath)) {
        return false;
    }

    return knownFilePaths === null || knownFilePaths.has(tabPath);
}

async function refreshCurrentWorkspaceInBackground(
    rootPath: string,
    preferences: AppPreferences,
    sequence: number,
    sequenceRef: MutableRefObject<number>,
    workspaceRef: MutableRefObject<WorkspaceState | null>,
    setWorkspace: Dispatch<SetStateAction<WorkspaceState | null>>,
    setMessage: Dispatch<SetStateAction<string | null>>,
) {
    try {
        const scanned = await scanWorkspace(rootPath, {
            excludeDirs: preferences.fileTreeExcludeDirs,
        });
        const builtTree = buildFileTree(scanned.nodes);

        if (!builtTree.ok) {
            throw new Error(builtTree.error.message);
        }

        if (
            sequenceRef.current !== sequence ||
            workspaceRef.current?.rootPath !== rootPath
        ) {
            return;
        }

        setWorkspace((current) =>
            current?.rootPath === rootPath
                ? workspaceReducer(current, {
                      type: "tree/loaded",
                      fileTree: builtTree.nodes,
                  })
                : current,
        );
    } catch (error) {
        if (sequenceRef.current === sequence) {
            setMessage(formatError(error, "后台刷新工作区失败。"));
        }
    }
}

function collectFilePaths(nodes: FileTreeNode[]) {
    const paths = new Set<string>();

    for (const node of nodes) {
        if (node.kind === "file") {
            paths.add(normalizeWorkspacePath(node.path));
            continue;
        }

        for (const childPath of collectFilePaths(node.children)) {
            paths.add(childPath);
        }
    }

    return paths;
}

/**
 * Update this window's read cache of the app state.
 *
 * The cache only mirrors what this window itself wrote; the file on disk is
 * merged by Rust, which is the only writer that sees every window.
 */
function upsertWorkspaceState(
    appState: PersistedAppState,
    persistedWorkspace: PersistedWorkspaceState,
): PersistedAppState {
    const rootPath = normalizeWorkspacePath(persistedWorkspace.rootPath);
    const existing = appState.workspaces.find(
        (candidate) => normalizeWorkspacePath(candidate.rootPath) === rootPath,
    );
    const otherWorkspaces = appState.workspaces.filter(
        (candidate) => normalizeWorkspacePath(candidate.rootPath) !== rootPath,
    );

    return {
        ...appState,
        stateVersion: appState.stateVersion || STATE_VERSION,
        recentWorkspaceRoot: rootPath,
        workspaces: [
            {
                ...persistedWorkspace,
                // A tab save carries no size; keep whatever this root had.
                windowSize:
                    persistedWorkspace.windowSize ?? existing?.windowSize,
            },
            ...otherWorkspaces,
        ],
    };
}

function withWindowSize(
    appState: PersistedAppState,
    rootPath: string | null,
    windowSize: PersistedWindowSize,
): PersistedAppState {
    const normalizedWindowSize = normalizePersistedWindowSize(windowSize);

    if (!rootPath) {
        return {
            ...appState,
            stateVersion: appState.stateVersion || STATE_VERSION,
            windowSize: normalizedWindowSize,
        };
    }

    const normalizedRootPath = normalizeWorkspacePath(rootPath);
    const existing = appState.workspaces.find(
        (candidate) =>
            normalizeWorkspacePath(candidate.rootPath) === normalizedRootPath,
    );

    return upsertWorkspaceState(appState, {
        ...(existing ?? {
            rootPath: normalizedRootPath,
            tabs: [],
            activeTabId: null,
            panels: DEFAULT_PANEL_STATE,
            treeFocusPath: null,
        }),
        windowSize: normalizedWindowSize,
    });
}

/**
 * The size a window showing `rootPath` should open at.
 *
 * Falls back to the top-level size for a root that has never been sized on its
 * own, and for a window with no workspace yet.
 */
function windowSizeForRoot(
    appState: PersistedAppState,
    rootPath: string | null,
): PersistedWindowSize {
    if (!rootPath) {
        return appState.windowSize;
    }

    const normalizedRootPath = normalizeWorkspacePath(rootPath);
    const workspace = appState.workspaces.find(
        (candidate) =>
            normalizeWorkspacePath(candidate.rootPath) === normalizedRootPath,
    );

    return workspace?.windowSize ?? appState.windowSize;
}

function toPersistedWorkspace(
    workspace: WorkspaceState,
): PersistedWorkspaceState {
    return {
        rootPath: workspace.rootPath,
        tabs: workspace.tabOrder
            .map((tabId) => workspace.tabs[tabId])
            .filter((tab): tab is WorkspaceTab => Boolean(tab))
            .map(
                ({
                    tabId,
                    path,
                    title,
                    dirty,
                    needsRenameOnFirstSave,
                }): PersistedWorkspaceTab => ({
                    tabId,
                    path,
                    title,
                    dirty,
                    needsRenameOnFirstSave,
                }),
            ),
        activeTabId: workspace.activeTabId,
        panels: workspace.panel,
        treeFocusPath: workspace.treeFocusPath ?? null,
    };
}

async function loadAppState() {
    const { invoke } = await import("@tauri-apps/api/core");
    const state = await invoke<PersistedAppState>("load_app_state");

    return normalizeAppState(state);
}

// Each writer submits only its own segment. Rust merges it into the file under
// a lock, because a window sending the whole state would overwrite whatever
// another window had saved since this one started.
async function saveWorkspaceState(workspace: PersistedWorkspaceState) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_workspace_state", { workspace });
}

async function saveWindowSize(
    rootPath: string | null,
    windowSize: PersistedWindowSize,
) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_window_size", {
        rootPath,
        windowSize: normalizePersistedWindowSize(windowSize),
    });
}

async function saveAppPreferences(preferences: AppPreferences) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_app_preferences", { preferences });
}

async function resolveWorkspaceOpenTarget(rootPath: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<WorkspaceOpenTarget>("workspace_open_target", { rootPath });
}

async function focusWorkspaceRoot(rootPath: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("focus_workspace_root", { rootPath });
}

async function openWorkspaceInNewWindow(rootPath: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_workspace_in_new_window", { rootPath });
}

async function bindWorkspaceRoot(rootPath: string) {
    if (!isTauriRuntime()) {
        return null;
    }

    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<BindWorkspaceRootResult>("bind_workspace_root", { rootPath });
}

async function scanWorkspace(rootPath: string, options: ScanWorkspaceOptions) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ScanWorkspaceResult>("scan_workspace", { rootPath, options });
}

/**
 * Name this window after the folder it shows.
 *
 * Several windows all called "Loam" cannot be told apart in the Dock's window
 * list or the window menu. Matches how a document window is named after its
 * file.
 */
async function setWorkspaceWindowTitle(rootPath: string | null) {
    if (!isTauriRuntime()) {
        return;
    }

    const name = rootPath ? basename(rootPath) : "";

    try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(name ? `${name} - Loam` : "Loam");
    } catch (error) {
        console.warn("Failed to set the workspace window title.", error);
    }
}

async function chooseWorkspaceRoot() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
        directory: true,
        multiple: false,
        title: "Open Workspace",
    });

    if (Array.isArray(selected)) {
        return selected[0] ?? null;
    }

    return selected;
}

async function restoreTauriWindowSize(windowSize: PersistedWindowSize) {
    const restoredSize = normalizePersistedWindowSize(windowSize);

    try {
        await setTauriWindowSize(restoredSize);
    } catch (error) {
        console.warn("Failed to restore persisted window size.", error);

        try {
            await setTauriWindowSize(DEFAULT_WINDOW_SIZE);
        } catch (fallbackError) {
            console.warn(
                "Failed to apply default window size fallback.",
                fallbackError,
            );
        }
    }
}

async function setTauriWindowSize(windowSize: PersistedWindowSize) {
    const { getCurrentWindow, LogicalSize } = await import(
        "@tauri-apps/api/window"
    );
    const normalizedWindowSize = normalizePersistedWindowSize(windowSize);

    await getCurrentWindow().setSize(
        new LogicalSize(
            normalizedWindowSize.width,
            normalizedWindowSize.height,
        ),
    );
}

async function getCurrentTauriWindowSize(fallback: PersistedWindowSize) {
    try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const [size, scaleFactor] = await Promise.all([
            currentWindow.innerSize(),
            currentWindow.scaleFactor(),
        ]);
        const logicalSize = size.toLogical(scaleFactor);

        return normalizePersistedWindowSize({
            width: logicalSize.width,
            height: logicalSize.height,
        });
    } catch (error) {
        console.warn("Failed to read current Tauri window size.", error);
        return getCurrentWindowSize(fallback);
    }
}

function normalizeAppState(state: PersistedAppState | null): PersistedAppState {
    if (!state) {
        return createDefaultAppState();
    }

        return {
            stateVersion: state.stateVersion || STATE_VERSION,
            recentWorkspaceRoot: state.recentWorkspaceRoot
                ? normalizeWorkspacePath(state.recentWorkspaceRoot)
                : null,
            preferences: normalizeAppPreferences(state.preferences),
            workspaces: Array.isArray(state.workspaces)
            ? state.workspaces
                  .filter((workspace) => workspace.rootPath)
                  .map((workspace) => ({
                      rootPath: normalizeWorkspacePath(workspace.rootPath),
                      tabs: Array.isArray(workspace.tabs)
                          ? workspace.tabs
                          : [],
                      activeTabId: workspace.activeTabId ?? null,
                      panels: normalizePanelState(workspace.panels),
                      // Absent in anything saved before the tree could be
                      // pointed at a folder.
                      treeFocusPath: workspace.treeFocusPath
                          ? normalizeWorkspacePath(workspace.treeFocusPath)
                          : null,
                      // Absent until this root's window has been resized.
                      windowSize: workspace.windowSize
                          ? normalizePersistedWindowSize(workspace.windowSize)
                          : undefined,
                  }))
            : [],
        windowSize: normalizePersistedWindowSize(state.windowSize),
        openWorkspaceRoots: Array.isArray(state.openWorkspaceRoots)
            ? state.openWorkspaceRoots
                  .filter((root) => typeof root === "string" && root)
                  .map((root) => normalizeWorkspacePath(root))
            : [],
    };
}

function createDefaultAppState(): PersistedAppState {
    return {
        stateVersion: STATE_VERSION,
        recentWorkspaceRoot: null,
        preferences: createDefaultAppPreferences(),
        workspaces: [],
        windowSize: DEFAULT_WINDOW_SIZE,
        openWorkspaceRoots: [],
    };
}

/**
 * A panel state saved by any earlier version of this app.
 *
 * Two renamings have happened here: the left panel became the navigator, and
 * the navigator's single width became one width per column. A state saved before
 * that holds the two columns added together, so the list's width is what is left
 * of it once the tree has taken its share.
 */
interface LegacyPanelState {
    leftCollapsed?: boolean;
    leftWidth?: number;
}

function normalizePanelState(
    // Partial on purpose: the store omits a width nobody has set, which is what
    // lets the legacy branch below tell "unset" from "set to the default".
    panel: (Partial<WorkspacePanelState> & LegacyPanelState) | undefined,
): WorkspacePanelState {
    const railWidth = clampRailWidth(
        panel?.railWidth ?? DEFAULT_PANEL_STATE.railWidth,
    );
    const listWidth =
        panel?.listWidth ??
        (typeof panel?.leftWidth === "number"
            ? panel.leftWidth - railWidth
            : undefined);

    return {
        navigatorCollapsed:
            panel?.navigatorCollapsed ??
            panel?.leftCollapsed ??
            DEFAULT_PANEL_STATE.navigatorCollapsed,
        listWidth: clampListWidth(
            listWidth ?? DEFAULT_PANEL_STATE.listWidth,
        ),
        railWidth,
        rightCollapsed:
            panel?.rightCollapsed ?? DEFAULT_PANEL_STATE.rightCollapsed,
        rightWidth: normalizePanelWidth(
            panel?.rightWidth,
            DEFAULT_PANEL_STATE.rightWidth,
        ),
    };
}

function normalizePanelWidth(width: number | undefined, fallback: number) {
    if (typeof width !== "number" || !Number.isFinite(width)) {
        return fallback;
    }

    // Wide enough for the narrowest column this app has — the rail — and no
    // wider than a panel that would leave the editor nothing.
    return Math.round(Math.min(Math.max(width, MIN_RAIL_WIDTH), 820));
}

function getCurrentWindowSize(fallback: PersistedWindowSize) {
    if (typeof window === "undefined") {
        return normalizePersistedWindowSize(fallback);
    }

    return normalizePersistedWindowSize({
        width: window.innerWidth || fallback.width,
        height: window.innerHeight || fallback.height,
    });
}

/**
 * Whether this window was built to run the folder picker.
 *
 * The picker itself is started by the component that owns the dialog; this
 * only stops the bootstrap from opening something else first.
 */
function startupActionIsOpenFolder() {
    if (typeof window === "undefined" || !window.location.search) {
        return false;
    }

    return (
        new URLSearchParams(window.location.search).get("workspaceAction") ===
        "openFolder"
    );
}

function isTauriRuntime() {
    return (
        typeof window !== "undefined" &&
        "__TAURI_INTERNALS__" in window
    );
}

function formatError(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    if (typeof error === "string" && error.length > 0) {
        return error;
    }

    return fallback;
}
