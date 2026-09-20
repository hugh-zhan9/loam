// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceBootstrap } from "./use-workspace-bootstrap";
import type { WorkspaceOpenChoice } from "./use-workspace-bootstrap";

/**
 * Where a folder the user picked ends up.
 *
 * The app opened one workspace at a time, so picking a folder always replaced
 * the current window's. Now three outcomes are possible and the wrong one is
 * silent: opening a second window on a folder already open, or replacing a
 * workspace the user only wanted alongside.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const { invoke, openDialog } = vi.hoisted(() => ({
    invoke: vi.fn(),
    openDialog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        setSize: vi.fn(async () => {}),
        innerSize: vi.fn(async () => ({ toLogical: () => ({ width: 1, height: 1 }) })),
        scaleFactor: vi.fn(async () => 1),
        onResized: vi.fn(async () => () => {}),
    }),
    LogicalSize: class {
        constructor(
            public width: number,
            public height: number,
        ) {}
    },
}));

const EMPTY_APP_STATE = {
    stateVersion: 1,
    recentWorkspaceRoot: null,
    preferences: {
        fileTreeExcludeDirs: [],
        fileWatchEnabled: true,
        searchMaxFileBytes: 1_048_576,
        searchMaxResults: 200,
        searchMaxMatchesPerFile: 20,
    },
    workspaces: [],
    windowSize: { width: 1480, height: 860 },
    openWorkspaceRoots: [],
};

interface Harness {
    chooseWorkspace: () => Promise<void>;
    rootPath: string | null;
}

function renderHook(
    confirmOpenTarget?: (rootPath: string) => Promise<WorkspaceOpenChoice | null>,
    session?: { rootPath: string | null; skippedRoots: string[] },
) {
    const harness: Harness = { chooseWorkspace: async () => {}, rootPath: null };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe() {
        const bootstrap = useWorkspaceBootstrap({ confirmOpenTarget, session });

        // Published from an effect, not during render: the render pass must
        // not write to anything outside the component.
        useEffect(() => {
            harness.chooseWorkspace = bootstrap.chooseWorkspace;
            harness.rootPath = bootstrap.workspace?.rootPath ?? null;
        });

        return null;
    }

    return { harness, container, root, render: () => root.render(<Probe />) };
}

function invokedCommands() {
    return invoke.mock.calls.map(([command]) => command as string);
}

beforeEach(() => {
    invoke.mockReset();
    openDialog.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    invoke.mockImplementation(async (command: string) => {
        switch (command) {
            case "load_app_state":
                return EMPTY_APP_STATE;
            case "get_window_session":
                return { kind: "workspace", rootPath: null, skippedRoots: [] };
            default:
                return undefined;
        }
    });
});

afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
});

describe("choosing a workspace folder", () => {
    it("asks where to open a folder no window has open", async () => {
        const confirm = vi.fn(async () => "new" as const);
        invoke.mockImplementation(async (command: string) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "workspace_open_target") {
                return { canonicalPath: "/tmp/blog", existing: null };
            }
            return undefined;
        });
        openDialog.mockResolvedValue("/tmp/blog");

        const { harness, root, render } = renderHook(confirm);
        await act(async () => render());
        await act(async () => harness.chooseWorkspace());

        expect(confirm).toHaveBeenCalledWith("/tmp/blog");
        expect(invoke).toHaveBeenCalledWith("open_workspace_in_new_window", {
            rootPath: "/tmp/blog",
        });
        await act(async () => root.unmount());
    });

    it("leaves everything alone when the user backs out of the prompt", async () => {
        const confirm = vi.fn(async () => null);
        invoke.mockImplementation(async (command: string) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "workspace_open_target") {
                return { canonicalPath: "/tmp/blog", existing: null };
            }
            return undefined;
        });
        openDialog.mockResolvedValue("/tmp/blog");

        const { harness, root, render } = renderHook(confirm);
        await act(async () => render());
        // A window with nothing to restore runs the picker itself on launch;
        // this test is about the explicit ⌘O that follows.
        invoke.mockClear();
        confirm.mockClear();
        await act(async () => harness.chooseWorkspace());

        expect(confirm).toHaveBeenCalledOnce();
        expect(invokedCommands()).not.toContain("open_workspace_in_new_window");
        expect(invokedCommands()).not.toContain("scan_workspace");
        await act(async () => root.unmount());
    });

    it("focuses the window that already has the folder, without asking", async () => {
        const confirm = vi.fn(async () => "current" as const);
        invoke.mockImplementation(async (command: string) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "workspace_open_target") {
                return { canonicalPath: "/tmp/notes", existing: "other" };
            }
            return undefined;
        });
        openDialog.mockResolvedValue("/tmp/notes");

        const { harness, root, render } = renderHook(confirm);
        await act(async () => render());
        await act(async () => harness.chooseWorkspace());

        expect(confirm).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith("focus_workspace_root", {
            rootPath: "/tmp/notes",
        });
        expect(invokedCommands()).not.toContain("open_workspace_in_new_window");
        await act(async () => root.unmount());
    });

    it("does nothing when the folder is the one this window already shows", async () => {
        const confirm = vi.fn(async () => "current" as const);
        invoke.mockImplementation(async (command: string) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "workspace_open_target") {
                return { canonicalPath: "/tmp/notes", existing: "current" };
            }
            return undefined;
        });
        openDialog.mockResolvedValue("/tmp/notes");

        const { harness, root, render } = renderHook(confirm);
        await act(async () => render());
        invoke.mockClear();
        await act(async () => harness.chooseWorkspace());

        expect(confirm).not.toHaveBeenCalled();
        expect(invokedCommands()).not.toContain("focus_workspace_root");
        expect(invokedCommands()).not.toContain("open_workspace_in_new_window");
        await act(async () => root.unmount());
    });

    it("never asks when the picker was cancelled", async () => {
        const confirm = vi.fn(async () => "new" as const);
        openDialog.mockResolvedValue(null);

        const { harness, root, render } = renderHook(confirm);
        await act(async () => render());
        invoke.mockClear();
        await act(async () => harness.chooseWorkspace());

        expect(confirm).not.toHaveBeenCalled();
        expect(invokedCommands()).not.toContain("workspace_open_target");
        await act(async () => root.unmount());
    });
});

describe("opening the workspace a window was launched for", () => {
    const SCANNED = {
        rootPath: "/tmp/blog",
        nodes: [],
        truncated: false,
        entryCount: 0,
        warnings: [],
    };

    it("opens the assigned root rather than the most recent one", async () => {
        // A restore of several windows hands each one its own root. Falling
        // back to recentWorkspaceRoot first would point every window at the
        // same folder.
        invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "load_app_state") {
                return { ...EMPTY_APP_STATE, recentWorkspaceRoot: "/tmp/notes" };
            }
            if (command === "scan_workspace") {
                const { rootPath } = args as { rootPath: string };
                return { ...SCANNED, rootPath };
            }
            if (command === "bind_workspace_root") {
                return { bound: true, ownedByOtherWindow: false };
            }
            return undefined;
        });

        const { harness, root, render } = renderHook(undefined, {
            rootPath: "/tmp/blog",
            skippedRoots: [],
        });
        await act(async () => render());

        expect(invoke).toHaveBeenCalledWith("scan_workspace", {
            rootPath: "/tmp/blog",
            options: expect.anything(),
        });
        expect(harness.rootPath).toBe("/tmp/blog");
        await act(async () => root.unmount());
    });

    it("tells the registry which root it opened", async () => {
        invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "scan_workspace") {
                const { rootPath } = args as { rootPath: string };
                return { ...SCANNED, rootPath };
            }
            if (command === "bind_workspace_root") {
                return { bound: true, ownedByOtherWindow: false };
            }
            return undefined;
        });

        const { root, render } = renderHook(undefined, {
            rootPath: "/tmp/blog",
            skippedRoots: [],
        });
        await act(async () => render());

        expect(invoke).toHaveBeenCalledWith("bind_workspace_root", {
            rootPath: "/tmp/blog",
        });
        await act(async () => root.unmount());
    });

    it("restores the size recorded for that workspace, not the shared one", async () => {
        const setSize = vi.fn(async () => {});
        const windowModule = await import("@tauri-apps/api/window");
        vi.spyOn(windowModule, "getCurrentWindow").mockReturnValue({
            setSize,
            innerSize: vi.fn(async () => ({
                toLogical: () => ({ width: 1, height: 1 }),
            })),
            scaleFactor: vi.fn(async () => 1),
            onResized: vi.fn(async () => () => {}),
        } as unknown as ReturnType<typeof windowModule.getCurrentWindow>);

        invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "load_app_state") {
                return {
                    ...EMPTY_APP_STATE,
                    windowSize: { width: 1480, height: 860 },
                    workspaces: [
                        {
                            rootPath: "/tmp/blog",
                            tabs: [],
                            activeTabId: null,
                            panels: {},
                            windowSize: { width: 1100, height: 700 },
                        },
                    ],
                };
            }
            if (command === "scan_workspace") {
                const { rootPath } = args as { rootPath: string };
                return { ...SCANNED, rootPath };
            }
            if (command === "bind_workspace_root") {
                return { bound: true, ownedByOtherWindow: false };
            }
            return undefined;
        });

        const { root, render } = renderHook(undefined, {
            rootPath: "/tmp/blog",
            skippedRoots: [],
        });
        await act(async () => render());

        expect(setSize).toHaveBeenCalledWith(
            expect.objectContaining({ width: 1100, height: 700 }),
        );
        await act(async () => root.unmount());
    });
});

describe("losing the race to bind a root", () => {
    const SCANNED = {
        rootPath: "/tmp/blog",
        nodes: [],
        truncated: false,
        entryCount: 0,
        warnings: [],
    };

    it("does not show a root another window took first", async () => {
        // A window showing a root it does not own is invisible to the
        // registry: left out of the restore list, and its window size written
        // into the owning window's entry.
        invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "scan_workspace") {
                const { rootPath } = args as { rootPath: string };
                return { ...SCANNED, rootPath };
            }
            if (command === "bind_workspace_root") {
                return { bound: false, ownedByOtherWindow: true };
            }
            return undefined;
        });

        const { harness, root, render } = renderHook(undefined, {
            rootPath: "/tmp/blog",
            skippedRoots: [],
        });
        await act(async () => render());

        expect(harness.rootPath).toBeNull();
        expect(invoke).toHaveBeenCalledWith("focus_workspace_root", {
            rootPath: "/tmp/blog",
        });
        await act(async () => root.unmount());
    });

    it("gives up quietly when the window is already gone", async () => {
        // The window closed while its own report was in flight. Nothing to
        // focus, and nothing to say.
        invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "scan_workspace") {
                const { rootPath } = args as { rootPath: string };
                return { ...SCANNED, rootPath };
            }
            if (command === "bind_workspace_root") {
                return { bound: false, ownedByOtherWindow: false };
            }
            return undefined;
        });

        const { harness, root, render } = renderHook(undefined, {
            rootPath: "/tmp/blog",
            skippedRoots: [],
        });
        await act(async () => render());

        expect(harness.rootPath).toBeNull();
        expect(invokedCommands()).not.toContain("focus_workspace_root");
        await act(async () => root.unmount());
    });
});

describe("a window with no workspace bound", () => {
    it("opens at the shared size, not the most recent workspace's", async () => {
        const setSize = vi.fn(async () => {});
        const windowModule = await import("@tauri-apps/api/window");
        vi.spyOn(windowModule, "getCurrentWindow").mockReturnValue({
            setSize,
            innerSize: vi.fn(async () => ({
                toLogical: () => ({ width: 1, height: 1 }),
            })),
            scaleFactor: vi.fn(async () => 1),
            onResized: vi.fn(async () => () => {}),
        } as unknown as ReturnType<typeof windowModule.getCurrentWindow>);

        // Saving already writes to the top level when no root is bound, so
        // restoring from another workspace's entry would disagree with it.
        invoke.mockImplementation(async (command: string) => {
            if (command === "load_app_state") {
                return {
                    ...EMPTY_APP_STATE,
                    recentWorkspaceRoot: "/tmp/notes",
                    windowSize: { width: 1480, height: 860 },
                    workspaces: [
                        {
                            rootPath: "/tmp/notes",
                            tabs: [],
                            activeTabId: null,
                            panels: {},
                            windowSize: { width: 1100, height: 700 },
                        },
                    ],
                };
            }
            return undefined;
        });
        openDialog.mockResolvedValue(null);

        const { root, render } = renderHook(undefined, {
            rootPath: null,
            skippedRoots: [],
        });
        await act(async () => render());

        expect(setSize).toHaveBeenCalledWith(
            expect.objectContaining({ width: 1480, height: 860 }),
        );
        await act(async () => root.unmount());
    });

    it("runs the duplicate check on the folder it picks at launch", async () => {
        // Other windows can already be up — a CLI `new`, or a document window
        // opening one — so this path cannot skip the check either.
        invoke.mockImplementation(async (command: string) => {
            if (command === "load_app_state") return EMPTY_APP_STATE;
            if (command === "workspace_open_target") {
                return { canonicalPath: "/tmp/notes", existing: "other" };
            }
            return undefined;
        });
        openDialog.mockResolvedValue("/tmp/notes");

        const { root, render } = renderHook(async () => "current", {
            rootPath: null,
            skippedRoots: [],
        });
        await act(async () => render());

        expect(invoke).toHaveBeenCalledWith("workspace_open_target", {
            rootPath: "/tmp/notes",
        });
        expect(invoke).toHaveBeenCalledWith("focus_workspace_root", {
            rootPath: "/tmp/notes",
        });
        await act(async () => root.unmount());
    });
});
