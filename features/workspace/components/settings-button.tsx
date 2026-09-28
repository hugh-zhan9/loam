"use client";

import { RefreshCw, Save, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  detectLlmWikiWorkspace,
  getLlmWikiConfig,
  getLlmWikiLog,
  getLlmConfig,
  saveLlmConfig,
  updateLlmWikiConfig,
} from "@/features/llm-wiki/lib/llm-wiki-client";
import { MemorySettingsSection } from "@/features/memory/components/memory-settings-section";
import {
  ImageHostSettingsSection,
  useImageHostSettings,
} from "./image-host-settings-section";
import {
  getWorkspaceConfig,
  setWorkspaceConfig,
} from "@/features/memory/lib/memory-client";
import type { WorkspaceMemoryConfig } from "@/features/memory/lib/types";
import type { LlmWikiKnowledgeConfig } from "@/features/llm-wiki/lib/types";
import type { LlmProviderApiMode } from "@/features/llm-wiki/lib/types";
import {
  Checkbox,
  DialogHeader,
  DialogOverlay,
  DialogSurface,
  FieldLabel,
  HairlineItem,
  IconButton,
  LogBlock,
  PanelSection,
  PanelText,
  PrimaryTextControlButton,
  SegmentedControl,
  TextArea,
  TextControlButton,
  TextInput,
} from "../../../common/components/ui-controls";
import type { AppPreferences } from "../lib/types";
import {
  appPreferencesEqual,
  createDefaultAppPreferences,
  parsePositiveIntegerSetting,
} from "../lib/preferences";

interface SettingsButtonProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  workspaceRoot?: string | null;
  preferences?: AppPreferences;
  onPreferencesChange?: (preferences: AppPreferences) => Promise<void>;
  onLlmConfigSaved?: () => Promise<void> | void;
}

export function SettingsButton({
  open,
  onOpenChange,
  workspaceRoot,
  preferences,
  onPreferencesChange,
  onLlmConfigSaved,
}: SettingsButtonProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const actualOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  return (
    <>
      <IconButton
        onClick={() => setOpen(true)}
        label="设置"
        icon={<Settings />}
      />
      {actualOpen ? (
        <SettingsDialog
          onClose={() => setOpen(false)}
          workspaceRoot={workspaceRoot ?? null}
          preferences={preferences ?? createDefaultAppPreferences()}
          onPreferencesChange={onPreferencesChange}
          onLlmConfigSaved={onLlmConfigSaved}
        />
      ) : null}
    </>
  );
}

