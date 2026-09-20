"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { tauriCore, tauriWindow } from "@/common/lib/tauri";
import { EmptyState, TextControlButton } from "../../../common/components/ui-controls";
import { useWorkspaceBootstrap } from "../hooks/use-workspace-bootstrap";
import {
    syncCliFrontendHeartbeat,
    syncCliWorkspaceSnapshot,
} from "../lib/cli-sync";
import { deleteDiscardedWorkspaceDrafts } from "../lib/discard-drafts";
import { createWorkspaceEmptyState } from "../lib/empty-state-copy";
import { draftDelete } from "@/features/recovery/lib/draft-client";
import type {
    AppPreferences,
    WorkspaceMenuActions,
    WorkspaceState,
    WorkspaceTab,
} from "../lib/types";
import {
    AppDialogProvider,
    useAppDialogs,
} from "./app-dialogs";
import { SettingsButton } from "./settings-button";
import { WorkspaceShell } from "./workspace-shell";
import { stopListening } from "@/common/lib/tauri-events";

export function WorkspaceApp({ session }: { session?: WorkspaceWindowSession }) {
    return (
        <AppDialogProvider>
            <WorkspaceAppInner session={session} />
        </AppDialogProvider>
    );
}

/** The workspace half of the window session Rust hands this window. */
interface WorkspaceWindowSession {
    rootPath: string | null;
    skippedRoots: string[];
}

function WorkspaceAppInner({ session }: { session?: WorkspaceWindowSession }) {
    const dialogs = useAppDialogs();

    // Asked only for a folder no window has open; a folder already open is
    // resolved before this runs.
    const confirmOpenTarget = useCallback(
        async (rootPath: string) => {
            const choice = await dialogs.choice({
                title: "在哪里打开这个文件夹？",
                message: rootPath,
                choices: [
                    { label: "当前窗口", value: "current" },
                    { label: "新窗口", value: "new" },
                ],
            });

            return choice === "current" || choice === "new" ? choice : null;
        },
        [dialogs],
    );
    const workspaceActionsRef = useRef<WorkspaceMenuActions | null>(null);
    const workspaceRef = useRef<WorkspaceState | null>(null);
    const {
        status,
        workspace,
        dispatch,
        chooseWorkspace,
        canChooseWorkspace,
        message,
        preferences,
        updatePreferences,
        persistCurrentWindowSize,
    } = useWorkspaceBootstrap({ confirmOpenTarget, session });
    useEffect(() => {
        workspaceRef.current = workspace;
    }, [workspace]);

    const chooseWorkspaceWithGuard = useCallback(async () => {
        const currentWorkspace = workspaceRef.current;

        if (
            currentWorkspace &&
            hasDirtyTabs(currentWorkspace) &&
            !(await dialogs.confirm({
                title: "切换工作区",
                message:
                    "当前工作区有未保存更改。打开其他文件夹会丢弃这些更改，是否继续？",
                confirmLabel: "继续",
                destructive: true,
            }))
        ) {
            return;
        }

        if (currentWorkspace && hasDirtyTabs(currentWorkspace)) {
            try {
                await deleteDiscardedWorkspaceDrafts(
                    currentWorkspace,
                    draftDelete,
                );
            } catch (error) {
                await dialogs.alert({
                    title: "切换工作区",
                    message: formatError(error, "无法清理已丢弃草稿。"),
                });
                return;
            }
        }

        await chooseWorkspace();
    }, [chooseWorkspace, dialogs]);

    const handleActionsChange = useCallback(
        (actions: WorkspaceMenuActions | null) => {
            workspaceActionsRef.current = actions;
        },
        [],
    );
    /*
     * Held in a ref for the same reason the menu actions are: this handler is
     * rebuilt whenever the workspace state changes — which is on every edit —
     * and the menu subscription must not be torn down and rebuilt with it.
     */
    const chooseWorkspaceRef = useRef(chooseWorkspaceWithGuard);
    useEffect(() => {
        chooseWorkspaceRef.current = chooseWorkspaceWithGuard;
    }, [chooseWorkspaceWithGuard]);

    useCliWorkspaceSync(workspace);
    useWorkspaceFrontendHeartbeat(workspace);
    useWorkspaceMenuEvents(workspaceActionsRef, chooseWorkspaceRef);
    useWorkspaceOpenFolderStartupAction(chooseWorkspaceWithGuard);
    useWorkspaceCloseGuard(workspaceRef, dialogs, persistCurrentWindowSize);

    return (
        <main
            data-mdx-root
            className="h-screen min-h-0 bg-base-100 text-base-content"
        >
            <SkippedWorkspacesNotice roots={session?.skippedRoots ?? []} />
            {workspace ? (
                <WorkspaceShell
                    workspace={workspace}
                    dispatch={dispatch}
                    onChooseWorkspace={chooseWorkspaceWithGuard}
                    canChooseWorkspace={canChooseWorkspace}
                    message={message}
                    preferences={preferences}
                    onPreferencesChange={updatePreferences}
                    onActionsChange={handleActionsChange}
                />
            ) : (
                <WorkspaceEmptyState
                    status={status}
                    message={message}
                    onChooseWorkspace={chooseWorkspaceWithGuard}
                    canChooseWorkspace={canChooseWorkspace}
                    preferences={preferences}
                    onPreferencesChange={updatePreferences}
                />
            )}
        </main>
    );
}

