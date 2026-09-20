#!/usr/bin/env node

import { existsSync, rmSync, cpSync, mkdtempSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${name} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout ?? "";
}

function runningPids(destinationApp) {
  const executable = join(destinationApp, "Contents", "MacOS", "loam");
  return command("ps", ["-axo", "pid=,comm="])
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match) => match !== null && match[2] === executable)
    .map((match) => Number(match[1]));
}

function isRunning(destinationApp) {
  return runningPids(destinationApp).length > 0;
}

async function waitForExit(destinationApp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(destinationApp)) return true;
    await sleep(250);
  }
  return !isRunning(destinationApp);
}

/**
 * Ask Loam to quit the way ⌘Q does.
 *
 * Only the app can see every window's unsaved tabs — `loam-cli` reports the
 * focused window alone — so saving is left to its own quit path. That path can
 * stop and ask, which is why this waits rather than assuming a quit happened.
 */
async function quitGracefully(destinationApp) {
  spawnSync("osascript", ["-e", 'quit app "Loam"'], { encoding: "utf8" });
  if (await waitForExit(destinationApp, 3000)) return true;

  console.log("Loam is still open — it may be asking about unsaved edits. Answer it in Loam; waiting…");
  return waitForExit(destinationApp, 120_000);
}

/**
 * End the process without going through the app.
 *
 * Drafts are written 1.5s after typing stops and come back as recoverable
 * drafts, so this loses at most that much — but it does not run the app's own
 * unsaved-changes prompt, so it is only reached when the caller asked for it.
 */
async function terminate(destinationApp) {
  for (const pid of runningPids(destinationApp)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  if (await waitForExit(destinationApp, 5000)) return true;

  for (const pid of runningPids(destinationApp)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return waitForExit(destinationApp, 5000);
}

/**
 * Ask a person what to do about the running app.
 *
 * Replaceable so the install can be driven without a terminal, and so the
 * three outcomes can be tested without standing in for stdin.
 */
async function promptHowToStop(destinationApp) {
  // Nothing is asked without someone to answer: a non-interactive run keeps
  // the old refusal rather than deciding to end the app on its own.
  if (!process.stdin.isTTY) return "abort";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Loam is running (pid ${runningPids(destinationApp).join(", ")}). The installed app cannot be replaced while it is.`);
    const answer = await rl.question("  [q] quit Loam, saving as it normally does  [f] force quit, keeping only autosaved drafts  [a] abort (default): ");
    const choice = answer.trim().toLowerCase();
    if (choice === "q" || choice === "quit") return "quit";
    if (choice === "f" || choice === "force") return "force";
    return "abort";
  } finally {
    rl.close();
  }
}

async function stopRunningApp(destinationApp, onRunning) {
  if (!isRunning(destinationApp)) return;

  const choice = await onRunning(destinationApp);
  if (choice === "abort") {
    throw new Error("Loam is running. Save your edits and close Loam, then run npm run install:local. The installed app has not been replaced.");
  }

  const stopped = choice === "quit"
    ? await quitGracefully(destinationApp)
    : await terminate(destinationApp);

  if (!stopped) {
    throw new Error("Loam is still running. The installed app has not been replaced.");
  }
}

export async function installLocalApp({ sourceApp, destinationApp, onRunning = promptHowToStop }) {
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

  // Asked before the copy and signing below, so the question does not arrive
  // after ten seconds of waiting.
  await stopRunningApp(destinationApp, onRunning);

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

    // Relaunched while the bundle was being prepared. Swapping it under a
    // live process leaves that process loading resources that have moved.
    if (isRunning(destinationApp)) {
      throw new Error("Loam started again while the new bundle was being prepared. Close it and run npm run install:local. The installed app has not been replaced.");
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
