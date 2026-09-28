import { tauriCore } from "./tauri";

/**
 * The image host a pasted image is uploaded to instead of `.assets`.
 *
 * One config for the whole app, kept by the backend in `~/.loam`. The webview
 * sees every field except the credentials, which it only learns exist.
 */

export type ImageHostProvider = "picgo" | "command" | "s3" | "github";

export type ImageHostInvoke = <T>(
    cmd: string,
    args: Record<string, unknown>,
) => Promise<T>;

export interface PublicImageHostConfig {
    enabled: boolean;
    /** As stored; a value this build does not know selects no provider. */
    provider: ImageHostProvider;
    picgo: { serverUrl: string };
    command: { command: string };
    s3: {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        pathStyle: boolean;
        pathPrefix: string;
        publicBaseUrl: string;
        hasSecretAccessKey: boolean;
    };
    github: {
        owner: string;
        repo: string;
        branch: string;
        pathPrefix: string;
        customBaseUrl: string;
        hasToken: boolean;
    };
}

export interface ImageHostConfigUpdate {
    enabled: boolean;
    provider: ImageHostProvider;
    picgo: { serverUrl: string };
    command: { command: string };
    s3: Omit<PublicImageHostConfig["s3"], "hasSecretAccessKey"> & {
        secretAccessKey: string;
        preserveSecretAccessKey: boolean;
    };
    github: Omit<PublicImageHostConfig["github"], "hasToken"> & {
        token: string;
        preserveToken: boolean;
    };
}

/** What a missing config file reads as; the backend owns the same defaults. */
export function defaultImageHostConfig(): PublicImageHostConfig {
    return {
        enabled: false,
        provider: "picgo",
        picgo: { serverUrl: "http://127.0.0.1:36677/upload" },
        command: { command: "" },
        s3: {
            endpoint: "",
            region: "",
            bucket: "",
            accessKeyId: "",
            pathStyle: false,
            pathPrefix: "",
            publicBaseUrl: "",
            hasSecretAccessKey: false,
        },
        github: {
            owner: "",
            repo: "",
            branch: "main",
            pathPrefix: "",
            customBaseUrl: "",
            hasToken: false,
        },
    };
}

/**
 * The update for a config as edited, with the secrets as typed.
 *
 * A blank secret field keeps the stored secret when there is one, as the LLM
 * API key does; there is nothing on screen to say what it was.
 */
export function imageHostConfigUpdate(
    config: PublicImageHostConfig,
    secrets: { secretAccessKey: string; token: string },
): ImageHostConfigUpdate {
    const { hasSecretAccessKey, ...s3 } = config.s3;
    const { hasToken, ...github } = config.github;
    return {
        enabled: config.enabled,
        provider: config.provider,
        picgo: { ...config.picgo },
        command: { ...config.command },
        s3: {
            ...s3,
            secretAccessKey: secrets.secretAccessKey,
            preserveSecretAccessKey:
                hasSecretAccessKey && secrets.secretAccessKey.trim() === "",
        },
        github: {
            ...github,
            token: secrets.token,
            preserveToken: hasToken && secrets.token.trim() === "",
        },
    };
}

/** Whether two configs say the same thing, field by field. */
export function imageHostConfigsEqual(
    left: PublicImageHostConfig,
    right: PublicImageHostConfig,
): boolean {
    return sameValue(left, right);
}

function sameValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (
        typeof left !== "object" ||
        typeof right !== "object" ||
        left === null ||
        right === null
    ) {
        return false;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
        keys.length === Object.keys(rightRecord).length &&
        keys.every((key) => sameValue(leftRecord[key], rightRecord[key]))
    );
}

async function resolveInvoke(
    invoke?: ImageHostInvoke,
): Promise<ImageHostInvoke> {
    return invoke ?? (await tauriCore()).invoke;
}

export async function getImageHostConfig(
    invoke?: ImageHostInvoke,
): Promise<PublicImageHostConfig> {
    return (await resolveInvoke(invoke))<PublicImageHostConfig>(
        "image_host_config_get",
        {},
    );
}

export async function updateImageHostConfig(
    config: ImageHostConfigUpdate,
    invoke?: ImageHostInvoke,
): Promise<PublicImageHostConfig> {
    return (await resolveInvoke(invoke))<PublicImageHostConfig>(
        "image_host_config_update",
        { config },
    );
}

/** Uploads one image to the configured host and returns where it can be read. */
export async function uploadImageToHost(
    name: string,
    bytes: Uint8Array,
    invoke?: ImageHostInvoke,
): Promise<string> {
    const uploaded = await (await resolveInvoke(invoke))<{ url: string }>(
        "upload_image_to_host",
        { name, bytes },
    );
    return uploaded.url;
}
