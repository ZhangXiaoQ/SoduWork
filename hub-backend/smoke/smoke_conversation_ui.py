# -*- coding: utf-8 -*-
"""Verify conversation capability selection, governance, probing, and execution specifications
share one contract.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "client"
ok = fail = 0


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def chk(name: str, cond: bool, extra="") -> None:
    global ok, fail
    if cond:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, "<<", str(extra)[:220])


compose_file = read(CLIENT / "components/panels/panels-compose.js")
compose = compose_file + read(CLIENT / "components/panels/compose-surface.js")
runtime = read(CLIENT / "components/panels/panels-compose-runtime.js")
voice = read(CLIENT / "components/panels/panels-compose-voice.js")
compose_caps = read(CLIENT / "components/panels/panels-compose-capabilities.js")
compose_ui = compose + compose_caps
chat_file = read(CLIENT / "components/panels/panels-chat.js")
# Assemble the behavior contract while checking that each module can be read.
chat_modules = [read(CLIENT / ("components/panels/" + name)) for name in (
    "chat-task-start.js", "chat-task-controller.js", "chat-scroll-follow.js", "chat-markdown.js", "chat-acceptance-results.js", "chat-message-renderer.js", "chat-send-queue.js", "chat-work-intent.js", "chat-draft-recovery.js",
    "chat-composer-bindings.js", "chat-session-controller.js")]
chat = chat_file + "\n".join(chat_modules)
tools_file = read(CLIENT / "components/panels/panels-chat-tools.js")
dom_patch = read(CLIENT / "components/panels/chat-dom-patch.js")
tools = tools_file + dom_patch
chat_css = read(CLIENT / "components/panels/panels-chat.css")
workspace_file = read(CLIENT / "components/panels/panels-chat-workspace.js")
workspace_controls = read(CLIENT / "components/panels/chat-workspace-controls.js")
workspace = workspace_file + workspace_controls
chrome = read(CLIENT / "components/panels/panels-chat-chrome.js")
desk = read(CLIENT / "desk.html")
preload = read(CLIENT / "preload.js")
ipc_file = read(CLIENT / "main/pi-session/ipc.js")
ipc = ipc_file + read(CLIENT / "main/pi-session/environment-ipc.js")
caps = read(CLIENT / "main/conversation/capabilities.js")
spec = read(CLIENT / "main/conversation/session-spec.js")
contract = read(CLIENT / "main/conversation/agent-contract.js")
model_config = read(CLIENT / "main/pi-session/model-config.js")
session_file = read(CLIENT / "main/pi-session/session.js")
session_modules = [read(CLIENT / ("main/pi-session/" + name)) for name in (
    "session-resources.js", "session-open.js", "session-handle.js", "session-send.js", "session-events.js")]
session = session_file + "\n".join(session_modules)
proxy = read(ROOT / "hub-backend/app/api/ai_proxy.py")
office = read(ROOT / "skills/office/SKILL.md")

chk("起手式展示三项基础能力并把选择传给会话",
    all(x in compose_ui for x in ("browser:", "computer:", "office:",
                               "capabilities: [..._pickedCapabilities]")))
chk("桌面操作是高风险能力，默认可用但保留危险动作边界",
    "risk: 'high', defaultOn: true" in caps
    and "删除、支付和发送等高风险动作仍严格守界" in compose_caps)
chk("浏览和 Office 都有真实运行探针",
    "Node 22" in caps and "officeEngine.probe" in caps and "Chrome" in caps)
chk("能力文件不是只判存在，而是起会话前真实读取",
    "fs.readFileSync(file, 'utf8')" in caps and "当前系统无法读取" in caps)
chk("基础能力严格取本机探活、设备授权与会话选择的交集",
    "const selectable = runtime.ok" in caps and "const deviceGranted" in caps
    and "requested.has(item.id) && item.selectable && item.deviceGranted" in caps)
# The full guide catalog now includes foundation skills. Verify the existing
# policy and grant behavior instead of depending on the catalog's map/filter order.
capability_contract = subprocess.run(
    ["node", "--test", "main/conversation/capabilities.test.js"],
    cwd=CLIENT, capture_output=True, text=True, encoding="utf-8", timeout=60,
)
chk("策略不可达时业务 Skill 失败关闭，但不会误伤本机基础能力",
    capability_contract.returncode == 0,
    capability_contract.stdout + capability_contract.stderr)
chk("会话使用中性门面，Pi 只保留兼容别名",
    "conversationSession" in preload and "piSession: conversationSession" in preload
    and "conversationSession || global.soduWorkAPI.piSession" in chat)
chk("开始对话时模型与能力一起进入不可变 SessionSpec",
    "sessionSpec.build" in ipc and "modelName: spec.modelName" in ipc
    and "Object.freeze" in spec and "capabilityIds" in spec)
chk("并行会话各自持有技能资源，不改共享技能目录",
    "new sdk.DefaultResourceLoader" in session and "additionalSkillPaths: dirs" in session
    and "noSkills: true" in session and "installSkills(prep.agentDir" not in session)
chk("用户选择的模型贯通到后端且无效选择不会静默换模型",
    "&model=" in model_config and "?agent=" in model_config and "modelName" in model_config
    and "if want and not any" in proxy)
chk("Office 适配遵循标准 Skill 且要求产出后再验证",
    "name: office" in office and "python-docx" in office and "必须验证" in office)
chk("普通文件走消息链接，只有可运行成果进入右侧承载区",
    all(name in desk for name in ("panels-chat-tools.js", "panels-chat-chrome.js",
                                  "panels-chat-workspace.js"))
    and "data-chat-open-file" in chrome
    and "ChatWorkbench.openOutput(hit.dataset.chatOpenFile)" in chrome
    and "artifactRequest(sessionApi(), context().ref, file, 'open')" in workspace
    and "function hasVisibleTabs" in workspace)
chk("全部标签关闭后不保留空的成果承载页",
    "if (!has) { WB.open = false; WB.maximized = false; WB.active = ''; }" in workspace
    and "previewKind(file)" in workspace
    and "WB.manualClosed = true" in workspace
    and "artifactRequest(sessionApi(), context().ref, file, 'open')" in workspace)
chk("工具过程使用短摘要、稳定节点和可折叠详情",
    "SHORT_SUMMARY = 38" in tools and "commandSummary" in tools
    and "data-tool-node" in chat and "ntool-head" in chat
    and ":focus-visible" in chat_css
    # Compact and wide preview rules must not overlap at the 960px boundary.
    and "@media(max-width:959px)" in chat_css
    and "@media(min-width:960px)" in chat_css)
chk("干活型收口契约真实进入每条会话的系统提示",
    "agentContract.prompts" in session and "appendSystemPrompt" in session
    and "最终答复必须以结果开头" in contract and "还需要我做什么" in contract)
chk("渲染依赖先于会话加载",
    desk.index('src="components/panels/chat-task-start.js') < desk.index('src="components/panels/chat-task-controller.js')
    and desk.index('src="components/panels/chat-acceptance-results.js') < desk.index('src="components/panels/chat-message-renderer.js')
    and desk.index('src="components/panels/chat-dom-patch.js') < desk.index('src="components/panels/panels-chat-tools.js')
    and all(name in desk and desk.index('src="components/panels/' + name) < desk.index('src="components/panels/panels-chat.js') for name in (
        "chat-task-start.js", "chat-task-controller.js", "chat-scroll-follow.js", "chat-markdown.js", "chat-acceptance-results.js", "chat-message-renderer.js", "chat-send-queue.js", "chat-work-intent.js", "chat-draft-recovery.js",
        "chat-composer-bindings.js", "chat-session-controller.js")))

# Physical source sizes are reviewed by tools/check-source-size.cjs (advisory).

print(f"\nconversation UI smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
