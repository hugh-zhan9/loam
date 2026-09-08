#!/usr/bin/env node

import { existsSync, rmSync, cpSync, mkdtempSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${name} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout ?? "";
}

function isRunning(destinationApp) {
  const executable = join(destinationApp, "Contents", "MacOS", "loam");
  return command("ps", ["-axo", "comm="]).split("\n").some((line) => line.trim() === executable);
}

export async function installLocalApp({ sourceApp, destinationApp }) {
  sourceApp = resolve(sourceApp);
  destinationApp = resolve(destinationApp);
  for (const app of [sourceApp, destinationApp]) {
    if (!app.endsWith(".app")) throw new Error(`Expected an .app path: ${app}`);
    if (existsSync(app) && lstatSync(app).isSymbolicLink()) throw new Error(`Refusing symlink app path: ${app}`);
  }
  if (!existsSync(join(sourceApp, "Contents", "MacOS", "loam")) ||
      !existsSync(join(sourceApp, "Contents", "Info.plist"))) {
    throw new Error(`Built Loam app not found at ${sourceApp}. Run npm run build:app first.`);
  }
  sourceApp = realpathSync(sourceApp);
  destinationApp = join(realpathSync(dirname(destinationApp)), basename(destinationApp));
  if (sourceApp === destinationApp || sourceApp.startsWith(destinationApp + sep) || destinationApp.startsWith(sourceApp + sep)) {
    throw new Error("Built app and install destination must be separate bundles.");
  }

  // Prepare and verify beside the destination so replacement uses same-volume
  // renames. A copy or signing failure cannot remove the installed application.
  const staging = mkdtempSync(join(dirname(destinationApp), ".loam-install-"));
  const nextApp = join(staging, "next.app");
  const previousApp = join(staging, "previous.app");
  let hasBackup = false;
  let installed = false;
  try {
    cpSync(sourceApp, nextApp, { recursive: true, preserveTimestamps: true });
    command("xattr", ["-dr", "com.apple.quarantine", nextApp]);
    command("codesign", ["--force", "--deep", "--sign", "-", nextApp]);
    command("codesign", ["--verify", "--deep", "--strict", nextApp]);

    if (isRunning(destinationApp)) {
      throw new Error("Loam is running. Save your edits and close Loam, then run npm run install:local. The installed app has not been replaced.");
    }

    if (existsSync(destinationApp)) {
      renameSync(destinationApp, previousApp);
      hasBackup = true;
    }
    renameSync(nextApp, destinationApp);
    installed = true;
    console.log(`Installed ${sourceApp} -> ${destinationApp}`);
    if (hasBackup) console.log(`Previous app: ${previousApp}`);
    return { destinationApp, backupApp: hasBackup ? previousApp : null };
  } catch (error) {
    // The replacement rename can fail after moving the old bundle aside.
    if (hasBackup && !installed) {
      renameSync(previousApp, destinationApp);
      hasBackup = false;
    }
    throw error;
  } finally {
    if (!hasBackup) rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== "darwin") throw new Error("Local .app installation requires macOS.");
  await installLocalApp({
    sourceApp: resolve(root, process.env.LOAM_BUILT_APP ?? "src-tauri/target/release/bundle/macos/Loam.app"),
    destinationApp: resolve(process.env.LOAM_INSTALL_APP ?? "/Applications/Loam.app"),
  });
}
