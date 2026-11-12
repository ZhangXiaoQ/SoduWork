'use strict';
/*
 * Personal Info (account center) i18n: real locale catalogs + real i18n runtime
 * verify the account surfaces translate in en/ja/ko, including dynamically
 * concatenated fragments (resend countdown, last-active stamp, deletion errors,
 * legal versions) and the deletion-confirmation placeholder guard.
 */
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const CORE = path.join(__dirname, '../core/');
const LOCALES = path.join(CORE, 'locales/');
const AUTH = path.join(__dirname, '../components/client-auth/');
const LOCALE_FILES = JSON.parse(fs.readFileSync(path.join(LOCALES, 'manifest.json'), 'utf8'))
  .filter(name => /^(en|ja|ko)-/.test(name));

const ACCOUNT_PHRASES = [
  // page chrome + nav
  '个人信息', '请先登录后管理个人信息。', '当前账号', '编辑个人资料', '个人头像',
  '账号安全', '登录设备', '隐私与数据',
  // security
  '邮箱用于登录、找回密码与重要的安全通知。', '登录邮箱', '尚未绑定邮箱', '更换邮箱', '绑定邮箱',
  '账号 ID', '登录密码', '通过邮箱验证码设置新密码，所有已登录设备需要重新登录',
  '修改后，所有已登录设备需要重新登录', '设置新密码',
  // sign-out confirmation
  '退出登录', '退出后，这台电脑需要重新登录才能使用 SoduWork。', '确定退出',
  // profile editor
  '昵称', '重新上传头像', '移除头像', 'PNG、JPEG、WebP · 5 MB 以内',
  '昵称不会改变你的账号或本机设备名称。', '保存资料', '保存后移除头像。',
  '请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片。', '头像已准备好，保存后生效。',
  '无法读取这张图片，请更换图片。', '昵称不能为空。',
  // email change
  '更换登录邮箱', '绑定登录邮箱', '验证新邮箱及当前账号后生效。完成后所有设备将退出登录。',
  '新邮箱', '新邮箱验证码', '6 位验证码', '获取验证码', '请输入有效的新邮箱。',
  '新邮箱验证码发送请求已受理，请查看邮箱。', '请获取并填写新邮箱的 6 位验证码。', '验证身份并更换',
  // devices
  '可删除其他登录设备。删除后，该设备需要重新登录。', '暂无活动记录', '删除设备', '当前设备',
  '退出后需重新验证身份',
  '该设备已删除。', '暂无设备记录',
  // privacy + deletion
  '隐私与个人数据', '查看协议与政策，或管理账号注销。', '协议与政策', '查看内容与版本',
  '用户协议', '隐私政策', '注销后无法登录；团队业务记录按必要范围保留',
  '注销会清理账号资料、个人资料库文件与个人记忆，并撤销登录。组织需求、已共享材料和必要审计记录保留；设备本地对话、文件及第三方服务的数据需在对应设备或服务中管理。',
  '注销账号', '即将注销', '。提交后所有设备将退出登录，账号不可恢复。',
  '团队业务记录和必要的审计记录可能保留。本机聊天、下载与工作目录不会由服务器删除，请先备份或自行清理。',
  '输入“注销账号”确认', '请完整输入“注销账号”。', '验证身份并注销',
  '正在验证身份…', '正在注销…', '正在提交注销申请，请稍候。', '正在退出登录…',
  '注销申请已受理，数据清理将在后台继续。',
  // re-authentication dialog
  '确认是你本人', '更换登录邮箱前，请验证身份。验证仅用于这一次操作。',
  '设置新密码前，请验证身份。验证仅用于这一次操作。', '导出个人数据前，请验证身份。验证仅用于这一次操作。',
  '注销账号前，请验证身份。验证仅用于这一次操作。', '删除设备前，请验证身份。验证仅用于这一次操作。',
  '此操作前，请验证身份。验证仅用于这一次操作。', '密码验证', '邮箱验证', '邮箱验证码',
  '向已验证的登录邮箱发送验证码', '验证并继续', '正在发送…', '验证码发送请求已受理，请查看邮箱。',
  '请获取并填写 6 位验证码。', '正在验证…', '服务未返回有效的身份确认凭据', '已取消身份验证',
  '导出个人数据',
  // shared ui
  '操作未完成，请重试', '关闭对话框', '协议内容暂未加载，请稍后重试。',
  '系统消息', '用户协议已更新', '隐私政策已更新',
  '和', '原文', '返回注册', '返回找回密码', '协议目录', '正文语言', '我的确认记录', '正在加载协议…',
  '版本：{value}', '更新日期：{value}', '生效日期：{value}',
  '暂无当前界面语言的版本，以下为{language}原文。',
  // dynamic templates
  '{n} 秒后重发', '最近活动 {value}', '设备已删除，刷新列表失败：{message}', '版本：{version}',
];

const TEMPLATE_EXPECT = {
  'en-US': { resend: 'Resend in 60s', version: 'Version: 1.13.5', last: 'Last active 2026/10/26 02:18', error: 'Device removed, but refreshing the list failed: timeout' },
  'ja-JP': { resend: '60 秒後に再送信', version: 'バージョン：1.13.5', last: '最終アクティビティ 2026/10/26 02:18', error: 'デバイスは削除されましたが、一覧の更新に失敗しました: timeout' },
  'ko-KR': { resend: '60초 후 재전송', version: '버전: 1.13.5', last: '마지막 활동 2026/10/26 02:18', error: '기기는 삭제되었지만 목록 새로 고침에 실패했습니다: timeout' },
};

