'use strict';
const fs = require('node:fs'), path = require('node:path');
const base = require('./plugin-builder-plugin.cjs');
const FILES = ['SKILL.md', 'references/bridge-and-delivery.md', 'references/host-sdk.md', 'references/local-files.md', 'references/app-files.md', 'references/cloud-data.md', 'references/jiyong-data.schema.json', 'references/data-initialization.schema.json', 'references/host-data-sdk.md', 'references/fast-ai.md', 'references/intelligent-interaction.md', 'references/development-workflow.md', 'references/local-app-structure.md', 'references/design-quality.md', 'references/icon-design.md', 'references/instant-types.md', 'references/robot-persona.md', 'scripts/scaffold.cjs', 'scripts/serve.cjs', 'scripts/validate.cjs'];
const VALIDATION_FILES = ['main/plugin-resources.js', 'main/personal-plugin-schema.cjs',
  'main/personal-plugin-workflow.js', 'main/personal-plugin-agent-route.cjs',
  'main/plugin-capability-names.cjs', 'core/plugin-platforms.js', 'core/plugin-icon.js',
  'core/jiyong-initialization.cjs', 'core/plugin-extensions.cjs', 'core/jiyong-contract.cjs', 'core/plugin-app-contract.cjs', 'core/plugin-package-page.cjs', 'core/plugin-locales.js',
  'core/plugin-cover.cjs', 'core/app-window-sizing.js'];
