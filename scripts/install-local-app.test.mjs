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

  // `ps -axo pid=,comm=` for a running installed app, plus an unrelated process.
  function runningPs() {
    const executable = join(realpathSync(destinationApp), "Contents", "MacOS", "loam");
    return `  4321 ${executable}\n  4322 /usr/bin/something-else\n`;
  }

  it("leaves a running app alone when nobody chose to end it", async () => {
    vi.mocked(spawnSync).mockImplementation((name) => ({
      status: 0,
      stdout: name === "ps" ? runningPs() : "",
      stderr: "",
    }));
    await expect(
      installLocalApp({ sourceApp, destinationApp, onRunning: async () => "abort" }),
    ).rejects.toThrow("Loam is running");
    expect(binary(destinationApp)).toBe("old");
    // Nothing is sent to the app itself, and it is not signalled.
    expect(spawnSync.mock.calls.some(([name]) => name === "osascript")).toBe(false);
  });

  it("asks the app to quit itself so it can save what it has open", async () => {
    // Only the app can see every window's unsaved tabs, so saving is its job,
    // not this script's.
    let quitting = false;
    vi.mocked(spawnSync).mockImplementation((name) => {
      if (name === "osascript") quitting = true;
      return { status: 0, stdout: name === "ps" && !quitting ? runningPs() : "", stderr: "" };
    });

    const result = await installLocalApp({
      sourceApp,
      destinationApp,
      onRunning: async () => "quit",
    });

    expect(spawnSync.mock.calls.some(([name, args]) =>
      name === "osascript" && args.join(" ").includes('quit app "Loam"'))).toBe(true);
    expect(binary(result.destinationApp)).toBe("new");
  });

  it("refuses when the app is still running after being asked to stop", async () => {
    // Never swap the bundle under a live process: it goes on loading
    // resources from a path that has moved.
    vi.mocked(spawnSync).mockImplementation((name) => ({
      status: 0,
      stdout: name === "ps" ? runningPs() : "",
      stderr: "",
    }));
    await expect(
      installLocalApp({ sourceApp, destinationApp, onRunning: async () => "force" }),
    ).rejects.toThrow("still running");
    expect(binary(destinationApp)).toBe("old");
  }, 30_000);

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
