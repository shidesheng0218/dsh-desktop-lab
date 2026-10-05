/**
 * `dsh-devkit scaffold`：从模板生成一个可安装的插件包。
 *
 * 模板不是示意，而是照抄官方 shipped 代码验证过的形态：
 * 两段式 slot 注册（sidebar.panellist + main）、/api/ 下的 exact Fetch 路由、
 * 零依赖 ESM、`dsh.bundle.patch` + `dsh.client` 双半声明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.resolve(HERE, '..', 'templates');

/** 包名必须是合法的 npm 作用域名；行 id 与面板 id 只用小写字母数字与连字符。 */
export function validateNames({ name, panelId, rowId }) {
  const problems = [];
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    problems.push(`包名 ${name} 不是合法的 npm 名称（小写字母/数字/._-，可带 @scope/ 前缀）`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(panelId)) {
    problems.push(`面板 id ${panelId} 只允许小写字母、数字与连字符，且以字母开头`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(rowId)) {
    problems.push(`行 id ${rowId} 只允许小写字母、数字与连字符，且以字母开头`);
  }
  return problems;
}

function substitute(text, tokens) {
  return text.replace(/__([A-Z_]+)__/g, (whole, key) =>
    Object.hasOwn(tokens, key) ? tokens[key] : whole,
  );
}

/**
 * @param {object} options
 * @param {string} options.dir 目标目录
 * @param {string} options.name 包名
 * @param {string} [options.template] 模板名
 * @param {string} [options.title] 展示标题
 * @param {string} [options.description] 展示描述
 * @param {string} [options.panelId] 面板 id，默认由包名推导
 * @param {string} [options.rowId] 补丁行 id，默认与 panelId 相同
 * @param {boolean} [options.force]
 */
export function scaffold(options) {
  const template = options.template ?? 'host-client-panel';
  const source = path.join(TEMPLATES_DIR, template);
  if (!fs.existsSync(source)) {
    throw new Error(`模板 ${template} 不存在。可用：${fs.readdirSync(TEMPLATES_DIR).join(', ')}`);
  }

  // 包名去掉 scope 后作为默认 id，保证 id 合法。
  const bare = options.name.replace(/^@[^/]+\//, '');
  const panelId = options.panelId ?? bare.replace(/^dsh-/, '').replace(/[^a-z0-9-]/g, '-');
  const rowId = options.rowId ?? panelId;
  const title = options.title ?? bare;
  const description = options.description ?? `${title} — DSH 桌面版插件`;

  const problems = validateNames({ name: options.name, panelId, rowId });
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const tokens = {
    PACKAGE_NAME: options.name,
    TITLE: title,
    DESCRIPTION: description,
    PANEL_ID: panelId,
    ROW_ID: rowId,
  };

  const target = path.resolve(options.dir);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && options.force !== true) {
    throw new Error(`目标目录 ${target} 非空。加 --force 覆盖已有文件。`);
  }

  const written = [];
  (function copy(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const childFrom = path.join(from, entry.name);
      // 模板内文件名不含占位符，直接沿用。
      const childTo = path.join(to, entry.name);
      if (entry.isDirectory()) {
        copy(childFrom, childTo);
        continue;
      }
      const content = substitute(fs.readFileSync(childFrom, 'utf8'), tokens);
      fs.writeFileSync(childTo, content);
      written.push(path.relative(target, childTo));
    }
  })(source, target);

  return { target, written: written.sort(), panelId, rowId };
}
