// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsButton } from "./settings-button";
import type { AppPreferences } from "../lib/types";
import { setWorkspaceConfig } from "@/features/memory/lib/memory-client";
import { saveLlmConfig } from "@/features/llm-wiki/lib/llm-wiki-client";
import {
  defaultImageHostConfig,
  getImageHostConfig,
  updateImageHostConfig,
  type ImageHostConfigUpdate,
} from "@/common/lib/image-host";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/features/llm-wiki/lib/llm-wiki-client", () => ({
  detectLlmWikiWorkspace: vi.fn(async () => ({ hasLlmWiki: false })),
  getLlmWikiConfig: vi.fn(),
  getLlmWikiLog: vi.fn(),
  getLlmConfig: vi.fn(async () => null),
  saveLlmConfig: vi.fn(async () => ({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiMode: "chat",
    hasApiKey: false,
  })),
  updateLlmWikiConfig: vi.fn(),
}));

const defaultMemoryConfig = {
  version: 3,
  enabled: true,
  capture: { enabled: false, sources: [] as string[] },
  agents: {
    claude: { enabled: false },
    codex: { enabled: false },
    cursor: { enabled: false },
  },
};

vi.mock("@/common/lib/image-host", async (importOriginal) => {
  // Only the two backend calls are replaced; the defaults and the update it
  // builds are what the section really sends.
  const actual = await importOriginal<typeof import("@/common/lib/image-host")>();
  return {
    ...actual,
    getImageHostConfig: vi.fn(async () => actual.defaultImageHostConfig()),
    updateImageHostConfig: vi.fn(async () => actual.defaultImageHostConfig()),
  };
});

vi.mock("@/features/memory/lib/memory-client", () => ({
  getWorkspaceConfig: vi.fn(async () => defaultMemoryConfig),
  setWorkspaceConfig: vi.fn(async (_rootPath: string, config: unknown) => config),
}));

vi.mock("../lib/theme-preference", async (importOriginal) => ({
  // Only the hook is replaced: the rest of the module is plain data and pure
  // functions the theme list reads, and a stub of those would be a second
  // definition of what a preference means.
  ...(await importOriginal<typeof import("../lib/theme-preference")>()),
  useThemePreference: () => ({
    preference: "system",
    resolvedTheme: "light",
    setPreference: vi.fn(),
  }),
}));

