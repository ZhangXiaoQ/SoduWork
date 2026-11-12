"""Public, versioned account documents and administrator-owned contact details."""
import json
import re
from datetime import datetime, timezone

from ..models import AppSetting

TERMS_VERSION = PRIVACY_VERSION = "2026-10-23"
SETTINGS_KEY = "account_legal_v1"
LOCALES = ("zh-CN", "en-US", "ja-JP", "ko-KR")

# Legacy fallback documents (shown until the first platform publication), one
# revision per supported client language so every UI locale reads its own text.
# {version}/{operator}/{contact} are filled per document; the per-language
# "operator"/"contact" entries are placeholders used while the administrator
# has not configured the real values yet.
_LEGAL_TEXTS = {
    "zh-CN": {
        "titles": {"terms": "用户协议", "privacy": "隐私政策"},
        "operator": "待管理员填写服务运营方",
        "contact": "待管理员填写隐私联系邮箱",
        "terms": """SoduWork 用户协议
版本：{version}
服务运营方：{operator}
联系邮箱：{contact}

一、账号注册与使用
你可以使用本人控制的邮箱注册。完成邮箱验证、设置密码并确认协议后，账号立即启用，加入管理员配置的默认组织和角色。组织、角色、模型额度、工程与插件权限由后台策略决定。请保管邮箱、密码和设备，不冒用他人身份。

二、工作内容与执行授权
SoduWork 提供对话、需求管理、工具及 Agent 执行能力。发送给模型或插件的内容取决于你实际选择和授权的操作。账号注册和验证码操作不调用大模型。AI 输出需要你结合实际情况核对；涉及外部系统的操作按产品内确认与组织权限执行。

三、组织与个人数据
加入默认组织后，团队共享内容按现有组织权限可见。个人资料、个人资料库和账号凭据按本人权限访问；团队需求、交付和审计记录遵循组织管理规则。

四、账号安全与终止
你可以修改密码、更换邮箱、移除登录设备、导出个人数据或申请注销。安全操作需要再次验证身份。注销将立即撤销登录，并异步清理个人云端数据；在执行的工作需先结束或移交。团队业务记录不因个人注销而级联删除。本机独立保存的聊天和文件需要在对应设备清理。

五、服务联系与协议更新
遇到账号、数据或服务问题，可联系上述邮箱。协议发生实质变更时应发布新版本并告知用户；涉及需要重新取得同意的处理，应重新确认。
""",
        "privacy": """SoduWork 隐私政策
版本：{version}
个人信息处理者：{operator}
隐私联系邮箱：{contact}

一、收集的信息与用途
邮箱用于注册、登录、找回密码和安全通知；服务端保存密码哈希，不保存可还原的登录密码。设备标识、系统类型、登录时间用于可信设备绑定和账号安全。头像和昵称由你主动填写。注册不要求身份证、手机号或个人住址。

二、本机、云端和第三方
本机聊天归档和工作文件不等于已上传云端。同步到 Hub 的需求、资料、个人记忆和设置按对应功能保存。你使用模型、插件或连接器时，所选服务可能接收实际任务所需内容；第三方服务由所选供应商及组织配置决定，可在相应模型或连接管理中查看。邮件服务接收收件邮箱和本次验证码或通知内容。

三、安全、保存和访问
验证码仅短期有效，验证记录按用途隔离；验证码、密码和授权凭据不进入普通日志。发信必需的内容加密保存，到期或完成后清除。账号信息在提供账号服务期间保存；注销后开始删除私人云端数据。导出下载有效期为 24 小时。出于组织业务连续性或依法应保存的记录，仅在必要范围内保留并限制访问，具体情况可向运营方查询。

四、你的权利与操作入口
你可在“个人信息”更正昵称、头像和邮箱，在“账号与安全”管理密码和登录设备，在“隐私与数据”查看确认的协议版本、导出本人数据、申请注销。对未在界面提供的查阅、复制、更正、删除、撤回同意或解释请求，可联系隐私邮箱。本产品账号流程不捆绑营销订阅，也不因拒绝非必要授权限制基本账号管理。

五、导出与注销范围
账号导出提供本人基本资料、协议记录、本人拥有的个人资料库文件及个人记忆。完整企业数据、他人个人信息、登录密钥及第三方密钥不包含在导出中；设备本地聊天通过对应设备导出。注销清除私人云端资料并撤销本产品保存的授权，团队需求、交付、审批和审计按组织归属保留。第三方平台独立保存的数据或未在线设备的本机文件，需在对应平台或设备处理。清理失败会记录并重试，未完成时不宣称已全部删除。

六、联系与更新
政策内容应与实际服务一致。信息处理目的、方式或范围发生实质变化时，运营方应告知并按适用要求重新取得同意。你可通过上述邮箱反馈个人信息问题。
""",
    },
    "en-US": {
        "titles": {"terms": "Terms of Service", "privacy": "Privacy Policy"},
        "operator": "Service operator pending administrator setup",
        "contact": "Privacy contact email pending administrator setup",
        "terms": """SoduWork Terms of Service
Version: {version}
Service operator: {operator}
Contact email: {contact}

1. Account registration and use
You may register with an email address you control. Once your email is verified, a password is set, and this agreement is confirmed, your account is activated immediately and joins the default organization and roles configured by the administrator. Organizations, roles, model quotas, and project and plugin permissions are governed by backend policy. Keep your email, password, and devices safe, and do not impersonate others.

2. Work content and execution authorization
SoduWork provides conversation, issue management, tool, and agent execution capabilities. What is sent to models or plugins depends on the operations you actually choose and authorize. Account registration and verification-code operations do not invoke large models. Check AI output against your actual situation; operations involving external systems follow in-product confirmation and organization permissions.

3. Organization and personal data
After joining the default organization, team-shared content is visible according to existing organization permissions. Personal profiles, the personal knowledge base, and account credentials are accessed according to your own permissions; team issues, deliverables, and audit records follow organization management rules.

4. Account security and termination
You can change your password, replace your email, remove signed-in devices, export your personal data, or request account deletion. Security operations require re-verification of your identity. Deletion immediately revokes sign-in and asynchronously cleans up personal cloud data; work in progress must first be finished or handed over. Team business records are not cascade-deleted by personal deletion. Chats and files saved independently on this device need to be cleaned up on the corresponding device.

5. Service contact and agreement updates
For account, data, or service issues, contact the email above. Material changes to this agreement will be released as a new version with notice to users; processing that requires renewed consent will be reconfirmed.
""",
        "privacy": """SoduWork Privacy Policy
Version: {version}
Personal information handler: {operator}
Privacy contact email: {contact}

1. Information collected and its use
Your email is used for registration, sign-in, password recovery, and security notices; the server stores password hashes only and never reversible sign-in passwords. Device identifiers, system type, and sign-in time are used for trusted device binding and account security. Avatar and nickname are filled in voluntarily. Registration does not require an ID number, phone number, or home address.

2. Local device, cloud, and third parties
Local chat archives and work files are not the same as being uploaded to the cloud. Issues, materials, personal memories, and settings synced to the Hub are stored by the corresponding features. When you use models, plugins, or connectors, the selected services may receive the content needed for the actual task; third-party services are determined by the selected providers and organization configuration and can be reviewed in the corresponding model or connection management. The email service receives the recipient address and the verification code or notification content of that message.

3. Security, retention, and access
Verification codes are valid only for a short period, and verification records are isolated by purpose; verification codes, passwords, and authorization credentials never enter ordinary logs. Content required for sending email is stored encrypted and cleared on expiry or completion. Account information is retained while account services are provided; deletion of personal cloud data begins after account deletion. Export downloads are valid for 24 hours. Records retained for organizational business continuity or as required by law are kept only within the necessary scope with restricted access; contact the operator for specifics.

4. Your rights and entry points
You can correct your nickname, avatar, and email under "Personal info", manage your password and signed-in devices under "Account security", and view confirmed agreement versions, export your data, or request deletion under "Privacy and data". For access, copying, correction, deletion, withdrawal of consent, or explanations not available in the interface, contact the privacy email. The account flow does not bundle marketing subscriptions, and refusing non-essential authorizations does not limit basic account management.

5. Scope of export and deletion
Account export includes your basic profile, agreement records, personal knowledge base files you own, and personal memories. Full enterprise data, other people's personal information, sign-in keys, and third-party keys are not included; local device chats are exported through the corresponding device. Deletion clears personal cloud data and revokes authorizations stored by this product, while team issues, deliverables, approvals, and audit records are retained under their organization. Data stored independently by third-party platforms, or local files on offline devices, must be handled on the corresponding platform or device. Cleanup failures are recorded and retried, and completion is never claimed before it is done.

6. Contact and updates
This policy should match the actual service. When the purposes, methods, or scope of processing materially change, the operator will notify users and obtain consent again as applicable. You can report personal information issues through the email above.
""",
    },
    "ja-JP": {
        "titles": {"terms": "利用規約", "privacy": "プライバシーポリシー"},
        "operator": "サービス提供者は管理者による設定待ちです",
        "contact": "プライバシー連絡先メールは管理者による設定待ちです",
        "terms": """SoduWork 利用規約
バージョン：{version}
サービス提供者：{operator}
連絡先メール：{contact}

一、アカウント登録と利用
本人が管理するメールアドレスで登録できます。メール認証の完了、パスワードの設定、本規約への同意をもってアカウントは直ちに有効化され、管理者が設定した既定の組織とロールに参加します。組織、ロール、モデル割り当て、プロジェクトおよびプラグインの権限はバックエンドのポリシーにより決定されます。メールアドレス・パスワード・端末を適切に管理し、他人になりすまさないでください。

二、作業内容と実行の許諾
SoduWork は対話、課題管理、ツール、エージェント実行の機能を提供します。モデルやプラグインに送信される内容は、ユーザーが実際に選択し許諾した操作によって決まります。アカウント登録と認証コードの操作では大規模モデルを呼び出しません。AI の出力は実際の状況に照らしてご確認ください。外部システムに関わる操作は、製品内の確認と組織の権限に従って実行されます。

三、組織と個人データ
既定の組織に参加すると、チームで共有するコンテンツは既存の組織権限に従って表示されます。個人プロフィール、個人ナレッジベース、アカウント資格情報は本人の権限の範囲でアクセスされ、チームの課題・成果物・監査記録は組織の管理規則に従います。

四、アカウントのセキュリティと終了
パスワードの変更、メールアドレスの変更、ログイン端末の削除、個人データのエクスポート、アカウント削除の申請ができます。セキュリティ操作では本人確認を再度行います。削除するとログインは直ちに取り消され、個人クラウドデータは非同期でクリーンアップされます。実行中の作業は先に完了するか引き継ぐ必要があります。チームの業務記録は個人削除によって連鎖削除されません。この端末に独立して保存されたチャットやファイルは、該当する端末でクリーンアップしてください。

五、サービス連絡と規約の更新
アカウント、データ、サービスに関する問題は、上記のメールアドレスにご連絡ください。本規約に実質的な変更がある場合は新バージョンを公開してユーザーに告知します。改めて同意が必要な処理については、再度確認を行います。
""",
        "privacy": """SoduWork プライバシーポリシー
バージョン：{version}
個人情報取扱者：{operator}
プライバシー連絡先メール：{contact}

一、収集する情報と利用目的
メールアドレスは登録、ログイン、パスワードの再設定、セキュリティ通知に使用します。サーバーはパスワードのハッシュのみを保存し、復元可能なログインパスワードは保存しません。端末識別子、システム種別、ログイン時刻は、信頼できる端末の紐付けとアカウントセキュリティに使用します。アバターとニックネームはご本人が任意に入力します。登録に身分証明書、電話番号、住所は不要です。

二、ローカル、クラウド、第三者
ローカルのチャットアーカイブと作業ファイルは、クラウドへアップロードされたことを意味しません。Hub に同期した課題、資料、個人メモリ、設定は、それぞれの機能に応じて保存されます。モデル、プラグイン、コネクタを利用する際、選択したサービスが実際のタスクに必要な内容を受け取る場合があります。第三者サービスは選択したプロバイダと組織の設定によって決まり、対応するモデルまたは接続管理で確認できます。メールサービスは受信者メールアドレスと、今回の認証コードまたは通知内容を受け取ります。

三、セキュリティ、保存、アクセス
認証コードは短期間のみ有効で、検証記録は用途ごとに分離されます。認証コード、パスワード、認可情報は通常のログに記録されません。送信に必要な内容は暗号化して保存し、期限切れまたは完了後に消去します。アカウント情報はアカウントサービスの提供期間中保存され、削除後は個人クラウドデータの削除を開始します。エクスポートのダウンロード有効期限は 24 時間です。組織の業務継続性や法令により保存すべき記録は、必要な範囲でのみ保管しアクセスを制限します。詳細は提供者までお問い合わせください。

四、ユーザーの権利と操作入口
「個人情報」でニックネーム・アバター・メールアドレスを修正し、「アカウントセキュリティ」でパスワードとログイン端末を管理し、「プライバシーとデータ」で同意済みの規約バージョンの確認、本人データのエクスポート、削除の申請ができます。画面で提供されていない閲覧、複製、訂正、削除、同意の撤回、説明の請求は、プライバシー連絡先メールまでご連絡ください。本製品のアカウントフローはマーケティング購読を組み込まず、不要な許諾を拒否しても基本的なアカウント管理は制限されません。

五、エクスポートと削除の範囲
アカウントのエクスポートには、本人の基本プロフィール、規約の記録、本人が所有する個人ナレッジベースのファイル、個人メモリが含まれます。企業データの一式、他人の個人情報、ログイン鍵、第三者の鍵は含まれません。端末ローカルのチャットは対応する端末からエクスポートします。削除すると個人クラウドデータが消去され、本製品が保存した認可も取り消されます。チームの課題、成果物、承認、監査記録は組織の帰属に従って保持されます。第三者プラットフォームが独立して保存したデータや、オフライン端末のローカルファイルは、対応するプラットフォームまたは端末で処理してください。クリーンアップに失敗した場合は記録して再試行し、完了していないのに完了したとは表示しません。

六、連絡と更新
ポリシーの内容は実際のサービスと一致させてください。情報処理の目的、方法または範囲に実質的な変更がある場合は、提供者がユーザーに告知し、適用要件に応じて改めて同意を取得します。個人情報の問題は、上記のメールアドレスからご連絡ください。
""",
    },
    "ko-KR": {
        "titles": {"terms": "이용약관", "privacy": "개인정보 처리방침"},
        "operator": "서비스 운영자는 관리자 설정 대기 중입니다",
        "contact": "개인정보 문의 이메일은 관리자 설정 대기 중입니다",
        "terms": """SoduWork 이용약관
버전: {version}
서비스 운영자: {operator}
문의 이메일: {contact}

1. 계정 등록 및 이용
본인이 관리하는 이메일로 등록할 수 있습니다. 이메일 인증 완료, 비밀번호 설정, 본 약관 동의 후 계정이 즉시 활성화되며 관리자가 구성한 기본 조직과 역할에 참여합니다. 조직, 역할, 모델 할당량, 프로젝트 및 플러그인 권한은 백엔드 정책에 따라 결정됩니다. 이메일, 비밀번호, 기기를 안전하게 보관하고 타인의 신원을 도용하지 마십시오.

2. 작업 내용과 실행 권한
SoduWork는 대화, 이슈 관리, 도구 및 에이전트 실행 기능을 제공합니다. 모델이나 플러그인에 전송되는 내용은 사용자가 실제로 선택하고 승인한 작업에 따라 달라집니다. 계정 등록과 인증 코드 작업은 대규모 모델을 호출하지 않습니다. AI 출력은 실제 상황에 맞게 확인하시기 바랍니다. 외부 시스템과 관련된 작업은 제품 내 확인과 조직 권한에 따라 실행됩니다.

3. 조직과 개인 데이터
기본 조직에 참여하면 팀 공유 콘텐츠는 기존 조직 권한에 따라 표시됩니다. 개인 프로필, 개인 지식 베이스, 계정 자격 증명은 본인 권한 범위에서 접근되며, 팀 이슈, 산출물, 감사 기록은 조직 관리 규칙을 따릅니다.

4. 계정 보안 및 종료
비밀번호 변경, 이메일 변경, 로그인 기기 제거, 개인 데이터 내보내기, 계정 삭제를 신청할 수 있습니다. 보안 작업에는 신원 재확인이 필요합니다. 삭제 시 로그인이 즉시 취소되고 개인 클라우드 데이터가 비동기로 정리됩니다. 진행 중인 작업은 먼저 완료하거나 인수인계해야 합니다. 팀 업무 기록은 개인 삭제로 연쇄 삭제되지 않습니다. 이 기기에 독립적으로 저장된 채팅과 파일은 해당 기기에서 정리해야 합니다.

5. 서비스 문의 및 약관 변경
계정, 데이터 또는 서비스 문제는 위 이메일로 문의하시기 바랍니다. 본 약관에 실질적인 변경이 있으면 새 버전을 게시하고 사용자에게 알립니다. 동의를 다시 받아야 하는 처리는 재확인합니다.
""",
        "privacy": """SoduWork 개인정보 처리방침
버전: {version}
개인정보 처리자: {operator}
개인정보 문의 이메일: {contact}

1. 수집하는 정보와 이용 목적
이메일은 등록, 로그인, 비밀번호 찾기, 보안 알림에 사용됩니다. 서버는 비밀번호 해시만 저장하며 복원 가능한 로그인 비밀번호는 저장하지 않습니다. 기기 식별자, 시스템 유형, 로그인 시간은 신뢰할 수 있는 기기 연결과 계정 보안에 사용됩니다. 아바타와 닉네임은 사용자가 직접 입력합니다. 등록 시 신분증, 전화번호, 주소가 필요하지 않습니다.

2. 로컬, 클라우드, 제3자
로컬 채팅 아카이브와 작업 파일은 클라우드에 업로드된 것과 같지 않습니다. Hub에 동기화된 이슈, 자료, 개인 메모리, 설정은 해당 기능에 따라 저장됩니다. 모델, 플러그인 또는 커넥터를 사용할 때 선택한 서비스가 실제 작업에 필요한 내용을 받을 수 있습니다. 제3자 서비스는 선택한 공급자와 조직 구성에 따라 결정되며, 해당 모델 또는 연결 관리에서 확인할 수 있습니다. 메일 서비스는 수신자 이메일과 이번 인증 코드 또는 알림 내용을 받습니다.

3. 보안, 보존, 접근
인증 코드는 짧은 기간에만 유효하며 검증 기록은 용도별로 분리됩니다. 인증 코드, 비밀번호, 승인 자격 증명은 일반 로그에 기록되지 않습니다. 발송에 필요한 내용은 암호화하여 저장하고 만료 또는 완료 후 삭제합니다. 계정 정보는 계정 서비스 제공 기간 동안 보관되며, 삭제 후 개인 클라우드 데이터 삭제가 시작됩니다. 내보내기 다운로드의 유효 기간은 24시간입니다. 조직의 업무 연속성 또는 법령에 따라 보존해야 하는 기록은 필요한 범위 내에서만 보관하고 접근을 제한합니다. 자세한 사항은 운영자에게 문의하시기 바랍니다.

4. 사용자의 권리와 조작 창구
"개인 정보"에서 닉네임, 아바타, 이메일을 수정하고, "계정 보안"에서 비밀번호와 로그인 기기를 관리하며, "개인정보와 데이터"에서 동의한 약관 버전 확인, 본인 데이터 내보내기, 삭제 신청을 할 수 있습니다. 화면에서 제공되지 않는 열람, 복제, 정정, 삭제, 동의 철회 또는 설명 요청은 개인정보 문의 이메일로 연락하시기 바랍니다. 본 제품의 계정 절차는 마케팅 구독을 묶지 않으며, 필수가 아닌 승인을 거절해도 기본 계정 관리는 제한되지 않습니다.

5. 내보내기 및 삭제 범위
계정 내보내기에는 본인 기본 프로필, 약관 기록, 본인이 소유한 개인 지식 베이스 파일, 개인 메모리가 포함됩니다. 전체 기업 데이터, 타인의 개인정보, 로그인 키, 제3자 키는 포함되지 않습니다. 기기 로컬 채팅은 해당 기기를 통해 내보냅니다. 삭제하면 개인 클라우드 자료가 지워지고 본 제품이 저장한 승인이 철회되며, 팀 이슈, 산출물, 승인, 감사 기록은 조직 소속에 따라 보관됩니다. 제3자 플랫폼이 독립적으로 저장한 데이터나 오프라인 기기의 로컬 파일은 해당 플랫폼 또는 기기에서 처리해야 합니다. 정리 실패는 기록 후 재시도하며, 완료되지 않은 상태에서 전부 삭제되었다고 표시하지 않습니다.

6. 문의 및 업데이트
정책 내용은 실제 서비스와 일치해야 합니다. 정보 처리의 목적, 방식 또는 범위에 실질적인 변경이 있을 때 운영자는 사용자에게 알리고 적용 요건에 따라 동의를 다시 받습니다. 개인정보 문제는 위 이메일로 피드백할 수 있습니다.
""",
    },
}


