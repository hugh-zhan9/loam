import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installLocalApp } from "./install-local-app.mjs";

const actualFs = await vi.importActual("node:fs");
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let folder;
let sourceApp;
let destinationApp;
function bundle(path, content) {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(path, "Contents", "MacOS", "loam"), content);
  writeFileSync(join(path, "Contents", "Info.plist"), "plist");
}
function binary(path) { return readFileSync(join(path, "Contents", "MacOS", "loam"), "utf8"); }

beforeEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync);
  folder = mkdtempSync(join(tmpdir(), "loam-install-test-"));
  sourceApp = join(folder, "built.app");
  destinationApp = join(folder, "Loam.app");
  bundle(sourceApp, "new");
  bundle(destinationApp, "old");
  vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("local app installation", () => {
  it("verifies the new bundle before replacing the old app, which remains available as a backup", async () => {
    const result = await installLocalApp({ sourceApp, destinationApp });
    expect(binary(destinationApp)).toBe("new");
    expect(binary(result.backupApp)).toBe("old");
    expect(binary(sourceApp)).toBe("new");
    expect(spawnSync.mock.calls.filter(([name]) => name === "codesign").map(([, args]) => args[0])).toEqual(["--force", "--verify"]);
    expect(spawnSync.mock.calls.some(([name]) => name === "osascript")).toBe(false);
  });

  it.each(["--force", "--verify"])("keeps the installed app when codesign %s fails", async (step) => {
    vi.mocked(spawnSync).mockImplementation((name, args) => ({ status: name === "codesign" && args[0] === step ? 1 : 0, stderr: "sign error", stdout: "" }));
    await expect(installLocalApp({ sourceApp, destinationApp })).rejects.toThrow("codesign failed");
    expect(binary(destinationApp)).toBe("old");
    expect(readdirSync(folder).sort()).toEqual(["Loam.app", "built.app"]);
  });

  it("refuses to replace a running app instead of bypassing unsaved window edits", async () => {
    vi.mocked(spawnSync).mockImplementation((name) => ({
      status: name === "osascript" ? 1 : 0,
      stdout: name === "ps" ? join(realpathSync(destinationApp), "Contents", "MacOS", "loam") : "",
      stderr: "cancelled",
    }));
    await expect(installLocalApp({ sourceApp, destinationApp })).rejects.toThrow("Loam is running");
    expect(binary(destinationApp)).toBe("old");
    expect(spawnSync.mock.calls.some(([name]) => name === "osascript")).toBe(false);
  });

  it("rejects a missing build or the installed bundle as its own source", async () => {
    await expect(installLocalApp({ sourceApp: join(folder, "absent.app"), destinationApp })).rejects.toThrow("not found");
    await expect(installLocalApp({ sourceApp: destinationApp, destinationApp })).rejects.toThrow("separate bundles");
    expect(binary(destinationApp)).toBe("old");
  });

  it("restores the old app if placing the new bundle fails after moving the old one", async () => {
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (source.endsWith("next.app")) throw new Error("replacement failed");
      return actualFs.renameSync(source, destination);
    });
    await expect(installLocalApp({ sourceApp, destinationApp })).rejects.toThrow("replacement failed");
    expect(binary(destinationApp)).toBe("old");
    expect(readdirSync(folder).sort()).toEqual(["Loam.app", "built.app"]);
  });

  it("installs on a machine without an existing app", async () => {
    rmSync(destinationApp, { recursive: true });
    const result = await installLocalApp({ sourceApp, destinationApp });
    expect(result.backupApp).toBeNull();
    expect(existsSync(destinationApp)).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(["Loam.app", "built.app"]);
  });
});
