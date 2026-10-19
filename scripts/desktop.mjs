import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 为子进程集中配置工作盘工具链、下载和临时目录，不修改用户的全局环境。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const tools = path.join(root, ".tools");
for (const folder of ["tmp", "cargo", "rustup", "target"]) mkdirSync(path.join(tools, folder), { recursive: true });
if (existsSync(path.join(tools, "cargo", "bin", "cargo.exe"))) {
  env.CARGO_HOME = path.join(tools, "cargo");
  env.RUSTUP_HOME = path.join(tools, "rustup");
  env.PATH = `${path.join(env.CARGO_HOME, "bin")};${env.PATH}`;
}
env.CARGO_TARGET_DIR = path.join(tools, "target");
env.TEMP = env.TMP = path.join(tools, "tmp");

// MSVC 的头文件和库变量仅用于本次构建；标准安装由 rustc 自行发现。
const vcvars = path.join(tools, "BuildTools", "VC", "Auxiliary", "Build", "vcvars64.bat");
if (process.platform === "win32" && existsSync(vcvars)) {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${vcvars}" >nul && set"`], { encoding: "utf8", env });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  for (const line of result.stdout.split(/\r?\n/)) {
    const split = line.indexOf("=");
    if (split > 0) env[line.slice(0, split)] = line.slice(split + 1);
  }
}

// 将常用验证命令映射到 Cargo，其余参数透传给项目锁定的 Tauri CLI。
const [action = "dev", ...args] = process.argv.slice(2);
let command = process.execPath;
let commandArgs = [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), action, ...args];
if (["test-core", "check", "test", "fmt", "clippy"].includes(action)) {
  command = "cargo";
  commandArgs = action === "test-core"
    ? ["test", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", ...args]
    : [action, "--manifest-path", "src-tauri/Cargo.toml", ...args];
}
const child = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit" });
if (child.error) process.stderr.write(`构建命令无法启动：${child.error.message}\n`);
process.exit(child.status ?? 1);
