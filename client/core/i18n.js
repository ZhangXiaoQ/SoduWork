/* Shared client locale state. Message catalogs are separate from persistence
   and loaded in manifest order by both desktop surfaces. */
(function (global) {
  'use strict';
  const builtInLocaleDefinitions = {
    'zh-CN': { label: '简体中文', fallback: null },
    'en-US': { label: 'English', fallback: 'zh-CN' },
    // Keep built-in metadata in sync with shipped locale packs.  Legacy
    // windows can start with a missing or older registry script; these entries
    // keep supported packs selectable instead of collapsing back to Chinese.
    'ja-JP': { label: '日本語', fallback: 'en-US' },
    'ko-KR': { label: '한국어', fallback: 'en-US' },
  };
  // Merge rather than replace: an older cached registry may know only zh/en,
  // while this renderer already has the newer packs on disk.
  const localeDefinitions = Object.assign({}, builtInLocaleDefinitions, global.SoduWorkLocaleRegistry?.locales || {});
  const LOCALES = Object.freeze(Object.fromEntries(Object.entries(localeDefinitions).map(([id, item]) => [id, item.label])));
  const SOURCE_LOCALE = 'zh-CN';
  const DEFAULT_LOCALE = 'en-US';
  const FALLBACKS = Object.freeze(Object.fromEntries(Object.entries(localeDefinitions).map(([id, item]) => [id, item.fallback || SOURCE_LOCALE])));
  const KEY = 'locale';
  const DICT = {
    'zh-CN': {
      "releaseNotes.title": "SoduWork {version} · 此版本新内容",
      "releaseNotes.updated": "SoduWork 已更新至 {version}",
      "releaseNotes.history": "查看历史更新",
      "releaseNotes.backToCurrent": "返回当前版本",
      "releaseNotes.dismiss": "知道了",
      "releaseNotes.close": "关闭",
      "releaseNotes.fallback": "此说明暂未提供当前语言，现显示可用原文。",
      "releaseNotes.empty": "此版本暂无可用的更新说明。",
      "releaseNotes.error": "暂时无法读取或保存更新说明，请稍后重试。",
      "eyebrow.task_workspace": "需求工作区",
      "eyebrow.preferences": "偏好设置",
      "eyebrow.create_task": "创建需求",
      "eyebrow.workspace_access": "工作区访问",
      "eyebrow.briefs": "简报",
      "eyebrow.personal_brief": "个人简报",
      "eyebrow.evidence": "证据",
      "eyebrow.team_brief": "团队简报",
      "eyebrow.teams": "团队",
      "eyebrow.sources": "来源",
      "eyebrow.agent_runtime": "智能体运行环境",
      "eyebrow.my_agents": "我的智能体",
      "eyebrow.live_task_queue": "实时需求队列",
      "eyebrow.current_stage": "当前阶段",
      "eyebrow.live_activity": "实时动态",
      "eyebrow.live_inspector": "实时详情",
      "eyebrow.capability_center": "能力中心",
      "eyebrow.source_control": "代码管理",
      "eyebrow.execution": "执行",
      "eyebrow.ai_team": "AI 团队",
      "eyebrow.ready": "就绪",
      "eyebrow.notifications": "通知",
      "eyebrow.tasks": "需求",
      "eyebrow.model_routing": "模型路由",
      "eyebrow.model_connections": "模型连接",
      "eyebrow.automation": "自动化",
      "eyebrow.capabilities": "能力",
      "eyebrow.personal_memory": "个人记忆",
      "eyebrow.local_document": "本地文档",
      "eyebrow.personal_ai_usage": "个人 AI 用量",
      "eyebrow.work_scenes": "工作场景",
      "eyebrow.agent_mix": "智能体分布",
      "eyebrow.recent_activity": "最近动态",
      "eyebrow.delivery_readiness": "交付准备",
      "eyebrow.ready_to_deliver": "可以交付",
      "eyebrow.requirement_brief": "需求概览",
      "eyebrow.requirement_detail": "需求详情",
      "eyebrow.plugin_work_surface": "插件工作台",
      "eyebrow.plugin_setup": "插件设置",
      "eyebrow.project_context": "项目上下文",
      "eyebrow.upstream_handoff": "上游交接",
      "eyebrow.stage_detail": "阶段详情",
      "eyebrow.delivery": "交付",
      "eyebrow.task_journey": "需求进展",
      language: '语言', languageZh: '简体中文', languageEn: 'English', languageJa: '日本語', languageKo: '한국어',
      'console.task': '{title}', 'console.taskWithSession': '{title}（有会话）',
      'console.unnamed': '未命名', 'console.unnamedWithSession': '未命名（有会话）',
      settings: '设置', preferences: '偏好', my: '我的',
      settingsSub: '管理客户端与工作目录', languageHint: '界面语言',
      languageNote: '选择后立即应用，后续可扩展更多语言。',
      home: '首页', update: '更新', updateRestart: '重启并更新',
      backHome: '返回主页', loading: '加载中…', 'chat.opening': '正在打开对话…',
      'nav.create': '新对话', 'nav.pichat': '新建对话', 'nav.history': '需求池',
      'nav.briefs': '简报', 'nav.team': '团队',
      'nav.schedules': '自动化', 'nav.skills': '插件', 'nav.models': '我的模型',
      'nav.agents': 'Agent 管理', 'nav.codeacct': '代码账号', 'nav.account': '个人信息', 'nav.memory': '我的记忆',
      'nav.usage': '我的用量', 'nav.notices': '通知', 'nav.skin': '外观',
      'nav.aidesk': 'AI 团队', 'group.collaboration': '协作', 'group.ai': 'AI 与账号',
      'group.preferences': '偏好', 'rail.more': '更多', 'rail.home': '主页',
      newChat: '新对话', pinned: '置顶', recentChats: '最近聊天', recentTasks: '最近需求',
      connected: '已连接 SoduWork 服务', connecting: '服务连接中',
      'models.available': '{count} 个可选模型', 'models.types': '{chat} 个聊天 · {image} 个图片 · {video} 个视频',
      'models.providers': '{count} 家服务已配置 · {personal} 个使用个人额度',
      'models.count': '{count} 模型', 'models.itemCount': '{count} 个',
      'models.keyLength': '个人 Key 已配置 · {count} 位，请求会优先使用你的个人额度',
      'models.noResults': '没有匹配“{query}”的服务或模型',
    },
    'en-US': {
      "releaseNotes.title": "What’s new in SoduWork {version}",
      "releaseNotes.updated": "SoduWork has been updated to {version}",
      "releaseNotes.history": "View release history",
      "releaseNotes.backToCurrent": "Back to current version",
      "releaseNotes.dismiss": "Got it",
      "releaseNotes.close": "Close",
      "releaseNotes.fallback": "These notes are not available in your language. Showing the available original text.",
      "releaseNotes.empty": "No release notes are available for this version.",
      "releaseNotes.error": "Unable to load or save release notes. Please try again later.",
      "eyebrow.task_workspace": "ISSUE WORKSPACE",
      "eyebrow.preferences": "PREFERENCES",
      "eyebrow.create_task": "CREATE ISSUE",
      "eyebrow.workspace_access": "WORKSPACE ACCESS",
      "eyebrow.briefs": "BRIEFS",
      "eyebrow.personal_brief": "PERSONAL BRIEF",
      "eyebrow.evidence": "EVIDENCE",
      "eyebrow.team_brief": "TEAM BRIEF",
      "eyebrow.teams": "TEAMS",
      "eyebrow.sources": "SOURCES",
      "eyebrow.agent_runtime": "AGENT RUNTIME",
      "eyebrow.my_agents": "MY AGENTS",
      "eyebrow.live_task_queue": "LIVE ISSUE QUEUE",
      "eyebrow.current_stage": "CURRENT STAGE",
      "eyebrow.live_activity": "LIVE ACTIVITY",
      "eyebrow.live_inspector": "LIVE INSPECTOR",
      "eyebrow.capability_center": "CAPABILITY CENTER",
      "eyebrow.source_control": "SOURCE CONTROL",
      "eyebrow.execution": "EXECUTION",
      "eyebrow.ai_team": "AI TEAM",
      "eyebrow.ready": "READY",
      "eyebrow.notifications": "NOTIFICATIONS",
      "eyebrow.tasks": "ISSUES",
      "eyebrow.model_routing": "MODEL ROUTING",
      "eyebrow.model_connections": "MODEL CONNECTIONS",
      "eyebrow.automation": "AUTOMATION",
      "eyebrow.capabilities": "CAPABILITIES",
      "eyebrow.personal_memory": "PERSONAL MEMORY",
      "eyebrow.local_document": "LOCAL DOCUMENT",
      "eyebrow.personal_ai_usage": "PERSONAL AI USAGE",
      "eyebrow.work_scenes": "WORK SCENES",
      "eyebrow.agent_mix": "AGENT MIX",
      "eyebrow.recent_activity": "RECENT ACTIVITY",
      "eyebrow.delivery_readiness": "DELIVERY READINESS",
      "eyebrow.ready_to_deliver": "READY TO DELIVER",
      "eyebrow.requirement_brief": "ISSUE OVERVIEW",
      "eyebrow.requirement_detail": "ISSUE DETAILS",
      "eyebrow.plugin_work_surface": "PLUGIN WORK SURFACE",
      "eyebrow.plugin_setup": "PLUGIN SETUP",
      "eyebrow.project_context": "PROJECT CONTEXT",
      "eyebrow.upstream_handoff": "UPSTREAM HANDOFF",
      "eyebrow.stage_detail": "STAGE DETAIL",
      "eyebrow.delivery": "DELIVERY",
      "eyebrow.task_journey": "ISSUE PROGRESS",
      language: 'Language', languageZh: '简体中文', languageEn: 'English', languageJa: '日本語', languageKo: '한국어',
      'console.task': '{title}', 'console.taskWithSession': '{title} (has chat)',
      'console.unnamed': 'Untitled', 'console.unnamedWithSession': 'Untitled (has chat)',
      settings: 'Settings', preferences: 'Preferences', my: 'My',
      settingsSub: 'Manage the client and work directory', languageHint: 'Interface language',
      languageNote: 'Applied immediately. More languages can be added later.',
      home: 'Home', update: 'Update', updateRestart: 'Restart and update',
      backHome: 'Back to home', loading: 'Loading…', 'chat.opening': 'Opening chat…',
      'nav.create': 'New chat', 'nav.pichat': 'New conversation', 'nav.history': 'Issues',
      'nav.briefs': 'Briefs', 'nav.team': 'Team',
      'nav.schedules': 'Automation', 'nav.skills': 'Plugins', 'nav.models': 'My models',
      'nav.agents': 'Agent management', 'nav.codeacct': 'Code accounts', 'nav.account': 'Personal info', 'nav.memory': 'My memory',
      'nav.usage': 'My usage', 'nav.notices': 'Notifications', 'nav.skin': 'Appearance',
      'nav.aidesk': 'AI team', 'group.collaboration': 'Collaboration', 'group.ai': 'AI and account',
      'group.preferences': 'Preferences', 'rail.more': 'More', 'rail.home': 'Home',
      newChat: 'New chat', pinned: 'Pinned', recentChats: 'Recent chats', recentTasks: 'Recent issues',
      connected: 'Connected to SoduWork', connecting: 'Connecting to service',
      'models.available': 'Available models: {count}', 'models.types': '{chat} chat · {image} image · {video} video',
      'models.providers': '{count} providers configured · {personal} using personal quota',
      'models.count': 'Models: {count}', 'models.itemCount': '{count}',
      'models.keyLength': 'Personal key configured · {count} characters. Requests use your personal quota first.',
      'models.noResults': 'No providers or models match “{query}”',
    },
  };
  // The English keyed table remains the complete contract. New locale packs
  // can start with the highest-value copy and safely inherit English until all
  // source phrases have been translated; Chinese is only the final fallback.
  const localeDict = {
    'ja-JP': Object.freeze({ ...DICT['en-US'], "eyebrow.task_workspace":"ISSUE ワークスペース","eyebrow.preferences":"環境設定","eyebrow.create_task":"ISSUE 作成","eyebrow.workspace_access":"ワークスペースアクセス","eyebrow.briefs":"ブリーフ","eyebrow.personal_brief":"個人ブリーフ","eyebrow.evidence":"エビデンス","eyebrow.team_brief":"チームブリーフ","eyebrow.teams":"チーム","eyebrow.sources":"ソース","eyebrow.agent_runtime":"AGENT ランタイム","eyebrow.my_agents":"マイ Agent","eyebrow.live_task_queue":"リアルタイム ISSUE キュー","eyebrow.current_stage":"現在のステージ","eyebrow.live_activity":"リアルタイムアクティビティ","eyebrow.live_inspector":"リアルタイム詳細","eyebrow.capability_center":"能力センター","eyebrow.source_control":"ソース管理","eyebrow.execution":"実行","eyebrow.ai_team":"AI チーム","eyebrow.ready":"準備完了","eyebrow.notifications":"通知","eyebrow.tasks":"ISSUE","eyebrow.model_routing":"モデルルーティング","eyebrow.model_connections":"モデル接続","eyebrow.automation":"オートメーション","eyebrow.capabilities":"能力","eyebrow.personal_memory":"個人メモリー","eyebrow.local_document":"ローカル文書","eyebrow.personal_ai_usage":"個人 AI 使用量","eyebrow.work_scenes":"ワークシーン","eyebrow.agent_mix":"AGENT 構成","eyebrow.recent_activity":"最近のアクティビティ","eyebrow.delivery_readiness":"納品準備","eyebrow.ready_to_deliver":"納品可能","eyebrow.requirement_brief":"ISSUE 概要","eyebrow.requirement_detail":"ISSUE 詳細","eyebrow.plugin_work_surface":"プラグイン作業台","eyebrow.plugin_setup":"プラグイン設定","eyebrow.project_context":"プロジェクト文脈","eyebrow.upstream_handoff":"上流引き継ぎ","eyebrow.stage_detail":"ステージ詳細","eyebrow.delivery":"納品","eyebrow.task_journey":"ISSUE の進行","language":"言語","languageZh":"簡体字中国語","languageEn":"English","languageJa":"日本語","languageKo":"한국어","console.task":"{title}","console.taskWithSession":"{title}（会話あり）","console.unnamed":"無題","console.unnamedWithSession":"無題（会話あり）","settings":"設定","preferences":"環境設定","my":"マイ","settingsSub":"クライアントと作業ディレクトリを管理","languageHint":"画面の言語","languageNote":"選択後すぐに適用されます。対応言語は今後拡張予定です。","home":"ホーム","update":"更新","updateRestart":"再起動して更新","backHome":"ホームへ戻る","loading":"読み込み中…","chat.opening":"対話を開いています…","nav.create":"新しいチャット","nav.pichat":"新しい対話","nav.history":"Issue プール","nav.briefs":"ブリーフ","nav.team":"チーム","nav.schedules":"オートメーション","nav.skills":"プラグイン","nav.models":"マイモデル","nav.agents":"Agent 管理","nav.codeacct":"コードアカウント","nav.account":"個人情報","nav.memory":"マイメモリー","nav.usage":"マイ使用量","nav.notices":"通知","nav.skin":"外観","nav.aidesk":"AI チーム","group.collaboration":"コラボレーション","group.ai":"AI とアカウント","group.preferences":"環境設定","rail.more":"もっと見る","rail.home":"ホーム","newChat":"新しいチャット","pinned":"ピン留め","recentChats":"最近のチャット","recentTasks":"最近の課題","connected":"SoduWork サービスに接続済み","connecting":"サービスに接続中","models.available":"利用可能なモデル: {count} 件","models.types":"チャット {chat} · 画像 {image} · 動画 {video}","models.providers":"{count} 社のサービスを設定済み · {personal} 件は個人枠を使用","models.count":"モデル {count} 件","models.itemCount":"{count} 件","models.keyLength":"個人キー設定済み · {count} 桁。リクエストは先に個人枠を使用します","models.noResults":"「{query}」に一致するサービスやモデルがありません" }),
    'ko-KR': Object.freeze({ ...DICT['en-US'], "eyebrow.task_workspace":"ISSUE 작업 공간","eyebrow.preferences":"환경 설정","eyebrow.create_task":"ISSUE 만들기","eyebrow.workspace_access":"작업 공간 접근","eyebrow.briefs":"브리프","eyebrow.personal_brief":"개인 브리프","eyebrow.evidence":"증거","eyebrow.team_brief":"팀 브리프","eyebrow.teams":"팀","eyebrow.sources":"출처","eyebrow.agent_runtime":"AGENT 실행 환경","eyebrow.my_agents":"내 Agent","eyebrow.live_task_queue":"실시간 ISSUE 대기줄","eyebrow.current_stage":"지금 단계","eyebrow.live_activity":"실시간 활동","eyebrow.live_inspector":"실시간 세부","eyebrow.capability_center":"능력 센터","eyebrow.source_control":"소스 관리","eyebrow.execution":"실행","eyebrow.ai_team":"AI 팀","eyebrow.ready":"준비 완료","eyebrow.notifications":"알림","eyebrow.tasks":"ISSUE","eyebrow.model_routing":"모델 안내","eyebrow.model_connections":"모델 연결","eyebrow.automation":"자동화","eyebrow.capabilities":"능력","eyebrow.personal_memory":"개인 기억","eyebrow.local_document":"이 기기 문서","eyebrow.personal_ai_usage":"개인 AI 사용량","eyebrow.work_scenes":"작업 장면","eyebrow.agent_mix":"AGENT 분포","eyebrow.recent_activity":"최근 활동","eyebrow.delivery_readiness":"납품 준비","eyebrow.ready_to_deliver":"납품 가능","eyebrow.requirement_brief":"ISSUE 개요","eyebrow.requirement_detail":"ISSUE 세부","eyebrow.plugin_work_surface":"플러그인 작업대","eyebrow.plugin_setup":"플러그인 설정","eyebrow.project_context":"프로젝트 배경","eyebrow.upstream_handoff":"상류 인계","eyebrow.stage_detail":"단계 세부","eyebrow.delivery":"납품","eyebrow.task_journey":"ISSUE 진행","language":"언어","languageZh":"중국어 간체","languageEn":"English","languageJa":"일본어","languageKo":"한국어","console.task":"{title}","console.taskWithSession":"{title}(대화 있음)","console.unnamed":"이름 없음","console.unnamedWithSession":"이름 없음(대화 있음)","settings":"설정","preferences":"환경 설정","my":"내 정보","settingsSub":"클라이언트와 작업 디렉터리 관리","languageHint":"화면 언어","languageNote":"고르면 바로 적용돼요. 앞으로 더 많은 언어를 더할 수 있어요.","home":"홈","update":"업데이트","updateRestart":"다시 시작하고 업데이트","backHome":"홈으로 돌아가기","loading":"로드 중…","chat.opening":"대화를 여는 중…","nav.create":"새 채팅","nav.pichat":"새 대화","nav.history":"Issue 보관함","nav.briefs":"브리프","nav.team":"팀","nav.schedules":"자동화","nav.skills":"플러그인","nav.models":"내 모델","nav.agents":"Agent 관리","nav.codeacct":"코드 계정","nav.account":"개인 정보","nav.memory":"내 기억","nav.usage":"내 사용량","nav.notices":"알림","nav.skin":"꼴","nav.aidesk":"AI 팀","group.collaboration":"협업","group.ai":"AI와 계정","group.preferences":"환경 설정","rail.more":"더 보기","rail.home":"홈","newChat":"새 채팅","pinned":"고정","recentChats":"최근 채팅","recentTasks":"최근 이슈","connected":"SoduWork 서비스에 연결됨","connecting":"서비스에 연결 중","models.available":"쓸 수 있는 모델: {count}개","models.types":"대화 {chat} · 그림 {image} · 영상 {video}","models.providers":"서비스 {count}곳 정함 · {personal}개는 개인 몫 사용","models.count":"모델 {count}개","models.itemCount":"{count}개","models.keyLength":"개인 Key를 정해 뒀고 {count}자예요. 요청은 먼저 개인 몫을 씁니다","models.noResults":"\"{query}\"에 맞는 서비스나 모델이 없어요" }),
  };
  /* UI copy used by legacy panels that still render their markup locally.  Keeping
     this table phrase based lets those panels participate in locale switching while
     they are gradually migrated to data-i18n keys.  It deliberately only matches
     complete, known UI phrases so user supplied task and chat content is untouched. */
  const EN_TEXT = global.SoduWorkLocaleMessages?.['en-US'] || {};
  const diagnosticTemplates = new Set([
    'Google Harness² {stage}（{phase}）失败：{detail}',
    'Google Harness² {stage}失败：{detail}',
    '模型请求失败（HTTP {status}）：{detail}',
  ]);
  // Only finite backend-owned diagnostics may translate their nested fields.
  // Other templates keep user names, provider output and tool text verbatim.
  const diagnosticParts = Object.fromEntries(['stage', 'phase', 'detail'].map(kind => [kind,
    new Map(Object.keys(EN_TEXT).filter(key => key.startsWith('harness2.' + kind + '.'))
      .map(key => [key.slice(('harness2.' + kind + '.').length), key]))]));
  const templates = Object.entries(EN_TEXT).filter(([source]) => /\{\w+\}/.test(source)).sort(([a], [b]) => b.replace(/\{\w+\}/g, '').length - a.replace(/\{\w+\}/g, '').length).map(([source, target]) => {
    const names = [];
    const pattern = source.split(/(\{\w+\})/).map(part => {
      if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { expression: new RegExp('^' + pattern + '$'), names, target, source,
      diagnostic: diagnosticTemplates.has(source) };
  });
  let currentLocale = initialLocale();
  let windowTitle = global.__soduworkWindowTitle || null;
  const missing = new Set();
  const adapter = global.SoduWorkLocaleDOM?.createAdapter({
    document: global.document, translate: translateText, locale: read,
    localizeKeyed: applyKeyed,
    onMissing: source => { if (missing.size < 3000) missing.add(source.trim()); },
  });
  function normalize(value) {
    const raw = String(value || '').trim();
    if (LOCALES[raw]) return raw;
    if (/^en(?:[-_]|$)/i.test(raw)) return 'en-US';
    if (/^ja(?:[-_]|$)/i.test(raw)) return LOCALES['ja-JP'] ? 'ja-JP' : DEFAULT_LOCALE;
    if (/^(ko|kr)(?:[-_]|$)/i.test(raw)) return LOCALES['ko-KR'] ? 'ko-KR' : DEFAULT_LOCALE;
    return DEFAULT_LOCALE;
  }
  function fallbackLocale(target) {
    const current = normalize(target);
    return FALLBACKS[current] || SOURCE_LOCALE;
  }
  function catalog(target) { return global.SoduWorkLocaleMessages?.[target] || {}; }
  function config() { return typeof cfg !== 'undefined' ? cfg : global.cfg; }
  function initialLocale() {
    try {
      // Migrate the earlier mirror-only implementation before synchronizing cfg.
      const mirror = global.localStorage.getItem('soduwork_work_cfg_v5_locale');
      if (mirror) return normalize(mirror);
      return normalize(config()?.locale);
    } catch (_) { return normalize(config()?.locale); }
  }
  function read() { return currentLocale; }
  function setWindowTitle(label = '', detail = '') {
    windowTitle = { label, detail };
    if (global.document) global.document.title = 'SoduWork' + (label ? ' · ' + translateText(label) : '') + (detail ? ' · ' + detail : '');
  }
  function translateText(value, target = read(), diagnosticDepth = 0) {
    const text = String(value == null ? '' : value);
    if (target === SOURCE_LOCALE) return text;
    const trimmed = text.trim().replace(/\s+/g, ' ');
    const key = Object.keys(DICT[SOURCE_LOCALE]).find(key => DICT[SOURCE_LOCALE][key] === trimmed);
    // Phrase translations are authoritative for ordinary labels. Keyed eyebrows
    // may share Chinese text but use uppercase/plural English (e.g. ISSUES).
    // Only t('eyebrow.…') should select that contextual presentation.
    const selectedCatalog = catalog(target);
    const fallback = fallbackLocale(target);
    const fallbackCatalog = catalog(fallback);
    const selectedDict = localeDict[target] || DICT[target] || {};
    const fallbackDict = localeDict[fallback] || DICT[fallback] || {};
    let entry = Object.hasOwn(selectedCatalog, trimmed) ? selectedCatalog[trimmed]
      : Object.hasOwn(fallbackCatalog, trimmed) ? fallbackCatalog[trimmed]
      : key ? selectedDict[key] ?? fallbackDict[key] : undefined;
    if (entry === undefined && /[\u3400-\u9fff]/.test(text)) {
      for (const template of templates) {
        const match = template.expression.exec(text.trim());
        if (!match) continue;
        const params = Object.fromEntries(template.names.map((name, i) => [name, match[i + 1]]));
        if (template.diagnostic) {
          if (diagnosticDepth > 1 || Object.values(params).some(value => value.length > 512)) return text;
          for (const [name, value] of Object.entries(params)) {
            if (name === 'status' && /^[1-5]\d{2}$/.test(value)) continue;
            const key = diagnosticParts[name]?.get(value);
            if (key) params[name] = selectedCatalog[key] ?? fallbackCatalog[key] ?? value;
            else if (name === 'detail' && value.startsWith('模型请求失败（HTTP ')) {
              params[name] = translateText(value, target, diagnosticDepth + 1);
              if (params[name] === value) return text;
            } else return text;
          }
          const localized = selectedCatalog[template.source] ?? template.target;
          entry = localized.replace(/\{(\w+)\}/g, (all, name) => params[name] ?? all);
          break;
        }
        // Guard: a slot that swallowed a whole clause (sentence-final punctuation
        // inside, or an implausibly long capture) means the template only aligned
        // by accident; reordering that would scramble the sentence. Skip and let
        // a narrower template (or the original text) win instead.
        if (Object.values(params).some(p => /[。！？!?]/.test(p) || p.length > 60)) continue;
        // Localized catalogs may override the template key (same {valueN} names);
        // otherwise fall back to the English template so pages never mix Chinese.
        const localized = Object.hasOwn(selectedCatalog, template.source) ? selectedCatalog[template.source] : template.target;
        entry = localized.replace(/\{(\w+)\}/g, (all, name) => params[name] ?? all);
        break;
      }
    }
    // Never replace words inside a sentence: user content and untranslated copy
    // must not become a mixture of languages or have their meaning changed.
    return entry === undefined ? text : text.replace(text.trim(), () => entry);
  }
  function t(key, fallback, params) {
    const selected = localeDict[read()] || DICT[read()] || {};
    const inherited = localeDict[fallbackLocale(read())] || DICT[fallbackLocale(read())] || {};
    const english = DICT['en-US'] || {};
    const selectedMessages = catalog(read());
    const inheritedMessages = catalog(fallbackLocale(read()));
    const template = Object.hasOwn(selectedMessages, key) ? selectedMessages[key]
      : Object.hasOwn(selected, key) ? selected[key]
      : Object.hasOwn(inheritedMessages, key) ? inheritedMessages[key] : Object.hasOwn(inherited, key) ? inherited[key]
      : Object.hasOwn(english, key) ? english[key] : Object.hasOwn(DICT[SOURCE_LOCALE], key) ? DICT[SOURCE_LOCALE][key] : translateText(fallback ?? key);
    return String(template).replace(/\{(\w+)\}/g, (match, name) => params && Object.hasOwn(params, name) ? String(params[name]) : match);
  }
  function applyKeyed(root = global.document) {
    const selector = '[data-i18n],[data-i18n-title]';
    const elements = Array.from(root?.querySelectorAll?.(selector) || []);
    if (root?.matches?.(selector)) elements.unshift(root);
    elements.forEach(el => {
      if (el.closest?.('[data-user-content],[translate="no"],[contenteditable="true"]')) return;
      const key = el.getAttribute('data-i18n');
      let params;
      try { params = JSON.parse(el.getAttribute('data-i18n-params') || 'null'); } catch (_) {}
      if (key) {
        const value = t(key, el.getAttribute('data-i18n-source') || el.textContent, params);
        if (el.textContent !== value) el.textContent = value;
      }
      const titleKey = el.getAttribute('data-i18n-title');
      if (titleKey && !(el.getAttribute('data-user-attributes') || '').split(/\s+/).includes('title')) {
        const value = t(titleKey, el.getAttribute('data-i18n-title-source') || el.getAttribute('title'), params);
        if (el.getAttribute('title') !== value) el.setAttribute('title', value);
      }
    });
  }
  function html(key, fallback, params = {}) {
    const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    return '<span data-i18n="' + escape(key) + '" data-i18n-source="' + escape(fallback ?? key) + '" data-i18n-params="' + escape(JSON.stringify(params)) + '">' + escape(t(key, fallback, params)) + '</span>';
  }
  function setLocale(value, options = {}) {
    const next = normalize(value);
    const changed = next !== currentLocale;
    currentLocale = next;
    missing.clear();
    // cfg/saveCfg are top-level lexical declarations, not window properties.
    const state = config();
    if (state) state.locale = next;
    // Incoming server/IPC configuration must update the reload mirror without
    // writing the configuration back to Hub or creating cross-window echoes.
    try { if (global.localStorage.getItem('soduwork_work_cfg_v5_locale') !== next) global.localStorage.setItem('soduwork_work_cfg_v5_locale', next); } catch (_) {}
    if (options.persist !== false) {
      // Keep a durable marker for an explicit local choice. Initial and remote
      // hydration calls use persist:false, so they must not claim ownership of
      // the per-device locale preference.
      try {
        if (!options.initial) {
          global.localStorage.setItem('soduwork_work_cfg_v5_locale_explicit', '1');
          global.localStorage.removeItem('soduwork_work_cfg_v5_locale_source');
        }
      } catch (_) {}
      try { if (typeof saveCfg === 'function') saveCfg(); else global.saveCfg?.(); } catch (_) {}
    }
    if (options.broadcast !== false) { try { global.soduWorkAPI?.setLocale?.(next); } catch (_) {} }
    const doc = global.document;
    if (doc) { doc.documentElement.lang = next; doc.documentElement.dataset.locale = next; }
    if (windowTitle) setWindowTitle(windowTitle.label, windowTitle.detail);
    applyKeyed();
    adapter?.apply();
    if (changed || options.initial) global.dispatchEvent(new CustomEvent('soduwork-locale-change', { detail: { locale: next } }));
    return next;
  }
  function options() { return Object.entries(LOCALES).map(([value, label]) => ({ value, label })); }
  global.SoduWorkI18n = Object.freeze({ LOCALES, normalize, getLocale: read, t, html, setLocale, setWindowTitle, options, translateText,
    translateNode: root => adapter?.apply(root), getMissing: () => [...missing].sort(),
    formatNumber: (value, options) => new Intl.NumberFormat(read(), options).format(value),
    formatDate: (value, options) => new Intl.DateTimeFormat(read(), options).format(new Date(value)),
  });
  global.SoduWorkI18n = global.SoduWorkI18n; // Read-only compatibility entry point for published renderer extensions.
  function ready() { applyKeyed(); adapter?.start(); }
  if (global.document?.readyState === 'loading') global.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
  global.addEventListener('storage', event => {
    if (event.key === 'soduwork_work_cfg_v5_locale' && event.newValue) setLocale(event.newValue, { persist: false, broadcast: false });
  });
  global.soduWorkAPI?.onLocaleChange?.(value => setLocale(value, { persist: false, broadcast: false }));
  setLocale(currentLocale, { persist: false, initial: true });
})(window);
