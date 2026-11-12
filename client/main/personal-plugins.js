/* Personal plugins live on this device. Publishing is a separate, explicit Hub action. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pluginWorkflow = require('./personal-plugin-workflow');
const pluginResources = require('./plugin-resources');
const sourceAccess = require('./plugin-source-access');
const { readPersonalArchive } = require('./plugin-package-reader.cjs');
const pluginPlatforms = require('../core/plugin-platforms');
const schema = require('./personal-plugin-schema.cjs');
const { KEY, VERSION } = schema;
const { normalizeBody, normalizeInstallSetup, slug } = schema.create({
  pluginWorkflow, pluginResources, pluginPlatforms,
});

const SCHEMA = 1;
const MAX_PLUGINS = 200;
const MAX_VERSIONS = 30;
const BUILDER_ID = 'local:plugin-builder';
const APP_DEVELOPER_ID = 'local:app-developer';
const SKILL_STUDIO_ID = 'local:skill-studio';
const skillStudio = require('./skill-studio-plugin');
const mcpStudio = require('./mcp-studio-plugin');
const MCP_STUDIO_ID = 'local:mcp-studio';
const PRODUCT_INCUBATOR_ID = 'local:product-incubator';
const productIncubator = require('./product-incubator-plugin');
// These services are implemented by SoduWork itself. They are declared in a
// plugin so the runtime can grant the capability, but are not user-managed
// connections and must not put a local plugin into a misleading "needs
// binding" state.
const VIRTUAL_MCP_SERVERS = new Set(['soduwork-media']);
const SIGNATURE_SCHEMA = 'soduwork.plugin-signature/v1';
const SIGNATURE_ALGORITHM = 'Ed25519';
const PUBLISHER_SCHEMA = 1;
const SIGNING_FIELDS = [
  'algorithm', 'contentChecksum', 'keyId', 'pluginKey', 'schema', 'signedAt', 'version',
];
let _safeStorage = null;

function text(value, limit) { return String(value == null ? '' : value).trim().slice(0, limit); }
function now() { return new Date().toISOString(); }
function hasInteractiveUi(value) {
  return Boolean(value && Array.isArray(value.contributions) && value.contributions.length);
}
function file(app) { return path.join(app.getPath('userData'), 'personal-plugins.json'); }
function publisherFile(app) { return path.join(app.getPath('userData'), 'plugin-publisher-identity.json'); }

function secureStoreAvailable() {
  if (!_safeStorage || !_safeStorage.isEncryptionAvailable()) return false;
  try {
    return process.platform !== 'linux' || _safeStorage.getSelectedStorageBackend() !== 'basic_text' ||
      process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE === '1';
  } catch (_) { return true; }
}

function writePublisher(app, row) {
  const target = publisherFile(app), temp = target + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(row, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(temp, target); }
  catch (error) {
    try { fs.copyFileSync(temp, target); fs.unlinkSync(temp); } catch (_) { throw error; }
  }
  try { fs.chmodSync(target, 0o600); } catch (_) { /* Windows follows the user profile ACL. */ }
}

function validPublisher(row) {
  if (!row || row.schemaVersion !== PUBLISHER_SCHEMA || !row.privateKeyCipher) return null;
  const publicRaw = Buffer.from(String(row.publicKey || ''), 'base64');
  const fingerprint = crypto.createHash('sha256').update(publicRaw).digest('hex');
  if (publicRaw.length !== 32 || fingerprint !== row.fingerprint ||
      !/^soduwork\.[a-f0-9]{24}$/.test(String(row.keyId || ''))) return null;
  return row;
}

function readPublisher(app) {
  const target = publisherFile(app);
  if (!fs.existsSync(target)) return null;
  try {
    const row = validPublisher(JSON.parse(fs.readFileSync(target, 'utf8')));
    if (row) return row;
  } catch (_) { /* report one actionable error below */ }
  throw new Error('本机插件发布身份已损坏，请联系管理员备份后重置');
}

function publicPublisher(row) {
  return {
    keyId: row.keyId, publicKey: row.publicKey, fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

function publisherIdentity(app) {
  let row = readPublisher(app);
  if (!row) {
    if (!secureStoreAvailable()) throw new Error('系统安全存储不可用，不能创建插件发布私钥');
    const pair = crypto.generateKeyPairSync('ed25519');
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const publicRaw = Buffer.from(jwk.x, 'base64url');
    const fingerprint = crypto.createHash('sha256').update(publicRaw).digest('hex');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    row = {
      schemaVersion: PUBLISHER_SCHEMA,
      keyId: 'soduwork.' + fingerprint.slice(0, 24),
      publicKey: publicRaw.toString('base64'), fingerprint,
      privateKeyCipher: _safeStorage.encryptString(String(privatePem)).toString('base64'),
      createdAt: now(),
    };
    writePublisher(app, row);
  }
  return { ok: true, identity: publicPublisher(row) };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalValue(value[key]); return out;
    }, {});
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function signPayload(app, raw) {
  const identity = publisherIdentity(app).identity;
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (Object.keys(payload).sort().join('|') !== SIGNING_FIELDS.join('|') ||
      payload.schema !== SIGNATURE_SCHEMA || payload.algorithm !== SIGNATURE_ALGORITHM ||
      payload.keyId !== identity.keyId || !/^[a-f0-9]{64}$/.test(String(payload.contentChecksum || '')) ||
      !KEY.test(String(payload.pluginKey || '')) || !VERSION.test(String(payload.version || ''))) {
    throw new Error('插件签名载荷不完整或与本机发布身份不一致');
  }
  const signedAt = Date.parse(String(payload.signedAt || ''));
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 15 * 60 * 1000) {
    throw new Error('插件签名请求已经过期，请重新提交');
  }
  if (!secureStoreAvailable()) throw new Error('系统安全存储不可用，不能读取插件发布私钥');
  const row = readPublisher(app);
  let privatePem = '';
  try { privatePem = _safeStorage.decryptString(Buffer.from(row.privateKeyCipher, 'base64')); }
  catch (_) { throw new Error('本机插件发布私钥无法解密'); }
  if (!/BEGIN PRIVATE KEY/.test(privatePem)) throw new Error('本机插件发布私钥无法读取');
  const signature = crypto.sign(null, canonicalBytes(payload), privatePem);
  if (signature.length !== 64) throw new Error('插件签名生成失败');
  return { ok: true, signature: {
    schema: SIGNATURE_SCHEMA, algorithm: SIGNATURE_ALGORITHM,
    keyId: identity.keyId, signedAt: payload.signedAt,
    signature: signature.toString('base64'),
  } };
}

