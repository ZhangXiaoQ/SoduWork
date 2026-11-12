'use strict';

// Fixed routes and fields only: renderer input never chooses an authenticated URL.
const actions = Object.freeze({
  password: { path: '/login/password', session: true },
  emailCode: { path: '/login/email-code', session: true },
  register: { path: '/register', session: true },
  emailChallenge: { path: '/email-challenges', session: false },
  emailChallengeStatus: { path: '/email-challenges', session: false, method: 'GET' },
  resetPassword: { path: '/password/reset', session: false, reset: true },
});

function request(action, raw, device) {
  const spec = actions[action];
  if (!spec) throw Error('不支持的账号操作');
  if (action === 'emailChallengeStatus') {
    const challengeId = String(raw.challengeId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(challengeId)) throw Error('验证码请求无效，请重新获取');
    return { ...spec, path: '/api/v1/client-auth' + spec.path + '/' + encodeURIComponent(challengeId) +
      '?device=' + encodeURIComponent(device) };
  }
  const body = { device, email: String(raw.email || '').trim() };
  if (action === 'password' || action === 'register') body.password = String(raw.password || '');
  if (['emailCode', 'register', 'resetPassword'].includes(action)) {
    body.challengeId = String(raw.challengeId || '');
    body.code = String(raw.code || '');
  }
  if (action === 'emailChallenge') body.purpose = String(raw.purpose || '');
  if (action === 'resetPassword') body.newPassword = String(raw.newPassword || '');
  if (action === 'register') {
    body.consents = { terms: String(raw.consents?.terms || ''), privacy: String(raw.consents?.privacy || '') };
    if (raw.consentLocales) body.consentLocales = { terms: String(raw.consentLocales.terms || '').slice(0, 32), privacy: String(raw.consentLocales.privacy || '').slice(0, 32) };
    body.displayName = String(raw.displayName || '').trim().slice(0, 64);
  }
  if (spec.session) for (const key of ['name', 'platform', 'version', 'workRoot']) {
    if (raw[key]) body[key] = String(raw[key]).trim().slice(0, key === 'workRoot' ? 400 : 64);
  }
  return { ...spec, path: '/api/v1/client-auth' + spec.path, body };
}

module.exports = { request };
