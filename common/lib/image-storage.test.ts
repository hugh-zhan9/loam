import { afterEach, describe, expect, it, vi } from "vitest";
import {
    loadImage,
    storeImageForDocument,
    storeImageForWorkspace,
} from "./image-storage";

afterEach(() => {
    vi.restoreAllMocks();
});

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

/**
 * Answers the image host lookup every store now starts with as "off", and
 * passes every other call through, so these cases see only the local save.
 */
function withImageHostOff(
    invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): Invoke {
    return (async (cmd: string, args: Record<string, unknown>) =>
        cmd === "image_host_config_get"
            ? { enabled: false }
            : invoke(cmd, args)) as Invoke;
}

/** An invoke for a host that is on, recording every command it is sent. */
function hostedInvoke(upload: () => Promise<unknown>) {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const invoke = (async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "image_host_config_get") return { enabled: true };
        if (cmd === "upload_image_to_host") return upload();
        throw new Error(`unexpected command ${cmd}`);
    }) as Invoke;
    return { calls, invoke };
}

describe("storeImage", () => {
    it("uses workspace .assets first and falls back to ~/.loam/assets", async () => {
        const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
        const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
            calls.push({ cmd, args });
            return {
                markdownPath: ".assets/abc123.png",
                storedPath: "/tmp/ws/.assets/abc123.png",
                usedFallback: false,
            };
        });
        const file = new File([new Uint8Array([1, 2, 3])], "paste.png", {
            type: "image/png",
        });

        const stored = storeImageForWorkspace(file, {
            rootPath: "/tmp/ws",
            currentFilePath: "/tmp/ws/doc.md",
            invoke: withImageHostOff(invoke),
        });

        await expect(stored).resolves.toMatchObject({
            url: ".assets/abc123.png",
            altText: "paste.png",
        });
        expect(calls[0].cmd).toBe("save_image_asset");
    });

    it("returns the absolute global fallback path from Tauri", async () => {
        const invoke = vi.fn(async () => ({
            markdownPath: "/Users/test/.loam/assets/abc123.png",
            storedPath: "/Users/test/.loam/assets/abc123.png",
            usedFallback: true,
        }));
        const file = new File([new Uint8Array([4, 5, 6])], "fallback.png", {
            type: "image/png",
        });

        await expect(
            storeImageForWorkspace(file, {
                rootPath: "/tmp/ws",
                currentFilePath: "/tmp/ws/doc.md",
                invoke: withImageHostOff(invoke),
            }),
        ).resolves.toMatchObject({
            url: "/Users/test/.loam/assets/abc123.png",
            altText: "fallback.png",
            storedPath: "/Users/test/.loam/assets/abc123.png",
            usedFallback: true,
        });
    });

    it("stores document images through the document asset command", async () => {
        const invoke = vi.fn(async () => ({
            markdownPath: ".assets/abc123.png",
            storedPath: "/tmp/doc/.assets/abc123.png",
            usedFallback: false,
        }));
        const file = new File([new Uint8Array([1, 2, 3])], "paste.png", {
            type: "image/png",
        });

        await expect(
            storeImageForDocument(file, {
                documentPath: "/tmp/doc/Note.md",
                invoke: withImageHostOff(invoke),
            }),
        ).resolves.toMatchObject({
            url: ".assets/abc123.png",
            altText: "paste.png",
            storedPath: "/tmp/doc/.assets/abc123.png",
            usedFallback: false,
        });

        expect(invoke).toHaveBeenCalledWith("save_document_image_asset", {
            documentPath: "/tmp/doc/Note.md",
            name: "paste.png",
            bytes: new Uint8Array([1, 2, 3]),
        });
    });

    it("returns URLs unchanged and invokes Rust for local image paths", async () => {
        const invoke = vi.fn(async () => ({
            bytes: [1, 2, 3],
            mimeType: "image/png",
            path: "/tmp/ws/.assets/abc123.png",
        }));
        const createObjectURL = vi
            .spyOn(URL, "createObjectURL")
            .mockReturnValue("blob:mock");

        await expect(loadImage("https://example.com/image.png")).resolves.toBe(
            "https://example.com/image.png",
        );
        await expect(loadImage("data:image/png;base64,AAAA")).resolves.toBe(
            "data:image/png;base64,AAAA",
        );

        await expect(
            loadImage(".assets/abc123.png", {
                rootPath: "/tmp/ws",
                currentFilePath: "/tmp/ws/doc.md",
                invoke,
            }),
        ).resolves.toBe("blob:mock");
        await expect(
            loadImage("images/abc123.png", {
                rootPath: "/tmp/ws",
                currentFilePath: "/tmp/ws/doc.md",
                invoke,
            }),
        ).resolves.toBe("blob:mock");

        expect(invoke).toHaveBeenCalledWith("load_image_asset", {
            rootPath: "/tmp/ws",
            currentFilePath: "/tmp/ws/doc.md",
            src: ".assets/abc123.png",
        });
        expect(invoke).toHaveBeenCalledWith("load_image_asset", {
            rootPath: "/tmp/ws",
            currentFilePath: "/tmp/ws/doc.md",
            src: "images/abc123.png",
        });
        expect(createObjectURL).toHaveBeenCalledTimes(2);
    });
});