function exportName(body) {
  return slug(body.key || body.name) + '-' + body.version + '.soduwork-plugin';
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
  return table;
})();
function zipCrc(bytes) { let c = 0xffffffff; for (const byte of bytes) c = ZIP_CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipU16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value, 0); return b; }
function zipU32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0); return b; }
function buildPluginArchive(body) {
  // Existing personal versions are immutable. A resource accepted by an
  // older client may intentionally contain a credential-shaped example (for
  // example, a security-audit fixture). Keep it exportable; new drafts still
  // use strict validation in normalizeBody().
  const resources = pluginResources.normalize(body.resources || [], { allowLegacyContent: true });
  const manifest = { schemaVersion: 1, ...body,
    capabilities: nodeCapabilities(body),
    resources: resources.map(item => ({ path: item.path, kind: item.kind,
      sha256: item.sha256, size: item.size,
      archivePath: 'skills/' + body.key + '/' + item.path })) };
  delete manifest.format; delete manifest.formatVersion;
  const entries = [{ name: 'plugin.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }];
  const skill = '---\nname: ' + body.key + '\ndescription: ' + JSON.stringify(body.description) +
    '\n---\n\n# ' + body.name + '\n\n' + body.instructions + '\n';
  entries.push({ name: 'skills/' + body.key + '/SKILL.md', bytes: Buffer.from(skill, 'utf8') });
  if (body.workflow) entries.push({ name: 'workflow.json', bytes: Buffer.from(JSON.stringify(body.workflow, null, 2), 'utf8') });
  resources.forEach(item => entries.push({ name: 'skills/' + body.key + '/' + item.path, bytes: Buffer.from(item.content, 'base64') }));
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), bytes = entry.bytes, crc = zipCrc(bytes);
    // ZIP flag 11 identifies UTF-8 names, including Chinese resource paths.
    const header = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), zipU16(20), zipU16(0x0800), zipU16(0), zipU16(0), zipU16(33), zipU32(crc), zipU32(bytes.length), zipU32(bytes.length), zipU16(name.length), zipU16(0), name, bytes]);
    local.push(header);
    central.push(Buffer.concat([Buffer.from([0x50,0x4b,0x01,0x02]), zipU16(20), zipU16(20), zipU16(0x0800), zipU16(0), zipU16(0), zipU16(33), zipU32(crc), zipU32(bytes.length), zipU32(bytes.length), zipU16(name.length), zipU16(0), zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(offset), name]));
    offset += header.length;
  }
  const centralBytes = Buffer.concat(central);
  return Buffer.concat([...local, centralBytes, Buffer.from([0x50,0x4b,0x05,0x06]), Buffer.alloc(4), zipU16(entries.length), zipU16(entries.length), zipU32(centralBytes.length), zipU32(offset), zipU16(0)]);
}

function read(app) {
  try {
    const value = JSON.parse(fs.readFileSync(file(app), 'utf8'));
    if (value && value.schemaVersion === SCHEMA && Array.isArray(value.plugins)) return value;
  } catch (_) { /* missing or damaged personal data starts as an empty local library */ }
  return { schemaVersion: SCHEMA, plugins: [] };
}

function write(app, value) {
  const target = file(app);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(temp, target); }
  catch (error) {
    fs.copyFileSync(temp, target);
    fs.unlinkSync(temp);
  }
}

function nodeCapabilities(body) {
  return {
    skills: [body.key, ...body.skills], mcpServers: body.mcpServers.slice(), secrets: [],
    runtime: body.runtime.slice(), network: Boolean(body.mcpServers.length || body.platforms?.length || ['connector', 'app'].includes(body.template)),
    ...(body.platforms?.length ? { platforms: body.platforms.slice() } : {}),
  };
}

function externalMcpServers(names, body) {
  return (Array.isArray(names) ? names : [])
    .map((name) => String(name || '').trim()).filter(Boolean)
    .filter((name) => !VIRTUAL_MCP_SERVERS.has(name) && !(name === 'soduwork-jiyong' && body?.jiyong?.mcp?.server === name));
}

function workflow(body) {
  return pluginWorkflow.normalize(body);
}