def required_versions():
    """Legacy fallback only; current registration versions come from documents()."""
    return {"terms": TERMS_VERSION, "privacy": PRIVACY_VERSION}


async def settings(session):
    row = await session.get(AppSetting, SETTINGS_KEY)
    try:
        value = json.loads(row.value) if row else {}
    except (ValueError, TypeError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    result = {key: str(value.get(key) or "") for key in ("operatorName", "contactEmail", "updatedAt")}
    result["configured"] = bool(result["operatorName"] and result["contactEmail"])
    return result


async def save_settings(session, body):
    name = str(body.get("operatorName") or "").strip()
    email = str(body.get("contactEmail") or "").strip()
    if not name or len(name) > 120 or any(ord(c) < 32 for c in name):
        raise ValueError("请填写有效的服务运营方名称（最多 120 字）")
    if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ValueError("请填写有效的隐私联系邮箱")
    value = {"operatorName": name, "contactEmail": email,
             "updatedAt": datetime.now(timezone.utc).isoformat()}
    row = await session.get(AppSetting, SETTINGS_KEY)
    if row is None:
        row = AppSetting(key=SETTINGS_KEY)
        session.add(row)
    row.value = json.dumps(value, ensure_ascii=False)
    await session.flush()
    return {**value, "configured": True}


def _legacy_document(kind, locale, operator, contact):
    texts = _LEGAL_TEXTS[locale]
    version = TERMS_VERSION if kind == "terms" else PRIVACY_VERSION
    return {"key": kind, "title": texts["titles"][kind], "version": version,
            "locale": locale, "defaultLocale": locale == "zh-CN", "format": "text",
            "content": texts[kind].format(version=version, operator=operator, contact=contact)}


async def legacy_documents(session):
    cfg = await settings(session)
    documents = []
    for locale in LOCALES:
        texts = _LEGAL_TEXTS[locale]
        operator = cfg["operatorName"] or texts["operator"]
        contact = cfg["contactEmail"] or texts["contact"]
        for kind in ("terms", "privacy"):
            documents.append(_legacy_document(kind, locale, operator, contact))
    return {"documents": documents, "requiredConsentVersions": required_versions(),
            "configured": cfg["configured"]}


async def documents(session, *, active=None):
    from .legal_publications import active_versions, public_documents
    active = await active_versions(session) if active is None else active
    result = await legacy_documents(session)
    for kind, row in active.items():
        result["documents"] = [item for item in result["documents"] if item["key"] != kind] + public_documents(row)
        result["requiredConsentVersions"][kind] = row.version
    result["configured"] = result["configured"] or all(kind in active for kind in ("terms", "privacy"))
    return result
