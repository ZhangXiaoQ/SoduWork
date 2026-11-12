import { ja as automationTemplatesJa, ko as automationTemplatesKo } from './automation-templates.js'
import { ja as capabilityCatalogJa, ko as capabilityCatalogKo } from './capability-catalog.js'
import { dictionary } from './shell.js'
import { ja as legalJa, ko as legalKo } from './legal-documents.js'
// High-value admin-shell translations for the additional locales. The complete
// English catalog remains the fallback, so adding a locale never leaves a
// half-rendered page or exposes Chinese source text in an English layout.
import { ja as governanceJa, ko as governanceKo } from './governance-overview.js'
import { ja as insightsMetricsJa, ko as insightsMetricsKo } from './insights-metrics.js'
import { ja as usageCenterJa, ko as usageCenterKo } from './usage-center.js'
import { ja as modelRuntimeOverviewJa, ko as modelRuntimeOverviewKo } from './model-runtime-overview.js'
import { ja as connectorJa, ko as connectorKo } from './connector-management.js'
import { ja as cloudRunnerJa, ko as cloudRunnerKo } from './cloud-runner-management.js'
import { ja as modelJa, ko as modelKo } from './model-capabilities.js'
import { ja as quotaJa, ko as quotaKo } from './quota-management.js'
import { ja as accessCatalogJa, ko as accessCatalogKo } from './access-catalog.js'
import { ja as operationsJa, ko as operationsKo } from './operations-overview.js'
const ja = {
  '编辑推荐': '推薦を編集', '编辑推荐 ': '推薦を編集: ',
  '推荐设置': '推薦設定',
  '推荐位置': '推薦場所', '可多选 · 排序默认升序': '複数選択可・並び順は既定で昇順',
  '可多选 · 客户端按目录默认排序': '複数選択可・クライアントはカタログ既定順で表示',
  '对话页 · 起手推荐': 'チャットページ・スターターカード',
  '出现在「新对话」页输入框下方，点击直接填入输入框（横向 ≤3）': '「新規チャット」ページの入力欄の下に表示され、クリックで入力欄に直接記入されます（横に最大3件）',
  '新对话页输入框下方的起手推荐位，点击直接打开应用': '新規チャットページの入力欄の下のスタータースロット。クリックでアプリを直接開きます',
  '应用页 · 推荐分组': 'アプリページ・おすすめグループ',
  '出现在应用面板「推荐」分组（大图卡片）': 'アプリパネル「おすすめ」グループに表示されます（大きなカード）',
  '应用面板「推荐」分组的大图卡片': 'アプリパネル「おすすめ」グループの大きなカード',
  '封面': 'カバー', '可选 · 仅用于应用页大图卡，coverUrl 自动填入': '任意・アプリページの大きなカードにのみ使用。coverUrl は自動取得',
  '两处使用同一套素材（图标＋应用名＋描述，文案自动生成）。': '両方の場所で同じ素材（アイコン・アプリ名・説明、文面は自動生成）を使用します。',
  '推荐 ': '推薦: ', '推荐 · {0}': '推薦 · {0}',
  '请填写有效的 HTTP(S) 封面地址': '有効な HTTP(S) カバー URL を入力してください',
  '已推荐，客户端目录会自动同步': '推薦しました。クライアントカタログに自動同期されます。',
  '取消推荐': '推薦を取り消す', '正在保存…': '保存中…', '已取消推荐': '推薦を取り消しました',
  '保存推荐信息后，应用仍需审核通过并上架，才会展示在客户端。': '推薦情報の保存後も、承認と公開を経てからクライアントに表示されます。',
  '两处使用同一套素材（图标＋应用名＋描述，文案自动生成）；封面仅用于应用页大图卡。': '両方の場所で同じ素材（アイコン・アプリ名・説明は自動生成）を使用します。カバーはアプリページのカードのみに使われます。',
  '已保存推荐，客户端目录会自动同步': '保存しました。クライアントカタログに自動同期されます。',
  '未命名集成源': '名称未設定の連携元',
  '设置': '設定', '外观': '外観', '通知': '通知', '需求池': '課題', '团队': 'チーム', '简报': 'ブリーフ',
  '自动化模板': '自動化テンプレート', '运行监控': '実行モニター', '执行网络': '実行ネットワーク', '用量与成本': '使用量とコスト',
  '项目与仓库': 'プロジェクトとリポジトリ', '仓库目录': 'リポジトリカタログ', '模型目录': 'モデルカタログ', '插件与应用': 'プラグインとアプリ',
  '能力目录': '機能カタログ', '系统集成': 'システム連携', '组织架构': '組織', '组织记忆': '組織メモリ', '工作目录': '作業カタログ',
  '用户管理': 'ユーザー管理', '角色权限': 'ロールと権限', '身份接入': 'ID 接続', '审计日志': '監査ログ', '保存': '保存', '取消': 'キャンセル',
  '关闭': '閉じる', '确定': '確認', '删除': '削除', '编辑': '編集', '添加': '追加', '刷新': '更新', '搜索': '検索', '重试': '再試行',
  '加载中…': '読み込み中…', '语言': '言語', '界面语言': '表示言語', '我的设置': 'マイ設定', '服务运行正常': 'サービスは正常です',
  '正在确认服务': 'サービスを確認中', '服务连接异常': 'サービス接続の問題', '同事': 'メンバー', '首页': 'ホーム', '返回': '戻る', '创建': '作成',
  '打开': '開く', '查看': '表示', '导出': 'エクスポート', '导入': 'インポート', '测试连接': '接続をテスト', '启用': '有効化', '停用': '無効化',
  '云端环境': 'クラウド環境', '连接器': 'コネクター', '插件': 'プラグイン', '技能': 'スキル', '模型': 'モデル', '智能体': 'エージェント',
  '需求': '課題', '任务': 'タスク', '运行中': '実行中', '已完成': '完了', '失败': '失敗', '排队中': '待機中', '待审核': '審査待ち', '已通过': '承認済み',
  '可更新': '更新可能', '下载中': 'ダウンロード中', '已下载': 'ダウンロード済み', '等待安装': 'インストール待ち',
  '安装中': 'インストール中', '已推迟': '延期済み', '已安装': 'インストール済み',
};

