import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("阶段 6 的安装钩子、性能口径和 CI 入口保持可执行", async () => {
  const hooks = await read("src-tauri/windows/hooks.nsh");
  assert.match(hooks, /!macro NSIS_HOOK_PREUNINSTALL/);
  assert.match(hooks, /\/DELETEAPPDATA/);
  assert.match(hooks, /\$UpdateMode <> 1/);
  assert.match(hooks, /--uninstall-data/);
  assert.match(hooks, /\bAbort\b/);
  assert.doesNotMatch(hooks, /!macro NSIS_HOOK_POSTUNINSTALL/);

  const config = await read("src-tauri/tauri.conf.json");
  assert.match(config, /"installMode": "currentUser"/);
  assert.match(config, /"installerHooks": "windows\/hooks.nsh"/);
  for (const extension of ["md", "markdown", "mdown"]) assert.match(config, new RegExp(`"${extension}"`));

  const workflow = await read(".github/workflows/check.yml");
  assert.match(workflow, /dtolnay\/rust-toolchain/);
  assert.match(workflow, /npm run build:desktop\n/);
  assert.doesNotMatch(workflow, /build:desktop -- --no-bundle/);
  assert.match(workflow, /install-audit\.ps1/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /npm run test:core -- --locked/);

  const performance = await read("tests/performance.mjs");
  assert.match(performance, /FORMAL_SAMPLE_COUNT/);
  assert.match(performance, /FORMAL_SWITCH_COUNT/);
  assert.match(performance, /process-memory\.ps1/);
  assert.match(performance, /full\.startTime > arguments\[0\]/);
  assert.match(performance, /specPassed: false/);

  const gitignore = await read(".gitignore");
  for (const entry of [".tools/", ".runtime/", ".reports/", "fixtures/_perf-*.md"]) {
    assert.match(gitignore, new RegExp(entry.replaceAll("/", "\\/").replaceAll(".", "\\.").replaceAll("*", "\\*")));
  }
});
