/**
 * devkit 校验器的回归测试。
 *
 * 重点不是「干净的包能通过」（那只说明检查没崩），而是「每一类已知的装机失败
 * 都能在装机之前被这条命令抓到」。每个用例都构造一个真实会失败的包。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkPackage, countCjkStringLiterals, lintPatch } from '../lib/check.mjs';
import { scaffold } from '../lib/scaffold.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-test-'));
}

/** 用真实模板生成一个干净包，作为「基准通过」的对照。 */
function makeCleanPackage() {
  const dir = path.join(makeTempDir(), 'pkg');
  scaffold({ dir, name: '@local/clean-panel', title: 'Clean' });
  return dir;
}

function codes(findings) {
  return findings.map((f) => f.code);
}

test('模板生成的包必须零错误零警告通过校验', () => {
  const dir = makeCleanPackage();
  const { findings, summary } = checkPackage(dir);
  assert.deepEqual(findings, []);
  assert.equal(summary.hasBundle, true);
  assert.equal(summary.hasClient, true);
  assert.equal(summary.dependencies, 0);
  assert.deepEqual(summary.patchRows, ['clean-panel']);
});

test('缺少 bundle patch 会被判为错误（GUI 会直接拒绝这种包）', () => {
  const dir = makeCleanPackage();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete manifest.dsh.bundle;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('bundle.no-patch'));
});

test('补丁行缺少 name 会被抓到', () => {
  const { findings, rows } = lintPatch(['- insert:', '    - id: orphan'].join('\n'));
  assert.ok(codes(findings).includes('patch.row-missing-name'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, undefined);
});

test('YAML 用制表符缩进会被抓到（Loader 会解析失败）', () => {
  const { findings } = lintPatch(['- insert:', '\t- id: x', "\t  name: '@local/x'"].join('\n'));
  assert.ok(codes(findings).includes('patch.tab-indent'));
});

test('patch 顶层不是数组会被抓到', () => {
  const { findings } = lintPatch('insert:\n  - id: x\n');
  assert.ok(codes(findings).includes('patch.not-a-list'));
});

test('client bundle 的工厂 id 与包名不一致会被抓到', () => {
  const dir = makeCleanPackage();
  const clientPath = path.join(dir, 'client.js');
  const text = fs.readFileSync(clientPath, 'utf8').replace("id: '@local/clean-panel'", "id: '@local/renamed'");
  fs.writeFileSync(clientPath, text);
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('client.id-mismatch'));
});

test('client bundle 漏掉 __ModuleLoader__ 会被抓到', () => {
  const dir = makeCleanPackage();
  fs.writeFileSync(path.join(dir, 'client.js'), 'export const nothing = 1;\n');
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('client.no-module-loader'));
});

test('client bundle import Harness 客户端包会被抓到（官方明令禁止）', () => {
  const dir = makeCleanPackage();
  const clientPath = path.join(dir, 'client.js');
  fs.appendFileSync(
    clientPath,
    "\nconst primitives = require('@deepseek-ai/dsh-client-ui-primitives');\n",
  );
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('client.forbidden-require'));
});

test('JS 语法错误会被抓到', () => {
  const dir = makeCleanPackage();
  fs.writeFileSync(path.join(dir, 'broken.js'), 'export function apply( { \n');
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('syntax.invalid'), JSON.stringify(findings, null, 2));
});

test('locale 两种语言键不一致会被抓到', () => {
  const dir = makeCleanPackage();
  fs.writeFileSync(path.join(dir, 'locale/zh.json'), JSON.stringify({ panel: '面板', extra: '多余' }));
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('locale.key-mismatch'));
});

test('图标越界（绝对路径 / ..）会被抓到', () => {
  const dir = makeCleanPackage();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.icon = '../outside.svg';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('icon.outside'));
});

test('声明了 client 却没有 exports["./client"] 会被抓到', () => {
  const dir = makeCleanPackage();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete manifest.exports['./client'];
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('client.no-export'));
});

test('缺失 package.json 直接报错而不是抛异常', () => {
  const { findings } = checkPackage(makeTempDir());
  assert.deepEqual(codes(findings), ['manifest.missing']);
});

/* ------------------------------------------ 界面文案本地化（启发式规则） */

test('client bundle 有中文文案却不注册 locale 时给出警告', () => {
  const dir = makeCleanPackage();
  const clientPath = path.join(dir, 'client.js');
  // 既有中文文案、又从不调用 locale.register —— 正是「界面文案写死」的形态
  fs.writeFileSync(
    clientPath,
    [
      "window.__ModuleLoader__.load({",
      "  id: '@local/clean-panel',",
      "  factory(require) {",
      "    return { inject: ['slots'], apply(ctx) { ctx.slots.register({ name: 'main', key: 'x' }, () => '标题'); } };",
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  const { findings } = checkPackage(dir);
  assert.ok(codes(findings).includes('client.hardcoded-copy'), JSON.stringify(findings, null, 2));
});

test('调用过 locale.register 的 client bundle 不触发该警告', () => {
  const dir = makeCleanPackage();
  const clientPath = path.join(dir, 'client.js');
  fs.writeFileSync(
    clientPath,
    [
      "window.__ModuleLoader__.load({",
      "  id: '@local/clean-panel',",
      "  factory(require) {",
      "    return { inject: ['slots'], apply(ctx) {",
      "      ctx.effect(() => ctx.locale.register('ns', { zh: { a: '标题' }, en: { a: 'Title' } }));",
      "      ctx.slots.register({ name: 'main', key: 'x' }, () => '标题');",
      '    } };',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  const { findings } = checkPackage(dir);
  assert.ok(!codes(findings).includes('client.hardcoded-copy'), JSON.stringify(findings, null, 2));
});

test('统计中文字面量时会跳过注释，避免把中文注释当成文案', () => {
  const withComments = [
    '// 这是一段中文注释，不应被计入',
    '/* 另一段中文注释 */',
    "const label = '保存';",
    '',
  ].join('\n');
  assert.equal(countCjkStringLiterals(withComments), 1);
  assert.equal(countCjkStringLiterals("const a = 'Save';"), 0);
});

test('scaffold 按上下文转义标题与描述，生成包零错误零警告', () => {
  const title = 'Alice\'s "Panel"\nBeta';
  const description = '同时包含 "双引号" 与 \'单引号\'\n下一行';
  const dir = path.join(makeTempDir(), 'pkg');
  scaffold({ dir, name: '@local/escaped-panel', title, description });

  let manifest;
  assert.doesNotThrow(() => {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  });
  assert.equal(manifest.meta.title, title);
  assert.equal(manifest.meta.description, description);
  assert.equal(manifest.description, description);
  assert.deepEqual(checkPackage(dir).findings, []);
});

for (const [label, statement] of [
  ['静态 import', "import primitives from '@deepseek-ai/dsh-client-ui-primitives';\n"],
  ['动态 import', "await import('@deepseek-ai/dsh-client-ui-primitives');\n"],
  ['re-export', "export { primitives } from '@deepseek-ai/dsh-client-ui-primitives';\n"],
]) {
  test(`client bundle 的${label}也会被禁用模块规则抓到`, () => {
    const dir = makeCleanPackage();
    fs.appendFileSync(path.join(dir, 'client.js'), `\n${statement}`);
    const { findings } = checkPackage(dir);
    assert.ok(codes(findings).includes('client.forbidden-require'), JSON.stringify(findings, null, 2));
  });
}