function build(raw) {
  const body = normalizeBody(raw);
  const graph = workflow(body);
  const hasWorkflow = body.template === 'workflow';
  if (hasWorkflow) body.workflow = graph;
  else delete body.workflow;
  const simulation = pluginWorkflow.simulation(graph);



  // Ordinary personal plugins keep the historical local-only policy. A
  // standalone release plugin is explicitly authored for enterprise task and
  // automation entrypoints; preserve that declaration in the local preview so
  // export/import does not turn it into a conversation-only draft.
  const standalone = body.distribution === 'standalone';
  const entrypoints = standalone
    ? {
      conversation: body.entrypoints?.conversation == null
        ? false : Boolean(body.entrypoints.conversation),
      task: body.entrypoints?.task == null ? true : Boolean(body.entrypoints.task),
      automation: body.entrypoints?.automation == null
        ? true : Boolean(body.entrypoints.automation),
    }
    : { conversation: true, task: false, automation: Boolean(body.jiyong && body.entrypoints?.automation) };
  const baseCapabilities = nodeCapabilities(body);
  const resultContract = graph.nodes.flatMap((node) => (node.outputs || []).map((output) => ({
    id: node.key + '.' + output.key, nodeKey: node.key, nodeName: node.name, ...output,
  })));
  const externalMcp = externalMcpServers(body.mcpServers, body);
  const evaluationCases = body.evaluationInstruction ? [{
    key: 'representative-case', name: '代表性任务',
    instruction: body.evaluationInstruction, inputs: {},
    criteria: body.evaluationCriteria.slice(),
    expectedOutputs: resultContract.filter((item) => item.required !== false).map((item) => item.id),
  }] : [];
  const components = [
    ...(body.resources ? [{ kind: 'resources', label: '随包资源', count: body.resources.length,
      state: 'ready', items: body.resources.map(item => item.path) }] : []),
    { kind: 'instructions', label: '工作说明', count: 1, state: 'ready' },
    {
      kind: 'skills', label: 'Skill', count: 1 + body.skills.length, state: 'ready',
      items: [body.key, ...body.skills],
    },
    ...(body.inputs.length ? [{
      kind: 'inputs', label: '任务参数', count: body.inputs.length, state: 'ready',
    }] : []),
    ...(body.setup.preferences.length ? [{
      kind: 'setup', label: '安装设置', count: body.setup.preferences.length, state: 'ready',
    }] : []),
    ...(body.mcpServers.length ? [{
      kind: 'mcp', label: '连接器', count: body.mcpServers.length,
      state: externalMcp.length ? 'needs-binding' : 'ready', items: body.mcpServers.slice(),
    }] : []),
    ...(body.runtime.length ? [{
      kind: 'runtime', label: '执行能力', count: body.runtime.length,
      state: 'needs-runner', items: body.runtime.slice(),
    }] : []),
    ...(hasWorkflow ? [{
      kind: 'workflow', label: '自动化流程', count: graph.nodes.length, state: 'ready',
    }] : []),
    ...(body.ui.contributions.length ? [{
      kind: 'ui', label: '员工界面', count: body.ui.contributions.length, state: 'ready',
    }] : []),
    { kind: 'contract', label: '结果契约', count: resultContract.length, state: 'ready' },
    ...(evaluationCases.length ? [{
      kind: 'evaluation', label: '发布评测', count: evaluationCases.length,
      state: 'ready', items: evaluationCases.map((item) => item.name),
    }] : []),
    ...(body.unsupportedComponents.length ? [{
      kind: 'unsupported', label: '个人试用不执行', count: body.unsupportedComponents.length,
      state: 'blocked', items: body.unsupportedComponents.slice(),
    }] : []),
  ];
  const permissionSummary = {
    riskLevel: (body.runtime.includes('computer') || body.unsupportedComponents.length) ? 'high'
      : (body.mcpServers.length || body.runtime.length || (body.resources || []).some(x => x.kind === 'script') || body.ui.contributions.some(
        item => item.source.type === 'external') ? 'medium' : 'low'),
    network: baseCapabilities.network, script: false, secretCount: 0,
    reasons: [
      ...(externalMcp.length
        ? ['需要配置 ' + externalMcp.length + ' 个连接器：' + externalMcp.join('、'), '运行时需要网络访问']
        : []),
      ...(body.runtime.length ? ['需要执行机提供：' + body.runtime.join('、')] : []),
      ...((body.resources || []).some(x => x.kind === 'script') ? ['包含脚本资源；安装不执行，使用仍须当前任务授权'] : []),
      ...(body.ui.contributions.some(item => item.source.type === 'external')
        ? ['包含受隔离承载的外部系统页面'] : []),
      ...(body.unsupportedComponents.length
        ? ['个人试用不会执行：' + body.unsupportedComponents.join('、')] : []),
    ],
  };
  const manifest = {
    schemaVersion: 1, key: body.key, name: body.name, version: body.version,
    description: body.description, author: body.author || 'SoduWork 个人作者', inputs: body.inputs,
    outputs: [{ key: 'result', label: '交付成果', accept: [] }],
    setup: body.setup, instructions: body.instructions, entrypoints, capabilities: baseCapabilities,
    evaluations: evaluationCases,
  };
  if (body.extensions != null) manifest.extensions = body.extensions;
  if (body.appCategory != null) manifest.appCategory = body.appCategory;
  if (body.distribution) manifest.distribution = body.distribution;
  if (body.locales) manifest.locales = body.locales;
  if (body.template === 'app') manifest.template = 'app';
  if (body.icon) manifest.icon = body.icon;
  if (body.coverUrl) manifest.coverUrl = body.coverUrl;
  if (body.appWindow) manifest.appWindow = body.appWindow;
  if (body.jiyong) manifest.jiyong = body.jiyong;
  if (body.ui.contributions.length) manifest.ui = body.ui;
  if (body.resources) manifest.resources = pluginResources.summary(body.resources);
  const canonical = JSON.stringify({
    manifest, workflow: graph, instructions: body.instructions,
    sourceKind: body.sourceKind, importChecksum: body.importChecksum,
    importWarnings: body.importWarnings,
    unsupportedComponents: body.unsupportedComponents,
    ...(body.entrypoints ? { entrypoints: body.entrypoints } : {}),
  });
  return {
    body, manifest, workflow: graph,
    capabilities: { ...baseCapabilities, hasScript: false, sourceKind: body.sourceKind,
      hasWorkflow, executionMode: hasWorkflow ? 'workflow' : 'direct', entrypoints,
      interactiveUi: hasInteractiveUi(body.ui),
      components, componentCount: components.reduce((sum, item) => sum + item.count, 0),
      permissionSummary, resultContract, evaluationCases,
      adapterWarnings: body.importWarnings.slice(),
      unsupportedComponents: body.unsupportedComponents.slice(),
      simulation, qualitySummary: {
        state: evaluationCases.length ? 'declared' : 'contract-only',
        caseCount: evaluationCases.length, resultCount: resultContract.length,
        message: evaluationCases.length ? '已声明 1 个发布评测' : '已有结果契约，尚未声明代表性发布评测',
      } },
    checksum: crypto.createHash('sha256').update(canonical).digest('hex'),
  };
}

