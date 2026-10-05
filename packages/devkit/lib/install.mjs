/**
 * 定位 DSH 安装位置。
 *
 * 优先级：
 *  1. `--app <path>` / `$DSH_APP_ASAR`：显式指定 asar 文件或源码目录
 *  2. macOS 默认安装路径 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
 *  3. 常见的源码 checkout（含 `packages/` 与 `apps/`）——供 DSH 仓库开发者使用
 *
 * 找不到时要明确报错并给出可操作的提示，而不是回退到某个猜出来的路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openAsar, openDirectory } from './asar.mjs';

const MACOS_DEFAULT = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

export const DEFAULT_MACOS_ASAR = MACOS_DEFAULT;

/**
 * @param {string|undefined} explicit 用户显式指定的路径
 * @returns {string} 解析出的绝对路径
 */
export function resolveInstall(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const fromEnv = process.env.DSH_APP_ASAR ?? process.env.DSH_DESKTOP_ASAR;
  if (fromEnv && !explicit) candidates.push(fromEnv);
  if (!explicit && !fromEnv) candidates.push(MACOS_DEFAULT);

  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (fs.existsSync(absolute)) return absolute;
  }

  throw new Error(
    [
      '找不到 DSH 安装位置。',
      `已尝试：${candidates.map((c) => `\n  - ${path.resolve(c)}`).join('')}`,
      '',
      '请用以下任一方式指定：',
      '  dsh-devkit <命令> --app "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"',
      '  DSH_APP_ASAR=/path/to/app.asar dsh-devkit <命令>',
      '',
      '若使用 DSH 源码 checkout，请把 --app 指向仓库根目录。',
    ].join('\n'),
  );
}

/**
 * 打开安装内容。asar 文件与普通目录都会自动识别。
 * @param {string|undefined} explicit
 */
export function openInstall(explicit) {
  const resolved = resolveInstall(explicit);
  const stat = fs.statSync(resolved);
  return stat.isDirectory() ? openDirectory(resolved) : openAsar(resolved);
}

/**
 * 判断某个 `@deepseek-ai/<pkg>/...` 相对路径在两种安装形态下的前缀。
 * 打包版是 `/dsh/node_modules/...`，源码 checkout 是 `/packages/<group>/<name>/...`，
 * 后者无法用统一前缀寻址，因此官方包文档提取只对打包版生效；
 * 源码 checkout 下会退回为扫描 `**\/README.md`。
 */
export function officialPackageRoot(source) {
  const probe = source.list().find((p) => p.includes('@deepseek-ai/'));
  if (probe === undefined) return null;
  const marker = probe.indexOf('@deepseek-ai/');
  return probe.slice(0, marker);
}