describe("SettingsButton", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("renders the save action with the primary button treatment", async () => {
    await renderSettings(root);

    const saveButton = getButton("保存");

    expect(saveButton.className).toContain("bg-primary");
    expect(saveButton.className).toContain("text-primary-content");
    expect(saveButton.className).not.toContain("bg-base-content");
  });

  it("scrolls the content pane instead of calling section scrollIntoView", async () => {
    await renderSettings(root);

    const scrollContainer = host.querySelector<HTMLElement>(
      "[data-settings-scroll-container]",
    );
    const llmSection = host.querySelector<HTMLElement>(
      '[data-settings-section="llm"]',
    );

    if (!scrollContainer || !llmSection) {
      throw new Error("Expected settings sections to be rendered.");
    }

    Object.defineProperty(scrollContainer, "offsetTop", {
      configurable: true,
      value: 40,
    });
    Object.defineProperty(llmSection, "offsetTop", {
      configurable: true,
      value: 420,
    });
    scrollContainer.scrollTo = vi.fn();
    llmSection.scrollIntoView = vi.fn();

    await act(async () => {
      getButton("LLM").click();
      await flushPromises();
    });

    expect(llmSection.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollContainer.scrollTo).toHaveBeenCalledWith({
      top: 380,
      behavior: "smooth",
    });
  });

  it("lets the settings content pane own vertical scrolling", async () => {
    await renderSettings(root);

    const scrollContainer = host.querySelector<HTMLElement>(
      "[data-settings-scroll-container]",
    );

    expect(scrollContainer?.className).toContain("min-h-0");
    expect(scrollContainer?.className).toContain("flex-1");
    expect(scrollContainer?.className).toContain("overflow-y-auto");
  });

  it("constrains the settings dialog to the viewport so the content pane can scroll", async () => {
    await renderSettings(root);

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');

    expect(dialog?.className).toContain("min-h-0");
    expect(dialog?.className).toContain(
      "h-[min(680px,78dvh,calc(100dvh-2rem))]",
    );
    expect(dialog?.className).not.toContain("max-h-[calc(100vh-7rem)]");
  });

  it("offers capture as an opt-in with no source chosen", async () => {
    await renderSettings(root, { workspaceRoot: "/tmp/ws" });

    expect(host.textContent).toContain("自动捕获 agent 会话");
    // The warning is the point: capture cannot be undone after the fact.
    expect(host.textContent).toContain("不能撤回");
    const claude = Array.from(host.querySelectorAll("input[type='checkbox']"))
      .map((input) => input as HTMLInputElement)
      .find((input) => input.parentElement?.textContent?.includes("Claude Code"));
    expect(claude?.checked).toBe(false);
    expect(claude?.disabled).toBe(true);
  });

  it("writes the capture switch back to the workspace configuration", async () => {
    await renderSettings(root, { workspaceRoot: "/tmp/ws" });

    const toggle = Array.from(host.querySelectorAll("input[type='checkbox']"))
      .map((input) => input as HTMLInputElement)
      .find((input) =>
        input.parentElement?.textContent?.includes("自动捕获 agent 会话"),
      );

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    expect(setWorkspaceConfig).toHaveBeenCalledWith(
      "/tmp/ws",
      expect.objectContaining({
        capture: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it("no longer offers a storage backend to migrate between", async () => {
    await renderSettings(root, { workspaceRoot: "/tmp/ws" });

    for (const gone of ["迁移预检", "开始迁移", "PostgreSQL"]) {
      expect(host.textContent).not.toContain(gone);
    }
  });

  it("saves the image host before any other setting", async () => {
    const onPreferencesChange = vi.fn(async () => {});
    await renderSettings(root, { onPreferencesChange });
    // A changed preference and an edited image host, so both saves happen.
    await act(async () => {
      fileWatchToggle()?.click();
      imageHostToggle()?.click();
      await flushPromises();
    });

    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    const imageHostSave = vi.mocked(updateImageHostConfig).mock
      .invocationCallOrder[0];
    const preferencesSave = onPreferencesChange.mock.invocationCallOrder[0];
    const llmSave = vi.mocked(saveLlmConfig).mock.invocationCallOrder[0];
    expect(imageHostSave).toBeDefined();
    expect(preferencesSave).toBeDefined();
    expect(imageHostSave).toBeLessThan(preferencesSave);
    expect(preferencesSave).toBeLessThan(llmSave);
  });

  it("stops the whole save when the image host is refused", async () => {
    vi.mocked(updateImageHostConfig).mockRejectedValueOnce({
      error_code: "image_host_config_invalid",
      message: "missing required field: s3.bucket",
    });
    const onPreferencesChange = vi.fn(async () => {});
    await renderSettings(root, { onPreferencesChange });
    await act(async () => {
      fileWatchToggle()?.click();
      imageHostToggle()?.click();
      await flushPromises();
    });

    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    expect(onPreferencesChange).not.toHaveBeenCalled();
    expect(saveLlmConfig).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      "保存设置失败。 missing required field: s3.bucket",
    );
  });

  it("keeps the image host section editable when its config cannot be read", async () => {
    vi.mocked(getImageHostConfig).mockRejectedValueOnce({
      error_code: "image_host_config_load_failed",
      message: "failed to parse image host config",
    });
    await renderSettings(root);

    const section = host.querySelector('[data-settings-section="imageHost"]');
    const alert = section?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "图床配置读取失败。 failed to parse image host config",
    );
    expect(alert?.textContent).toContain("在这里修改后保存设置，会用下面的内容覆盖它");
    const toggle = imageHostToggle();
    expect(toggle?.disabled).toBe(false);
  });

  it("keeps a stored secret when its field is left blank", async () => {
    const stored = defaultImageHostConfig();
    vi.mocked(getImageHostConfig).mockResolvedValueOnce({
      ...stored,
      enabled: true,
      provider: "s3",
      s3: { ...stored.s3, bucket: "images", hasSecretAccessKey: true },
    });
    await renderSettings(root);

    const secret = host.querySelector<HTMLInputElement>(
      '[data-settings-section="imageHost"] input[type="password"]',
    );
    expect(secret?.placeholder).toBe("已配置，留空则保留");

    // Something else in the section changes; the secret field stays blank.
    const pathStyle = Array.from(
      host.querySelectorAll<HTMLInputElement>(
        '[data-settings-section="imageHost"] input[type="checkbox"]',
      ),
    ).find((input) => input.parentElement?.textContent?.includes("path-style"));
    await act(async () => {
      pathStyle?.click();
      await flushPromises();
    });

    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    const sent = vi.mocked(updateImageHostConfig).mock
      .calls[0][0] as ImageHostConfigUpdate;
    expect(sent.enabled).toBe(true);
    expect(sent.provider).toBe("s3");
    expect(sent.s3.bucket).toBe("images");
    expect(sent.s3.preserveSecretAccessKey).toBe(true);
    expect(sent.s3.pathStyle).toBe(true);
    expect(sent.s3).not.toHaveProperty("hasSecretAccessKey");
  });

  it("leaves the image host config unwritten when its section was not edited", async () => {
    const onPreferencesChange = vi.fn(async () => {});
    await renderSettings(root, { onPreferencesChange });
    await act(async () => {
      fileWatchToggle()?.click();
      await flushPromises();
    });

    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    // Every paste reads that file; saving an unrelated setting must not
    // create it for someone who never used an image host.
    expect(updateImageHostConfig).not.toHaveBeenCalled();
    expect(onPreferencesChange).toHaveBeenCalled();
    expect(saveLlmConfig).toHaveBeenCalled();
  });

  it("repairs a config that could not be read only once its section is worked in", async () => {
    vi.mocked(getImageHostConfig).mockRejectedValueOnce({
      error_code: "image_host_config_load_failed",
      message: "failed to parse image host config",
    });
    await renderSettings(root);

    // Saving something else must not quietly replace a damaged host with an
    // empty one that is switched off.
    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });
    expect(updateImageHostConfig).not.toHaveBeenCalled();

    await act(async () => {
      imageHostToggle()?.click();
      imageHostToggle()?.click();
      await flushPromises();
    });
    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    const sent = vi.mocked(updateImageHostConfig).mock
      .calls[0][0] as ImageHostConfigUpdate;
    expect(sent.enabled).toBe(false);
    expect(sent.s3.preserveSecretAccessKey).toBe(false);
  });

  it("writes nothing when the switch is turned on and back off", async () => {
    await renderSettings(root);

    await act(async () => {
      imageHostToggle()?.click();
      imageHostToggle()?.click();
      await flushPromises();
    });
    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    expect(updateImageHostConfig).not.toHaveBeenCalled();
  });

  it("writes the image host switch into what it saves", async () => {
    await renderSettings(root);

    await act(async () => {
      imageHostToggle()?.click();
      await flushPromises();
    });
    await act(async () => {
      getButton("保存").click();
      await flushPromises();
    });

    const sent = vi.mocked(updateImageHostConfig).mock
      .calls[0][0] as ImageHostConfigUpdate;
    expect(sent.enabled).toBe(true);
    expect(sent.provider).toBe("picgo");
    expect(sent.picgo.serverUrl).toBe("http://127.0.0.1:36677/upload");
  });
});

async function renderSettings(
  root: ReturnType<typeof createRoot>,
  options: {
    workspaceRoot?: string;
    onPreferencesChange?: (preferences: AppPreferences) => Promise<void>;
  } = {},
) {
  await act(async () => {
    root.render(
      <SettingsButton
        open={true}
        onOpenChange={vi.fn()}
        workspaceRoot={options.workspaceRoot}
        preferences={preferences}
        onPreferencesChange={options.onPreferencesChange ?? vi.fn()}
      />,
    );
    await flushPromises();
  });
}

function fileWatchToggle() {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
  ).find((input) =>
    input.parentElement?.textContent?.includes("启用工作区文件监听"),
  );
}

function imageHostToggle() {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      '[data-settings-section="imageHost"] input[type="checkbox"]',
    ),
  ).find((input) =>
    input.parentElement?.textContent?.includes("上传到图床"),
  );
}

function getButton(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );

  if (!button) {
    throw new Error(`Expected button "${label}"`);
  }

  return button as HTMLButtonElement;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const preferences: AppPreferences = {
  fileTreeExcludeDirs: [],
  fileWatchEnabled: true,
  searchMaxFileBytes: 1048576,
  searchMaxResults: 100,
  searchMaxMatchesPerFile: 20,
};

