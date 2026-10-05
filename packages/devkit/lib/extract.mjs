/**
 * `dsh-devkit docs` 与 `dsh-devkit source`：
 * 把 asar 里的官方文档 / 源码抽取到本地缓存，让人类和 agent 都能用普通工具读。
 *
 * 这是本项目第一个真实痛点：Desktop 版把 287 个官方包的 README 关在
 * app.asar 里，ripgrep、read 工具、`cat` 全都打不开。抽取一次之后，
 * 后续任何检索都退回成普通文件操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openInstall, officialPackageRoot } from './install.mjs';

/** 官方包在归档中的目录前缀形如 `/dsh/node_modules/@deepseek-ai/dsh-xxx/`。 */
function packageFilePattern(root) {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}@deepseek-ai/([^/]+)/(.+)$`);
}

function listPackages(source, root) {
  const pattern = packageFilePattern(root);
  const packages = new Map();
  for (const entry of source.list()) {
    const match = pattern.exec(entry);
    if (match === null) continue;
    const [, pkg, relative] = match;
    if (!packages.has(pkg)) packages.set(pkg, []);
    packages.get(pkg).push(relative);
  }
  return packages;
}

function writeFile(target, buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
}

/**
 * 抽取每个官方包的 README（中英）。
 * @returns {{packages:number, files:number, out:string}}
 */
export function extractDocs({ app, out, force = false, filter }) {
  const source = openInstall(app);
  try {
    const root = officialPackageRoot(source);
    if (root === null) {
      throw new Error(
        '该安装形态下找不到 `@deepseek-ai/*` 包目录；docs 命令目前只支持打包后的 Desktop 版。',
      );
    }
    const packages = listPackages(source, root);
    let files = 0;
    let count = 0;

    for (const [pkg, entries] of [...packages].sort()) {
      if (filter !== undefined && !pkg.includes(filter)) continue;
      const wanted = entries.filter((e) => /^README(\.zh)?\.md$/.test(e));
      if (wanted.length === 0) continue;
      count += 1;
      for (const relative of wanted) {
        const target = path.join(out, pkg, relative);
        if (!force && fs.existsSync(target)) continue;
        const buffer = source.read(`${root}@deepseek-ai/${pkg}/${relative}`);
        if (buffer === null) continue;
        writeFile(target, buffer);
        files += 1;
      }
    }

    // 顺带写一份索引，便于 grep 前先看清有哪些包。
    const index = [...packages.keys()].sort().join('\n');
    writeFile(path.join(out, 'INDEX.txt'), Buffer.from(`${index}\n`, 'utf8'));

    return { packages: count, files, out };
  } finally {
    source.close();
  }
}

/**
 * 抽取指定官方包的已构建源码（`lib/**` + `package.json`）。
 * 当 README 说不清某个 Service 方法签名时，这是唯一权威来源——
 * 本项目的 Host 半（`sessionQuery` / `sessionProjectionCache`）就是这么确认的。
 */
export function extractSource({ app, out, packages, force = false }) {
  const source = openInstall(app);
  try {
    const root = officialPackageRoot(source);
    if (root === null) throw new Error('找不到 `@deepseek-ai/*` 包目录。');
    const all = listPackages(source, root);
    let files = 0;
    const missing = [];

    for (const pkg of packages) {
      const entries = all.get(pkg);
      if (entries === undefined) {
        missing.push(pkg);
        continue;
      }
      const wanted = entries.filter(
        (e) => e === 'package.json' || /^lib\/.*\.(js|mjs|cjs|json)$/.test(e),
      );
      for (const relative of wanted) {
        const target = path.join(out, pkg, relative);
        if (!force && fs.existsSync(target)) continue;
        const buffer = source.read(`${root}@deepseek-ai/${pkg}/${relative}`);
        if (buffer === null) continue;
        writeFile(target, buffer);
        files += 1;
      }
    }

    return { files, missing, out };
  } finally {
    source.close();
  }
}

/**
 * 在已抽取的文档缓存里做一次朴素全文检索，省去调用方拼 ripgrep。
 */
export function searchDocs({ out, term, limit = 40 }) {
  const hits = [];
  const needle = term.toLowerCase();
  const stack = [out];
  while (stack.length > 0 && hits.length < limit) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.md') || entry.name === 'INDEX.txt') continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({
            package: path.basename(path.dirname(full)),
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
          });
        }
      }
    }
  }
  return hits;
}