function current(plugin) {
  return (plugin.versions || []).find((item) => item.version === plugin.currentVersion) || (plugin.versions || [])[0] || null;
}

function comparableResourceSummary(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    path: String(item && item.path || ''), kind: String(item && item.kind || ''),
    sha256: String(item && item.sha256 || ''), size: Number(item && item.size || 0),
  })).sort((left, right) => {
    const a = left.path + '\u0000' + left.kind + '\u0000' + left.sha256;
    const b = right.path + '\u0000' + right.kind + '\u0000' + right.sha256;
    return a < b ? -1 : a > b ? 1 : left.size - right.size;
  });
}

function publicPlugin(plugin, detail) {
  const version = current(plugin);
  if (!version) return null;
  const preferences = require('./personal-plugin-setup.cjs').state(plugin, version);
  const hasWorkflow = Boolean(version.capabilities.hasWorkflow);
  const ui = (version.manifest || {}).ui || { contributions: [] };
  const interactive = hasInteractiveUi(ui);
  const externalMcp = externalMcpServers(version.body.mcpServers || [], version.body);
  const out = {
    pluginId: plugin.id, key: plugin.key, name: plugin.name, description: plugin.description,
    ...((version.manifest || {}).locales ? { locales: version.manifest.locales } : {}),
    ...(version.body.template === 'app' ? { template: 'app' } : {}),
    ...((version.manifest || {}).extensions != null ? {extensions:version.manifest.extensions} : {}),
    ...(version.body.template === 'app' ? {appCategory:require('../core/plugin-app-contract.cjs').category(version.manifest?.appCategory)} : {}),
    authorName: String((version.manifest || {}).author || version.body.author || 'SoduWork 个人作者'),
    ...((version.manifest || {}).coverUrl ? { coverUrl: version.manifest.coverUrl } : {}),
    ...((version.manifest || {}).icon ? { icon: version.manifest.icon } : {}),
    ...((version.manifest || {}).appWindow ? { appWindow: version.manifest.appWindow } : {}),
    ...((version.manifest || {}).jiyong ? { jiyong: version.manifest.jiyong } : {}),
    version: version.version, checksum: version.checksum,
    sourceKind: plugin.builtIn ? 'builtin' : (version.capabilities.sourceKind || 'personal'),
    personal: true,
    builtIn: Boolean(plugin.builtIn), enabled: plugin.enabled !== false,
    dependencyReadiness: {
      requiredMcp: externalMcp.slice(), missingMcp: externalMcp.slice(),
      state: externalMcp.length ? 'needs_connection' : 'ready',
    },
    ...preferences,
    conversationUse: plugin.enabled !== false
      ? preferences.setupState === 'ready'
        ? { available: true, code: 'ready', label: '\u53ef\u5728\u5bf9\u8bdd\u4f7f\u7528' }
        : { available: false, code: 'needs_setup', label: '待完成设置', reason: preferences.setupMessage }
      : { available: false, code: 'disabled', label: '\u5df2\u505c\u7528' },
    organizationWide: false, projectCount: 0,
    workflow: hasWorkflow ? (version.workflow.nodes || []).map(
      (node) => ({ key: node.key, type: node.type, name: node.name })) : [],
    inputs: ((version.manifest || {}).inputs || []),
    setup: ((version.manifest || {}).setup || { title: '', description: '', preferences: [] }),
    ui,
    /*
     * Recompute entrypoint policy for legacy snapshots. Local automation resolves the current
     * version by key; Hub task workflows require enterprise publication. The built-in
     * development assistant remains conversation-only.
     */
    entrypoints: {
      conversation: true, task: false,
      automation: !plugin.builtIn && (!interactive || Boolean(version.body.jiyong && version.body.entrypoints?.automation)),
    },
    capabilities: {
      ...(version.body.platforms?.length ? { platforms: version.body.platforms.slice() } : {}),
      skills: version.capabilities.skills || [], mcpServers: version.capabilities.mcpServers || [],
      runtime: version.capabilities.runtime || [],
      network: Boolean(version.capabilities.network), hasScript: Boolean(version.capabilities.hasScript),
      interactiveUi: interactive,
      hasWorkflow, executionMode: version.capabilities.executionMode || (hasWorkflow ? 'workflow' : 'direct'),
      components: version.capabilities.components || [],
      componentCount: Number(version.capabilities.componentCount || 0),
      adapterWarnings: version.capabilities.adapterWarnings || [],
      unsupportedComponents: version.capabilities.unsupportedComponents || [],
      resources: pluginResources.summary(version.body.resources || []),
      resultContract: version.capabilities.resultContract || [],
      evaluationCases: version.capabilities.evaluationCases || [],
      qualitySummary: version.capabilities.qualitySummary || {
        state: 'contract-only', caseCount: 0, resultCount: 0,
        message: '尚未声明发布评测',
      },
      permissionSummary: version.capabilities.permissionSummary || {
        riskLevel: version.capabilities.network ? 'medium' : 'low',
        network: Boolean(version.capabilities.network), script: false, secretCount: 0, reasons: [],
      },
    },
    createdAt: plugin.createdAt, updatedAt: plugin.updatedAt,
  };
  if (detail) {
    out.localDraft = sourceAccess.inheritBody([plugin], { ...version.body });
    out.localVersions = (plugin.versions || []).map((item) => ({
      version: item.version,
      checksum: item.checksum,
      createdAt: item.createdAt || plugin.createdAt,
      current: item.version === plugin.currentVersion,
    }));
  }
  return out;
}

