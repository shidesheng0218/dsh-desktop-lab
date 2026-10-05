/**
 * 读取 Electron app.asar 的最小实现。
 *
 * 为什么需要它：Desktop 版把整个 dsh 发行版打进 `app.asar` 这一个文件里，
 * 于是 `app.asar/dsh/node_modules/...` 这种路径在真实文件系统上根本不存在——
 * shell 的 `ls`/`cat`/`cp`、ripgrep（glob/grep 工具）、`node` 的 fs 全部读不到。
 * 官方技能文档明确说明了这一点。想读官方包的 README 或 `lib/index.js` 源码，
 * 就必须自己解析 asar 容器。
 *
 * 格式（已用真实文件验证）：
 *   [0,8)      pickle：uint32 载荷长度 + uint32 头长度
 *   [8,8+H)    头 pickle：uint32 字符串长度 + UTF-8 JSON 目录树
 *   [8+H, ...) 所有文件数据，目录树里的 `offset` 以此为基准
 * 注意头 pickle 里的字符串长度在偏移 4 而不是 0 —— 少看 4 字节会得到一段
 * 看起来像 JSON 的垃圾，正是本项目起步时踩过的坑。
 */
import fs from 'node:fs';
import path from 'node:path';

const HEADER_PICKLE_BYTES = 8;
const STRING_LENGTH_OFFSET = 4;
const STRING_BODY_OFFSET = 8;

/**
 * 打开一个 asar 归档。
 * @param {string} file asar 文件绝对路径
 * @returns {{kind:'asar', path:string, list:()=>string[], read:(p:string)=>Buffer|null}}
 */
export function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(HEADER_PICKLE_BYTES);
  fs.readSync(fd, head, 0, HEADER_PICKLE_BYTES, 0);
  const headerSize = head.readUInt32LE(4);
  const header = Buffer.alloc(headerSize);
  fs.readSync(fd, header, 0, headerSize, HEADER_PICKLE_BYTES);
  const jsonLength = header.readUInt32LE(STRING_LENGTH_OFFSET);
  const tree = JSON.parse(
    header.toString('utf8', STRING_BODY_OFFSET, STRING_BODY_OFFSET + jsonLength),
  );
  const dataOffset = HEADER_PICKLE_BYTES + headerSize;

  const paths = [];
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const next = `${prefix}/${name}`;
      if (child.files) walk(child, next);
      else paths.push(next);
    }
  })(tree, '');

  const byPath = new Set(paths);

  return {
    kind: 'asar',
    path: file,
    list: () => [...paths].sort(),
    read(target) {
      const node = lookup(tree, target);
      if (node === null || node.files) return null;
      // 原生模块等文件被 asar 排除在主归档外（放在 app.asar.unpacked/），
      // 它们的目录项没有 offset；这类文件本工具不处理。
      if (node.offset === undefined) return null;
      const buffer = Buffer.alloc(node.size);
      if (node.size > 0) {
        fs.readSync(fd, buffer, 0, node.size, dataOffset + Number(node.offset));
      }
      return buffer;
    },
    close: () => fs.closeSync(fd),
    has: (target) => byPath.has(target),
  };
}

function lookup(tree, target) {
  let node = tree;
  for (const segment of target.split('/').filter(Boolean)) {
    if (!node.files || !node.files[segment]) return null;
    node = node.files[segment];
  }
  return node;
}

/**
 * 把一个普通目录包装成与 asar 相同的接口，让命令对
 * “打包的 Desktop 版”和“DSH 源码 checkout”两种情况用同一套代码。
 * @param {string} dir 目录绝对路径
 */
export function openDirectory(dir) {
  const paths = [];
  (function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), next);
      else if (entry.isFile()) paths.push(next);
    }
  })(dir, '');

  return {
    kind: 'directory',
    path: dir,
    list: () => [...paths].sort(),
    read(target) {
      const full = path.join(dir, target);
      if (!full.startsWith(path.resolve(dir))) return null;
      try {
        return fs.readFileSync(full);
      } catch {
        return null;
      }
    },
    close: () => {},
    has: (target) => paths.includes(target),
  };
}