function SettingsDialog({
  onClose,
  workspaceRoot,
  preferences,
  onPreferencesChange,
  onLlmConfigSaved,
}: {
  onClose: () => void;
  workspaceRoot: string | null;
  preferences: AppPreferences;
  onPreferencesChange?: (preferences: AppPreferences) => Promise<void>;
  onLlmConfigSaved?: () => Promise<void> | void;
}) {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("search");
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<SettingsSection, HTMLElement | null>>({
    search: null,
    files: null,
    imageHost: null,
    memory: null,
    llm: null,
  });
  const imageHost = useImageHostSettings();
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [apiMode, setApiMode] = useState<LlmProviderApiMode>("chat");
  const [apiKey, setApiKey] = useState("");
  const [hasExistingApiKey, setHasExistingApiKey] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingMemorySettings, setSavingMemorySettings] = useState(false);
  const [memoryConfig, setMemoryConfigState] = useState<WorkspaceMemoryConfig | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [fileWatchEnabled, setFileWatchEnabled] = useState(
    preferences.fileWatchEnabled,
  );
  const [searchMaxFileBytesText, setSearchMaxFileBytesText] = useState(
    String(preferences.searchMaxFileBytes),
  );
  const [searchMaxResultsText, setSearchMaxResultsText] = useState(
    String(preferences.searchMaxResults),
  );
  const [searchMaxMatchesPerFileText, setSearchMaxMatchesPerFileText] =
    useState(String(preferences.searchMaxMatchesPerFile));
  const [excludeDirsText, setExcludeDirsText] = useState(
    preferences.fileTreeExcludeDirs.join("\n"),
  );
  const [llmWikiConfig, setLlmWikiConfig] =
    useState<LlmWikiKnowledgeConfig | null>(null);
  const [llmWikiLog, setLlmWikiLog] = useState("");
  const [loadingLlmWiki, setLoadingLlmWiki] = useState(false);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadingConfig(true);
      setMessage(null);

      try {
        const config = await getLlmConfig();

        if (cancelled) {
          return;
        }

        if (config) {
          setBaseUrl(config.baseUrl);
          setModel(config.model);
          setApiMode(config.apiMode);
          setHasExistingApiKey(config.hasApiKey);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(formatError(error, "加载 LLM 配置失败。"));
        }
      } finally {
        if (!cancelled) {
          setLoadingConfig(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setFileWatchEnabled(preferences.fileWatchEnabled);
    setSearchMaxFileBytesText(String(preferences.searchMaxFileBytes));
    setSearchMaxResultsText(String(preferences.searchMaxResults));
    setSearchMaxMatchesPerFileText(
      String(preferences.searchMaxMatchesPerFile),
    );
    setExcludeDirsText(preferences.fileTreeExcludeDirs.join("\n"));
  }, [preferences]);

  // The memory section only needs this workspace's capture settings; the
  // library itself is global and has its own panel.
  useEffect(() => {
    if (!workspaceRoot) {
      setMemoryConfigState(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const config = await getWorkspaceConfig(workspaceRoot);
        if (!cancelled) {
          setMemoryConfigState(config);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(formatError(error, "加载记忆设置失败。"));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) {
      setLlmWikiConfig(null);
      setLlmWikiLog("");
      return;
    }

    let cancelled = false;

    async function loadLlmWikiSettings() {
      setLoadingLlmWiki(true);

      try {
        const status = await detectLlmWikiWorkspace(workspaceRoot as string);

        if (!status.hasLlmWiki) {
          if (!cancelled) {
            setLlmWikiConfig(null);
            setLlmWikiLog("");
          }
          return;
        }

        const [config, log] = await Promise.all([
          getLlmWikiConfig(workspaceRoot as string),
          getLlmWikiLog(workspaceRoot as string),
        ]);

        if (!cancelled) {
          setLlmWikiConfig(config);
          setLlmWikiLog(log);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(formatError(error, "加载 LLM Wiki 设置失败。"));
        }
      } finally {
        if (!cancelled) {
          setLoadingLlmWiki(false);
        }
      }
    }

    void loadLlmWikiSettings();

    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  const saveSettings = async () => {
    setSavingSettings(true);
    setMessage(null);

    try {
      const nextExcludeDirs = parseExcludeDirs(excludeDirsText);
      const nextPreferences = {
        fileTreeExcludeDirs: nextExcludeDirs,
        fileWatchEnabled,
        searchMaxFileBytes: parsePositiveIntegerSetting(
          searchMaxFileBytesText,
          1_024,
          50 * 1_024 * 1_024,
          preferences.searchMaxFileBytes,
        ),
        searchMaxResults: parsePositiveIntegerSetting(
          searchMaxResultsText,
          1,
          5_000,
          preferences.searchMaxResults,
        ),
        searchMaxMatchesPerFile: parsePositiveIntegerSetting(
          searchMaxMatchesPerFileText,
          1,
          500,
          preferences.searchMaxMatchesPerFile,
        ),
      };

      // First, so that an image host refused as incomplete stops the save
      // before anything else has been written.
      await imageHost.save();

      if (!appPreferencesEqual(nextPreferences, preferences)) {
        await onPreferencesChange?.(nextPreferences);
      }

      const saved = await saveLlmConfig({
        baseUrl,
        model,
        apiMode,
        apiKey,
        preserveApiKey: hasExistingApiKey && apiKey.trim() === "",
      });
      setHasExistingApiKey(saved.hasApiKey);
      setApiKey("");
      setBaseUrl(saved.baseUrl);
      setModel(saved.model);
      setApiMode(saved.apiMode);
      await onLlmConfigSaved?.();
      onClose();
    } catch (error) {
      setMessage(formatError(error, "保存设置失败。"));
    } finally {
      setSavingSettings(false);
    }
  };
  const toggleLlmWiki = async () => {
    if (!workspaceRoot || !llmWikiConfig) {
      return;
    }

    setLoadingLlmWiki(true);
    setMessage(null);

    try {
      const nextConfig = await updateLlmWikiConfig(workspaceRoot, {
        paused: !llmWikiConfig.paused,
        skipPaths: llmWikiConfig.skipPaths,
      });
      setLlmWikiConfig(nextConfig);
      await onLlmConfigSaved?.();
    } catch (error) {
      setMessage(formatError(error, "保存 LLM Wiki 开关失败。"));
    } finally {
      setLoadingLlmWiki(false);
    }
  };
  const refreshLlmWikiLog = async () => {
    if (!workspaceRoot) {
      return;
    }

    setLoadingLlmWiki(true);
    setMessage(null);

    try {
      setLlmWikiLog(await getLlmWikiLog(workspaceRoot));
    } catch (error) {
      setMessage(formatError(error, "刷新 LLM Wiki 日志失败。"));
    } finally {
      setLoadingLlmWiki(false);
    }
  };
  /// Applies one change to this workspace's capture settings.
  ///
  /// Read, change, write: the configuration is small and the panel is the only
  /// writer, so a merge that could lose a concurrent edit is not worth building.
  const updateMemoryCapture = async (
    change: (capture: { enabled: boolean; sources: string[] }) => {
      enabled: boolean;
      sources: string[];
    },
  ) => {
    if (!workspaceRoot) {
      setMessage("打开工作区后可以修改记忆设置。");
      return;
    }

    setSavingMemorySettings(true);
    setMessage(null);

    try {
      const current = await getWorkspaceConfig(workspaceRoot);
      const next = await setWorkspaceConfig(workspaceRoot, {
        ...current,
        capture: change(current.capture),
      });
      setMemoryConfigState(next);
    } catch (error) {
      setMessage(formatError(error, "保存记忆设置失败。"));
    } finally {
      setSavingMemorySettings(false);
    }
  };


  const selectSection = (section: SettingsSection) => {
    setActiveSection(section);
    const container = contentScrollRef.current;
    const target = sectionRefs.current[section];

    if (!container || !target) {
      return;
    }

    container.scrollTo({
      top: target.offsetTop - container.offsetTop,
      behavior: "smooth",
    });
  };

  return (
    <DialogOverlay onDismiss={onClose}>
      <DialogSurface
        label="设置"
        // A sidebar beside a content pane, so this one is a grid rather than the
        // shell's default column. The surface itself — corner, shadow, never taller
        // than the window — comes from the shell, like every other dialog's.
        className="grid h-[min(680px,78dvh,calc(100dvh-2rem))] w-[min(90vw,840px)] grid-cols-[minmax(104px,152px)_minmax(0,1fr)]"
      >
        <aside className="min-h-0 min-w-0 overflow-auto border-r border-[var(--mdx-separator)] bg-base-200 px-3 py-4">
          {/* No heading of its own: the header beside it already says 设置, and the
              two sat one above the other saying the same word twice. */}
          <div className="space-y-1">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={[
                  "block w-full rounded-[var(--mdx-control-radius)] px-2 py-1.5 text-left text-xs transition-colors",
                  activeSection === section.id
                    ? "bg-base-100 font-medium text-base-content"
                    : "text-base-content/70 hover:bg-base-100/70 hover:text-base-content",
                ].join(" ")}
                onClick={() => selectSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 min-h-0 flex-col">
          <DialogHeader
            actions={
              <>
                {message ? (
                  <div className="max-w-64 truncate text-xs text-error">
                    {message}
                  </div>
                ) : null}
                <TextControlButton onClick={onClose}>
                  <X aria-hidden="true" />
                  关闭
                </TextControlButton>
                <PrimaryTextControlButton
                  onClick={() => void saveSettings()}
                  disabled={
                    loadingConfig ||
                    imageHost.loading ||
                    savingSettings ||
                    !baseUrl.trim() ||
                    !model.trim()
                  }
                >
                  <Save aria-hidden="true" />
                  {savingSettings ? "保存中" : "保存"}
                </PrimaryTextControlButton>
              </>
            }
          >
            设置
          </DialogHeader>

          <div
            ref={contentScrollRef}
            data-settings-scroll-container
            className="min-h-0 flex-1 divide-y divide-[var(--mdx-separator)] overflow-y-auto overflow-x-hidden pb-4"
          >
            <div
              ref={(node) => {
                sectionRefs.current.search = node;
              }}
              data-settings-section="search"
              className="scroll-mt-5"
            >
              <PanelSection
                title="搜索限制"
                hint="超过上限的文件不会被搜索，结果也会截断在这里设定的条数。"
              >
              {/*
               * Three counts on one row rather than three rows of one. Width says
               * something about a value: a field as wide as the panel claims the
               * number in it could be long, and none of these can.
               */}
              <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                <NumberField
                  label="单文件上限（字节）"
                  value={searchMaxFileBytesText}
                  disabled={savingSettings}
                  onChange={setSearchMaxFileBytesText}
                />
                <NumberField
                  label="最大结果数"
                  value={searchMaxResultsText}
                  disabled={savingSettings}
                  onChange={setSearchMaxResultsText}
                />
                <NumberField
                  label="每文件最大匹配"
                  value={searchMaxMatchesPerFileText}
                  disabled={savingSettings}
                  onChange={setSearchMaxMatchesPerFileText}
                />
              </div>
              </PanelSection>
            </div>

            <div
              ref={(node) => {
                sectionRefs.current.files = node;
              }}
              data-settings-section="files"
              className="scroll-mt-5"
            >
              <PanelSection
                title="文件监听"
                hint="未保存正文会以明文草稿保存在 ~/.loam/drafts/，保存或丢弃后会清理对应草稿。"
              >
                <div className="flex min-w-0 flex-col gap-5">
                  <label className="flex min-w-0 items-center gap-2.5 text-[13.5px] leading-[1.75] text-base-content/85">
                    <Checkbox
                      checked={fileWatchEnabled}
                      onChange={(event) =>
                        setFileWatchEnabled(event.currentTarget.checked)
                      }
                      disabled={savingSettings}
                    />
                    <span>启用工作区文件监听</span>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <FieldLabel>不监听的目录，每行一个</FieldLabel>
                    <TextArea
                      className="min-h-24"
                      value={excludeDirsText}
                      onChange={(event) =>
                        setExcludeDirsText(event.currentTarget.value)
                      }
                      placeholder={"node_modules\ndist\nraw/archive"}
                      disabled={savingSettings}
                    />
                  </label>
                </div>
              </PanelSection>
            </div>

            <ImageHostSettingsSection
              sectionRef={(node) => {
                sectionRefs.current.imageHost = node;
              }}
              settings={imageHost}
              disabled={savingSettings}
            />

            <MemorySettingsSection
              sectionRef={(node) => {
                sectionRefs.current.memory = node;
              }}
              disabled={!workspaceRoot || savingMemorySettings}
              config={memoryConfig}
              onToggleCapture={(enabled) => {
                void updateMemoryCapture((capture) => ({
                  ...capture,
                  enabled,
                }));
              }}
              onToggleSource={(source, enabled) => {
                void updateMemoryCapture((capture) => ({
                  ...capture,
                  sources: enabled
                    ? [...capture.sources, source]
                    : capture.sources.filter((current) => current !== source),
                }));
              }}
            />

            <div
              ref={(node) => {
                sectionRefs.current.llm = node;
              }}
              data-settings-section="llm"
              className="scroll-mt-5"
            >
              <PanelSection
                title="LLM API"
                hint="提问、综述和 wiki 的后台处理都用这一个 provider。API Key 存在本机的凭据里。"
              >
                <div className="flex min-w-0 flex-col gap-5">
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <FieldLabel>Base URL</FieldLabel>
                    <TextInput
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.currentTarget.value)}
                      disabled={loadingConfig || savingSettings}
                    />
                  </label>
                  {/* A model name, a two-position switch and a key: three short
                      values, so three full-width rows was three times the height for
                      no more information. */}
                  <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <label className="flex min-w-0 flex-col gap-1.5">
                      <FieldLabel>Model</FieldLabel>
                      <TextInput
                        value={model}
                        onChange={(event) => setModel(event.currentTarget.value)}
                        disabled={loadingConfig || savingSettings}
                      />
                    </label>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <FieldLabel>API 模式</FieldLabel>
                      <SegmentedControl
                        label="API 模式"
                        value={apiMode}
                        options={LLM_API_MODE_OPTIONS}
                        onChange={setApiMode}
                        disabled={loadingConfig || savingSettings}
                      />
                    </div>
                  </div>
                  <label className="flex min-w-0 flex-col gap-1.5 sm:max-w-sm">
                    <FieldLabel>API Key</FieldLabel>
                    <TextInput
                      value={apiKey}
                      type="password"
                      placeholder={
                        hasExistingApiKey
                          ? "已配置，留空则保留"
                          : "请输入 API Key"
                      }
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      disabled={loadingConfig || savingSettings}
                    />
                  </label>

                  {/* The background worker and its log: two rows about the same
                      thing, separated by a rule rather than boxed. */}
                  <ul className="flex min-w-0 flex-col">
                    <HairlineItem>
                      <div className="flex min-w-0 items-center justify-between gap-4">
                        <PanelText className="min-w-0">
                          LLM Wiki 后台处理
                        </PanelText>
                        <TextControlButton
                          className="shrink-0"
                          onClick={() => void toggleLlmWiki()}
                          disabled={
                            !workspaceRoot || !llmWikiConfig || loadingLlmWiki
                          }
                        >
                          {llmWikiConfig?.paused ? "启用" : "暂停"}
                        </TextControlButton>
                      </div>
                    </HairlineItem>
                    <HairlineItem>
                      <div className="flex min-w-0 items-center justify-between gap-4">
                        <PanelText className="min-w-0">日志</PanelText>
                        <IconButton
                          className="shrink-0"
                          label="刷新 LLM Wiki 日志"
                          icon={
                            <RefreshCw
                              className={
                                loadingLlmWiki ? "animate-spin" : undefined
                              }
                            />
                          }
                          onClick={() => void refreshLlmWikiLog()}
                          disabled={!workspaceRoot || loadingLlmWiki}
                        />
                      </div>
                      <LogBlock className="mt-2 max-h-40">
                        {workspaceRoot
                          ? llmWikiLog || "暂无日志"
                          : "打开工作区后显示 LLM Wiki 日志"}
                      </LogBlock>
                    </HairlineItem>
                  </ul>
                </div>
              </PanelSection>
            </div>
          </div>
        </div>
      </DialogSurface>
    </DialogOverlay>
  );
}

/**
 * A count, in a field as wide as a count.
 *
 * One component because three of these sat side by side and each had been written
 * out again: the label, the numeric input mode, the disabled wiring. The width
 * comes from the grid it is placed in rather than from the field, so a row of three
 * stays even.
 */
function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel className="block truncate">
        <span title={label}>{label}</span>
      </FieldLabel>
      <TextInput
        value={value}
        inputMode="numeric"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

const LLM_API_MODE_OPTIONS: Array<{
  value: LlmProviderApiMode;
  label: string;
}> = [
  { value: "chat", label: "Chat" },
  { value: "responses", label: "Responses" },
];

/**
 * Appearance is not here: it lives on the title bar, where the window it changes
 * is in view. See `appearance-button.tsx`.
 */
type SettingsSection = "search" | "files" | "imageHost" | "memory" | "llm";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "search", label: "搜索" },
  { id: "files", label: "文件" },
  { id: "imageHost", label: "图床" },
  { id: "memory", label: "Memory" },
  { id: "llm", label: "LLM" },
];

function parseExcludeDirs(text: string) {
  return Array.from(
    new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.replaceAll("\\", "/").trim())
        .map((line) => line.replace(/^\/+|\/+$/g, ""))
        .filter((line) => line.length > 0)
        .filter(
          (line) =>
            !line
              .split("/")
              .some((part) => part === "." || part === ".."),
        ),
    ),
  );
}

function formatError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return `${fallback} ${error.message}`;
  }

  if (typeof error === "string" && error.length > 0) {
    return `${fallback} ${error}`;
  }

  if (error && typeof error === "object") {
    if (
      "message" in error &&
      typeof error.message === "string" &&
      error.message.length > 0
    ) {
      return `${fallback} ${error.message}`;
    }

    if (
      "error" in error &&
      typeof error.error === "string" &&
      error.error.length > 0
    ) {
      return `${fallback} ${error.error}`;
    }

    try {
      return `${fallback} ${JSON.stringify(error)}`;
    } catch {
      return `${fallback} ${String(error)}`;
    }
  }

  return fallback;
}