function builderPlugin() {
  const body = normalizeBuiltinBody(require('./plugin-builder-plugin.cjs').body());
  const version = build(body);
  return {
    id: BUILDER_ID, key: body.key, name: body.name, description: body.description,
    enabled: true, builtIn: true, currentVersion: body.version, versions: [{ ...version, version: body.version }],
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

function skillStudioPlugin(app) {
  const body = normalizeBuiltinBody(skillStudio.body(app));
  const version = build(body);
  return {
    id: SKILL_STUDIO_ID, key: body.key, name: body.name, description: body.description,
    enabled: true, builtIn: true, currentVersion: body.version, versions: [{ ...version, version: body.version }],
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  };
}

function normalizeBuiltinBody(body) {
  return normalizeBody(require('./builtin-plugin-locales.cjs').withLocales(body));
}

function builtinPlugins(app, ids) {
  const items = [builderPlugin()];
  if (!ids || ids.includes(APP_DEVELOPER_ID)) {
    try {
      const body = normalizeBuiltinBody(require('./app-developer-plugin.cjs').body(app)), version = build(body);
      items.push({ id: APP_DEVELOPER_ID, key: body.key, name: body.name, description: body.description,
        enabled: true, builtIn: true, currentVersion: body.version, versions: [{ ...version, version: body.version }],
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' });
    } catch (error) {
      if (ids) throw new Error('即用开发资源不完整，请修复客户端安装后重试');
      console.warn('[personal-plugins] App Developer unavailable:', error.code || 'invalid-resources');
    }
  }
  if (!ids || ids.includes(PRODUCT_INCUBATOR_ID)) {
    try {
      const body = normalizeBuiltinBody(productIncubator.body(app)), version = build(body);
      items.push({ id: PRODUCT_INCUBATOR_ID, key: body.key, name: body.name, description: body.description,
        enabled: true, builtIn: true, currentVersion: body.version, versions: [{ ...version, version: body.version }],
        createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' });
    } catch (error) {
      if (ids) throw new Error('产品孵化资源不完整，请修复客户端安装后重试');
      console.warn('[personal-plugins] Product Incubator unavailable:', error.code || 'invalid-resources');
    }
  }
  // A missing optional resource must never break ordinary chat or other plugins.
  if (!ids || ids.includes(MCP_STUDIO_ID)) {
    try {
      const body = normalizeBuiltinBody(mcpStudio.body(app)), version = build(body);
      items.push({id:MCP_STUDIO_ID,key:body.key,name:body.name,description:body.description,
        enabled:true,builtIn:true,currentVersion:body.version,versions:[{...version,version:body.version}],
        createdAt:'2026-09-08T00:00:00.000Z',updatedAt:'2026-09-08T00:00:00.000Z'});
    } catch(error) {
      if(ids) throw new Error('连接器快速配置资源不完整，请修复客户端安装');
      console.warn('[personal-plugins] MCP Studio unavailable:',error.code || 'invalid-resources');
    }
  }
  if (ids && !ids.includes(SKILL_STUDIO_ID)) return items;
  try { items.push(skillStudioPlugin(app)); }
  catch (error) {
    if (ids) throw new Error('Skill 创建与优化资源不完整，请修复客户端安装后重试');
    console.warn('[personal-plugins] Skill Studio unavailable:', error.code || 'invalid-resources');
  }
  return items;
}

function catalog(app, includeDisabled) {
  const personal = read(app).plugins.filter((item) => includeDisabled || item.enabled !== false);
  return [...builtinPlugins(app), ...personal].map((item) => publicPlugin(item, false)).filter(Boolean);
}

function get(app, pluginId) {
  const plugin = [...builtinPlugins(app, [String(pluginId || '')]), ...read(app).plugins].find(
    (item) => item.id === String(pluginId || ''));
  if (!plugin) throw new Error('个人插件不存在');
  return publicPlugin(plugin, true);
}

function exportDraft(app, pluginId) {
  const plugin = read(app).plugins.find((item) => item.id === String(pluginId || ''));
  if (!plugin) throw new Error('个人插件不存在');
  const version = current(plugin);
  if (!version || !version.body) throw new Error('个人插件当前版本不完整');
  return {
    format: 'soduwork-personal-plugin-draft',
    formatVersion: 1,
    ...sourceAccess.inheritBody([plugin], version.body),
  };
}

async function exportToFile(app, dialog, pluginId) {
  if (!dialog || typeof dialog.showSaveDialog !== 'function') {
    throw new Error('系统文件保存窗口不可用');
  }
  const draft = exportDraft(app, pluginId);
  const result = await dialog.showSaveDialog(require("./native-locale.cjs").dialogOptions({
    title: '导出个人插件压缩包',
    defaultPath: path.join(app.getPath('documents'), exportName(draft)),
    filters: [{ name: 'SoduWork 插件压缩包', extensions: ['soduwork-plugin', 'soduwork-plugin', 'soduwork-plugin'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }));
  if (!result || result.canceled || !result.filePath) return { ok: true, canceled: true };
  // Normalize resource bytes before packaging so the archive is self-contained
  // and can be imported on another device without adjacent files.
  const resources = pluginResources.normalize(draft.resources || [], { allowLegacyContent: true });
  // Plugin export is always a portable package. Older dialogs may return a
  // `.json` path from a remembered choice; normalize that path so users never
  // receive a zip with a misleading JSON extension.
  const archivePath = require('./plugin-package-name.cjs').archivePath(result.filePath);
  if (archivePath !== result.filePath && fs.existsSync(archivePath)) {
    throw new Error('同名插件压缩包已存在，请重新导出并在保存窗口选择该文件或使用其他名称');
  }
  {
    const archive = buildPluginArchive(draft);
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    return { ok: true, canceled: false, filePath: archivePath,
      filename: path.basename(archivePath), version: draft.version,
      resourceCount: resources.length, archive: true };
  }
}

function preflight(raw) {
  const version = build(raw);
  if (version.body.template === 'app') return {ok:true,sourceKind:'personal',manifest:version.manifest,workflow:version.workflow,
    capabilities:version.capabilities,simulation:version.capabilities.simulation,checks:[
      {key:'schema',label:'即用声明与页面入口有效',ok:true},
      {key:'resources',label:'随包资源已收集并通过完整性校验',ok:true},
      ...(version.body.jiyong?[{key:'storage',label:'数据集合、参数与初始化声明有效',ok:true},
        {key:'storage-location',label:version.body.jiyong.storage?.location==='cloud'?'云端数据声明有效；数据库按包名及账号自动开通':'数据本地化：使用宿主 SQLite',ok:true}]:[]),
      {key:'secret',label:'包内配置未发现禁止内置的凭据',ok:true},
    ]};
  return { ok: true, sourceKind: 'personal', manifest: version.manifest, workflow: version.workflow,
    capabilities: version.capabilities, simulation: version.capabilities.simulation, checks: [
      { key: 'schema', label: '个人插件结构完整', ok: true },
      { key: 'inputs', label: '公开参数可生成任务表单且不收集凭据', ok: true },
      { key: 'setup', label: '安装设置只包含非敏感版本配置', ok: true },
      { key: 'dag', label: '节点依赖无环', ok: true },
      ...(version.capabilities.hasWorkflow ? [require('./personal-plugin-agent-route.cjs').localCheck(version.workflow)] : []),
      { key: 'handoff', label: '上下游输入输出契约一致', ok: true },
      { key: 'routing', label: 'Agent 与模型只使用抽象偏好，不绑定具体机器', ok: true },
      { key: 'secret', label: '插件定义不保存真实密钥', ok: true },
      { key: 'local', label: '安装后默认仅自己可见', ok: true },
    ] };
}

async function preflightCandidate(app,body,deps={}) {
  const preview=await require('./app-resource-cache.cjs').request({action:'preflight',body});
  if(body.template!=='app')return preview;
  const cloud=await require('./jiyong-cloud-data.cjs').preflight({app,...deps},body);
  if(cloud)preview.checks.push(cloud);
  if(cloud?.ok===false)return {...preview,ok:false};
  // Installation validates the package without executing its pages. Native
  // startup diagnostics remain an explicit development check only.
  return preview;
}

function preflightArchive(content) {
  const draft = readPersonalArchive(Buffer.from(String(content || ''), 'base64'));
  const preview = preflight(draft);
  return { ...preview, sourceKind: 'personal', personalDraft: draft, local: true };
}

function create(app, raw) {
  const state = read(app);
  const version = build(sourceAccess.inheritBody(state.plugins, normalizeBody(raw)));
  let plugin = state.plugins.find((item) => item.key === version.body.key);
  if (!plugin) {
    if (state.plugins.length >= MAX_PLUGINS) throw new Error('个人插件数量已达到上限');
    const at = now();
    plugin = { id: 'local:' + crypto.randomUUID(), key: version.body.key, name: version.body.name,
      description: version.body.description, enabled: true, currentVersion: version.body.version,
      versions: [], createdAt: at, updatedAt: at };
    state.plugins.unshift(plugin);
  }
  const same = plugin.versions.find((item) => item.version === version.body.version);
  if (same && same.checksum !== version.checksum) throw new Error('同一版本内容已经变化，请提升版本号后再安装');
  if (!same) plugin.versions.unshift({ ...version, version: version.body.version, createdAt: now() });
  if (version.body.sourcePluginId) plugin.sourcePluginId = version.body.sourcePluginId;
  plugin.versions = plugin.versions.slice(0, MAX_VERSIONS);
  plugin.name = version.body.name;
  plugin.description = version.body.description;
  plugin.currentVersion = version.body.version;
  plugin.enabled = true;
  plugin.updatedAt = now();
  write(app, state);
  return { ok: true, created: !same, plugin: publicPlugin(plugin, true), message: '个人插件已安装，仅你在这台 SoduWork 上可见' };
}

function setEnabled(app, pluginId, enabled) {
  const state = read(app);
  const plugin = state.plugins.find((item) => item.id === String(pluginId || ''));
  if (!plugin) throw new Error('个人插件不存在');
  plugin.enabled = Boolean(enabled); plugin.updatedAt = now(); write(app, state);
  return { ok: true, plugin: publicPlugin(plugin, true) };
}

function setVersion(app, pluginId, versionName) {
  const state = read(app);
  const plugin = state.plugins.find((item) => item.id === String(pluginId || ''));
  if (!plugin) throw new Error('个人插件不存在');
  const version = (plugin.versions || []).find(
    (item) => item.version === text(versionName, 40));
  if (!version) throw new Error('这个个人插件版本不存在');
  plugin.currentVersion = version.version;
  plugin.name = version.body.name;
  plugin.description = version.body.description;
  plugin.updatedAt = now();
  write(app, state);
  return {
    ok: true, plugin: publicPlugin(plugin, true),
    message: '已切换到 v' + version.version + '，新的个人对话试用会使用这个版本',
  };
}

function remove(app, pluginId) {
  const state = read(app);
  const before = state.plugins.length;
  state.plugins = state.plugins.filter((item) => item.id !== String(pluginId || ''));
  if (before === state.plugins.length) throw new Error('个人插件不存在');
  write(app, state);
  return { ok: true };
}

function configure(app, pluginId, checksum, config) {
  const state = read(app);
  const plugin = state.plugins.find(item => item.id === String(pluginId || ''));
  if (!plugin) throw Error('个人插件不存在');
  const version = current(plugin);
  if (!checksum || checksum !== version.checksum) throw Error('插件版本已变化，请重新打开设置');
  const values = require('./personal-plugin-setup.cjs').validate(version.manifest.setup, config);
  plugin.setupByVersion = { ...(plugin.setupByVersion || {}), [checksum]: values };
  plugin.updatedAt = now();
  write(app, state);
  return { ok: true, plugin: publicPlugin(plugin, true) };
}

function resolve(app, rawIds, options = {}) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String))].slice(0, 3);
  const all = [...builtinPlugins(app, ids), ...read(app).plugins];
  const readRoots = [], resourceBundles = [];
  const items = ids.map((id) => {
    const plugin = all.find((row) => row.id === id);
    if (!plugin || plugin.enabled === false) throw new Error('个人插件不存在或已停用');
    const version = current(plugin);
    const hasWorkflow = Boolean(version.capabilities.hasWorkflow);
    const setup = require('./personal-plugin-setup.cjs');
    const preferences = setup.state(plugin, version);
    if (preferences.setupState !== 'ready') throw Error('请先在插件「' + plugin.name + '」的设置中完成配置：' + preferences.setupMessage);
    const interactive = hasInteractiveUi(version.body.ui);
    const route = hasWorkflow
      ? (version.workflow.nodes || []).map((node) => node.name).filter(Boolean).join(' → ') : '';
      const mcpServers = version.body.mcpServers || [];
      const builtInMcp = mcpServers.filter((name) => VIRTUAL_MCP_SERVERS.has(String(name || '').trim()));
      const externalMcp = externalMcpServers(mcpServers, version.body);
    const skills = version.body.skills || [];
    const runtime = version.body.runtime || [];
    const acceptance = version.body.evaluationCriteria || [];
    if (version.body.resources || version.manifest.resources) {
      const actual = pluginResources.summary(pluginResources.normalize(
        version.body.resources, { allowLegacyContent: true }));
      if (JSON.stringify(comparableResourceSummary(actual)) !==
          JSON.stringify(comparableResourceSummary(version.manifest.resources || []))) {
        throw new Error('本机插件资源与版本清单不一致，请重新导入可信插件版本');
      }
    }
    const resourceBundle = options.cwd ? pluginResources.materialize(version.body.resources,
      options.cwd, plugin.key, { allowLegacyContent: true }) : null;
    const resourceGuide = resourceBundle ? pluginResources.guidance(resourceBundle) : '';
    if (resourceBundle?.directory) {
      readRoots.push(resourceBundle.directory);
      resourceBundles.push({ pluginId: plugin.id, key: plugin.key, digest: resourceBundle.digest,
        resources: pluginResources.normalize(version.body.resources, { allowLegacyContent: true }) });
    }
    return {
      pluginId: plugin.id, key: plugin.key, name: plugin.name, version: version.version,
      scopeLabel: '仅自己', personal: true,
      workflow: hasWorkflow ? (version.workflow.nodes || []).map(
        (node) => ({ key: node.key, type: node.type, name: node.name })) : [],
      capabilities: publicPlugin(plugin).capabilities,
      context: [
        '本轮已启用本机个人插件「' + plugin.name + '」v' + version.version + '。',
        route ? '建议步骤：' + route + '。' : '',
        '工作方法：\n' + version.body.instructions,
        resourceGuide,
        skills.length
          ? '本轮复用 Skill：' + skills.join('、') + '。任务执行时必须加载这些已授权方法；不可用时要明确说明。'
          : '',
        builtInMcp.length
          ? '本轮使用 SoduWork 内置能力：' + builtInMcp.join('、') + '。这些能力由 SoduWork 直接提供，无需用户配置外部 MCP。'
          : '',
        externalMcp.length
          ? '本轮依赖外部 MCP：' + externalMcp.join('、') + '。只有当前会话已配置并授权时才能调用；不可用时必须明确说明。'
          : '',
        runtime.length
          ? '本轮需要的基础执行能力：' + runtime.join('、') + '。只能调用实际可用且本轮已授权的能力。'
          : '',
        acceptance.length
          ? '完成标准：\n- ' + acceptance.join('\n- ')
          : '',
        interactive
          ? '当前是交互插件：页面需要在可见的会话或任务界面中使用，不会进入无人值守的后台自动化。'
          : hasWorkflow
            ? '当前是个人工作流草稿：本轮可按这些步骤完成工作；定时任务也可在本机按此方法自动执行，上传企业并审核发布后才有多人协作与人工门禁的正式编排。'
            : '当前是个人能力：本机对话与定时任务可直接使用；上传企业并审核发布后，才能供团队与正式任务调用。',
        '个人插件只为当前轮次提供方法与质量标准，不代表企业审批、合并或发布已经执行。',
      ].filter(Boolean).join('\n\n').slice(0, 10000) + setup.guidance(preferences.setupConfig),
    };
  });
  return { ok: true, items, readRoots, resourceBundles };
}

function service({ app, identityOf, fetchImpl, beforeWrite = async () => {}, validateWrite = () => {} }) {
  const access = sourceAccess.authorizer({ app, identityOf, fetchImpl, read, normalizeBody });
  return {
    async get(id) { await access.ids([id], 'edit'); return get(app, id); },
    async use(id) { await access.ids([id], 'use'); return get(app, id); },
    async preflight(body) { return preflightCandidate(app, await access.body(body), { identityOf, fetchImpl }); },
    async create(body) {
      const authorized=await access.body(body), checked=await preflightCandidate(app,authorized,{identityOf,fetchImpl});
      if(checked.ok===false)return {ok:false,installed:false,reason:checked.checks.filter(row=>row.ok===false).map(row=>row.label).join('\n'),checks:checked.checks};
      const current=await access.body(body);
      if(build(current).checksum!==build(authorized).checksum)throw Error('即用候选内容已变化，请重新检查后安装');
      require('./jiyong-edit-source.cjs').assertInstallCurrent(app,current);
      await beforeWrite(current);
      validateWrite(current);
      const result=create(app,current);
      try{result.initialization=await require('./jiyong-initialization.cjs').initialize({app,identityOf,fetchImpl},result.plugin.pluginId,result.plugin);return result;}
      catch(error){return {ok:false,installed:true,plugin:result.plugin,reason:'即用已保存，但数据初始化未完成：'+error.message};}
    },
  };
}

function install({ app, ipcMain, dialog, safeStorage, identityOf, fetchImpl }) {
  _safeStorage = safeStorage;
  const access = sourceAccess.authorizer({ app, identityOf, fetchImpl, read, normalizeBody });
  const shared = service({ app, identityOf, fetchImpl });
  ipcMain.handle('personal-plugin-choose-package', () => require('./plugin-package-picker').choose(dialog));
  ipcMain.handle('personal-plugin-list', async (_event, options) => ({ ok: true,
    items: await require('./personal-plugin-catalog-worker.cjs').catalog(app, Boolean(options && options.includeDisabled)) }));
  ipcMain.handle('personal-plugin-get', (_event, pluginId) => ({ ok: true, plugin: get(app, pluginId) }));
  ipcMain.handle('personal-plugin-preflight', async (_event, body) => preflightCandidate(app,await access.body(body),{identityOf,fetchImpl}));
  ipcMain.handle('personal-plugin-preflight-archive', async (_event, _name, content) => {
    const result = await require('./app-resource-cache.cjs').request({action:'preflight-archive',content});
    const body=await access.body(result.personalDraft);
    return {...result,...await preflightCandidate(app,body,{identityOf,fetchImpl}),personalDraft:body};
  });
  ipcMain.handle('personal-plugin-initialize',async(_event,pluginId)=>require('./jiyong-initialization.cjs').initialize({app,identityOf,fetchImpl},String(pluginId)));
  ipcMain.handle('personal-plugin-create', (_event, body) => shared.create(body));
  ipcMain.handle('personal-plugin-metadata-update', (_event, pluginId, options) =>
    require('./personal-plugin-metadata.cjs').update({app,identityOf,pluginId,options}));
  ipcMain.handle('personal-plugin-configure', async (_event, id, checksum, config) => {
    await access.ids([id], 'use'); return configure(app, id, checksum, config);
  });
  ipcMain.handle('personal-plugin-enable', async (_event, pluginId, enabled) => {
    if (enabled) await access.ids([pluginId], 'use'); return setEnabled(app, pluginId, enabled);
  });
  ipcMain.handle('personal-plugin-version', async (_event, pluginId, version) => {
    await access.ids([pluginId], 'use'); return setVersion(app, pluginId, version);
  });
  ipcMain.handle('personal-plugin-delete', (_event, pluginId) => remove(app, pluginId));
  ipcMain.handle('personal-plugin-resolve', async (_event, ids) => {
    await access.ids(ids, 'use'); return resolve(app, ids);
  });
  ipcMain.handle('personal-plugin-export', async (_event, pluginId) => {
    await access.ids([pluginId], 'edit'); return exportToFile(app, dialog, pluginId);
  });
  ipcMain.handle('personal-plugin-publisher-identity', () => publisherIdentity(app));
  ipcMain.handle('personal-plugin-sign', async (_event, payload) => {
    await access.key(payload?.pluginKey); return signPayload(app, payload);
  });
}

module.exports = {
  BUILDER_ID, APP_DEVELOPER_ID, SKILL_STUDIO_ID, MCP_STUDIO_ID, PRODUCT_INCUBATOR_ID, build, catalog, get, create, preflight, resolve, setVersion,
  exportDraft, exportToFile, install, publisherIdentity, signPayload, normalizeInstallSetup, configure,
  preflightArchive, preflightCandidate, service,
  _canonicalBytes: canonicalBytes, _read: read, _publicPlugin: publicPlugin,
};