const ko = {
  '编辑推荐': '추천 편집', '编辑推荐 ': '추천 편집: ',
  '推荐位置': '추천 위치', '可多选 · 排序默认升序': '복수 선택 · 순서는 기본 오름차순',
  '推荐设置': '추천 설정',
  '可多选 · 客户端按目录默认排序': '복수 선택 · 클라이언트는 카탈로그 기본 순서로 표시',
  '对话页 · 起手推荐': '대화 페이지 · 시작 카드',
  '出现在「新对话」页输入框下方，点击直接填入输入框（横向 ≤3）': '새 대화 페이지 입력창 아래에 표시되며, 클릭하면 입력창에 바로 채워집니다(한 줄에 최대 3개)',
  '新对话页输入框下方的起手推荐位，点击直接打开应用': '새 대화 페이지 입력창 아래의 시작 슬롯입니다. 클릭하면 앱을 바로 엽니다',
  '应用页 · 推荐分组': '앱 페이지 · 추천 그룹',
  '出现在应用面板「推荐」分组（大图卡片）': '앱 패널의 ‘추천’ 그룹에 표시됩니다(큰 카드)',
  '应用面板「推荐」分组的大图卡片': '앱 패널 ‘추천’ 그룹의 큰 카드',
  '封面': '표지', '可选 · 仅用于应用页大图卡，coverUrl 自动填入': '선택·앱 페이지 큰 카드에만 사용되며 coverUrl은 자동 채움',
  '两处使用同一套素材（图标＋应用名＋描述，文案自动生成）。': '두 위치는 동일한 소재(아이콘·앱 이름·설명, 문구 자동 생성)를 사용합니다.',
  '推荐 ': '추천: ', '推荐 · {0}': '추천 · {0}',
  '请填写有效的 HTTP(S) 封面地址': '유효한 HTTP(S) 표지 URL을 입력하세요',
  '已推荐，客户端目录会自动同步': '추천했습니다. 클라이언트 카탈로그에 자동 동기화됩니다.',
  '取消推荐': '추천 해제', '正在保存…': '저장 중…', '已取消推荐': '추천을 취소했습니다',
  '保存推荐信息后，应用仍需审核通过并上架，才会展示在客户端。': '추천 정보를 저장한 후에도 승인과 게시를 거쳐야 클라이언트에 표시됩니다.',
  '两处使用同一套素材（图标＋应用名＋描述，文案自动生成）；封面仅用于应用页大图卡。': '두 위치는 동일한 소재(아이콘·앱 이름·설명, 문구 자동 생성)를 사용하며, 표지는 앱 페이지 카드에만 사용됩니다.',
  '已保存推荐，客户端目录会自动同步': '저장했습니다. 클라이언트 카탈로그에 자동 동기화됩니다.',
  '未命名集成源': '이름 없는 연동 소스',
  '设置': '설정', '外观': '모양', '通知': '알림', '需求池': '이슈', '团队': '팀', '简报': '브리핑',
  '自动化模板': '자동화 템플릿', '运行监控': '실행 모니터링', '执行网络': '실행 네트워크', '用量与成本': '사용량 및 비용',
  '项目与仓库': '프로젝트 및 저장소', '仓库目录': '저장소 카탈로그', '模型目录': '모델 카탈로그', '插件与应用': '플러그인 및 앱',
  '能力目录': '기능 카탈로그', '系统集成': '시스템 통합', '组织架构': '조직', '组织记忆': '조직 메모리', '工作目录': '작업 카탈로그',
  '用户管理': '사용자 관리', '角色权限': '역할 및 권한', '身份接入': 'ID 연동', '审计日志': '감사 로그', '保存': '저장', '取消': '취소',
  '关闭': '닫기', '确定': '확인', '删除': '삭제', '编辑': '편집', '添加': '추가', '刷新': '새로 고침', '搜索': '검색', '重试': '다시 시도',
  '加载中…': '로드 중…', '语言': '언어', '界面语言': '인터페이스 언어', '我的设置': '내 설정', '服务运行正常': '서비스가 정상입니다',
  '正在确认服务': '서비스 확인 중', '服务连接异常': '서비스 연결 문제', '同事': '동료', '首页': '홈', '返回': '뒤로', '创建': '생성',
  '打开': '열기', '查看': '보기', '导出': '내보내기', '导入': '가져오기', '测试连接': '연결 테스트', '启用': '사용', '停用': '사용 중지',
  '云端环境': '클라우드 환경', '连接器': '커넥터', '插件': '플러그인', '技能': '스킬', '模型': '모델', '智能体': '에이전트',
  '需求': '이슈', '任务': '작업', '运行中': '실행 중', '已完成': '완료', '失败': '실패', '排队中': '대기 중', '待审核': '검토 대기', '已通过': '승인됨',
  '可更新': '업데이트 가능', '下载中': '다운로드 중', '已下载': '다운로드 완료', '等待安装': '설치 대기 중',
  '安装中': '설치 중', '已推迟': '연기됨', '已安装': '설치됨',
};

// Authored NAV constants use Chinese source text; fill missing labels from the keyed
// shell catalog before applying existing page translations. Those catalogs remain authoritative.
const shellMessages = locale => Object.fromEntries(Object.entries(dictionary['zh-CN']).map(([key, source]) => [source, dictionary[locale][key]]))

export const messagesByLocale = Object.freeze({
  'ja-JP': Object.freeze({ ...shellMessages('ja-JP'), ...automationTemplatesJa, ...ja, ...connectorJa, ...cloudRunnerJa, ...modelJa, ...quotaJa, ...accessCatalogJa, ...operationsJa, ...governanceJa, ...insightsMetricsJa, ...usageCenterJa, ...modelRuntimeOverviewJa, ...capabilityCatalogJa, ...legalJa }),
  'ko-KR': Object.freeze({ ...shellMessages('ko-KR'), ...automationTemplatesKo, ...ko, ...connectorKo, ...cloudRunnerKo, ...modelKo, ...quotaKo, ...accessCatalogKo, ...operationsKo, ...governanceKo, ...insightsMetricsKo, ...usageCenterKo, ...modelRuntimeOverviewKo, ...capabilityCatalogKo, ...legalKo }),
});
