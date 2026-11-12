'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, patchSource } = require('../scripts/patch-pi-retry-schedule.cjs');

test('Pi retry schedule patch is idempotent and preserves exponential fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-retry-'));
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  const settingsFile = path.join(dir, 'core', 'settings-manager.js');
  const agentFile = path.join(dir, 'core', 'agent-session.js');
  fs.writeFileSync(settingsFile, [
    '    getRetrySettings() {',
    '        return {',
    '            enabled: this.getRetryEnabled(),',
    '            maxRetries: this.settings.retry?.maxRetries ?? 3,',
    '            baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,',
    '        };',
    '    }',
  ].join('\n'));
  fs.writeFileSync(agentFile, [
    '        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);',
  ].join('\n'));
  const firstSettings = patchSource(settingsFile);
  const secondSettings = patchSource(settingsFile);
  const firstAgent = patchSource(agentFile);
  const secondAgent = patchSource(agentFile);
  const settingsSource = fs.readFileSync(settingsFile, 'utf8');
  const agentSource = fs.readFileSync(agentFile, 'utf8');
  assert.equal(firstSettings.patched, true);
  assert.equal(secondSettings.already, true);
  assert.equal(firstAgent.patched, true);
  assert.equal(secondAgent.already, true);
  assert.equal(settingsSource.includes(MARKER), true);
  assert.match(settingsSource, /delayScheduleMs:/);
  assert.equal(agentSource.includes(MARKER), true);
  assert.match(agentSource, /Number\.isFinite\(scheduledDelay\)/);
  assert.match(agentSource, /settings\.baseDelayMs \* 2 \*\* \(this\._retryAttempt - 1\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('current SDK retry helpers preserve fallback and cap an explicit schedule', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-retry-current-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'core'));
  const settingsFile = path.join(dir, 'core/settings-manager.js');
  const agentFile = path.join(dir, 'core/agent-session.js');
  fs.writeFileSync(settingsFile, '            baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,');
  fs.writeFileSync(agentFile, '        const delayMs = retryDelayMs(settings, this._retryAttempt);');
  assert.equal(patchSource(settingsFile).patched, true);
  assert.equal(patchSource(agentFile).patched, true);
  const delay = new Function('settings', 'retryDelayMs', fs.readFileSync(agentFile, 'utf8') + '; return delayMs;');
  assert.equal(delay.call({_retryAttempt: 1}, {delayScheduleMs: [240000], maxAgentDelayMs: 60000}, () => 2000), 60000);
  assert.equal(delay.call({_retryAttempt: 1}, {delayScheduleMs: [15000], maxAgentDelayMs: 60000}, () => 2000), 15000);
  assert.equal(delay.call({_retryAttempt: 1}, {}, () => 2000), 2000);
  assert.equal(patchSource(settingsFile).already, true);
  assert.equal(patchSource(agentFile).already, true);
});