const BACKEND_DELETION_SUMMARY = '注销会清理账号资料、个人资料库文件与个人记忆，并撤销登录；组织需求、已共享材料和必要审计记录保留。设备本地对话、文件及第三方服务的数据需在对应设备或服务中管理。';

function bootI18n() {
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      documentElement: { lang: '', dataset: {}, style: { setProperty() {} } },
      readyState: 'complete', body: null, title: '',
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null }),
      getElementById: () => null,
    },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    cfg: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const run = (file, base) => vm.runInContext(
    fs.readFileSync(path.join(base, file), 'utf8'), sandbox, { filename: file });
  run('locale-registry.js', LOCALES);
  for (const file of LOCALE_FILES) run(file, LOCALES);
  run('i18n-dom.js', CORE);
  run('i18n.js', CORE);
  return sandbox;
}

const read = name => fs.readFileSync(path.join(AUTH, name), 'utf8');

test('account center phrase catalog covers en/ja/ko completely', () => {
  const sandbox = bootI18n();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    sandbox.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false });
    const catalog = sandbox.SoduWorkLocaleMessages[locale] || {};
    const missing = ACCOUNT_PHRASES.filter(phrase => !Object.hasOwn(catalog, phrase));
    assert.deepEqual(missing, [], locale + ' 缺少的个人信息页词条');
  }
});

test('dynamic fragments translate through templates in all three languages', () => {
  const sandbox = bootI18n();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    sandbox.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false });
    const T = value => sandbox.SoduWorkI18n.translateText(value);
    assert.equal(T('60 秒后重发'), TEMPLATE_EXPECT[locale].resend, locale + ' 重发倒计时');
    assert.equal(T('版本：1.13.5'), TEMPLATE_EXPECT[locale].version, locale + ' 协议版本行');
    assert.equal(T('最近活动 2026/10/26 02:18'), TEMPLATE_EXPECT[locale].last, locale + ' 设备最近活动');
    assert.equal(T('设备已删除，刷新列表失败：timeout'), TEMPLATE_EXPECT[locale].error, locale + ' 设备删除错误');
  }
});

test('fixed account phrases translate without leaving Chinese residue', () => {
  const sandbox = bootI18n();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    sandbox.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false });
    const T = value => sandbox.SoduWorkI18n.translateText(value);
    assert.equal(T('即将注销').includes('即将注销'), false, locale + ' 注销开场句必须翻译');
    assert.equal(T('确认是你本人').includes('确认是你本人'), false, locale + ' 验证弹窗标题必须翻译');
    assert.equal(T('退出后需重新验证身份').includes('退出后需重新验证身份'), false, locale + ' 当前设备提示必须翻译');
    assert.equal(T('退出后，这台电脑需要重新登录才能使用 SoduWork。').includes('退出后，这台电脑需要重新登录才能使用 SoduWork。'), false,
      locale + ' 退出确认正文必须翻译');
    assert.equal(T('确定退出').includes('确定退出'), false, locale + ' 退出确认按钮必须翻译');
    assert.equal(T('输入“注销账号”确认').includes('输入'), false, locale + ' 注销确认提示必须翻译');
    // The literal keyword the user must type stays verbatim in every locale.
    assert.ok(T('输入“注销账号”确认').includes('注销账号'), locale + ' 确认关键词保持原文');
  }
  sandbox.SoduWorkI18n.setLocale('en-US', { persist: false, broadcast: false });
  assert.equal(sandbox.SoduWorkI18n.translateText('注销账号'), 'Delete account');
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    sandbox.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false });
    assert.notEqual(sandbox.SoduWorkI18n.translateText(BACKEND_DELETION_SUMMARY), BACKEND_DELETION_SUMMARY,
      locale + ' 后端注销范围说明必须使用对应语言');
  }
});

test('deletion confirmation placeholder is exempted from phrase translation', () => {
  // The input's placeholder shows the exact keyword to type ("注销账号");
  // data-user-attributes must keep the adapter from translating it to "Delete account".
  const source = read('account-center.js');
  assert.match(source, /placeholder="注销账号" data-user-attributes="placeholder"/);
  assert.doesNotMatch(source, /note\.textContent === '请完整输入“注销账号”。'/);
});

test('dialog close buttons use the unambiguous close-dialog phrase', () => {
  assert.match(read('account-ui.js'), /data-ac-close aria-label="关闭对话框"/);
  const auth = read('client-auth.js');
  assert.match(auth, /class="soduwork-pwd-close" aria-label="关闭对话框" title="关闭对话框"/);
});

test('account nav entry resolves in the keyed dictionary', () => {
  const sandbox = bootI18n();
  for (const [locale, expected] of [['en-US', 'Personal info'], ['ja-JP', '個人情報'], ['ko-KR', '개인 정보']]) {
    sandbox.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false });
    assert.equal(sandbox.SoduWorkI18n.t('nav.account', '个人信息'), expected, locale + ' 侧栏导航');
  }
});
