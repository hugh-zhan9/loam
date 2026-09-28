"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  defaultImageHostConfig,
  getImageHostConfig,
  imageHostConfigUpdate,
  imageHostConfigsEqual,
  updateImageHostConfig,
  type ImageHostProvider,
  type PublicImageHostConfig,
} from "@/common/lib/image-host";
import {
  Checkbox,
  FieldLabel,
  PanelSection,
  PanelText,
  SegmentedControl,
  TextInput,
} from "../../../common/components/ui-controls";
import { formatError } from "../lib/workspace-save";

interface ImageHostSecrets {
  secretAccessKey: string;
  token: string;
}

const NO_SECRETS: ImageHostSecrets = { secretAccessKey: "", token: "" };

/**
 * The image host settings as the dialog edits them.
 *
 * Loading and saving live here so the dialog only has to decide when to save.
 * A config that could not be read leaves the section editable from the
 * defaults: saving over the damaged file is the only way to repair it from the
 * app, and until then every paste fails rather than quietly saving locally.
 *
 * Saving writes the file only when what is on screen differs from what was
 * loaded, or a secret was typed. Every paste reads the file, and a file that
 * exists is held to the strict rules for credentials — no symlink on its path —
 * so a dialog that wrote it for anyone who saved any setting, or who flicked the
 * switch and back, would put people who never used an image host under those
 * rules too. A config that could not be read is replaced only once the user has
 * worked in this section, where the warning is: saving some other setting must
 * not quietly turn a damaged host off.
 */
