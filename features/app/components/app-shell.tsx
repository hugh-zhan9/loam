"use client";

import { Component, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { tauriCore } from "@/common/lib/tauri";
import { DocumentApp } from "@/features/document/components/document-app";
import { DocumentError } from "@/features/document/components/document-error";
import { WorkspaceApp } from "@/features/workspace/components/workspace-app";
import { useBackground } from "@/features/workspace/lib/use-background";
import { PrimaryTextControlButton } from "../../../common/components/ui-controls";
import {
    normalizeAppWindowSession,
    type AppWindowSession,
} from "../lib/app-session";

export function AppShell() {
    const [session, setSession] = useState<AppWindowSession | null>(null);

    // Called for its effect, and here rather than in the appearance panel: the
    // background has to be on the window from the moment it opens, and every
    // window kind renders this component. The palette itself needs no equivalent
    // — it is a stylesheet, which the pre-hydration script in `app/layout.tsx`
    // can set before the first paint. An image cannot be read that early.
    useBackground();

    useEffect(() => {
        let cancelled = false;

        async function loadSession() {
            if (!isTauriRuntime()) {
                setSession(normalizeAppWindowSession({ kind: "workspace" }));
                return;
            }

            try {
                const { invoke } = await tauriCore();
                const rawSession = await invoke("get_window_session");
                if (!cancelled) {
                    setSession(normalizeAppWindowSession(rawSession));
                }
            } catch (error) {
                console.warn("Failed to load Loam window session.", error);
                if (!cancelled) {
                    setSession(normalizeSessionFromLocation());
                }
            }
        }

        void loadSession();

        return () => {
            cancelled = true;
        };
    }, []);

    if (!session) {
        return (
            <main className="flex h-screen items-center justify-center bg-base-100 text-sm text-base-content/70">
                正在打开 Loam...
            </main>
        );
    }

    return (
        <AppRenderErrorBoundary resetKey={sessionKey(session)}>
            <div
                data-mdx-shell=""
                data-mdx-window-kind={session.kind}
                data-mdx-platform={isLikelyMacPlatform() ? "macos" : "other"}
                className="h-full min-h-0"
            >
                {renderSession(session)}
            </div>
        </AppRenderErrorBoundary>
    );
}

function renderSession(session: AppWindowSession) {
    if (session.kind === "document") {
        return <DocumentApp session={session} />;
    }

    if (session.kind === "documentError") {
        return <DocumentError session={session} />;
    }

    return <WorkspaceApp session={session} />;
}

function sessionKey(session: AppWindowSession) {
    if (session.kind === "document") {
        return `document:${session.realPath}`;
    }

    if (session.kind === "documentError") {
        return `document-error:${session.path}`;
    }

    return "workspace";
}

export class AppRenderErrorBoundary extends Component<
    { children: ReactNode; resetKey: string },
    { error: Error | null; resetKey: string }
> {
    state: { error: Error | null; resetKey: string } = {
        error: null,
        resetKey: this.props.resetKey,
    };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    static getDerivedStateFromProps(
        props: { resetKey: string },
        state: { error: Error | null; resetKey: string },
    ) {
        if (props.resetKey !== state.resetKey) {
            return { error: null, resetKey: props.resetKey };
        }

        return null;
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Loam render failed.", error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <main
                    role="alert"
                    className="flex h-screen items-center justify-center bg-base-100 px-6 text-base-content"
                >
                    <div className="max-w-md text-sm">
                        <h1 className="mb-2 text-base font-semibold">
                            Loam 渲染失败
                        </h1>
                        <p className="text-base-content/70">
                            诊断信息已写入开发者控制台。重新加载会重建界面，磁盘上的文件不受影响。
                        </p>
                        {/*
                         * A way out of this screen, because there was none: the
                         * boundary holds until something changes the reset key,
                         * and nothing on this screen could. Reloading rebuilds
                         * the window from the same files.
                         */}
                        <div className="mt-4">
                            <PrimaryTextControlButton
                                onClick={() => {
                                    if (typeof window !== "undefined") {
                                        window.location.reload();
                                    }
                                }}
                            >
                                重新加载
                            </PrimaryTextControlButton>
                        </div>
                    </div>
                </main>
            );
        }

        return this.props.children;
    }
}

function normalizeSessionFromLocation(): AppWindowSession {
    if (typeof window === "undefined") {
        return normalizeAppWindowSession({ kind: "workspace" });
    }

    const params = new URLSearchParams(window.location.search);
    const realPath = params.get("realPath");

    if (params.get("mode") !== "document" || !realPath) {
        return normalizeAppWindowSession({ kind: "workspace" });
    }

    return normalizeAppWindowSession({
        kind: "document",
        fileName: fileNameFromPath(realPath),
        displayPath: realPath,
        realPath,
    });
}

function fileNameFromPath(path: string) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? path;
}

function isTauriRuntime() {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isLikelyMacPlatform() {
    if (typeof navigator === "undefined") {
        return false;
    }

    return /Mac/.test(navigator.platform);
}
