import { getImageHostConfig, uploadImageToHost } from "./image-host";
import { tauriCore } from "./tauri";

const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/tiff": "tiff",
};

export interface StoredImage {
    url: string;
    altText: string;
}

export interface StoredWorkspaceImage extends StoredImage {
    /** Where the file was written; null when it went to the image host. */
    storedPath: string | null;
    usedFallback: boolean;
}

export interface StoreImageForWorkspaceOptions {
    rootPath?: string | null;
    currentFilePath?: string | null;
    invoke?: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
}

export interface StoreImageForDocumentOptions {
    documentPath: string;
    invoke?: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
}

interface SaveImageAssetResponse {
    markdownPath: string;
    storedPath: string;
    usedFallback: boolean;
}

interface LoadImageAssetResponse {
    bytes: number[];
    mimeType: string;
    path: string;
}

function extOf(file: File | Blob, nameHint?: string): string {
    const name = (file instanceof File ? file.name : nameHint) || "";
    const dot = name.lastIndexOf(".");
    if (dot > 0 && dot < name.length - 1) {
        return name.slice(dot + 1).toLowerCase();
    }
    return MIME_TO_EXT[file.type] || "bin";
}

/**
 * The remote URL when the image host is on, or null to store the image locally.
 *
 * Read afresh for every image: the setting is shared by every window, and one of
 * them may have just changed it. Anything that goes wrong is thrown, a config
 * that cannot be read included — a host the user turned on must not quietly
 * become a local save.
 */
async function uploadWhenHostEnabled(
    name: string,
    bytes: Uint8Array,
    invoke: NonNullable<StoreImageForWorkspaceOptions["invoke"]>,
): Promise<string | null> {
    const config = await getImageHostConfig(invoke);
    if (!config.enabled) return null;
    return uploadImageToHost(name, bytes, invoke);
}

function hostedImage(url: string, altText: string): StoredWorkspaceImage {
    return { url, altText, storedPath: null, usedFallback: false };
}

function isPassthroughImageUrl(src: string): boolean {
    return src.startsWith("//") || /^(https?:|data:|blob:)/i.test(src);
}

export async function storeImageForWorkspace(
    file: File,
    options: StoreImageForWorkspaceOptions = {},
): Promise<StoredWorkspaceImage> {
    const ext = extOf(file);
    const name = file.name || `image.${ext}`;
    const altText = name;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { invoke } = options.invoke
        ? { invoke: options.invoke }
        : await tauriCore();
    const hostedUrl = await uploadWhenHostEnabled(name, bytes, invoke);
    if (hostedUrl !== null) return hostedImage(hostedUrl, altText);

    const response = await invoke<SaveImageAssetResponse>("save_image_asset", {
        rootPath: options.rootPath ?? null,
        currentFilePath: options.currentFilePath ?? null,
        name,
        bytes,
    });

    return {
        url: response.markdownPath,
        altText,
        storedPath: response.storedPath,
        usedFallback: response.usedFallback,
    };
}

export async function storeImageForDocument(
    file: File,
    options: StoreImageForDocumentOptions,
): Promise<StoredWorkspaceImage> {
    const ext = extOf(file);
    const name = file.name || `image.${ext}`;
    const altText = name;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { invoke } = options.invoke
        ? { invoke: options.invoke }
        : await tauriCore();
    const hostedUrl = await uploadWhenHostEnabled(name, bytes, invoke);
    if (hostedUrl !== null) return hostedImage(hostedUrl, altText);

    const response = await invoke<SaveImageAssetResponse>(
        "save_document_image_asset",
        {
            documentPath: options.documentPath,
            name,
            bytes,
        },
    );

    return {
        url: response.markdownPath,
        altText,
        storedPath: response.storedPath,
        usedFallback: response.usedFallback,
    };
}

export async function storeImage(file: File): Promise<StoredWorkspaceImage> {
    return storeImageForWorkspace(file);
}

export async function loadImage(
    src: string,
    options: {
        rootPath?: string | null;
        currentFilePath?: string | null;
        invoke?: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
    } = {},
): Promise<string> {
    if (isPassthroughImageUrl(src)) {
        return src;
    }

    const { invoke } = options.invoke
        ? { invoke: options.invoke }
        : await tauriCore();
    const image = await invoke<LoadImageAssetResponse>("load_image_asset", {
        rootPath: options.rootPath ?? null,
        currentFilePath: options.currentFilePath ?? null,
        src,
    });
    const blob = new Blob([new Uint8Array(image.bytes)], {
        type: image.mimeType,
    });
    return URL.createObjectURL(blob);
}

export const IMAGE_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "avif",
    "heic",
    "tiff",
]);

export function isImagePath(p: string): boolean {
    const dot = p.lastIndexOf(".");
    if (dot < 0) return false;
    return IMAGE_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}
