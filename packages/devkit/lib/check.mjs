/**
 * `dsh-devkit check`：在把插件包交给 GUI 安装之前，把能静态发现的问题全部找出来。
 *
 * 为什么需要它：桌面版安装 bundle 的失败反馈很晚（pnpm 装完、Loader 组合时才知道），
 * 而插件生态的几条硬规矩（client 半不得 import Harness 客户端包、client bundle 的
 * 工厂 id 必须等于包名、bundle 必须带 patch）散落在官方各篇文档里。这里把它们
 * 收敛成一条命令。
 *
 * 诚实边界：这不是 YAML 解析器，patch 检查是面向 Loader 补丁子集的结构化 lint；
 * `node --check` 只验证语法，不解析 import，也不执行任何插件代码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const ICON_MAX_BYTES = 256 * 1024;

/** 官方文档明令禁止：客户端 bundle 不得把 Harness 客户端包当模块加载。 */
const FORBIDDEN_CLIENT_REQUIRE = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*|\bimport\s*)['"]@deepseek-ai\/dsh-client-[^'"]*['"]/;

/**
 * 对 Loader 补丁做结构化检查。
 * 只覆盖插件作者会用到的子集：顶层数组 + `insert:` + 每行 `id` / `name`。
 * @param {string} text patch 文件内容
 */
export function lintPatch(text) {
  const findings = [];
  const lines = text.split('\n');
  const rows = [];
  let seenArrayItem = false;

  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const lineNumber = index + 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;

    if (/^\t/.test(line)) {
      findings.push({
        level: 'error',
        code: 'patch.tab-indent',
        message: `第 ${lineNumber} 行用制表符缩进；YAML 不允许制表符缩进，Loader 会解析失败`,
      });
    }

    if (/^-\s/.test(line)) {
      seenArrayItem = true;
      if (/^-\s+insert:\s*$/.test(line) === false && /^-\s+id:\s*\S/.test(line) === false) {
        findings.push({
          level: 'warn',
          code: 'patch.unknown-entry',
          message: `第 ${lineNumber} 行是顶层数组项，但既不是 insert 也不是按 id 定目标：${line.trim().slice(0, 60)}`,
        });
      }
      return;
    }

    const idMatch = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idMatch !== null) {
      rows.push({ id: idMatch[1], line: lineNumber, name: undefined });
      return;
    }
    const nameMatch = /^\s+name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch !== null && rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last.name === undefined) {
        last.name = nameMatch[1];
        if (!/^['"]/.test(nameMatch[1])) {
          findings.push({
            level: 'warn',
            code: 'patch.unquoted-name',
            message: `第 ${lineNumber} 行的 name 未加引号（${nameMatch[1]}）；含 @ / 的包名建议始终加引号`,
          });
        }
      }
    }
  });

  if (!seenArrayItem) {
    findings.push({
      level: 'error',
      code: 'patch.not-a-list',
      message: 'patch 顶层不是 YAML 数组；Loader 补丁必须是「顶层数组」形式',
    });
  }

  for (const row of rows) {
    if (row.name === undefined) {
      findings.push({
        level: 'error',
        code: 'patch.row-missing-name',
        message: `第 ${row.line} 行插入的行有 id 但没有 name；name 是插件包说明符，缺失会导致该行无法加载`,
      });
    }
  }

  if (rows.length === 0 && seenArrayItem) {
    findings.push({
      level: 'warn',
      code: 'patch.no-rows',
      message: 'patch 里没有找到任何 insert 行；这个 bundle 不会带来新插件',
    });
  }

  return { findings, rows };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 用 node --check 校验语法：复制成 .mjs 后检查，避免受 CJS/ESM 判定影响。 */
function checkSyntax(file, tempDir) {
  const target = path.join(tempDir, `${path.basename(file)}.mjs`);
  fs.copyFileSync(file, target);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    return null;
  } catch (error) {
    const detail = (error.stderr?.toString() ?? error.message).trim().split('\n').slice(0, 4).join(' ');
    return detail;
  }
}

function resolveManifestPath(root, value, field) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`${field} 必须是包目录内的相对路径`);
  }
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${field} 路径越界：${value}`);
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${field} 不能经过符号链接：${value}`);
    }
  }
  return target;
}