/**
 * Subscribes the window to its native File menu, once.
 *
 * Everything it needs arrives through a ref, so the effect has no reason to
 * re-run: `listen` is an IPC round trip, and re-subscribing means a window with
 * no listeners at all until it comes back. This used to depend on the
 * choose-workspace handler, which is rebuilt on every workspace state change —
 * so every keystroke dropped the menu on the floor and re-registered it, and
 * ⌘S pressed in that gap did nothing.
 */
function useWorkspaceMenuEvents(
    workspaceActionsRef: RefObject<WorkspaceMenuActions | null>,
    chooseWorkspaceRef: RefObject<() => Promise<void>>,
) {
    useEffect(() => {
        if (!isTauriRuntime()) {
            return;
        }

        let disposed = false;
        const unlisteners: Array<() => void> = [];

        const runAction = (handler: () => Promise<void> | void) => {
            void Promise.resolve(handler()).catch((error) => {
                console.warn("Failed to run workspace menu action.", error);
            });
        };

        const subscribe = async () => {
            const { getCurrentWindow } = await tauriWindow();
            const currentWindow = getCurrentWindow();

            const nextUnlisteners = await Promise.all([
                currentWindow.listen("mdx-menu-open-folder", () => {
                    runAction(() => chooseWorkspaceRef.current());
                }),
                currentWindow.listen("mdx-menu-new-folder", () => {
                    runAction(
                        workspaceActionsRef.current?.createFolder ??
                            noopAsync,
                    );
                }),
                currentWindow.listen("mdx-menu-new-markdown-file", () => {
                    runAction(
                        workspaceActionsRef.current?.createMarkdownFile ??
                            noopAsync,
                    );
                }),
                currentWindow.listen("mdx-menu-rename", () => {
                    runAction(
                        workspaceActionsRef.current?.renameSelection ??
                            noopAsync,
                    );
                }),
                currentWindow.listen("mdx-menu-trash", () => {
                    runAction(
                        workspaceActionsRef.current?.deleteSelection ??
                            noopAsync,
                    );
                }),
                currentWindow.listen("mdx-menu-refresh", () => {
                    runAction(
                        workspaceActionsRef.current?.refreshTree ?? noopAsync,
                    );
                }),
                currentWindow.listen("mdx-menu-save", () => {
                    runAction(
                        workspaceActionsRef.current?.saveActiveTab ??
                            noopAsync,
                    );
                }),
                currentWindow.listen("mdx-menu-close-tab", () => {
                    runAction(
                        workspaceActionsRef.current?.closeActiveTab ??
                            noopAsync,
                    );
                }),
            ]);
            unlisteners.push(...nextUnlisteners);

            if (disposed) {
                unlisteners.forEach(stopListening);
            }
        };

        void subscribe().catch((error) => {
            console.warn("Failed to subscribe to workspace menu events.", error);
        });

        return () => {
            disposed = true;
            unlisteners.forEach(stopListening);
        };
    }, [chooseWorkspaceRef, workspaceActionsRef]);
}

