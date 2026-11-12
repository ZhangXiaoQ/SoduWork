/* SoduWork workspace shell owns navigation without duplicating business panels.
   Keep frequent actions in the main menu and personal settings in account mode.
   Settings reuse the same content area with their own secondary navigation.
   Brand, new chat and account stay fixed; other entries share a scroll area. */
(function (global) {
  'use strict';
  const chatContext = {
    get active() { return active; },
    get activeChatId() { return activeChatId; }, set activeChatId(value) { activeChatId = value; },
    get _reconcileChats() { return _reconcileChats; },
    get _upsertChatItems() { return _upsertChatItems; },
    get sessionOff() { return sessionOff; }, set sessionOff(value) { sessionOff = value; },
    get updateChatState() { return updateChatState; },
    get historyLoad() { return historyLoad; }, set historyLoad(value) { historyLoad = value; },
    get renderChats() { return renderChats; },
    get setChats() { return setChats; },
    get sidebarProjects() { return sidebarProjects; },
    get chatItems() { return chatItems; }, set chatItems(value) { chatItems = value; },
    get newSessionContext() { return newSessionContext; },
    get chatNames() { return chatNames; },
    get chatState() { return chatState; },
    get upsertChat() { return upsertChat; },
    get openChatMenu() { return openChatMenu; }, set openChatMenu(value) { openChatMenu = value; },
    get icon() { return icon; },
    get setActiveChat() { return setActiveChat; },
    get root() { return root; },
    get wsT() { return wsT; },
    get CHAT_STATE() { return CHAT_STATE; },
    get _chatUiKey() { return _chatUiKey; },
    get mount() { return mount; },
    get MAX_CHAT_ITEMS() { return MAX_CHAT_ITEMS; },
    get pinnedChats() { return pinnedChats; },
    get chats() { return chats; },
    get _empty() { return _empty; },
    get chatsLoading() { return chatsLoading; }, set chatsLoading(value) { chatsLoading = value; },
  };
  const { setChats, upsertChat, removeChat, setActiveChat, pinStorageKey, legacyPinnedIds, pinnedIds, togglePinned, forgetPinned, deleteHistoryChat, archiveHistoryChat, rememberChatName, updateChatState, renameChat, closeChatMenu, openChatRename, chatMenuItem, _newChatRow, _paintChatLocale, _paintChatRow, _syncChatList, renderChats, subscribeConversationPresence, refreshConversationHistory } = global.WorkspaceChatList.create(chatContext);

  /* One 24-unit optical grid for the rail and its menus. Both states reuse
     the same outlines: selection adds ink without shrinking or changing the
     silhouette. Interior gaps are transparent, including on dark themes. */
  const lineGlyph = (paths) => '<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + paths + '</g>';
  const BELL_BODY = 'M4.75 17.25c1.35-1.4 1.75-3.4 1.75-6.25V9.75a5.5 5.5 0 0 1 11 0V11c0 2.85.4 4.85 1.75 6.25Z';
  const BELL_CLAPPER = '<path d="M9.75 20a2.6 2.6 0 0 0 4.5 0"/>';
  const PEOPLE_HEADS = '<circle cx="8" cy="7.75" r="2.75"/><circle cx="17" cy="8.5" r="2.25"/>';
  const PEOPLE_SHOULDERS = '<path d="M3.25 20v-1.5a4.75 4.75 0 0 1 9.5 0V20M15.75 14.75a4.5 4.5 0 0 1 5 4.5V20"/>';
  const TRAY_OUTLINE = '<path d="M5.5 5.75h13L21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6Z"/>';
  const TRAY_NOTCH = '<path d="M3 12h5.25L10 14.5h4l1.75-2.5H21"/>';
  const SETTINGS_TRACKS = '<path d="M3.5 7h2M10.5 7h10M3.5 17h10M18.5 17h2"/>';
  const SETTINGS_KNOBS = '<circle cx="8" cy="7" r="2.5"/><circle cx="16" cy="17" r="2.5"/>';
  const APP_BOX = '<path d="M4.25 13.25v6A1.5 1.5 0 0 0 5.75 20.75h12.5a1.5 1.5 0 0 0 1.5-1.5v-6"/>';
  const APP_CIRCLE = '<circle cx="4.25" cy="5.25" r="2.1"/>';
  const APP_DIAMOND = '<rect x="10" y="4" width="4" height="4" rx=".45" transform="rotate(25 12 6)"/>';
  const APP_STAR = '<path d="m19.5 1.75.95 2.05 2.25.3-1.65 1.55.4 2.25-1.95-1.1-1.95 1.1.4-2.25L16.3 4.1l2.25-.3Z"/>';
  const APP_TRAILS = '<path d="M6.75 8.25c1.5 1.45 2.1 3.1 2.1 5M12.5 10l-.7 4M18 10c-1.8 1.25-2.5 3.2-2.6 5"/>';
  const ICONS = {
    home: lineGlyph('<path d="M9 7.5V5.75A2.75 2.75 0 0 1 11.75 3h5.5A2.75 2.75 0 0 1 20 5.75v3.5A2.75 2.75 0 0 1 17.25 12h-2.85"/><path d="M4.1 10.25A2.75 2.75 0 0 1 6.85 7.5h4.8a2.75 2.75 0 0 1 2.75 2.75v5.5a2.75 2.75 0 0 1-2.75 2.75H8.6l-3.45 2.25a.65.65 0 0 1-1.05-.55Z"/><path d="M7.4 11.55h3.7"/>'),
    aidesk: lineGlyph(PEOPLE_HEADS + PEOPLE_SHOULDERS),
    pichat: lineGlyph('<path d="M7.5 4h9a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H9l-5 3v-4.5a4 4 0 0 1-.5-2V8a4 4 0 0 1 4-4Z"/><path d="M8 9h8M8 13h5"/>'),
    create: lineGlyph('<path d="M13 4.5H6.5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2H18a2 2 0 0 0 2-2v-7"/><path d="m9.5 14.5.75-3.25L18 3.5A1.77 1.77 0 0 1 20.5 6l-7.75 7.75Z"/>'),
    // Pair the request-pool outline with its selected color artwork.
    history: lineGlyph('<circle cx="6.9" cy="5.6" r="1.2"/><path d="M16.2 3h1.8a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1.8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M4.1 12.4a2.3 2.3 0 0 1 2.3-2.3h5.5a2.3 2.3 0 0 1 2.3 2.3v4.1a2.3 2.3 0 0 1-2.3 2.3H8.7l-3.35 2.2a.6.6 0 0 1-.95-.45Z"/><path d="M7.2 13.4h3.9"/>'),
    add: lineGlyph('<path d="M12 4.5v15M4.5 12h15"/>'),
    briefs: lineGlyph('<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5Z"/><path d="M14 3.5v5h5M8.5 12h7M8.5 16h5"/>'),
    team: lineGlyph(PEOPLE_HEADS + PEOPLE_SHOULDERS),
    schedules: lineGlyph('<g transform="translate(12 12) scale(1.14) translate(-12 -12.575)"><path d="m12 4.9 8.2 4.05L12 13.05 3.8 8.95Z"/><path d="m3.8 12.55 8.2 4.1 8.2-4.1"/><path d="m3.8 16.15 8.2 4.1 8.2-4.1"/></g>'),
    skills: lineGlyph('<g transform="translate(12 12) scale(1.13) translate(-12 -12)"><path d="M9.25 8.75V7A2.75 2.75 0 0 1 12 4.25h5A2.75 2.75 0 0 1 19.75 7v5.5a2.75 2.75 0 0 1-2.75 2.75h-2.25"/><path d="M4.25 11.5A2.75 2.75 0 0 1 7 8.75h5a2.75 2.75 0 0 1 2.75 2.75v5.5A2.75 2.75 0 0 1 12 19.75H7a2.75 2.75 0 0 1-2.75-2.75Z"/></g>'),
    // Both states share the open box, rising trails and circle/diamond/star silhouette.
    apps: lineGlyph(APP_BOX + APP_CIRCLE + APP_DIAMOND + APP_STAR + APP_TRAILS),
    models: lineGlyph('<path d="m12 3.5 8.5 4.25L12 12 3.5 7.75ZM3.5 12l8.5 4.25L20.5 12M3.5 16.25 12 20.5l8.5-4.25"/>'),
    agents: lineGlyph('<rect x="3.5" y="7.25" width="17" height="13" rx="3.25"/><path d="M12 3.75v3.5M9 17h6"/><circle fill="currentColor" stroke="none" cx="8.5" cy="12.75" r="1"/><circle fill="currentColor" stroke="none" cx="15.5" cy="12.75" r="1"/>'),
    codeacct: lineGlyph('<circle cx="8.25" cy="15.75" r="4.25"/><path d="m11.25 12.75 8.5-8.5M17 7l2.5 2.5M14.25 9.75l2.5 2.5"/>'),
    cloud: lineGlyph('<path d="M7 16H6a4 4 0 0 1-.4-8 6.4 6.4 0 0 1 12.2-1A4.5 4.5 0 0 1 18 16h-1M8 20h8M12 16v4"/>'),
    memory: lineGlyph('<rect x="5.5" y="3.75" width="14.5" height="16.5" rx="1.75"/><path d="M3.5 7.5h4M3.5 12h4M3.5 16.5h4M10.5 8.5h6M10.5 13h4"/>'),
    library: lineGlyph('<path d="M20.34 9.3V7.9a1.9 1.9 0 0 0-1.9-1.9h-5.17a1.9 1.9 0 0 1-1.43-.65l-.94-1.07a1.9 1.9 0 0 0-1.43-.65H5.68a1.9 1.9 0 0 0-1.9 1.9v3.12"/><path d="M7.3 11.7h12.8l-1.1 9.6H5Z"/>'),
    usage: lineGlyph('<rect x="4" y="12" width="3" height="8" rx=".75"/><rect x="10.5" y="4" width="3" height="16" rx=".75"/><rect x="17" y="8" width="3" height="12" rx=".75"/>'),
    notices: lineGlyph('<path d="' + BELL_BODY + '"/>' + BELL_CLAPPER),
    skin: lineGlyph('<path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.25a2.25 2.25 0 0 0 1.7-3.72 1.75 1.75 0 0 1 1.3-2.93h1.5a2.75 2.75 0 0 0 2.75-2.75A7.6 7.6 0 0 0 12 3.5Z"/><g fill="currentColor" stroke="none"><circle cx="7.25" cy="10.25" r="1"/><circle cx="10.5" cy="7.25" r="1"/><circle cx="15" cy="7.75" r="1"/></g>'),
    account: lineGlyph('<circle cx="12" cy="8" r="4"/><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2"/>'),
    settings: lineGlyph(SETTINGS_TRACKS + SETTINGS_KNOBS),
    shortcuts: lineGlyph('<path d="M4 5.5h16v13H4z"/><path d="M7 9h2M11 9h2M15 9h2M7 13h2M11 13h6"/>'),
    more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></g>',
    archive: lineGlyph('<path d="M4 8h16v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z"/><rect x="3" y="3.5" width="18" height="4.5" rx="1"/><path d="M9 12h6"/>'),
    rename: lineGlyph('<path d="m4 16.75-.8 3.9 3.9-.8L18.9 8.05a2.1 2.1 0 0 0-3-3Z"/><path d="m14.5 6.5 3 3"/>'),
    move: lineGlyph('<path d="M4 7h9M9 3l4 4-4 4M20 17h-9M15 13l-4 4 4 4"/>'),
  };
  /* Open marks stay open when selected. Filled accents share their exact
     outline geometry, so status never changes an icon's size or alignment. */
  const SOLID_ICONS = {
    home: ICONS.home,
    schedules: ICONS.schedules,
    notices: lineGlyph('<path fill="currentColor" d="' + BELL_BODY + '"/>' + BELL_CLAPPER),
    skills: ICONS.skills,
    history: ICONS.history,
    library: ICONS.library,
    aidesk: lineGlyph('<g fill="currentColor">' + PEOPLE_HEADS + '</g>' + PEOPLE_SHOULDERS),
    account: ICONS.account,
    settings: lineGlyph(SETTINGS_TRACKS + '<g fill="currentColor">' + SETTINGS_KNOBS + '</g>'),
    more: ICONS.more,
    archive: ICONS.archive,
    apps: '<g fill="none" stroke="#7c5cf0" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + APP_BOX + APP_TRAILS + '</g>' +
      '<g stroke="none"><g fill="#f59e0b">' + APP_CIRCLE + '</g><g fill="#ec4899">' + APP_DIAMOND + '</g><g fill="#22b8d6">' + APP_STAR + '</g></g>',
  };
  const META = {
    aidesk: ['AI 团队', '实时查看 AI 员工、需求进展与交付'],
    create: ['新对话', '交给它做一件事，或者先聊一聊'],
    pichat: ['新建对话', '直接问它，不用先建需求'],
    history: ['需求池', '收集需求，安排执行，跟进交付'], add: ['创建需求', '把目标交给团队或 AI'],
    briefs: ['简报', '查看个人日报、周报与团队概况'],
    team: ['团队', '查看成员、负载与协作需求'], schedules: ['自动化', '让重复工作按计划自动执行'],
    skills: ['插件', '使用技能、连接器与企业插件扩展能力'], apps: ['即用', '点开就是工作界面；本地安装免审核免提交'], models: ['我的模型', '配置个人模型与调用额度'],
    agents: ['Agent 管理', '管理 Agent、Runner 与可用状态'], codeacct: ['代码账号', '管理代码提交身份与访问凭据'],
    cloud: ['云端环境', '管理负责执行会话的云端服务器'],
    memory: ['我的记忆', '导入会话，确认摘要后用于后续工作'],
    library: ['资料库', '保存和整理个人笔记、图片与文档'],
    usage: ['我的用量', '查看个人 AI 消耗、工作场景与 Agent 分布'],
    notices: ['通知', '回看需求与审批提醒'], skin: ['外观', '选择皮肤与界面风格'],
    account: ['个人信息', '管理个人资料、账号安全与登录设备', '个人信息'],
    settings: ['设置', '管理客户端与工作目录'], shortcuts: ['快捷键', '编辑高频动作的按键组合'], detail: ['需求详情', '查看完整过程、证据与下一步'],
    archive: ['归档会话', '查看、恢复或彻底删除归档的会话和项目'],
  };
  const wsT = (key, fallback) => global.SoduWorkI18n && typeof global.SoduWorkI18n.t === 'function'
    ? global.SoduWorkI18n.t(key, fallback) : fallback;
  const navLabel = (key) => wsT('nav.' + key, META[key] ? (META[key][2] || META[key][0]) : key);
  const navLabelHtml = (key) => global.SoduWorkI18n?.html
    ? global.SoduWorkI18n.html('nav.' + key, META[key] ? (META[key][2] || META[key][0]) : key)
    : '<span>' + navLabel(key) + '</span>';
  const groupLabel = (label) => label === '协作' ? wsT('group.collaboration', label) :
    label === 'AI 与账号' ? wsT('group.ai', label) : label === '偏好' ? wsT('group.preferences', label) : label;

  /* Main navigation lists frequent actions in priority order. */
  const HOME_GROUPS = [
    ['', ['schedules', 'skills', 'library', 'notices']],
    ['协作', ['history', 'aidesk'], 'collaboration'],
  ];
  /* Account navigation groups personal work, security and preferences. */
  const SETTINGS_GROUPS = [
    ['AI 与账号', ['account', 'usage', 'agents', 'models', 'cloud', 'codeacct']],
    ['工作内容', ['archive']],
    ['偏好', ['shortcuts', 'skin', 'settings']],
  ];
  const SETTINGS_KEYS = new Set(SETTINGS_GROUPS.reduce((a, g) => a.concat(g[1]), []));
  /* Primary destinations stay in one predictable order. Keep the rail flat so
     the first six icons are the product's main navigation, not two visual
     groups with a separator in between. */
  /* Primary destinations stay in one predictable order. Keep the rail flat so
     the first six icons are the product's main navigation, not two visual
     groups with a separator in between. */
  /* Primary destinations stay in one predictable order. Keep the rail flat so
     the first six icons are the product's main navigation, not two visual
     groups with a separator in between. */
  const RAIL_ITEMS = [
    ['create', '主页', 'home'],
    ['apps', '即用', 'apps'],
    ['history', '需求池', 'history'],
    ['skills', '插件', 'skills'],
    ['schedules', '自动化', 'schedules'],
    ['library', '资料库', 'library'],
  ];
  /* Team and briefs stay registered while their menu entries are temporarily hidden. */
  const RAIL_MORE_ITEMS = [
    ['aidesk', 'AI 团队', 'aidesk'],
    ['memory', '记忆', 'memory'],
  ];
  const RAIL_MORE_KEYS = new Set(RAIL_MORE_ITEMS.map(([key]) => key));
  const CONVERSATION_KEYS = new Set(['create', 'pichat']);

  const icon = (key) => '<svg viewBox="0 0 24 24">' + (ICONS[key] || ICONS.history) + '</svg>';
  const APP_PAGE_GIFT_MARKUP = '<g stroke="none"><rect x="5" y="12.75" width="14" height="7.5" rx="1.5" fill="#7c5cf0"/><rect x="3.75" y="9.5" width="16.5" height="3.9" rx="1.4" fill="#4f8df7"/><path d="M11.25 13.4v7.4a.75.75 0 0 0 1.5 0v-7.4Z" fill="#ffffff" opacity=".85"/><rect x="5.35" y="4.35" width="3.2" height="3.2" rx=".9" fill="#f59e0b"/><rect x="10.55" y="2.6" width="2.9" height="2.9" rx=".8" fill="#ec4899"/><circle cx="17.35" cy="5.6" r="1.6" fill="#22d3ee"/></g><path d="M12 7.25V5.9" stroke="#7c5cf0" stroke-width="1.5" stroke-linecap="round"/>';
  /* Neutral states are genuine open line drawings, paired with the approved
     full-color artwork. Keep the same subject, scale and center in both states. */
  const RAIL_LINE_ICONS = {
    home: lineGlyph('<path d="M9 7V6a3.5 3.5 0 0 1 3.5-3.5h6A3.5 3.5 0 0 1 22 6v5a3.5 3.5 0 0 1-3.5 3.5H18"/><path d="M2 10.5A3.5 3.5 0 0 1 5.5 7h9a3.5 3.5 0 0 1 3.5 3.5v6a3.5 3.5 0 0 1-3.5 3.5H8l-6 3Z"/><path d="M6.5 11.5h7M6.5 15.5h4.5"/>'),
    history: lineGlyph('<path d="M6 10H4.75L2.5 15v5A1.5 1.5 0 0 0 4 21.5h16a1.5 1.5 0 0 0 1.5-1.5v-5l-2-5"/><path d="M2.5 15h5l1.5 3h6l1.5-3h5M6.5 15V4A1.5 1.5 0 0 1 8 2.5h7M10 7h3M10 11h2"/><rect x="15.5" y="3" width="6" height="6" rx="1.5"/><path d="m17 6 1 1 2-2"/>'),
    skills: lineGlyph('<path d="M9 6V4.5a2.5 2.5 0 1 1 5 0V6h4a2 2 0 0 1 2 2v3h-1.5a2.5 2.5 0 1 0 0 5H20v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4h1.5a2.5 2.5 0 1 0 0-5H3V8a2 2 0 0 1 2-2Z"/>'),
    schedules: lineGlyph('<path d="m12.5 4.5-9 4.75L12 14l3-1.6M3.5 15l8.5 4.75L20.5 15"/><path d="m19 2-5 7h4l-1 5 6-8h-4Z"/>'),
    library: lineGlyph('<path d="M3 17V6a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M7 15v-4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v2M10 13h3"/><path d="M5 15h8l2-3h5a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 21H5a2 2 0 0 1-2-2v-4Z"/>'),
  };
  const RAIL_COLOR_ICONS = new Set(['home', 'history', 'skills', 'schedules', 'library']);
  const railIcon = (key) => RAIL_COLOR_ICONS.has(key)
    ? '<svg class="ws-icon-line ws-rail-line-art" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon="' + key + '">' + RAIL_LINE_ICONS[key] + '</svg>' +
      '<img class="ws-rail-art ws-icon-solid" src="assets/rail-icons/' + key + '.svg" data-icon="' + key + '" alt="" aria-hidden="true" draggable="false">'
    : '<svg class="ws-icon-line" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon="' + key + '">' + (ICONS[key] || ICONS.history) + '</svg>' +
    (key === 'apps'
      ? '<svg class="ws-rail-app-icon ws-icon-solid" viewBox="0 0 24 24" data-icon="apps" aria-hidden="true" focusable="false"><g transform="translate(12 11.425) scale(1.15) translate(-12 -11.425)">' + APP_PAGE_GIFT_MARKUP + '</g></svg>'
      : '<svg class="ws-icon-solid" viewBox="0 0 24 24" data-icon="' + key + '" aria-hidden="true" focusable="false">' + (SOLID_ICONS[key] || ICONS[key] || ICONS.history) + '</svg>');
  let root = null, active = '', nav = null, rail = null, railMoreMenu = null, recent = null, chats = null, pinnedChats = null, chatItems = [];
  /* The main process persists the last manually selected directory. It is a fallback
     for new chats, not project membership; choosing the default workspace clears it. */
  let recentWorkspace = { dir: '', name: '' }, recentWorkspaceLoaded = false;
  function loadRecentWorkspace() {
    if (recentWorkspaceLoaded) return;
    recentWorkspaceLoaded = true;
    const bridge = global.soduWorkAPI && global.soduWorkAPI.recentWorkspace;
    if (!bridge || typeof bridge.get !== 'function') return;
    Promise.resolve(bridge.get()).then(reply => {
      if (reply && reply.ok && reply.dir) recentWorkspace = { dir: reply.dir, name: reply.name || '' };
    }).catch(() => {});
  }
  /* Reload the main-process directory preference after a manual update or reset. */
  function refreshRecentWorkspace() {
    recentWorkspace = { dir: '', name: '' };
    recentWorkspaceLoaded = false;
    loadRecentWorkspace();
  }
  loadRecentWorkspace();
  let openChatMenu = null;
  let updateStatus = null;
  let activeChatId = '';
  let sidebarProjects = null;
  let sessionOff = null;
  let chatsLoading = true;
  let historyLoad = null;
  const chatNames = new Map();
  const { MAX_CHAT_ITEMS, CHAT_STATE, chatState, _chatAt, _chatUiKey, _withChatUiKey, _sameDraft, _settleDraft, _reconcileChats, _upsertChatItems } = global.WorkspaceChatHistory;
  let mode = 'home';              // home | settings
  let collaborationCollapsed = true; // Start collapsed; preserve expansion during navigation and permission refreshes.
  let lastHomeView = 'create';    // Return to a new chat when leaving settings.
  let railMoreOpen = false;
  function reportWorkspaceView(key) {
    if (global.WorkspaceNavigation) { global.WorkspaceNavigation.record(key); return; }
    try { global.soduWorkAPI?.reportWorkspaceView?.(key); } catch (_) {}
  }

  function layoutForView(key) {
    if (CONVERSATION_KEYS.has(String(key || ''))) return 'conversation';
    if (SETTINGS_KEYS.has(String(key || ''))) return 'settings';
    return 'utility';
  }

  function syncWorkspaceLayout(key) {
    if (!root) return;
    const layout = layoutForView(key);
    root.dataset.layout = layout;
    const html = document.documentElement;
    if (html.dataset.deskPanel !== 'workspace') return;
    html.dataset.workspaceLayout = layout;
    if (layout === 'utility') html.style.setProperty('--ws-main-left', 'var(--ws-rail-w,52px)');
    else html.style.removeProperty('--ws-main-left');
  }

  /* Team navigation requires the server-provided management capability.
     Wait for asynchronous capabilities before showing the entry. */
  function teamAllowed() {
    const cap = global.__teamCap;
    if (!cap) return false;
    return cap.teamModuleVisible !== undefined ? !!cap.teamModuleVisible : !!cap.canManage;
  }

  function navHtml(groups) {
    return groups.map(([label, items, group]) => {
      const shown = items.filter((key) => key !== 'team' || teamAllowed());
      if (!shown.length) return '';
      const children = shown.map((key) => '<button class="ws-nav-item" data-view="' + key + '">' + icon(key) +
        navLabelHtml(key) + (key === 'history' ? '<em id="wsApprovalBadge" title="待我确认"></em>' : '') +
        '</button>').join('');
      if (group === 'collaboration') return '<div class="ws-nav-group">' +
        '<button class="ws-section-toggle" id="wsCollaborationToggle" type="button" aria-expanded="' + !collaborationCollapsed +
          '" aria-controls="wsCollaborationItems" title="' + (collaborationCollapsed ? '展开' : '收起') + label + '">' +
          '<span>' + groupLabel(label) + '</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>' +
        '<div class="ws-nav-children" id="wsCollaborationItems"' + (collaborationCollapsed ? ' hidden' : '') + '>' + children + '</div></div>';
      return '<div class="ws-nav-group">' + (label ? '<div class="ws-section-label">' + groupLabel(label) + '</div>' : '') + children + '</div>';
    }).join('');
  }

  function railHtml() {
    const button = (key, label, iconKey) => {
      const text = key === 'create' ? wsT('rail.home', label) : navLabel(key);
      return '<button class="ws-rail-button" type="button" data-rail-view="' + key + '" aria-label="' + text + '" title="' + text + '">' +
        railIcon(iconKey) + '<span>' + text + '</span>' +
      '</button>';
    };
    const primary = RAIL_ITEMS.map(([key, label, iconKey]) => button(key, label, iconKey)).join('');
    const more = RAIL_MORE_ITEMS
      .filter(([key]) => key !== 'team' || teamAllowed())
      .map(([key, label, iconKey]) => '<button type="button" data-rail-view="' + key + '"><span class="ws-rail-popover-icon">' + icon(iconKey) + '</span><span>' + navLabel(key) + '</span></button>')
      .join('');
    const moreText = wsT('rail.more', '更多');
    const settingsText = wsT('settings', '设置');
    const noticeText = navLabel('notices');
    const moreMenu = '<div class="ws-rail-more-wrap"><button class="ws-rail-button ws-rail-menu-button" type="button" data-rail-menu="more" aria-label="' + moreText + '" aria-expanded="false" title="' + moreText + '">' + railIcon('more') + '<span>' + moreText + '</span></button>' +
      '<div class="ws-rail-popover ws-rail-more-popover" id="wsRailMoreMenu" hidden><div class="ws-rail-popover-title">' + moreText + '</div>' + more + '</div></div>';
    return '<div class="ws-rail-top">' + primary + '<div id="wsSidebarApps" class="ws-sidebar-apps"></div>' + moreMenu + '</div>' +
      '<div class="ws-rail-bottom">' +
        '<button class="ws-rail-button ws-rail-settings" type="button" data-rail-view="settings" aria-label="' + settingsText + '" title="' + settingsText + '">' + railIcon('settings') + '<span>' + settingsText + '</span></button>' +
        '<button class="ws-update ws-rail-update" id="wsUpdate" hidden title="有新版本已就绪，点一下重启更新" aria-label="重启并更新">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v9"/><path d="m8.5 9.5 3.5 3.5 3.5-3.5"/><path d="M5 15a7 7 0 0 0 14 0"/></svg><i></i></button>' +
        '<button class="ws-rail-button ws-rail-notices" type="button" data-rail-view="notices" aria-label="' + noticeText + '" title="' + noticeText + '" aria-describedby="wsRailNoticeBadge">' +
          railIcon('notices') + '<em id="wsRailNoticeBadge"></em></button>' +
        '<button class="ws-rail-account" id="wsRailMine" type="button" title="打开个人信息" aria-label="打开个人信息">' +
          '<span class="ws-rail-avatar" aria-hidden="true"><span data-soduwork-user-initial>我</span></span></button>' +
      '</div>';
  }

  function syncRail() {
    if (!rail) return;
    rail.querySelectorAll('.ws-rail-button[data-rail-view]').forEach((button) => {
      const selected = button.dataset.railView === active;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const moreButton = rail.querySelector('[data-rail-menu="more"]');
    const moreMenu = railMoreMenu;
    const moreActive = railMoreOpen || RAIL_MORE_KEYS.has(active);
    if (moreButton) {
      moreButton.classList.toggle('active', moreActive);
      moreButton.setAttribute('aria-expanded', String(railMoreOpen));
      if (moreActive) moreButton.setAttribute('aria-current', 'page');
      else moreButton.removeAttribute('aria-current');
    }
    if (moreMenu) moreMenu.hidden = !railMoreOpen;
    if (railMoreOpen) positionRailMoreMenu();
  }

  function setRailMoreOpen(open) {
    railMoreOpen = Boolean(open);
    syncRail();
  }

  function openWorkspaceView(key) {
    if (!global.WorkspaceHost) return;
    setRailMoreOpen(false);
    global.WorkspaceHost.open(key, key === 'create'
      ? (global.WorkspaceShell && typeof global.WorkspaceShell.newSessionPayload === 'function'
        ? global.WorkspaceShell.newSessionPayload()
        : { newSession: true })
      : {});
  }

  function onRailMoreMenuClick(e) {
    const button = e.target.closest('button[data-rail-view]');
    if (!button) return;
    openWorkspaceView(button.dataset.railView);
  }

  function positionRailMoreMenu() {
    if (!railMoreMenu || !railMoreOpen || railMoreMenu.hidden || !rail) return;
    const button = rail.querySelector('[data-rail-menu="more"]');
    if (!button) return;
    const buttonRect = button.getBoundingClientRect();
    const menuHeight = railMoreMenu.getBoundingClientRect().height || 160;
    const top = Math.max(8, Math.min(buttonRect.top, window.innerHeight - menuHeight - 8));
    const left = Math.max(8, Math.min(buttonRect.right - 1, window.innerWidth - 176));
    railMoreMenu.style.top = Math.round(top) + 'px';
    railMoreMenu.style.left = Math.round(left) + 'px';
  }

  function renderRail() {
    if (!rail) return;
    if (railMoreMenu) {
      railMoreMenu.removeEventListener('click', onRailMoreMenuClick);
      railMoreMenu.remove();
      railMoreMenu = null;
    }
    rail.innerHTML = railHtml();
    railMoreMenu = rail.querySelector('#wsRailMoreMenu');
    if (railMoreMenu) {
      document.body.appendChild(railMoreMenu);
      railMoreMenu.addEventListener('click', onRailMoreMenuClick);
    }
    syncRail();
    global.WorkspaceSidebarApps?.mount();
    refreshNoticeBadge();
    if (updateStatus) applyUpdateState(updateStatus);
  }


  function renderNav() {
    nav.innerHTML = navHtml(mode === 'settings' ? SETTINGS_GROUPS : HOME_GROUPS);
    nav.setAttribute('aria-hidden', String(mode === 'home'));
    /* The new-chat entry lives in its own nav container above #wsNav. Keep
       its active state in sync with grouped navigation and the rail. */
    root.querySelectorAll('.ws-nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === active));
    syncRail();
  }

  function applyLocaleToShell() {
    if (!root) return;
    const text = {
      '#wsBack span': wsT('backHome', '返回主页'),
      '#wsPinnedToggle span': wsT('pinned', '置顶'),
      '#wsChatsToggle span': wsT('recentChats', '最近聊天'),
      '#wsRecentToggle span': wsT('recentTasks', '最近需求'),
      '#wsMine .ws-profile-copy b': wsT('my', '我的'),
      '#wsHubState': root.querySelector('#wsMine')?.dataset.connection === 'connected'
        ? wsT('connected', '已连接 SoduWork 服务') : wsT('connecting', '服务连接中'),
    };
    Object.keys(text).forEach((selector) => {
      const node = root.querySelector(selector);
      if (node && node.textContent !== text[selector]) node.textContent = text[selector];
    });
    const chatNav = root.querySelector('.ws-new-chat');
    if (chatNav) {
      chatNav.setAttribute('aria-label', wsT('newChat', '新对话'));
      const label = chatNav.querySelector('[data-view="create"] > span');
      if (label) label.textContent = navLabel('create');
    }
    root.querySelectorAll('.ws-chat').forEach(_paintChatLocale);
  }

  /* Switch sidebar and header modes while retaining the same content container. */
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    root.dataset.mode = mode;
    renderNav();
  }

  function mount() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'workspaceShell';
    root.className = 'workspace-shell';
    root.dataset.mode = 'home';
    root.dataset.layout = layoutForView(document.documentElement.dataset.workspaceView || 'create');
    root.innerHTML =
      '<nav class="ws-rail" id="wsRail" aria-label="工作区快捷导航"></nav>' +
      '<aside class="ws-side">' +
        '<div class="ws-brand"><img class="ws-mark" src="icon.png" alt="" draggable="false">' +
        '<span><b>SoduWork</b></span><button type="button" id="wsGlobalSearch" class="ws-global-search" aria-label="全局搜索" title="全局搜索 · Ctrl+Shift+F"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button></div>' +
        '<button class="ws-back" id="wsBack"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>' +
          '<span>返回主页</span></button>' +
        '<nav class="ws-new-chat" aria-label="新对话">' + navHtml([['', ['create']]]) + '</nav>' +
        '<div class="ws-side-scroll" id="wsSideScroll" tabindex="0" aria-label="工作区导航与会话">' +
        '<nav class="ws-nav" id="wsNav"></nav>' +
        '<section class="ws-list ws-pinned ws-chat-group" id="wsPinnedBox" hidden>' +
          '<button class="ws-section-toggle" id="wsPinnedToggle" type="button" aria-expanded="true" aria-controls="wsPinnedChats" title="收起置顶">' +
            '<span>置顶</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>' +
          '<div class="ws-list-body" id="wsPinnedChats"></div></section>' +
        /* Navigation, pins and chats share scrolling; recent requirements remain above the account. */
        '<section class="ws-list ws-chats ws-chat-group" id="wsChatsBox">' +
          '<button class="ws-section-toggle" id="wsChatsToggle" type="button" aria-expanded="true" aria-controls="wsChats" title="收起最近聊天">' +
            '<span>最近聊天</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>' +
          '<div class="ws-list-body" id="wsChats"></div></section>' +
        '</div>' +
        '<section class="ws-list ws-recent is-collapsed" id="wsRecentBox">' +
          '<button class="ws-section-toggle" id="wsRecentToggle" type="button" aria-expanded="false" ' +
            'aria-controls="wsRecent" title="展开最近需求"><span>最近需求</span>' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>' +
          '<div class="ws-list-body" id="wsRecent" tabindex="0" role="region" aria-labelledby="wsRecentToggle"></div></section>' +
        '<div class="ws-profile-row">' +
          '<button class="ws-profile" id="wsMine" type="button" data-connection="connecting" title="打开个人信息">' +
            '<span class="ws-avatar" aria-hidden="true"><span data-soduwork-user-initial>我</span></span>' +
            '<span class="ws-profile-copy"><b>我的</b><small id="wsHubState">正在连接服务</small></span>' +
            '<svg class="ws-profile-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>' +
        '</div>' +
      '</aside>' +
      /* Drag this separator to resize the sidebar. */
      '<div class="ws-resizer" id="wsResizer" title="拖动调整菜单宽度"></div>' +
      '<main class="ws-stage"><div class="ws-canvas" id="wsCanvas"></div></main>';
    document.body.appendChild(root);
    if (!root._localeBound) {
      root._localeBound = true;
      root._onLocaleChange = () => {
        renderRail(); renderNav();
        applyLocaleToShell();
        const mineRail = root.querySelector('#wsRailMine');
        if (mineRail) mineRail.title = wsT('settings', '设置');
      };
      window.addEventListener('soduwork-locale-change', root._onLocaleChange);
    }
    if (!root._pluginCatalogBound) {
      root._pluginCatalogBound = true;
      root._onPluginCatalogChange = () => {
        global.PluginUIHost?.invalidateCatalog?.();
        refreshNav();
      };
      window.addEventListener('soduwork:plugins-changed', root._onPluginCatalogChange);
    }
    rail = root.querySelector('#wsRail');
    nav = root.querySelector('#wsNav');
    recent = root.querySelector('#wsRecent');
    chats = root.querySelector('#wsChats');
    pinnedChats = root.querySelector('#wsPinnedChats');
    root.querySelector('#wsGlobalSearch').addEventListener('click', () => global.SoduWorkGlobalSearch?.open());
    global.SoduWorkGlobalSearch?.refreshEntry();
    if (global.WorkspaceSidebarProjects) sidebarProjects = global.WorkspaceSidebarProjects.create({
      root, getItems: () => chatItems, render: renderChats, legacyPins: legacyPinnedIds,
    });
    if (document.documentElement.dataset.deskPanel === 'workspace') {
      document.documentElement.style.setProperty('--ws-rail-w', '52px');
    }
    syncWorkspaceLayout(document.documentElement.dataset.workspaceView || 'create');
    renderRail();
    renderNav();
    applyLocaleToShell();
    renderChats();
    // Presentation preferences belong to the groups, not to a history snapshot.
    // Keep the mounted lists alive while collapsed so streaming and pinning stay in sync.
    function wireChatGroup(toggleId, key, label) {
      const toggle = root.querySelector('#' + toggleId);
      const body = root.querySelector('#' + toggle.getAttribute('aria-controls'));
      const setCollapsed = (collapsed) => {
        body.hidden = collapsed;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.title = (collapsed ? '展开' : '收起') + label;
      };
      let collapsed = false;
      try { collapsed = localStorage.getItem(key) === '1'; } catch (_e) { /* Storage may be unavailable. */ }
      setCollapsed(collapsed);
      toggle.addEventListener('click', () => {
        setCollapsed(!body.hidden);
        try { localStorage.setItem(key, body.hidden ? '1' : '0'); } catch (_e) { /* Still usable for this visit. */ }
      });
    }
    wireChatGroup('wsPinnedToggle', 'soduwork_work_ws_pinned_collapsed', '置顶');
    wireChatGroup('wsChatsToggle', 'soduwork_work_ws_chats_collapsed', '最近聊天');
    const recentBox = root.querySelector('#wsRecentBox');
    const recentToggle = root.querySelector('#wsRecentToggle');
    const setRecentCollapsed = (collapsed) => {
      recentBox.classList.toggle('is-collapsed', collapsed);
      recentToggle.setAttribute('aria-expanded', String(!collapsed));
      recentToggle.title = collapsed ? '展开最近需求' : '收起最近需求';
    };
    setRecentCollapsed(true);
    recentToggle.addEventListener('click', () => {
      setRecentCollapsed(!recentBox.classList.contains('is-collapsed'));
    });
    subscribeConversationPresence();
    refreshConversationHistory();

    /* Restore the sidebar width from storage, update --ws-side-w while dragging, and save on release.
       Track pointer movement on document so dragging continues outside the handle.
       Set the variable on documentElement: fixed business panels are body children
       and cannot inherit a custom property from the workspace shell. */
    (function wireSideResize() {
      const KEY = 'soduwork_work_ws_side_w';
      const CSSROOT = document.documentElement;
      const clamp = (w) => Math.max(168, Math.min(440, w));
      const setW = (w) => CSSROOT.style.setProperty('--ws-side-w', clamp(w) + 'px');
      try { const s = parseInt(localStorage.getItem(KEY) || '', 10); if (s) setW(s); } catch (e) { /* Use defaults when storage is unavailable. */ }
      const rz = root.querySelector('#wsResizer') || document.getElementById('wsResizer');
      if (!rz) return;
      /* Move the separator to body to escape the shell stacking context.
         Otherwise fixed panels cover the handle despite its local z-index.
         Keep this move idempotent and place the separator after the panels. */
      if (rz.parentElement !== document.body) document.body.appendChild(rz);
      rz.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const side = root.querySelector('.ws-side');
        const startX = e.clientX;
        const startW = side ? side.getBoundingClientRect().width : 220;
        CSSROOT.classList.add('ws-resizing');
        try { rz.setPointerCapture(e.pointerId); } catch (_e) { /* Pointer capture is unavailable in some environments. */ }
        const onMove = (ev) => { setW(startW + (ev.clientX - startX)); };
        const onUp = () => {
          CSSROOT.classList.remove('ws-resizing');
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          const s2 = root.querySelector('.ws-side');
          if (s2) { try { localStorage.setItem(KEY, String(Math.round(s2.getBoundingClientRect().width))); } catch (_e) {} }
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    })();

    /* The account avatar opens the default account-security page. */
    function openPersonalAccount() {
      if (global.WorkspaceHost) global.WorkspaceHost.open('account', { tab: 'security' });
    }
    root.querySelector('#wsMine').addEventListener('click', () => {
      openPersonalAccount();
    });
    /* Return to the page that was active before entering settings. */
    root.querySelector('#wsBack').addEventListener('click', () => {
      if (!global.WorkspaceHost) return;
      const key = lastHomeView || 'create';
      global.WorkspaceHost.open(key, key === 'create'
        ? (global.WorkspaceShell && typeof global.WorkspaceShell.newSessionPayload === 'function'
          ? global.WorkspaceShell.newSessionPayload()
          : { newSession: true })
        : {});
    });

    document.addEventListener('pointerdown', (e) => {
      if (!railMoreOpen) return;
      const target = e.target;
      if (target && (target.closest?.('.ws-rail') || target.closest?.('#wsRailMoreMenu'))) return;
      setRailMoreOpen(false);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!openChatMenu) return;
      const target = e.target;
      if (target?.closest?.('.ws-chat-menu,.ws-chat-more')) return;
      closeChatMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openChatMenu) { e.preventDefault(); closeChatMenu(true); }
    });
    window.addEventListener('resize', positionRailMoreMenu);

    root.addEventListener('click', (e) => {
      const railMine = e.target.closest('#wsRailMine');
      if (railMine) {
        openPersonalAccount();
        return;
      }
      const railMore = e.target.closest('[data-rail-menu="more"]');
      if (railMore) {
        e.stopPropagation();
        setRailMoreOpen(!railMoreOpen);
        return;
      }
      const toggle = e.target.closest('#wsCollaborationToggle');
      if (toggle) {
        collaborationCollapsed = !collaborationCollapsed;
        root.querySelector('#wsCollaborationItems').hidden = collaborationCollapsed;
        toggle.setAttribute('aria-expanded', String(!collaborationCollapsed));
        toggle.title = collaborationCollapsed ? '展开协作' : '收起协作';
        return;
      }
      const button = e.target.closest('button[data-view],button[data-rail-view]');
      if (!button) {
        if (railMoreOpen && !e.target.closest('.ws-rail')) setRailMoreOpen(false);
        return;
      }
      if (!global.WorkspaceHost) return;
      const key = button.dataset.view || button.dataset.railView;
      /* New chat is an action: selecting it while viewing a conversation creates a fresh draft.
         Other pages use ordinary navigation; archived chats retain their explicit chatId. */
      openWorkspaceView(key);
    });
    return root;
  }

  /* Select the sidebar mode from the current page so all navigation entry points agree. */
  function setActive(key) {
    mount(); active = key;
    reportWorkspaceView(key);
    setMode(SETTINGS_KEYS.has(key) ? 'settings' : 'home');
    syncWorkspaceLayout(key);
    if (!SETTINGS_KEYS.has(key) && key !== 'detail') lastHomeView = key;
    railMoreOpen = false;
    root.querySelectorAll('.ws-nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === key));
    syncRail();
    root.dataset.view = key;
    renderChats();
  }

  /* Render independent empty states without changing the parallel scroll hierarchy. */
  function _empty(box, text) {
    const d = document.createElement('div'); d.className = 'ws-list-empty'; d.textContent = text;
    box.appendChild(d);
  }

  function setTasks(items) {
    mount();
    const list = (items || []).slice().sort((a, b) => {
      const rank = { doing: 0, todo: 1, done: 2, cancel: 3 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
    }).slice(0, 8);
    recent.innerHTML = '';
    root.querySelector('#wsRecentBox').classList.toggle('is-empty', !list.length);
    if (!list.length) { _empty(recent, '还没有需求'); return; }
    list.forEach((task) => {
      const b = document.createElement('button'); b.className = 'ws-task'; b.dataset.taskId = task.id || '';
      const dot = document.createElement('i'); dot.className = 'st-' + (task.status || 'todo');
      const title = document.createElement('span'); title.textContent = task.title || '未命名需求';
      if (task.title) title.setAttribute('data-user-content', '');
      b.append(dot, title); b.addEventListener('click', (e) => {
        /* Pending requirements reopen their conversation; fall back to details when no chat host exists. */
        e.stopPropagation();
        if (typeof global.openTaskConversation === 'function') {
          global.openTaskConversation(task.id, task.title || '', { source: 'task-list' });
        } else if (global.WorkspaceHost) global.WorkspaceHost.open('create', {
          tab: 'chat', taskId: task.id, taskTitle: task.title || '', taskSession: true,
        });
        else if (typeof global.openDetailEntry === 'function') global.openDetailEntry(task.id);
      });
      recent.appendChild(b);
    });
  }

  /* The conversation view supplies recent chat records with id, title and updatedAt. */







  // A late history response or automatic title must not undo a user's rename.




  /* Load real local history when the shell mounts, before the user opens a chat.
     Coalesce concurrent reads from startup and navigation. */










  /* Group newly persisted conversations under their explicit project immediately. */
  function fileChatInProject(chatId, projectId, meta) {
    const done = sidebarProjects?.file(String(chatId || ''), String(projectId || ''), meta) === true;
    if (done) renderChats();
    return done;
  }

  function newSessionContext() {
    const selected = chatItems.find((row) => String(row && row.id || '') === activeChatId);
    const project = projectForChat(activeChatId);
    const context = project ? { sidebarProjectId: project.id, sidebarProjectName: project.name, projectId: project.businessProjectId || '' } : {};
    // A cloud conversation's cwd is either empty or a private replay cache.
    // Never carry it into a local draft; local and remote workspaces are
    // separate roots even when their conversations share the sidebar.
    if (selected && (selected.cloud === true || String(selected.locationMode || '').toLowerCase() === 'remote')) {
      return context;
    }
    const cwd = String(selected && (selected.cwd || selected.workDir || selected.workspaceDir) || '').trim();
    if (!cwd) return context;
    const workspaceLabel = String(selected.workspaceName || selected.workspaceLabel || '').trim() ||
      cwd.split(/[\\/]/).filter(Boolean).pop() || '\u5f53\u524d\u5de5\u4f5c\u76ee\u5f55';
    return { ...context, cwd, workspaceLabel };
  }

  /* 顶部「新对话」/窗口菜单「新建」等纯新对话入口的参数：项目归属只认显式
     传入（cda885c8），但工作目录作为默认值延续——显式传入优先；其次沿用当
     前活动会话的目录（云端会话目录不沿用，见 newSessionContext 的防护）；
     无活动会话时用最近一次手选的目录兜底（冷启动，主进程已校验目录仍存在）。
     用户点「默认工作区」会同步清掉最近手选记录，之后的新对话不再延续。 */
  function newSessionPayload(extra) {
    const given = extra || {};
    let inherited = {};
    if (!given.cwd) {
      const context = newSessionContext();
      if (context.cwd) {
        inherited = { cwd: context.cwd, workspaceLabel: context.workspaceLabel || '',
          workspaceSource: 'last-session' };
      } else if (recentWorkspace.dir) {
        inherited = { cwd: recentWorkspace.dir, workspaceLabel: recentWorkspace.name || '',
          workspaceSource: 'recent' };
      }
    }
    return { ...inherited, ...given, newSession: true };
  }

  function projectForChat(id) { return sidebarProjects?.projectForChat(String(id || '')) || null; }

  function setApprovalCount(count) {
    mount(); const badge=root.querySelector('#wsApprovalBadge');
    const n=Number(count||0);
    if (badge) { badge.textContent=n>99?'99+':String(n||''); badge.classList.toggle('show',n>0); }
  }
  function setNoticeCount(count) {
    if (!root) return;
    const badge=root.querySelector('#wsRailNoticeBadge');
    const n=Math.max(0, Number(count)||0);
    if (badge) { badge.textContent=n>99?'99+':String(n||''); badge.classList.toggle('show',n>0); }
  }
  function refreshNoticeBadge() {
    setNoticeCount(typeof noticeUnread === 'function' ? noticeUnread() : 0);
  }
  function setConnected(ok) {
    mount();
    const mine = root.querySelector('#wsMine');
    if (mine) mine.dataset.connection = ok ? 'connected' : 'connecting';
    root.querySelector('#wsHubState').textContent = ok ? wsT('connected', '已连接 SoduWork 服务') : wsT('connecting', '服务连接中');
  }

  /* Refresh team navigation after asynchronous capability loading. */
  function refreshNav() {
    if (root && nav) { renderRail(); renderNav(); }
  }

  /* Keep update status available; installation requires an explicit progress-card action. */
  function setUpdateState(status) {
    updateStatus = status || {};
    mount();
    applyUpdateState(updateStatus);
  }

  function applyUpdateState(status) {
    const btn = root.querySelector('#wsUpdate');
    if (btn) global.ClientUpdateView?.present(status, btn);
  }

  global.WorkspaceShell = { mount, setActive, setTasks, setChats, upsertChat, removeChat, setActiveChat, renameChat,
                            searchChats: () => chatItems.filter(row => !row.pending).map(row => ({ ...row })),
                            searchProjects: () => sidebarProjects?.searchProjects() || [],
                            openSearchProject: id => sidebarProjects?.openSearchProject(id),
                            newSessionContext, newSessionPayload, projectForChat, fileChatInProject,
                            refreshConversationHistory, setApprovalCount, setNoticeCount, setConnected, refreshNav, setUpdateState,
                            refreshRecentWorkspace,
                            _reconcileChats, _upsertChatItems, _chatState: chatState,
                            get active() { return active; }, get mode() { return mode; },
                            get activeChatId() { return activeChatId; }, set activeChatId(value) { activeChatId = value; },
                            /* Remember the return destination for the detail page. */
                            get lastView() { return lastHomeView; } };
  // The desk has no pet dock; reuse the store/window-sync invalidation hook.
  if (typeof global.updateNoticeBadge !== 'function') global.updateNoticeBadge = () => {
    refreshNoticeBadge();
    const panel = document.getElementById('noticePanel');
    if (panel?.classList.contains('show') && typeof _renderNoticePanel === 'function') _renderNoticePanel();
  };
  if (global.addEventListener) {
    global.addEventListener('pagehide', () => reportWorkspaceView(active));
    global.addEventListener('beforeunload', () => reportWorkspaceView(active));
  }
})(window);