function collectJs(dir, base, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, base, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * 校验一个插件包目录。
 * @param {string} dir 包目录
 * @returns {{findings:Array, summary:object}}
 */
export function checkPackage(dir) {
  const findings = [];
  const push = (level, code, message) => findings.push({ level, code, message });
  const root = path.resolve(dir);

  const manifestPath = path.join(root, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      findings: [{ level: 'error', code: 'manifest.missing', message: '缺少 package.json' }],
      summary: {},
    };
  }

  const manifest = readJson(manifestPath);
  const summary = {
    name: manifest.name,
    version: manifest.version,
    hasBundle: manifest.dsh?.bundle?.patch !== undefined,
    hasClient: manifest.dsh?.client !== undefined,
    dependencies: Object.keys(manifest.dependencies ?? {}).length,
  };

  if (manifest.name === undefined) push('error', 'manifest.no-name', 'package.json 缺少 name');
  if (manifest.version === undefined) push('error', 'manifest.no-version', 'package.json 缺少 version');

  const jsFiles = collectJs(root, root);
  if (jsFiles.length > 0 && manifest.type !== 'module') {
    push(
      'warn',
      'manifest.not-esm',
      `包内有 ${jsFiles.length} 个 .js 文件但没有 "type": "module"；官方插件包全部是 ESM`,
    );
  }

  if (summary.dependencies > 0) {
    push(
      'warn',
      'manifest.has-dependencies',
      `声明了 ${summary.dependencies} 个运行时依赖；零依赖的包才能离线安装，且不受 npm 源影响`,
    );
  }

  // ---- bundle patch ----
  if (summary.hasBundle) {
    const patchRelative = manifest.dsh.bundle.patch;
    let patchPath;
    try {
      patchPath = resolveManifestPath(root, patchRelative, 'dsh.bundle.patch');
    } catch (error) {
      push('error', 'bundle.patch-outside', error.message);
    }
    if (patchPath === undefined || !fs.existsSync(patchPath)) {
      if (patchPath !== undefined) push('error', 'bundle.patch-missing', `dsh.bundle.patch 指向 ${patchRelative}，但文件不存在`);
    } else {
      const { findings: patchFindings, rows } = lintPatch(fs.readFileSync(patchPath, 'utf8'));
      findings.push(...patchFindings);
      summary.patchRows = rows.map((r) => r.id);
      for (const row of rows) {
        if (row.name === undefined) continue;
        // 行里指向本包的 name 必须与 package.json 的 name 完全一致，
        // 否则安装后 Loader 会去别处找这个模块。
        if (row.name.replace(/^['"]|['"]$/g, '') === manifest.name) continue;
        if (row.name.includes('@deepseek-ai/')) continue; // 指向随 dsh 发行的包，允许
        push(
          'warn',
          'bundle.row-name-foreign',
          `patch 行 ${row.id} 指向 ${row.name}，既不是本包名也不是官方包；请确认这是刻意为之`,
        );
      }
    }
  } else {
    push(
      'error',
      'bundle.no-patch',
      '没有 dsh.bundle.patch。GUI 的 Add plugin 会直接拒绝：它只管理带 bundle patch 的包',
    );
  }

  // ---- client half ----
  if (summary.hasClient) {
    const clientSpec = manifest.dsh.client;
    const exportPath = manifest.exports?.['./client'];
    if (exportPath === undefined) {
      push('error', 'client.no-export', '声明了 dsh.client，但 exports 里没有 "./client" 入口');
    }
    const clientFiles = [exportPath, clientSpec.entry].filter((v) => typeof v === 'string');
    for (const relative of clientFiles) {
      let clientPath;
      try {
        clientPath = resolveManifestPath(root, relative, 'client entry');
      } catch (error) {
        push('error', 'client.entry-outside', error.message);
        continue;
      }
      if (!fs.existsSync(clientPath)) {
        push('error', 'client.entry-missing', `client 入口 ${relative} 不存在`);
        continue;
      }
      const text = fs.readFileSync(clientPath, 'utf8');
      if (!text.includes('__ModuleLoader__')) {
        push(
          'error',
          'client.no-module-loader',
          `${relative} 没有调用 window.__ModuleLoader__.load(...)；这是浏览器端唯一的注册入口`,
        );
      }
      if (manifest.name !== undefined) {
        const factoryId = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?\bid\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
        if (factoryId !== manifest.name) {
          push(
            'error',
            'client.id-mismatch',
            `${relative} 的工厂 id 是 ${factoryId ?? '缺失'}，但包名是 ${manifest.name}；两者必须一致`,
          );
        }
      }
      if (FORBIDDEN_CLIENT_REQUIRE.test(text)) {
        push(
          'error',
          'client.forbidden-require',
          `${relative} require/import 了 @deepseek-ai/dsh-client-* 包。官方明确禁止：这些包随时会变，且抛出异常会直接让整个 slot 空白`,
        );
      }
      if (/\bdocument\.body\b/.test(text)) {
        push(
          'warn',
          'client.document-body',
          `${relative} 触碰了 document.body；插件应当只在自己的 slot 内渲染`,
        );
      }
      // 官方文档要求 "Route visible UI text through the Client locale service"。
      // 这条规则是启发式的：一个既有 CJK 文案、又从不注册 locale 命名空间的
      // 客户端 bundle，几乎可以肯定把界面文案写死了。误报只是警告，代价可接受。
      const cjkLiterals = countCjkStringLiterals(text);
      if (cjkLiterals > 0 && !/locale\s*\.\s*register\s*\(/.test(text)) {
        push(
          'warn',
          'client.hardcoded-copy',
          `${relative} 里有 ${cjkLiterals} 处含中文的字符串字面量，但没有调用 locale.register()。` +
            '界面文案应走 ctx.locale（官方要求），否则英文界面下会显示中文',
        );
      }
    }
    const platform = clientSpec.platform;
    if (platform !== undefined && platform !== 'web') {
      push('warn', 'client.platform', `dsh.client.platform 是 "${platform}"，桌面 GUI 需要 "web"`);
    }
  }

  // ---- 图标与展示元数据 ----
    if (manifest.icon !== undefined) {
      // 边界检查必须排在存在性检查之前：越界路径同时也是「不存在的路径」，
      // 先报缺失会把真正的问题（宿主会拒绝这个包）掩盖成一个小笔误。
      const outside =
        /^([/\\]|[a-zA-Z]:)/.test(manifest.icon) || manifest.icon.split(/[/\\]/).includes('..');
      if (outside) {
        push('error', 'icon.outside', 'icon 必须是包目录内的相对路径，不能是绝对路径或包含 ..');
      } else {
        let iconPath;
        try {
          iconPath = resolveManifestPath(root, manifest.icon, 'icon');
        } catch (error) {
          push('error', 'icon.outside', error.message);
        }
        if (iconPath !== undefined && !fs.existsSync(iconPath)) {
          push('error', 'icon.missing', `manifest 声明 icon: ${manifest.icon}，但文件不存在`);
        } else if (iconPath !== undefined) {
          const stat = fs.statSync(iconPath);
        if (stat.size > ICON_MAX_BYTES) {
          push('error', 'icon.too-large', `图标 ${stat.size} 字节，超过 256 KiB 上限`);
        }
        if (!ICON_EXTENSIONS.has(path.extname(iconPath).toLowerCase())) {
          push('warn', 'icon.format', `图标扩展名 ${path.extname(iconPath)} 不在 SVG/PNG/JPEG/WebP 之内`);
        }
      }
    }
  }

  // ---- 语言包 ----
  const localeDir = path.join(root, 'locale');
  if (fs.existsSync(localeDir)) {
    const files = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    const keySets = new Map();
    for (const file of files) {
      try {
        const data = readJson(path.join(localeDir, file));
        keySets.set(file, flattenKeys(data).sort().join('\n'));
      } catch (error) {
        push('error', 'locale.invalid', `locale/${file} 不是合法 JSON：${error.message}`);
      }
    }
    const entries = [...keySets.entries()];
    if (entries.length > 1) {
      const [, reference] = entries[0];
      for (const [file, keys] of entries.slice(1)) {
        if (keys !== reference) {
          push(
            'warn',
            'locale.key-mismatch',
            `locale/${file} 的键与 locale/${entries[0][0]} 不一致；缺键会退回英文或显示原始键名`,
          );
        }
      }
    }
    if (files.length > 0 && entries.length > 0) {
      const hasZh = files.includes('zh.json');
      const hasEn = files.includes('en.json');
      if (!hasZh || !hasEn) {
        push('warn', 'locale.incomplete', '官方展示元数据约定同时提供 locale/en.json 与 locale/zh.json');
      }
    }
  }

  // ---- 语法 ----
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devkit-check-'));
  try {
    for (const relative of jsFiles) {
      const failure = checkSyntax(path.join(root, relative), tempDir);
      if (failure !== null) {
        push('error', 'syntax.invalid', `${relative} 语法错误：${failure}`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  summary.fileCount = jsFiles.length;
  return { findings, summary };
}

function flattenKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/** 中日韩统一表意文字 + 假名 + 谚文。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/**
 * 统计含中日韩字符的字符串字面量数量（启发式）。
 *
 * 先尽量剥掉注释，避免把中文注释算成文案。完整解析 JS 需要真正的 parser，
 * 这里只服务于一条警告级规则，所以容忍粗糙：宁可偶尔漏报，也不要为了
 * 精准而引入一个会在正常代码上报错的解析器。
 * @param {string} text 文件内容
 */
export function countCjkStringLiterals(text) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  let count = 0;
  for (const match of withoutComments.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) {
    if (CJK_PATTERN.test(match[0])) count += 1;
  }
  return count;
}
