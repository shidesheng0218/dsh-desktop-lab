/**
 * 读取 Electron app.asar 的最小实现。
 */
import fs from 'node:fs';
import path from 'node:path';

const HEADER_PICKLE_BYTES = 8;
const STRING_LENGTH_OFFSET = 4;
const STRING_BODY_OFFSET = 8;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;

function readExact(fd, buffer, position) {
  let read = 0;
  while (read < buffer.length) {
    const count = fs.readSync(fd, buffer, read, buffer.length - read, position + read);
    if (count === 0) throw new Error('asar 文件在读取时意外结束');
    read += count;
  }
}

function validSegment(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
    !name.includes('/') && !name.includes('\\');
}

function splitTarget(target) {
  if (typeof target !== 'string' || target.startsWith('/') || target.includes('\\')) return null;
  const parts = target.split('/');
  return parts.length > 0 && parts.every(validSegment) ? parts : null;
}

function validateTree(tree, archiveSize, dataOffset) {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) throw new Error('asar 目录树无效');
  const paths = [];
  const byPath = new Set();
  function walk(node, prefix, depth) {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error('asar 目录树深度或节点无效');
    }
    if (node.files === undefined) return;
    if (node.files === null || typeof node.files !== 'object' || Array.isArray(node.files)) throw new Error('asar files 节点无效');
    for (const [name, child] of Object.entries(node.files)) {
      if (!validSegment(name)) throw new Error(`asar 包含非法路径段: ${name}`);
      const next = prefix === '' ? name : `${prefix}/${name}`;
      if (byPath.has(next)) throw new Error(`asar 包含重复路径: ${next}`);
      byPath.add(next);
      if (child && typeof child === 'object' && child.files !== undefined) {
        walk(child, next, depth + 1);
      } else {
        if (child === null || typeof child !== 'object' || Array.isArray(child)) throw new Error(`asar 文件节点无效: ${next}`);
        const size = Number(child.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`asar 文件大小无效: ${next}`);
        if (child.offset !== undefined) {
          const offset = Number(child.offset);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > archiveSize - dataOffset || size > archiveSize - dataOffset - offset) {
            throw new Error(`asar 文件范围越界: ${next}`);
          }
        }
        paths.push(next);
      }
    }
  }
  walk(tree, '', 0);
  if (paths.length > MAX_ENTRIES) throw new Error(`asar 文件数量超过 ${MAX_ENTRIES} 限制`);
  return { paths, byPath };
}

export function openAsar(file) {
  const resolved = path.resolve(file);
  const archiveSize = fs.statSync(resolved).size;
  const fd = fs.openSync(resolved, 'r');
  try {
    if (archiveSize < HEADER_PICKLE_BYTES) throw new Error('asar 头部不完整');
    const head = Buffer.alloc(HEADER_PICKLE_BYTES);
    readExact(fd, head, 0);
    const headerSize = head.readUInt32LE(4);
    if (headerSize < STRING_BODY_OFFSET || headerSize > MAX_HEADER_BYTES || headerSize > archiveSize - HEADER_PICKLE_BYTES) {
      throw new Error('asar 头部大小无效');
    }
    const header = Buffer.alloc(headerSize);
    readExact(fd, header, HEADER_PICKLE_BYTES);
    const jsonLength = header.readUInt32LE(STRING_LENGTH_OFFSET);
    if (jsonLength > headerSize - STRING_BODY_OFFSET) throw new Error('asar JSON 头部长度越界');
    const tree = JSON.parse(header.toString('utf8', STRING_BODY_OFFSET, STRING_BODY_OFFSET + jsonLength));
    const dataOffset = HEADER_PICKLE_BYTES + headerSize;
    const { paths, byPath } = validateTree(tree, archiveSize, dataOffset);
    return {
      kind: 'asar', path: resolved, list: () => [...paths].sort(),
      read(target) {
        const parts = splitTarget(target);
        if (parts === null) return null;
        const node = lookup(tree, parts);
        if (node === null || node.files !== undefined || node.offset === undefined) return null;
        const buffer = Buffer.alloc(Number(node.size));
        if (buffer.length > 0) readExact(fd, buffer, dataOffset + Number(node.offset));
        return buffer;
      },
      close: () => fs.closeSync(fd),
      has: (target) => byPath.has(target),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function lookup(tree, parts) {
  let node = tree;
  for (const segment of parts) {
    if (!node.files || !Object.hasOwn(node.files, segment)) return null;
    node = node.files[segment];
  }
  return node;
}

export function openDirectory(dir) {
  const resolved = fs.realpathSync(dir);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`不是目录: ${dir}`);
  const paths = [];
  (function walk(current, prefix, depth) {
    if (depth > MAX_DEPTH) throw new Error('目录深度超过限制');
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`目录包含不支持的符号链接: ${full}`);
      const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (stat.isDirectory()) walk(full, next, depth + 1);
      else if (stat.isFile()) paths.push(next);
    }
  })(resolved, '', 0);
  const rootPrefix = `${resolved}${path.sep}`;
  return {
    kind: 'directory', path: resolved, list: () => [...paths].sort(),
    read(target) {
      const parts = splitTarget(target);
      if (parts === null) return null;
      const full = path.resolve(resolved, ...parts);
      if (full !== resolved && !full.startsWith(rootPrefix)) return null;
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return fs.readFileSync(full);
      } catch { return null; }
    },
    close: () => {}, has: (target) => paths.includes(target),
  };
}
