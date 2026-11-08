// 打包 extension/ 为可分发的 extension.zip。
//
// 存在的理由：手工 `zip -r` 极易漏掉排除项，历史上因此把含硬编码后端密钥的
// background-bac.js 和 .DS_Store 打进了下载包。这里把打包规则固化成脚本，
// 并在写盘后做 fail-closed 校验，让"打包错"变成"构建失败"而不是"线上泄漏"。
//
// 用法：
//   node scripts/pack-extension.mjs            # 生成并同步到 3 个位置
//   node scripts/pack-extension.mjs --check    # 只校验现有 zip，不重新生成

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "extension");

// 打包时需要排除的模式（传给 zip -x）
const PACK_EXCLUDES = [
  "*.DS_Store",
  "__MACOSX*",
  "*/.DS_Store",
  "*background-bac.js", // 含历史硬编码密钥的死代码，任何情况下都不得进入产物
  "*.map",
  "*.log",
];

// 打包后校验：这些片段绝不能出现在 zip 清单里
const PACK_FORBIDDEN = [".DS_Store", "__MACOSX", "background-bac"];

// 产物需要同步到的位置：
//   public/extension.zip — 落地页下载源（vite build 会拷进 dist）
//   dist/extension.zip   — 本地预览 / 已构建站点
//   extension.zip        — 仓库根目录，供手动分发
const OUTPUTS = [
  path.join(ROOT, "public", "extension.zip"),
  path.join(ROOT, "dist", "extension.zip"),
  path.join(ROOT, "extension.zip"),
];

export function readZipListing(zipFile) {
  return execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8" });
}

export function assertCleanListing(zipFile) {
  const listing = readZipListing(zipFile);
  const leaked = PACK_FORBIDDEN.filter((bad) => listing.includes(bad));
  if (leaked.length > 0) {
    throw new Error(`打包产物含被排除文件：${leaked.join(", ")}`);
  }
  return listing;
}

/** 列出 extension/ 里应进入产物的源文件（与打包排除规则一致）。 */
export function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(EXT_DIR, full);
      if (PACK_EXCLUDES.some((pat) => matchExclude(rel, name, pat))) continue;
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(EXT_DIR);
  return out;
}

// zip -x 的模式足够简单（后缀/字面量），这里用等价规则判断
function matchExclude(rel, name, pat) {
  const p = pat.replace(/^\*/, ""); // "*.DS_Store" -> ".DS_Store"
  if (pat.startsWith("*")) return rel.endsWith(p);
  if (pat.startsWith("*/")) return rel.includes(pat.slice(1)); // "*/.DS_Store"
  return rel === pat || name === pat;
}

/**
 * 内容一致性校验：zip 里的每个文件必须与 extension/ 源文件字节一致，
 * 源目录里的每个应打包文件也必须出现在 zip 中。
 * 存在的理由：--check 旧版只看清单，"改了代码忘重新打包"完全检测不到 ——
 * 用户下载到的仍是旧扩展，且所有测试都绿（历史事故的固定剧本）。
 */
export function assertZipMatchesSource(zipFile) {
  const listing = readZipListing(zipFile).trim().split("\n").filter(Boolean);
  const zipSet = new Set(listing);
  const stale = [];
  const missing = [];
  for (const rel of listSourceFiles()) {
    if (!zipSet.has(rel)) {
      missing.push(rel);
      continue;
    }
    const zipBytes = execFileSync("unzip", ["-p", zipFile, rel], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const srcBytes = fs.readFileSync(path.join(EXT_DIR, rel));
    if (!zipBytes.equals(srcBytes)) stale.push(rel);
  }
  if (stale.length > 0) {
    throw new Error(`zip 内容与源码不一致（需重新打包）：${stale.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`zip 缺少源文件：${missing.join(", ")}`);
  }
  return listing.length;
}

/** 把 extension/ 打包到 outFile（覆盖写），并做 fail-closed 校验。 */
export function packExtensionZip(outFile) {
  if (!fs.existsSync(EXT_DIR)) {
    throw new Error(`extension/ 目录不存在：${EXT_DIR}`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  const args = ["-r", "-q", outFile, "."];
  for (const pattern of PACK_EXCLUDES) args.push("-x", pattern);
  execFileSync("zip", args, { cwd: EXT_DIR, stdio: "ignore" });

  const listing = assertCleanListing(outFile);
  assertZipMatchesSource(outFile); // 生成后立刻自证内容与源码一致
  const sizeKb = Math.round(fs.statSync(outFile).size / 1024);
  return { file: outFile, sizeKb, entries: listing.trim().split("\n").length };
}

function main() {
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    let ok = true;
    for (const out of OUTPUTS) {
      if (!fs.existsSync(out)) {
        console.warn(`[pack] 缺失：${path.relative(ROOT, out)}`);
        ok = false;
        continue;
      }
      try {
        assertCleanListing(out);
        // 内容一致性：zip 必须与当前 extension/ 源码一致，
        // 防止"忘了重新打包，产物还是旧代码"
        assertZipMatchesSource(out);
        console.log(`[pack] ✓ ${path.relative(ROOT, out)}`);
      } catch (e) {
        console.error(`[pack] ✗ ${path.relative(ROOT, out)} — ${e.message}`);
        ok = false;
      }
    }
    process.exit(ok ? 0 : 1);
  }

  const primary = OUTPUTS[0];
  const { sizeKb, entries } = packExtensionZip(primary);
  console.log(
    `[pack] 已生成 ${path.relative(ROOT, primary)} (${entries} 个条目, ${sizeKb} KB)`
  );

  // 同步到其余位置，保证三份产物字节一致（旧流程手工拷贝，极易漏掉其中一份）
  for (const out of OUTPUTS.slice(1)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(primary, out);
    console.log(`[pack] 已同步 ${path.relative(ROOT, out)}`);
  }
}

// 作为 CLI 直接运行时才执行；被 vite.config.js import 时只导出函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[pack] 失败：${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}
