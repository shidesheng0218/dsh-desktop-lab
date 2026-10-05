#!/usr/bin/env node
/**
 * dsh-devkit —— 为 DeepSeek Harness 桌面版开发插件的工具链。
 *
 *   docs             抽取全部官方包 README 到本地缓存
 *   source <pkg...>  抽取指定官方包已构建的 lib/ 源码
 *   search <term>    在已抽取文档里检索
 *   where            打印解析到的 DSH 安装位置与发行版本
 *   scaffold <dir>   从模板生成插件包
 *   check <dir>      校验插件包（装机前把所有静态问题找出来）
 *   install <dir>    打印 GUI 安装指引
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInstall, resolveInstall } from '../lib/install.mjs';
import { extractDocs, extractSource, searchDocs } from '../lib/extract.mjs';
import { scaffold } from '../lib/scaffold.mjs';
import { checkPackage } from '../lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DEFAULT_CACHE = path.join(REPO_ROOT, '.cache', 'dsh-official');

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        i += 1;
      }
    } else {
      options._.push(token);
    }
  }
  return options;
}

function bold(text) {
  return `\u001b[1m${text}\u001b[0m`;
}
function dim(text) {
  return `\u001b[2m${text}\u001b[0m`;
}
function red(text) {
  return `\u001b[31m${text}\u001b[0m`;
}
function yellow(text) {
  return `\u001b[33m${text}\u001b[0m`;
}
function green(text) {
  return `\u001b[32m${text}\u001b[0m`;
}

function readVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return manifest.version ?? '0.0.0';
}

function usage() {
  process.stdout.write(
    [
      bold('dsh-devkit') + dim(` v${readVersion()} — DSH 桌面版插件工具链`),
      '',
      bold('用法'),
      '  dsh-devkit <命令> [参数]',
      '',
      bold('命令'),
      '  docs              抽取全部官方包 README 到缓存',
      '  source <pkg...>   抽取指定官方包已构建的 lib/ 源码',
      '  search <关键词>   在已抽取文档里检索',
      '  where             打印 DSH 安装位置与发行版本',
      '  scaffold <目录>   从模板生成插件包',
      '  check <目录>      校验插件包',
      '  install <目录>    打印 GUI 安装指引',
      '',
      bold('公共选项'),
      '  --app <路径>      app.asar 文件或 DSH 源码目录（默认 macOS 安装路径）',
      '  --out <目录>      缓存输出目录（默认 .cache/dsh-official）',
      '  --force           覆盖已存在的文件',
      '  --json            以 JSON 输出结果',
      '  --filter <文本>   docs 命令只抽取包名包含该文本的包',
      '',
      bold('scaffold 选项'),
      '  --name <包名>     必填，例如 @local/my-panel',
      '  --title <标题>    展示标题',
      '  --description <描述>',
      '  --panel-id <id>   面板 id，默认由包名推导',
      '  --row-id <id>     补丁行 id，默认与 panel-id 相同',
      '  --template <名>   默认 host-client-panel',
      '',
    ].join('\n'),
  );
}

function commandWhere(options) {
  const resolved = resolveInstall(options.app);
  const source = openInstall(options.app);
  let version;
  try {
    const raw = source.read('/package.json');
    if (raw !== null) version = JSON.parse(raw.toString('utf8')).version;
  } finally {
    source.close();
  }
  const result = { install: resolved, format: resolved.endsWith('.asar') ? 'asar' : 'directory', version };
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${bold('DSH 安装位置')}  ${resolved}\n`);
    process.stdout.write(`${bold('形态')}          ${result.format}\n`);
    process.stdout.write(`${bold('发行版本')}      ${version ?? dim('未知')}\n`);
  }
}

function commandDocs(options) {
  const out = path.resolve(options.out ?? DEFAULT_CACHE);
  const result = extractDocs({
    app: options.app,
    out,
    force: options.force === true,
    filter: typeof options.filter === 'string' ? options.filter : undefined,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${green('✓')} 抽取 ${result.packages} 个包的文档，写入 ${result.files} 个文件\n`);
    process.stdout.write(`  ${dim(result.out)}\n`);
    process.stdout.write(`  下一步：dsh-devkit search <关键词> 或直接用 ripgrep 检索该目录\n`);
  }
}

function commandSource(options) {
  const packages = options._.slice(1);
  if (packages.length === 0) {
    process.stderr.write(red('✗ 需要至少一个官方包名，例如：dsh-devkit source dsh-session-query\n'));
    process.exitCode = 1;
    return;
  }
  const out = path.resolve(options.out ?? DEFAULT_CACHE);
  const result = extractSource({ app: options.app, out, packages, force: options.force === true });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${green('✓')} 抽取 ${result.files} 个源文件到 ${result.out}\n`);
    for (const pkg of result.missing) {
      process.stderr.write(`${yellow('!')} 官方包里没有 ${pkg}\n`);
    }
  }
}

function commandSearch(options) {
  const term = options._.slice(1).join(' ');
  if (term === '') {
    process.stderr.write(red('✗ 需要检索关键词\n'));
    process.exitCode = 1;
    return;
  }
  const out = path.resolve(options.out ?? DEFAULT_CACHE);
  if (!fs.existsSync(out)) {
    process.stderr.write(red(`✗ 缓存目录不存在：${out}\n  先运行 dsh-devkit docs\n`));
    process.exitCode = 1;
    return;
  }
  const hits = searchDocs({ out, term });
  if (options.json) process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
  else if (hits.length === 0) process.stdout.write(`${yellow('没找到')} ${term}\n`);
  else {
    for (const hit of hits) {
      process.stdout.write(`${bold(hit.package)}:${hit.line}  ${hit.text}\n`);
    }
  }
}

function commandScaffold(options) {
  const dir = options._[1];
  const name = options.name;
  if (dir === undefined || typeof name !== 'string') {
    process.stderr.write(red('✗ 用法：dsh-devkit scaffold <目录> --name @local/my-panel\n'));
    process.exitCode = 1;
    return;
  }
  const result = scaffold({
    dir,
    name,
    title: typeof options.title === 'string' ? options.title : undefined,
    description: typeof options.description === 'string' ? options.description : undefined,
    panelId: typeof options['panel-id'] === 'string' ? options['panel-id'] : undefined,
    rowId: typeof options['row-id'] === 'string' ? options['row-id'] : undefined,
    template: typeof options.template === 'string' ? options.template : undefined,
    force: options.force === true,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${green('✓')} 生成 ${result.target}\n`);
    for (const file of result.written) process.stdout.write(`  ${file}\n`);
    process.stdout.write(`\n下一步：dsh-devkit check ${path.relative(process.cwd(), result.target)}\n`);
  }
}

function commandCheck(options) {
  const dir = options._[1];
  if (dir === undefined) {
    process.stderr.write(red('✗ 用法：dsh-devkit check <插件包目录>\n'));
    process.exitCode = 1;
    return;
  }
  const { findings, summary } = checkPackage(dir);
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${bold(summary.name ?? dir)} ${dim(`v${summary.version ?? '?'}`)}\n`);
    process.stdout.write(
      `  bundle patch: ${summary.hasBundle ? '✓' : '✗'}   client 半边: ${summary.hasClient ? '✓' : '✗'}   ` +
        `运行时依赖: ${summary.dependencies}   JS 文件: ${summary.fileCount ?? 0}\n`,
    );
    if (summary.patchRows?.length > 0) {
      process.stdout.write(`  补丁行: ${summary.patchRows.join(', ')}\n`);
    }
    process.stdout.write('\n');
    for (const finding of findings) {
      const tag = finding.level === 'error' ? red('错误') : yellow('警告');
      process.stdout.write(`  ${tag} ${dim(finding.code)}  ${finding.message}\n`);
    }
    if (findings.length === 0) process.stdout.write(`  ${green('没有发现问题')}\n`);
    process.stdout.write(
      `\n  ${errors.length} 个错误，${warnings.length} 个警告\n`,
    );
  }

  if (errors.length > 0) process.exitCode = 1;
}

function commandInstall(options) {
  const dir = options._[1];
  if (dir === undefined) {
    process.stderr.write(red('✗ 用法：dsh-devkit install <插件包目录>\n'));
    process.exitCode = 1;
    return;
  }
  const absolute = path.resolve(dir);
  const { findings } = checkPackage(absolute);
  const errors = findings.filter((f) => f.level === 'error');
  if (errors.length > 0) {
    process.stderr.write(red('✗ 先修掉校验错误再安装：\n'));
    for (const error of errors) process.stderr.write(`  ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(absolute, 'package.json'), 'utf8'));
  process.stdout.write(
    [
      bold('在 DSH 桌面版 GUI 里安装'),
      '',
      '  1. 打开左侧栏最下方的 Settings → 或直接在侧栏找到 Plugins（插件）入口',
      '  2. 点 Add plugin（添加插件）',
      `  3. 在输入框里粘贴这个绝对路径：`,
      '',
      `     ${absolute}`,
      '',
      '  4. 点 Install；装完会问 Enable now，选它',
      `  5. 侧栏会出现「${manifest.meta?.title ?? manifest.name}」的图标，点开即是面板`,
      '',
      dim('说明：Add plugin 接受「包名 / Git 地址 / tarball / 绝对本地路径」。'),
      dim('同一个包重新安装需要重启 DSH 才会加载新的 JS 模块代。'),
      '',
    ].join('\n'),
  );
}

const COMMANDS = {
  docs: commandDocs,
  source: commandSource,
  search: commandSearch,
  where: commandWhere,
  scaffold: commandScaffold,
  check: commandCheck,
  install: commandInstall,
};

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    usage();
    return;
  }
  const command = COMMANDS[argv[0]];
  if (command === undefined) {
    process.stderr.write(red(`✗ 未知命令：${argv[0]}\n\n`));
    usage();
    process.exitCode = 1;
    return;
  }
  try {
    command(parseArgs(argv));
  } catch (error) {
    process.stderr.write(`${red('✗')} ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();