export function useImageHostSettings() {
  const [config, setConfig] = useState<PublicImageHostConfig>(
    defaultImageHostConfig,
  );
  const [secrets, setSecrets] = useState<ImageHostSecrets>(NO_SECRETS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The config as last loaded or saved: what a save would change. */
  const [stored, setStored] = useState<PublicImageHostConfig>(
    defaultImageHostConfig,
  );
  /** Whether the user has worked in the section at all, for a repair. */
  const [touched, setTouched] = useState(false);

  const editConfig = useCallback<typeof setConfig>((next) => {
    setTouched(true);
    setConfig(next);
  }, []);
  const editSecrets = useCallback<typeof setSecrets>((next) => {
    setTouched(true);
    setSecrets(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await getImageHostConfig();
        if (!cancelled) {
          setConfig(loaded);
          setStored(loaded);
        }
      } catch (error) {
        if (!cancelled) setLoadError(formatError(error, "图床配置读取失败。"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    const secretTyped =
      secrets.secretAccessKey.trim() !== "" || secrets.token.trim() !== "";
    const changed = secretTyped || !imageHostConfigsEqual(config, stored);
    const needsWrite = loadError === null ? changed : touched;
    if (!needsWrite) return config;

    const saved = await updateImageHostConfig(
      imageHostConfigUpdate(config, secrets),
    );
    setConfig(saved);
    setStored(saved);
    setSecrets(NO_SECRETS);
    setLoadError(null);
    setTouched(false);
    return saved;
  }, [config, loadError, secrets, stored, touched]);

  return {
    config,
    setConfig: editConfig,
    secrets,
    setSecrets: editSecrets,
    loading,
    loadError,
    save,
  };
}

export type ImageHostSettings = ReturnType<typeof useImageHostSettings>;

const PROVIDER_OPTIONS: Array<{ value: ImageHostProvider; label: string }> = [
  { value: "picgo", label: "PicGo" },
  { value: "command", label: "自定义命令" },
  { value: "s3", label: "S3" },
  { value: "github", label: "GitHub" },
];

export function ImageHostSettingsSection({
  sectionRef,
  settings,
  disabled,
}: {
  sectionRef: (node: HTMLElement | null) => void;
  settings: ImageHostSettings;
  disabled: boolean;
}) {
  const { config, setConfig, secrets, setSecrets, loading, loadError } =
    settings;
  const locked = disabled || loading;

  const update = <Key extends "picgo" | "command" | "s3" | "github">(
    key: Key,
    change: Partial<PublicImageHostConfig[Key]>,
  ) => setConfig((current) => ({ ...current, [key]: { ...current[key], ...change } }));

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { placeholder?: string; type?: string; mono?: boolean } = {},
  ) => (
    <label className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <TextInput
        value={value}
        type={options.type}
        placeholder={options.placeholder}
        className={options.mono ? "font-mono" : undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={locked}
      />
    </label>
  );

  return (
    <div
      ref={sectionRef}
      data-settings-section="imageHost"
      className="scroll-mt-5"
    >
      <PanelSection
        title="图床"
        hint="开启后，粘贴或拖入的图片会上传到图床，文档里写入远程链接，不再保存到 .assets。图片会离开本机；上传失败时不会改存本地。"
      >
        <div className="flex min-w-0 flex-col gap-5">
          {loadError ? (
            <div
              role="alert"
              className="min-w-0 break-words rounded-[var(--mdx-control-radius)] border border-error/30 bg-error/10 px-3 py-2 text-xs"
            >
              {loadError}
              在修好之前，粘贴图片都会失败。在这里修改后保存设置，会用下面的内容覆盖它，凭据需要重新填写。
            </div>
          ) : null}

          <label className="flex min-w-0 items-center gap-2.5 text-[13.5px] leading-[1.75] text-base-content/85">
            <Checkbox
              checked={config.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                setConfig((current) => ({ ...current, enabled }));
              }}
              disabled={locked}
            />
            <span>粘贴或拖入图片时上传到图床</span>
          </label>

          <div className="flex min-w-0 flex-col gap-1.5">
            <FieldLabel>上传方式</FieldLabel>
            <SegmentedControl
              label="上传方式"
              value={config.provider}
              options={PROVIDER_OPTIONS}
              onChange={(provider) =>
                setConfig((current) => ({ ...current, provider }))
              }
              disabled={locked}
            />
          </div>

          {config.provider === "picgo" ? (
            <ProviderFields hint="PicGo 或 PicList 的上传服务地址。需要在它的设置里开启 Server；配置了鉴权 key 时，把 ?key=… 写进地址。">
              {field("服务地址", config.picgo.serverUrl, (serverUrl) =>
                update("picgo", { serverUrl }),
              )}
            </ProviderFields>
          ) : null}

          {config.provider === "command" ? (
            <ProviderFields hint="通过登录 shell 运行，图片的临时文件路径作为最后一个参数传入；命令输出中最后一个 http(s) 链接会被插入文档。60 秒内没有结束视为失败。">
              {field(
                "命令",
                config.command.command,
                (command) => update("command", { command }),
                { placeholder: "picgo upload", mono: true },
              )}
            </ProviderFields>
          ) : null}

          {config.provider === "s3" ? (
            <ProviderFields hint="AWS S3、Cloudflare R2、MinIO，以及阿里云 OSS、腾讯云 COS 的 S3 兼容接口。对象是否可以公开读取由 bucket 策略决定。">
              {field(
                "Endpoint",
                config.s3.endpoint,
                (endpoint) => update("s3", { endpoint }),
                { placeholder: "https://s3.us-east-1.amazonaws.com" },
              )}
              <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
                {field(
                  "Region",
                  config.s3.region,
                  (region) => update("s3", { region }),
                  { placeholder: "us-east-1，R2 填 auto" },
                )}
                {field("Bucket", config.s3.bucket, (bucket) =>
                  update("s3", { bucket }),
                )}
                {field("Access Key ID", config.s3.accessKeyId, (accessKeyId) =>
                  update("s3", { accessKeyId }),
                )}
                {field(
                  "Secret Access Key",
                  secrets.secretAccessKey,
                  (secretAccessKey) =>
                    setSecrets((current) => ({ ...current, secretAccessKey })),
                  {
                    type: "password",
                    placeholder: config.s3.hasSecretAccessKey
                      ? "已配置，留空则保留"
                      : "请输入 Secret Access Key",
                  },
                )}
              </div>
              {field(
                "公开访问地址",
                config.s3.publicBaseUrl,
                (publicBaseUrl) => update("s3", { publicBaseUrl }),
                { placeholder: "https://img.example.com" },
              )}
              {field(
                "路径前缀（可选）",
                config.s3.pathPrefix,
                (pathPrefix) => update("s3", { pathPrefix }),
                { placeholder: "blog/images" },
              )}
              <label className="flex min-w-0 items-center gap-2.5 text-[13.5px] leading-[1.75] text-base-content/85">
                <Checkbox
                  checked={config.s3.pathStyle}
                  onChange={(event) => {
                    const pathStyle = event.currentTarget.checked;
                    update("s3", { pathStyle });
                  }}
                  disabled={locked}
                />
                <span>使用 path-style 地址（MinIO 通常需要）</span>
              </label>
            </ProviderFields>
          ) : null}

          {config.provider === "github" ? (
            <ProviderFields hint="Token 需要这个仓库的 Contents 写权限。私有仓库的 raw 链接无法在编辑器中显示。">
              <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-3">
                {field("Owner", config.github.owner, (owner) =>
                  update("github", { owner }),
                )}
                {field("仓库", config.github.repo, (repo) =>
                  update("github", { repo }),
                )}
                {field("分支", config.github.branch, (branch) =>
                  update("github", { branch }),
                )}
              </div>
              {field(
                "Token",
                secrets.token,
                (token) => setSecrets((current) => ({ ...current, token })),
                {
                  type: "password",
                  placeholder: config.github.hasToken
                    ? "已配置，留空则保留"
                    : "请输入 GitHub token",
                },
              )}
              {field(
                "路径前缀（可选）",
                config.github.pathPrefix,
                (pathPrefix) => update("github", { pathPrefix }),
                { placeholder: "images" },
              )}
              {field(
                "自定义链接前缀（可选）",
                config.github.customBaseUrl,
                (customBaseUrl) => update("github", { customBaseUrl }),
                { placeholder: "https://cdn.jsdelivr.net/gh/owner/repo@main" },
              )}
            </ProviderFields>
          ) : null}
        </div>
      </PanelSection>
    </div>
  );
}

function ProviderFields({
  hint,
  children,
}: {
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PanelText tone="meta">{hint}</PanelText>
      {children}
    </div>
  );
}