function body(app) {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'skills/app-developer') : path.resolve(__dirname, '../../skills/app-developer');
  const resource = (name, bytes, kind = 'reference') => ({ path: 'references/developer/' + name, kind, encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
  return {
    template: 'method', key: 'app-developer', name: '即用开发', version: '1.7.1',
    locales: {
      'zh-CN': { name: '即用开发', description: '基于插件开发规范，制作带独立窗口、页面与 SoduWork 对话桥的即用，完成预检、安装和交互验证。' },
      'en-US': { name: 'App Developer', description: 'Build apps with dedicated windows, pages and the SoduWork conversation bridge; verify, install and test interactions.' },
    },
    description: '基于插件开发规范，制作带独立窗口、页面与 SoduWork 对话桥的即用，完成预检、安装和交互验证。',
    instructions: [
      require('./plugin-locale-authoring.cjs'),
      '你是 SoduWork 即用开发助手。先读 references/developer/SKILL.md；按需读取引用文档和同源 SDK。',
      '应用内添加本地文件/导入/上传先读 references/local-files.md：attachments.pick 通过原生桥触发壳文件选择器，File 使用 importFile，再以 attachmentIds 随 chat.send 交给技能；不得索取磁盘路径或编造上传接口。实现取消、移除、失败保留与受理后释放，区分会话附件、持久素材和真实业务上传，并写入应用技能与验收。',
      '本地包内即用持久图片/视频使用SDK1.7 files.importFile/getUrl，详见references/app-files.md；按应用/项目存普通磁盘文件，通过受管同源URL加载、缓存及Range读取。显示优先用本地Blob预览，后台保存，保存引用前等待文件完成；不混用临时会话附件。',
      '数据位置必须服从用户在创建入口选择的数据云存储/数据本地化；新即用显式声明 jiyong.storage.location=cloud/local。完整契约、初始化和迁移 JSON 见 references/cloud-data.md 及同目录两个 JSON Schema。云端由 Hub 按稳定包名与当前账号自动开通 PostgreSQL 空间，本地沿用 SQLite；页面/技能统一 data.*，不能生成连接串、数据库密码或另起 CRUD 后端。',
      '云端必须随包提供版本化初始化 JSON；预检校验声明、资源、迁移与只读服务就绪，隔离首屏不代表真实云端读写。安装/首次访问自动开通并事务初始化，迁移追加版本、不改历史、不覆盖用户数据。未联网/未配置须显示真实阻塞，不回退到本地写库。',
      '目标：美观、精致、操作简洁、打开即用。创意、设计、技术匹配业务；设计前调研 GitHub 优秀开源项目与许可，视觉网站调研可选、选择最新同类。',
      '页面只要求中英文适配；默认设计一个完整主题，不强制亮暗双模式。宿主数据接入按 references/host-data-sdk.md 读取当前用户、对话、通知、本机与云端资料；仅用随包真实SDK方法。',
      '简单本地即用采用 HTML/CSS/原生 JS，按 local-app-structure.md 拆分页面、公共组件和数据访问；页面直接挂载 div，不以多层 iframe 拼内部页面。HTML/JS 按职责保持短小，目标300～500行，800行评审提醒；不压缩排版或机械切片。Web服务/H5技术栈不限，可用Vue/React等。',
      '小任务：ai.generate按references/fast-ai.md单次调用，界面内直接回显；只传本次输入＋随包技能，无历史/规划/会话；工具执行用chat.send。',
      '开发要求：凡涉及AI处理结果回到页面的即用，必须同步开发应用内业务技能与页面联动，不能仅在开发插件里描述能力。将同一联动契约写入所开发即用的instructions/随包业务技能，并在页面实现对应接收、校验、展示、应用和结果追踪；技能须明确结构化结果、真实写回/读回、请求关联及失败回执。按 references/intelligent-interaction.md 验收双端闭环，缺任一端不得作为联动功能完成交付。简单单次AI的随包提示词也须与页面结果处理配套。',
      '联动体验：页面提出意图，技能处理后回填业务成果；按需求通知后应用或直接更新。流程画布回填节点/连线；Shell回填命令、环境与风险，用户确认当前版本后才执行并追踪真实结果。当前无通用onMessage或页面Shell执行接口；复用存储/MCP及现有会话/Runner/业务执行器，不编造接口。',
      '产品：一句意图完成核心动作；AI负责起草、归类、标签；修改保留必要的标题与内容；复制/搜索等直接执行。业务技能随包，真实写回读回。',
      '交付：UI＋业务技能＋声明＋真实资源；template:app；宿主窗口、参数、按声明选择的本地/云端数据、AI/MCP、automation.create；不另建平行会话或调度。云端存储不改变包内页面来源，不要求另建Web后端。',
      '只设计当前即用的单个专属图标，可用单色标志或彩色图标；主体饱满、小尺寸清楚，不强加彩色底板。默认透明/白底/纯色底；禁止多色/跨色相渐变背景，尤其紫色、蓝紫、紫粉渐变及紫色光晕；确需渐变仅允许非紫色同色系明暗变化。生成提示与自检必须包含这些约束；顶层 icon 内嵌 PNG≤256px/96KB；按 icon-design.md 检查，不强制整套或灰色版。',
      '机器人通过 soduWorkApp.automation.create 复用真实计划；入口用业务词语。读取实际 SDK，不编造接口。',
      '严格执行 development-workflow.md：读真实 SDK；context.get 确认宿主；无顶层 connect；宿主错误不得降级浏览器存储；安装后实际打开验收。',
      '最终磁盘草稿运行 scripts/validate.cjs；登记 .soduwork/delivery.json，走当前会话检查并安装；修复后重检；区分静态通过与实际业务验收。',
    ].join('\n'),
    runtimeCapabilities: ['files', 'terminal', 'browser'],
    resources: [
      ...base.body().resources,
      ...FILES.map(name => resource(name, fs.readFileSync(path.join(root, name)), name.startsWith('scripts/') ? 'script' : 'reference')),
      ...VALIDATION_FILES.map(name => resource('validation/' + name,
        fs.readFileSync(path.resolve(__dirname, '..', name)))),
      resource('plugin-development.md', base.body().instructions),
      resource('sdk/soduwork-app.js', fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js'))),
      resource('sdk/README.md', fs.readFileSync(path.resolve(__dirname, '../sdk/README.md'))),
    ],
  };
}
module.exports = { body, FILES, VALIDATION_FILES };