describe("storeImage with the image host on", () => {
    const file = () =>
        new File([new Uint8Array([1, 2, 3])], "paste.png", {
            type: "image/png",
        });

    it("uploads a workspace image instead of saving it to .assets", async () => {
        const { calls, invoke } = hostedInvoke(async () => ({
            url: "https://img.example/a.png",
        }));

        await expect(
            storeImageForWorkspace(file(), {
                rootPath: "/tmp/ws",
                currentFilePath: "/tmp/ws/doc.md",
                invoke,
            }),
        ).resolves.toEqual({
            url: "https://img.example/a.png",
            altText: "paste.png",
            storedPath: null,
            usedFallback: false,
        });
        expect(calls.map((call) => call.cmd)).toEqual([
            "image_host_config_get",
            "upload_image_to_host",
        ]);
        expect(calls[1].args).toEqual({
            name: "paste.png",
            bytes: new Uint8Array([1, 2, 3]),
        });
    });

    it("uploads a document window's image too", async () => {
        const { calls, invoke } = hostedInvoke(async () => ({
            url: "https://img.example/b.png",
        }));

        await expect(
            storeImageForDocument(file(), {
                documentPath: "/tmp/doc/Note.md",
                invoke,
            }),
        ).resolves.toMatchObject({ url: "https://img.example/b.png" });
        expect(calls.map((call) => call.cmd)).toEqual([
            "image_host_config_get",
            "upload_image_to_host",
        ]);
    });

    it("throws a failed upload instead of saving locally", async () => {
        const failure = {
            error_code: "image_host_upload_failed",
            message: "could not reach the PicGo server",
        };
        const { calls, invoke } = hostedInvoke(async () => {
            throw failure;
        });

        await expect(
            storeImageForWorkspace(file(), {
                rootPath: "/tmp/ws",
                currentFilePath: "/tmp/ws/doc.md",
                invoke,
            }),
        ).rejects.toBe(failure);
        expect(calls.some((call) => call.cmd.startsWith("save_"))).toBe(false);
    });

    it("throws when the config cannot be read instead of saving locally", async () => {
        const calls: string[] = [];
        const invoke = (async (cmd: string) => {
            calls.push(cmd);
            throw { error_code: "image_host_config_load_failed", message: "bad" };
        }) as Invoke;

        await expect(
            storeImageForDocument(file(), {
                documentPath: "/tmp/doc/Note.md",
                invoke,
            }),
        ).rejects.toMatchObject({ error_code: "image_host_config_load_failed" });
        expect(calls).toEqual(["image_host_config_get"]);
    });
});