function useWorkspaceCloseGuard(
    workspaceRef: RefObject<WorkspaceState | null>,
    dialogs: ReturnType<typeof useAppDialogs>,
    persistCurrentWindowSize: () => Promise<void>,
) {
    const closingRef = useRef(false);

    useEffect(() => {
        if (!isTauriRuntime()) {
            return;
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;

        const subscribe = async () => {
            const { getCurrentWindow } = await tauriWindow();
            const currentWindow = getCurrentWindow();
            const nextUnlisten = await currentWindow.onCloseRequested(
                (event) => {
                    const workspace = workspaceRef.current;
                    const dirtyCount = workspace ? dirtyTabCount(workspace) : 0;

                    logWorkspaceCloseDiagnostic("close-requested", {
                        closing: closingRef.current,
                        dirtyTabCount: dirtyCount,
                        hasWorkspace: Boolean(workspace),
                        tabCount: workspace?.tabOrder.length ?? 0,
                    });

                    if (closingRef.current) {
                        logWorkspaceCloseDiagnostic("close-already-in-progress", {
                            dirtyTabCount: dirtyCount,
                        });
                        event.preventDefault();
                        return;
                    }

                    event.preventDefault();

                    if (!workspace || dirtyCount === 0) {
                        closingRef.current = true;
                        logWorkspaceCloseDiagnostic("close-destroy-clean", {
                            hasWorkspace: Boolean(workspace),
                        });
                        void persistCurrentWindowSize()
                            .then(() => closeWorkspaceWindow(currentWindow))
                            .catch((error) => {
                            closingRef.current = false;
                            logWorkspaceCloseDiagnostic("close-destroy-failed", {
                                message: formatError(error, "close failed"),
                            });
                        });
                        return;
                    }

                    closingRef.current = true;
                    logWorkspaceCloseDiagnostic("close-prevented-dirty", {
                        dirtyTabCount: dirtyCount,
                    });

                    void dialogs.confirm({
                        title: "关闭窗口",
                        message:
                            "当前工作区有未保存更改。关闭窗口会丢弃这些更改，是否继续？",
                        confirmLabel: "关闭",
                        destructive: true,
                    }).then((confirmed) => {
                        logWorkspaceCloseDiagnostic("close-confirm-result", {
                            confirmed,
                        });
                        if (!confirmed) {
                            closingRef.current = false;
                            return;
                        }
                        logWorkspaceCloseDiagnostic("close-discard-drafts-start", {
                            dirtyTabCount: dirtyCount,
                        });
                        void deleteDiscardedWorkspaceDrafts(
                            workspace,
                            draftDelete,
                        ).then(() => {
                            logWorkspaceCloseDiagnostic("close-destroy-start", {
                                dirtyTabCount: dirtyCount,
                            });
                            return persistCurrentWindowSize();
                        }).then(() => {
                            return closeWorkspaceWindow(currentWindow);
                        }).catch((error) => {
                            closingRef.current = false;
                            logWorkspaceCloseDiagnostic("close-destroy-failed", {
                                message: formatError(error, "close failed"),
                            });
                            void dialogs.alert({
                                title: "关闭窗口",
                                message: formatError(
                                    error,
                                    "无法清理已丢弃草稿。",
                                ),
                            });
                        });
                    }).catch((error) => {
                        closingRef.current = false;
                        logWorkspaceCloseDiagnostic("close-confirm-failed", {
                            message: formatError(error, "confirm failed"),
                        });
                        console.warn(
                            "Failed to confirm workspace close.",
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
        };

        void subscribe().catch((error) => {
            console.warn("Failed to subscribe to window close requests.", error);
        });

        return () => {
            disposed = true;
            stopListening(unlisten);
        };
    }, [dialogs, persistCurrentWindowSize, workspaceRef]);
}

function useWorkspaceOpenFolderStartupAction(
    chooseWorkspace: () => Promise<void>,
) {
    useEffect(() => {
        if (
            typeof window === "undefined" ||
            window.location.search.length === 0
        ) {
            return;
        }

        const params = new URLSearchParams(window.location.search);
        if (params.get("workspaceAction") !== "openFolder") {
            return;
        }

        params.delete("workspaceAction");
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${
            nextSearch ? `?${nextSearch}` : ""
        }${window.location.hash}`;
        window.history.replaceState(null, "", nextUrl);

        void chooseWorkspace().catch((error) => {
            console.warn(
                "Failed to run workspace startup open-folder action.",
                error,
            );
        });
    }, [chooseWorkspace]);
}

async function closeWorkspaceWindow(
    currentWindow: { destroy: () => Promise<void> },
) {
    await currentWindow.destroy();
}

function logWorkspaceCloseDiagnostic(
    stage: string,
    details: Record<string, unknown>,
) {
    if (!isTauriRuntime()) {
        return;
    }

    void tauriCore()
        .then(({ invoke }) =>
            invoke("workspace_close_diagnostic", { stage, details }),
        )
        .catch((error) => {
            console.warn("Failed to write workspace close diagnostic.", error);
        });
}

function useCliWorkspaceSync(workspace: WorkspaceState | null) {
    useEffect(() => {
        if (!isTauriRuntime() || workspace) {
            return;
        }

        void syncCliWorkspaceSnapshot(null).catch((error) => {
            console.warn("Failed to sync CLI workspace snapshot.", error);
        });
    }, [workspace]);
}

function useWorkspaceFrontendHeartbeat(workspace: WorkspaceState | null) {
    useEffect(() => {
        if (!isTauriRuntime()) {
            return;
        }

        let disposed = false;

        const sendHeartbeat = () => {
            if (disposed) {
                return;
            }

            void syncCliFrontendHeartbeat(workspace).catch((error) => {
                console.warn("Failed to sync workspace frontend heartbeat.", error);
            });
        };

        sendHeartbeat();
        const interval = window.setInterval(sendHeartbeat, 15_000);
        window.addEventListener("focus", sendHeartbeat);
        window.addEventListener("pageshow", sendHeartbeat);
        document.addEventListener("visibilitychange", sendHeartbeat);

        return () => {
            disposed = true;
            window.clearInterval(interval);
            window.removeEventListener("focus", sendHeartbeat);
            window.removeEventListener("pageshow", sendHeartbeat);
            document.removeEventListener("visibilitychange", sendHeartbeat);
        };
    }, [workspace]);
}

function isTauriRuntime() {
    return (
        typeof window !== "undefined" &&
        "__TAURI_INTERNALS__" in window
    );
}

async function noopAsync() {}

function hasDirtyTabs(workspace: WorkspaceState) {
    return dirtyTabCount(workspace) > 0;
}

function dirtyTabCount(workspace: WorkspaceState) {
    return workspace.tabOrder.filter((tabId) => isDirtyTab(workspace.tabs[tabId]))
        .length;
}

function isDirtyTab(tab: WorkspaceTab | undefined): tab is WorkspaceTab {
    return Boolean(tab?.dirty);
}

function formatError(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) {
        return `${fallback} ${error.message}`;
    }

    if (typeof error === "string" && error.length > 0) {
        return `${fallback} ${error}`;
    }

    if (error && typeof error === "object") {
        const record = error as Record<string, unknown>;
        if (typeof record.message === "string" && record.message.length > 0) {
            return `${fallback} ${record.message}`;
        }
    }

    return fallback;
}

/**
 * What launch could not reopen.
 *
 * Shown once, in the first window to ask for its session, rather than as a
 * dialog per folder: a missing volume should not stand between the user and
 * the workspaces that did come back.
 */
function SkippedWorkspacesNotice({ roots }: { roots: string[] }) {
    const [dismissed, setDismissed] = useState(false);

    if (dismissed || roots.length === 0) {
        return null;
    }

    return (
        <div
            role="status"
            data-mdx-skipped-workspaces
            className="flex items-start justify-between gap-3 border-b border-[var(--mdx-separator)] bg-base-200 px-3 py-2 text-xs text-base-content/80"
        >
            <div className="min-w-0">
                <div>{`${roots.length} 个工作区未能恢复：`}</div>
                <ul className="mt-1 space-y-0.5">
                    {roots.map((root) => (
                        <li key={root} className="truncate font-mono">
                            {root}
                        </li>
                    ))}
                </ul>
            </div>
            <TextControlButton onClick={() => setDismissed(true)}>
                知道了
            </TextControlButton>
        </div>
    );
}

function WorkspaceEmptyState({
    status,
    message,
    onChooseWorkspace,
    canChooseWorkspace,
    preferences,
    onPreferencesChange,
}: {
    status: string;
    message: string | null;
    onChooseWorkspace: () => void;
    canChooseWorkspace: boolean;
    preferences: AppPreferences;
    onPreferencesChange: (preferences: AppPreferences) => Promise<void>;
}) {
    const isLoading = status === "loading";
    const emptyState = createWorkspaceEmptyState({
        status,
        canChooseWorkspace,
        message,
    });

    return (
        <div className="grid h-full min-h-0 grid-rows-[44px_minmax(0,1fr)]">
            <header className="flex items-center justify-between border-b border-[var(--mdx-separator)] bg-base-200 px-3">
                <div />
                <div className="flex items-center gap-2">
                    {canChooseWorkspace ? (
                        <TextControlButton
                            onClick={onChooseWorkspace}
                            disabled={isLoading}
                        >
                            打开文件夹
                        </TextControlButton>
                    ) : (
                        <div className="text-xs text-base-content/65">
                            需要桌面版
                        </div>
                    )}
                    <SettingsButton
                        preferences={preferences}
                        onPreferencesChange={onPreferencesChange}
                    />
                </div>
            </header>

            <section className="flex min-h-0 items-center justify-center px-6">
                <EmptyState
                    title={emptyState.title}
                    description={emptyState.description}
                    actionLabel={emptyState.actionLabel}
                    onAction={canChooseWorkspace ? onChooseWorkspace : undefined}
                    actionDisabled={isLoading}
                />
            </section>
        </div>
    );
}
