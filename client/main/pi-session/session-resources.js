/* Session-scoped skill resources and isolated delivery verification. */
const fs = require('fs');
const path = require('path');
const stream = require('./event-stream');
const attachments = require('./attachments');
const goalReview = require('../conversation/goal-review');
const goalQuality = require('../conversation/goal-quality');
const sessionHelpers = require('./session-helpers');

function canonicalPath(value) {
  if (!value) return '';
  let resolved = path.resolve(String(value));
  try { resolved = fs.realpathSync(resolved); } catch (error) { /* Missing paths are diagnosed below. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function containsPath(root, target) {
  if (!target) return false;
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function skillDiagnostic(item) {
  const message = String(item.message || item.error || '');
  // The SDK includes a source excerpt in YAML diagnostics. Show its location
  // and cause without copying a long/private description into the chat bubble.
  const yaml = message.match(/^(.+?) at line (\d+), column (\d+):\s*\n/);
  return yaml ? `SKILL.md 的 YAML 头第 ${yaml[2]} 行、第 ${yaml[3]} 列格式有误（${yaml[1]}）。请修正后重新导入`
    : message.split(/[\r\n]/, 1)[0].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240);
}

/* Pi deduplicates by real file and by declared Skill name. Count equality is
   not a loading contract: aliases and same-name installations legitimately
   produce fewer Skills. Verify coverage of each requested path instead. */
function verifySkills(dirs, loaded, options = {}) {
  const skills = loaded.skills || [];
  const diagnostics = loaded.diagnostics || [];
  // Do not repeat filesystem canonicalization inside the coverage scan; a
  // large Skill catalog must not turn history opening into thousands of I/O calls.
  const keys = new Map();
  const key = (value) => {
    if (!keys.has(value)) keys.set(value, canonicalPath(value));
    return keys.get(value);
  };
  const files = new Set(skills.map((item) => key(item.filePath)).filter(Boolean));
  const covered = new Set(files);
  diagnostics.forEach((item) => {
    const collision = item && item.collision;
    if (item && item.type === 'collision' && collision &&
        files.has(key(collision.winnerPath))) {
      covered.add(key(collision.loserPath));
    }
  });
  const coveredFiles = [...covered];
  const missing = dirs.filter((dir) => !coveredFiles.some((file) => containsPath(key(dir), file)));
  const optional = new Set((options.optionalSkillDirs || []).map(key));
  const optionalOnly = target => dirs.some(dir => optional.has(key(dir)) && containsPath(key(dir), target)) &&
    !dirs.some(dir => !optional.has(key(dir)) && containsPath(key(dir), target));
  const errors = diagnostics.filter(item => item && (item.type === 'error' ||
    item.type === 'warning' && !covered.has(key(item.path))));
  if (missing.length || errors.length) {
    const details = [], warnings = [];
    const report = (target, message) => (optionalOnly(target) ? warnings : details).push(message);
    missing.forEach((dir) => {
      const reasons = diagnostics.filter((item) => item && containsPath(key(dir), key(item.path)))
        .map(skillDiagnostic).filter(Boolean);
      report(key(dir), path.basename(dir) + '（' + [...new Set(reasons.length ? reasons : ['未读取到有效的 SKILL.md'])].join('；') + '）');
    });
    errors.forEach((item) => {
      if (!missing.some((dir) => containsPath(key(dir), key(item.path)))) {
        report(key(item.path), [path.basename(path.dirname(item.path || '')), skillDiagnostic(item)].filter(Boolean).join('：'));
      }
    });
    if (details.length) throw new Error('以下 Skill 未能加载，请检查或重新安装：' + details.join('；'));
    if (warnings.length && options.warnings) options.warnings.push(
      '已跳过不可用的默认技能：' + warnings.slice(0, 8).join('；') +
      (warnings.length > 8 ? `；另有 ${warnings.length - 8} 项` : '') + '。普通对话可继续。');
  }
  return skills;
}

/*
 * Retry transient model failures at the Agent layer while preserving completed tool
 * results. Disable default provider replay to avoid multiplied retries; retain SDK
 * cancellation and explicit user policies.
 */
function configureSoduWorkRetryPolicy(settingsManager) {
  if (!settingsManager || typeof settingsManager.applyOverrides !== 'function') return;
  const globalSettings = typeof settingsManager.getGlobalSettings === 'function'
    ? settingsManager.getGlobalSettings() || {} : {};
  const projectSettings = typeof settingsManager.getProjectSettings === 'function'
    ? settingsManager.getProjectSettings() || {} : {};
  const globalRetry = globalSettings.retry && typeof globalSettings.retry === 'object'
    ? globalSettings.retry : {};
  const projectRetry = projectSettings.retry && typeof projectSettings.retry === 'object'
    ? projectSettings.retry : {};
  const provider = globalRetry.provider && typeof globalRetry.provider === 'object'
    ? globalRetry.provider : {};
  const projectProvider = projectRetry.provider && typeof projectRetry.provider === 'object'
    ? projectRetry.provider : {};
  const overrides = { retry: {} };
  const hasExplicitMaxRetries = Number.isInteger(globalRetry.maxRetries)
    || Number.isInteger(projectRetry.maxRetries);
  if (!hasExplicitMaxRetries) {
    overrides.retry.maxRetries = 6;
  }
  if (!hasExplicitMaxRetries
    && !Array.isArray(globalRetry.delayScheduleMs)
    && !Array.isArray(projectRetry.delayScheduleMs)) {
    overrides.retry.delayScheduleMs = [5000, 15000, 30000, 60000, 120000, 240000];
  }
  if (!Number.isInteger(provider.maxRetries) && !Number.isInteger(projectProvider.maxRetries)) {
    overrides.retry.provider = { maxRetries: 0, maxRetryDelayMs: 0 };
  }
  if (Object.keys(overrides.retry).length) settingsManager.applyOverrides(overrides);
}

const DEFAULT_RESOURCE_LOAD_TIMEOUT_MS = 5000;

function resourceLoadTimeoutMs(options) {
  const requested = Number(options && options.timeoutMs);
  if (Number.isFinite(requested) && requested > 0) return Math.max(250, Math.min(requested, 60000));
  return DEFAULT_RESOURCE_LOAD_TIMEOUT_MS;
}

async function reloadResourceLoader(loader, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      require('./background-process').run(() => loader.reload()),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Resource loader timed out');
          error.code = 'RESOURCE_LOAD_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * A history view must never be held hostage by an extension. The SDK loads
 * configured extensions serially and an extension that waits on a child
 * process or network can leave reload() pending forever. Keep the normal
 * extension path for new sessions, but let callers request a lightweight
 * resource set while resuming an archive. A bounded fallback also protects
 * fresh sessions when a third-party extension regresses.
 */
async function sessionResources(sdk, cwd, agentDir, skillDirs, appendSystemPrompt, options) {
  const unique = new Map();
  (skillDirs || []).map((item) => String(item || '').trim()).filter(Boolean).forEach((item) => {
    const key = canonicalPath(item);
    if (!unique.has(key)) unique.set(key, path.resolve(item));
  });
  const dirs = [...unique.values()];
  let settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const requestedNoExtensions = Boolean(options && (options.noExtensions ||
    options.accessPolicy && options.accessPolicy.mode !== 'full'));
  const loaderOptions = {
    cwd, agentDir, settingsManager,
    additionalSkillPaths: dirs,
    appendSystemPrompt: [...(appendSystemPrompt || [])],
    noSkills: true,
    noExtensions: requestedNoExtensions,
    // A SoduWork-owned context hook remains active when user extensions are
    // disabled. Historical tool calls must not advertise unavailable tools.
    extensionFactories: [{ name: 'soduwork-tool-context', hidden: true,
      factory: require('./tool-context').extension }],
  };
  let resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
  let degraded = requestedNoExtensions;
  try {
    await reloadResourceLoader(resourceLoader, resourceLoadTimeoutMs(options));
  } catch (error) {
    if (!error || error.code !== 'RESOURCE_LOAD_TIMEOUT' || requestedNoExtensions) throw error;
    // The original loader has no cancellation API. Do not await it again;
    // isolate the session on a fresh loader that excludes configured third
    // party extensions so the archive can still be opened and rendered.
    settingsManager = sdk.SettingsManager.create(cwd, agentDir);
    resourceLoader = new sdk.DefaultResourceLoader({
      ...loaderOptions, settingsManager, noExtensions: true,
    });
    await reloadResourceLoader(resourceLoader, resourceLoadTimeoutMs(options));
    degraded = true;
  }
  /* ResourceLoader may reload/normalize settings. Apply runtime policies after
     that pass so the values used by AgentSession are the final values. */
  configureSoduWorkRetryPolicy(settingsManager);
  require('./context-recovery').configure(settingsManager);
  const loaded = resourceLoader.getSkills();
  const skillWarnings = [];
  const skills = verifySkills(dirs, loaded, { optionalSkillDirs: options?.optionalSkillDirs, warnings: skillWarnings });
  return {
    settingsManager,
    resourceLoader,
    skillReadScope: require('../access-control/resource-read-scope').fromSkills(skills),
    skills: Object.freeze(skills.map((item) => item.name || path.basename(item.filePath || ''))),
    skillWarnings: Object.freeze(skillWarnings),
    degraded,
    extensionsDeferred: requestedNoExtensions,
    extensionTimeoutMs: resourceLoadTimeoutMs(options),
  };
}

async function initializeExtensions(session, resources) {
  await require('./extension-lifecycle').initialize(session, { timeoutMs: resources.extensionTimeoutMs });
  // The public bind operation also runs resources_discover. Keep SoduWork's read
  // scope and displayed skill names aligned with the SDK's resulting catalog.
  const skills = resources.resourceLoader.getSkills().skills || [];
  resources.skillReadScope = require('../access-control/resource-read-scope').fromSkills(skills);
  resources.skills = Object.freeze(skills.map(item => item.name || path.basename(item.filePath || '')));
}

async function independentReview(options) {
  const value = options || {};
  const deterministic = goalReview.machine({
    cwd: value.cwd,
    profile: value.profile,
    spec: value.spec,
    evidence: value.evidence,
    outputSnapshot: value.outputSnapshot,
  });
  if (!deterministic.pass) {
    return goalReview.outcome('', { deterministic });
  }
  const reviewEvidence = {
    ...value.evidence, deterministicChecks: deterministic.checks,
  };
  let reviewSession = null;
  let unsubscribe = null;
  try {
    if (!value.sdk.SessionManager || typeof value.sdk.SessionManager.inMemory !== 'function') {
      throw new Error('in-memory verifier session is unavailable');
    }
    const resources = await sessionResources(
      value.sdk, value.cwd, value.agentDir, [],
      [goalQuality.verifierSystemPrompt()], { accessPolicy: value.accessPolicy },
    );
    const created = await value.sdk.createAgentSession({
      model: value.model, modelRuntime: value.runtime,
      cwd: value.cwd, agentDir: value.agentDir,
      settingsManager: resources.settingsManager,
      resourceLoader: resources.resourceLoader,
      sessionManager: value.sdk.SessionManager.inMemory(),
      tools: ['read', 'list', 'glob', 'grep'],
      thinkingLevel: 'medium',
    });
    reviewSession = created.session;
    // This hidden verifier has no approval UI. It may inspect only the same
    // workspace; uncertain or external operations are refused immediately.
    const accessRules = require('../access-control/policy');
    const accessPolicy = accessRules.normalize(value.accessPolicy, value.cwd);
    if (accessPolicy && accessPolicy.mode !== 'full') {
      const previous = reviewSession.agent?.beforeToolCall;
      if (typeof previous !== 'function') throw new Error('Verifier runtime does not support access restrictions');
      const readonly = { ...accessPolicy, mode: 'readonly' };
      reviewSession.agent.beforeToolCall = async (context, signal) => {
        const existing = await previous.call(reviewSession.agent, context, signal);
        if (existing?.block) return existing;
        const operation = accessRules.operation(readonly,
          String(context.toolCall?.name || ''), context.args || {}, value.cwd);
        if (signal?.aborted || operation.verdict !== 'allow') {
          return { block: true, reason: 'The internal verifier may only read permitted files in the current workspace.' };
        }
        return existing;
      };
    }
    const verifierAcc = stream.create();
    unsubscribe = reviewSession.subscribe((event) => {
      try { verifierAcc.push(event); } catch (error) { /* isolated verifier */ }
    });
    let reviewed = null;
    let reviewImages = [];
    try {
      const rows = Array.isArray(value.outputSnapshot && value.outputSnapshot.files)
        ? value.outputSnapshot.files.slice() : [];
      const evidenceDir = path.join(value.cwd, '.soduwork', 'evidence');
      try {
        fs.readdirSync(evidenceDir, { withFileTypes: true }).forEach((entry) => {
          if (!entry.isFile() || !/\.(?:png|jpe?g|webp)$/i.test(entry.name)) return;
          const target = path.join(evidenceDir, entry.name);
          const stat = fs.statSync(target);
          rows.push({
            path: target, relative: '.soduwork/evidence/' + entry.name,
            name: entry.name, size: stat.size, mimeType: '',
          });
        });
      } catch (error) { /* UI evidence is optional for non-visual work */ }
      const seen = new Set();
      const visualFiles = rows.filter((file) => {
        const target = String(file && file.path || '');
        if (!/\.(?:png|jpe?g|webp)$/i.test(target) || seen.has(target)) return false;
        seen.add(target); return true;
      }).slice(0, 6);
      reviewImages = await attachments.images(visualFiles);
    } catch (error) { reviewImages = []; }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0
        ? goalQuality.verificationPrompt(value.goal, value.spec, reviewEvidence)
        : [
            'Your previous verifier response was not valid JSON.',
            'Review the same unchanged workspace. Return exactly one JSON object',
            'with verdict, summary, every required score, gaps, evidence and deliverables. No markdown.',
          ].join(' ');
      await require('./background-process').run(() => reviewSession.prompt(prompt, { images: reviewImages }));
      reviewed = goalReview.outcome(
        sessionHelpers.lastAssistantText(verifierAcc.snapshot()), { deterministic, spec: value.spec });
      if (reviewed.source !== 'verifier-protocol') return reviewed;
    }
    return {
      ...reviewed,
      retryable: false,
      reason: '\u72ec\u7acb\u590d\u6838\u8fde\u7eed\u4e24\u6b21\u6ca1\u6709\u8fd4\u56de\u6709\u6548\u7ed3\u8bba\uff0c\u5df2\u505c\u6b62\u907f\u514d\u9519\u8bef\u653e\u884c',
    };
  } catch (error) {
    return {
      phase: 'blocked', retryable: false, source: 'verifier-runtime',
      reason: '\u72ec\u7acb\u590d\u6838\u5668\u6ca1\u6709\u6b63\u5e38\u8fd0\u884c\uff0c\u4e0d\u80fd\u628a\u672a\u590d\u6838\u7684\u7ed3\u679c\u5f53\u4f5c\u4ea4\u4ed8',
      gaps: [{
        check: 'verifier_runtime',
        reason: String((error && error.message) || error),
        action: '\u6062\u590d\u72ec\u7acb\u590d\u6838\u4f1a\u8bdd\u540e\u91cd\u8bd5',
      }],
      review: null, deterministic,
    };
  } finally {
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (error) { /* ignore */ }
    try { if (reviewSession) reviewSession.dispose(); } catch (error) { /* ignore */ }
  }
}
module.exports = { sessionResources, initializeExtensions, independentReview, verifySkills, configureSoduWorkRetryPolicy };
