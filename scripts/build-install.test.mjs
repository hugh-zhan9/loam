import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let folder;
let project;
let script;
let log;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "loam-shell-test-"));
  project = join(folder, "project with spaces");
  mkdirSync(join(project, "scripts"), { recursive: true });
  script = join(project, "scripts", "build-install.sh");
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "build-install.sh"), script);
  chmodSync(script, 0o755);
  log = join(folder, "calls");
  writeFileSync(join(folder, "npm"), `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$LOAM_TEST_LOG"
if [[ "$*" == "run $LOAM_TEST_FAIL" ]]; then exit 23; fi
`);
  chmodSync(join(folder, "npm"), 0o755);
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("shell build and installation entry", () => {
  it.each([
    ["", 0, ["build:app", "install:local"]],
    ["build:app", 23, ["build:app"]],
    ["install:local", 23, ["build:app", "install:local"]],
  ])("runs from the project directory and propagates failure at %s", (failure, status, steps) => {
    const result = spawnSync(script, [], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, LOAM_TEST_LOG: log, LOAM_TEST_FAIL: failure },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(steps.map((step) => `${project}|run ${step}`));
  });
});
