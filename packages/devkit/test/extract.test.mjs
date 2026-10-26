import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractDocs, extractSource, searchDocs } from '../lib/extract.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-extract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    app: path.join(root, 'app'),
    out: path.join(root, 'out'),
    packageRoot: path.join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai'),
  };
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('docs 默认刷新变化内容并移除当前包内过期 README', (t) => {
  const { app, out, packageRoot } = workspace(t);
  const pkg = path.join(packageRoot, 'alpha');
  write(path.join(pkg, 'README.md'), '# alpha v1\n');
  write(path.join(pkg, 'README.zh.md'), '# 中文\n');
  extractDocs({ app, out });

  write(path.join(pkg, 'README.md'), '# alpha v2\n');
  fs.rmSync(path.join(pkg, 'README.zh.md'));
  extractDocs({ app, out });

  assert.equal(fs.readFileSync(path.join(out, 'alpha', 'README.md'), 'utf8'), '# alpha v2\n');
  assert.equal(fs.existsSync(path.join(out, 'alpha', 'README.zh.md')), false);
});

test('docs 搜索只遍历当前 INDEX 中的包，不返回已删除包的旧缓存', (t) => {
  const { app, out, packageRoot } = workspace(t);
  write(path.join(packageRoot, 'alpha', 'README.md'), '# alpha\n');
  write(path.join(packageRoot, 'beta', 'README.md'), '# unique needle\n');
  extractDocs({ app, out });
  assert.equal(searchDocs({ out, term: 'unique needle' }).length, 1);

  fs.rmSync(path.join(packageRoot, 'beta'), { recursive: true });
  extractDocs({ app, out });
  assert.deepEqual(searchDocs({ out, term: 'unique needle' }), []);
});

test('source 默认刷新变化内容并清理解包范围内过期源码', (t) => {
  const { app, out, packageRoot } = workspace(t);
  const pkg = path.join(packageRoot, 'alpha');
  write(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/alpha', version: '1.0.0' }));
  write(path.join(pkg, 'lib', 'index.js'), 'export const version = 1;\n');
  write(path.join(pkg, 'lib', 'old.js'), 'export const old = true;\n');
  extractSource({ app, out, packages: ['alpha'] });

  write(path.join(pkg, 'lib', 'index.js'), 'export const version = 2;\n');
  fs.rmSync(path.join(pkg, 'lib', 'old.js'));
  write(path.join(out, 'alpha', 'lib', 'keep.txt'), 'not generated\n');
  write(path.join(out, 'alpha', 'README.md'), 'docs must survive source extraction\n');
  extractSource({ app, out, packages: ['alpha'] });

  assert.equal(fs.readFileSync(path.join(out, 'alpha', 'lib', 'index.js'), 'utf8'), 'export const version = 2;\n');
  assert.equal(fs.existsSync(path.join(out, 'alpha', 'lib', 'old.js')), false);
  assert.equal(fs.existsSync(path.join(out, 'alpha', 'lib', 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(out, 'alpha', 'README.md')), true);
});
