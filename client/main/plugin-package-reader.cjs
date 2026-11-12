'use strict';

// A small, inert ZIP reader for personal plugin packages. It only extracts
// JSON/text metadata and resource bytes; it never executes package contents.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { MAX_PACKAGE_BYTES } = require('./plugin-package-limits.cjs');

const MAX_UNPACKED_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 300;

function safeName(raw) {
  const name = String(raw || '').replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:\//.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..' ||
        /[\x00-\x1f\x7f]/.test(part))) {
    throw new Error('插件包包含越界文件路径');
  }
  return name;
}

function readEntries(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!data.length || data.length > MAX_PACKAGE_BYTES) {
    throw new Error('插件包为空或超过 10MB');
  }
  const entries = new Map();
  let offset = 0;
  let unpacked = 0;
  while (offset + 30 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const size = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    if ((flags & 0x08) || (flags & 0x01) || ![0, 8].includes(method)) {
      throw new Error('插件包使用了不支持的压缩或加密方式');
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > data.length || size > MAX_UNPACKED_BYTES ||
        unpacked + size > MAX_UNPACKED_BYTES) {
      throw new Error('插件包解压后超过 30MB');
    }
    const name = safeName(data.subarray(nameStart, nameStart + nameLength).toString('utf8'));
    if (entries.has(name)) throw new Error('插件包包含重复文件路径');
    const compressed = data.subarray(dataStart, dataEnd);
    let bytes;
    try { bytes = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed); }
    catch (_) { throw new Error('插件包中的文件无法解压'); }
    if (bytes.length !== size) throw new Error('插件包文件大小校验失败：' + name);
    entries.set(name, bytes);
    unpacked += bytes.length;
    if (entries.size > MAX_FILES) throw new Error('插件包文件过多');
    offset = dataEnd;
  }
  if (!entries.size) throw new Error('插件包不是有效的 ZIP 压缩包');
  return entries;
}

function jsonEntry(entries, name) {
  const bytes = entries.get(name);
  if (!bytes) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
    return value;
  } catch (_) { throw new Error(name + ' 不是有效的 JSON 清单'); }
}

function resourceDraft(entries, manifest) {
  const rows = Array.isArray(manifest.resources) ? manifest.resources : [];
  return rows.map(raw => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const archivePath = item.archivePath ||
      ('skills/' + String(manifest.key || '') + '/' + String(item.path || ''));
    const bytes = entries.get(safeName(archivePath));
    if (!bytes) throw new Error('插件资源缺失：' + String(item.path || archivePath));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (item.sha256 && String(item.sha256).toLowerCase() !== sha256) {
      throw new Error('插件资源校验不一致：' + String(item.path || archivePath));
    }
    return {
      path: String(item.path || ''), kind: String(item.kind || 'asset'),
      encoding: 'base64', content: bytes.toString('base64'),
      sha256, size: bytes.length,
    };
  });
}

function readPersonalArchive(input) {
  const entries = readEntries(input);
  const manifest = jsonEntry(entries, 'plugin.json') || jsonEntry(entries, 'soduwork/plugin.json');
  if (!manifest) throw new Error('插件包缺少 plugin.json');
  const capabilities = manifest.capabilities && typeof manifest.capabilities === 'object'
    ? manifest.capabilities : {};
  const workflow = jsonEntry(entries, 'workflow.json') ||
    (manifest.workflow && typeof manifest.workflow === 'object' ? manifest.workflow : null);
  const evaluations = Array.isArray(manifest.evaluations) ? manifest.evaluations : [];
  const representative = evaluations[0] && typeof evaluations[0] === 'object' ? evaluations[0] : {};
  const mcpServers = manifest.mcpServers || capabilities.mcpServers || [];
  const runtime = manifest.runtimeCapabilities || manifest.runtime || capabilities.runtime || [];
  const skills = manifest.skills || capabilities.skills || [];
  const hasWorkflow = Boolean(workflow && Array.isArray(workflow.nodes) && workflow.nodes.length);
  const platformList = manifest.platforms || capabilities.platforms || [];
  const template = String(manifest.template || '').trim() ||
    (hasWorkflow ? 'workflow' : (mcpServers.length || platformList.length ? 'connector' : 'method'));
  const draft = {
    template, key: String(manifest.key || ''), name: String(manifest.name || ''),
    version: String(manifest.version || ''), author: String(manifest.author || ''),
    ...(manifest.appCategory != null ? {appCategory:require('../core/plugin-app-contract.cjs').category(manifest.appCategory)} : {}),
    description: String(manifest.description || ''), instructions: String(manifest.instructions || ''),
    inputs: Array.isArray(manifest.inputs) ? manifest.inputs : [],
    setup: manifest.setup && typeof manifest.setup === 'object' ? manifest.setup : {},
    ui: manifest.ui && typeof manifest.ui === 'object' ? manifest.ui : { contributions: [] },
    entrypoints: manifest.entrypoints && typeof manifest.entrypoints === 'object'
      ? manifest.entrypoints : undefined,
    skills: Array.isArray(skills) ? skills : [],
    mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
    runtimeCapabilities: Array.isArray(runtime) ? runtime : [],
    platforms: Array.isArray(platformList) ? platformList : [],
    evaluationInstruction: String(representative.instruction || ''),
    evaluationCriteria: Array.isArray(representative.criteria) ? representative.criteria : [],
    sourceKind: String(manifest.sourceKind || 'personal'),
    importChecksum: String(manifest.importChecksum || ''),
    importWarnings: Array.isArray(manifest.importWarnings) ? manifest.importWarnings : [],
    unsupportedComponents: Array.isArray(manifest.unsupportedComponents)
      ? manifest.unsupportedComponents : [],
    resources: resourceDraft(entries, manifest),
  };
  if (manifest.extensions != null) draft.extensions = require('../core/plugin-extensions.cjs').normalize(manifest.extensions);
  if (manifest.distribution) draft.distribution = String(manifest.distribution);
  if (manifest.locales != null) draft.locales = require('../core/plugin-locales').normalize(manifest.locales);
  if (manifest.sourcePluginId) draft.sourcePluginId = String(manifest.sourcePluginId);
  if (manifest.icon) draft.icon = manifest.icon;
  if (manifest.coverUrl) draft.coverUrl = require('../core/plugin-cover.cjs').normalize(manifest.coverUrl);
  if (manifest.appWindow != null) draft.appWindow = require('../core/app-window-sizing').normalize(manifest.appWindow);
  if (manifest.jiyong != null) draft.jiyong = require('../core/jiyong-contract.cjs').normalize(manifest.jiyong);
  if (hasWorkflow) draft.workflow = workflow;
  return draft;
}

module.exports = { readPersonalArchive, _readEntries: readEntries };
