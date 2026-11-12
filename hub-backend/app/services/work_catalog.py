"""Professional profiles and work scenarios. Positions describe long-term expertise, roles grant
platform permissions, workflow nodes assign task responsibility, and capabilities remain
runtime-independent.
"""
from __future__ import annotations

import re
from typing import Iterable

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from .agent_naming import cli_from_name


PROFILE_DEFINITIONS = [
    {"id": "p_solution", "name": "方案顾问", "category": "方案与咨询", "sort": 1,
     "description": "理解业务目标，组织调研、约束、方案与汇报材料。",
     "competencies": ["需求澄清", "方案设计", "行业调研", "结构化表达"]},
    {"id": "p_pm", "name": "产品经理", "category": "产品与体验", "sort": 2,
     "description": "把业务问题转成产品范围、原型、验收标准和迭代计划。",
     "competencies": ["需求分析", "产品规划", "原型", "验收设计"]},
    {"id": "p_design", "name": "设计师", "category": "产品与体验", "sort": 3,
     "description": "负责信息架构、交互体验、视觉表达和设计验收。",
     "competencies": ["信息架构", "交互设计", "视觉设计", "可用性"]},
    {"id": "p_research", "name": "研究员", "category": "研究与分析", "sort": 4,
     "description": "围绕问题检索证据、分析推理、交叉验证并形成可追溯结论。",
     "competencies": ["研究设计", "资料检索", "证据分析", "研究报告"]},
    {"id": "p_data", "name": "数据分析师", "category": "研究与分析", "sort": 5,
     "description": "从数据中建立口径、分析规律并形成可复核的结论与图表。",
     "competencies": ["数据口径", "统计分析", "可视化", "洞察表达"]},
    {"id": "p_dev", "name": "软件工程师", "category": "研发交付", "sort": 6,
     "description": "在受控代码仓库中设计、实现、测试并提交可维护的软件变更。",
     "competencies": ["软件设计", "编码实现", "自动化测试", "代码交付"]},
    {"id": "p_qa", "name": "质量工程师", "category": "研发交付", "sort": 7,
     "description": "设计验证策略、复现缺陷、执行质量门禁并沉淀证据。",
     "competencies": ["测试设计", "缺陷分析", "质量门禁", "验收证据"]},
    {"id": "p_ops", "name": "交付运维", "category": "研发交付", "sort": 8,
     "description": "管理环境、发布、健康检查、回滚与运行稳定性。",
     "competencies": ["环境管理", "持续交付", "可观测性", "故障恢复"]},
    {"id": "p_office", "name": "综合办公", "category": "经营与协作", "sort": 9,
     "description": "处理文档、表格、汇报、会议和日常协同工作。",
     "competencies": ["文档处理", "表格分析", "汇报材料", "协作跟进"]},
]


SCENARIO_DEFINITIONS = [
    {"key": "project-fix-release", "name": "工程修复与发布", "category": "研发交付", "sort": 20,
     "description": "在已有工程中复现问题、修复、验证、提交代码并发布到目标环境。",
     "positionIds": ["p_dev", "p_qa", "p_ops"],
     "intentHints": ["修复", "缺陷", "bug", "故障", "报错", "发布", "上线", "回归"],
     "requiredCapabilities": ["repository", "terminal"],
     "defaultPluginKey": "project-validation-release",
     "outputContract": {
         "kind": "repository-change",
         "summary": "代码进入仓库并在目标环境完成可验证发布，不返回替代性的压缩包。",
         "deliverables": ["提交记录或变更集", "自动化测试结果", "AI 独立审查结论", "发布与健康检查证据"],
         "acceptance": ["问题可以稳定复现并已修复", "代码与测试已进入仓库", "目标环境可访问", "保留回滚依据"]}},
    {"key": "software-delivery", "name": "软件研发交付", "category": "研发交付", "sort": 10,
     "description": "从需求基线到实现、测试、AI 审查、自动合并、发布和业务验收。",
     "positionIds": ["p_dev", "p_qa", "p_ops", "p_pm"],
     "intentHints": ["开发", "实现", "新增功能", "代码", "接口", "程序", "系统", "重构", "工程"],
     "requiredCapabilities": ["repository", "terminal"],
     "defaultPluginKey": "software-delivery",
     "outputContract": {
         "kind": "repository-change",
         "summary": "以仓库变更、质量证据和环境结果作为交付，不以下载压缩包代替工程交付。",
         "deliverables": ["需求基线", "代码提交", "测试报告", "AI Code Review", "发布记录"],
         "acceptance": ["需求边界明确", "质量门禁通过", "代码已合并", "环境验证通过", "业务验收留痕"]}},
    {"key": "requirement-change-release", "name": "需求变更与发布", "category": "研发交付", "sort": 11,
     "description": "在既有产品和验收基线上分析需求变更影响，完成实现、回归、审查、合并和发布。",
     "positionIds": ["p_pm", "p_dev", "p_qa", "p_ops"],
     "intentHints": ["需求变更", "变更需求", "需求调整", "需求迭代", "改需求", "新增规则", "优化功能"],
     "requiredCapabilities": ["repository", "terminal"],
     "defaultPluginKey": "soduwork-change-149",
     "outputContract": {
         "kind": "repository-change",
         "summary": "交付影响分析、固定代码变更、回归证据、审查结论和目标环境发布结果。",
         "deliverables": ["变更影响与验收基线", "代码提交", "回归测试报告", "AI Code Review", "发布记录"],
         "acceptance": ["变更范围和兼容边界明确", "受影响路径完成回归", "代码已合并", "环境验证通过", "保留回滚依据"]}},
    {"key": "bugfix-release", "name": "Bug 修复与发布", "category": "研发交付", "sort": 12,
     "description": "先复现和定位缺陷，再以最小修复、回归测试、独立审查和可回滚发布完成闭环。",
     "positionIds": ["p_dev", "p_qa", "p_ops"],
     "intentHints": ["bug", "缺陷", "故障", "报错", "异常", "崩溃", "修复 bug", "回归失败"],
     "requiredCapabilities": ["repository", "terminal"],
     "defaultPluginKey": "soduwork-bugfix-149",
     "outputContract": {
         "kind": "repository-change",
         "summary": "交付稳定复现证据、最小根因修复、回归结果、审查结论和目标环境发布结果。",
          "deliverables": ["复现与修复基线", "代码提交", "修复前后回归证据", "AI Code Review", "发布与健康检查证据"],
          "acceptance": ["缺陷可稳定复现或明确阻断", "修复前失败测试与修复后通过证据齐全", "代码已合并", "环境验证通过", "保留回滚依据"]}},
    {"key": "production-release", "name": "独立上线", "category": "研发交付", "sort": 13,
     "description": "对已经合并并留有固定代码版本的任务，独立执行环境审批、部署、健康检查和回执归档。",
     "positionIds": ["p_ops", "p_qa", "p_dev"],
     "intentHints": ["上线", "部署", "发版", "发布生产", "预发布", "回滚", "健康检查"],
     "requiredCapabilities": ["repository"],
     "defaultPluginKey": "project-production-release",
     "outputContract": {
         "kind": "production-release",
         "summary": "只发布已合并的固定代码版本，环境与审批来自环境中心，形成可核对、可回滚的上线回执。",
         "deliverables": ["上线材料核对决定", "环境审批记录", "部署版本", "健康检查证据", "回滚依据"],
         "acceptance": ["代码版本已合并且可追溯", "环境审批完整", "实际部署版本正确", "健康检查通过", "保留一键回滚依据"]}},
    {"key": "product-prototype", "name": "智能体产品设计", "category": "产品与体验", "sort": 30,
     "description": "把业务需求设计成目标、计划、工具、权限、证据与人审完整可见的智能体产品，并输出可交互原型。",
     "positionIds": ["p_pm", "p_design", "p_solution"],
     "intentHints": ["智能体", "agent", "原型", "交互稿", "页面方案", "产品设计", "界面设计", "体验设计"],
     "requiredCapabilities": ["browser", "files"], "defaultPluginKey": "product-prototype",
     "outputContract": {
         "kind": "prototype", "summary": "交付智能体产品契约、可直接打开的交互原型和独立体验审查。",
         "deliverables": ["需求与验收基线", "智能体产品契约", "单文件 HTML 交互原型", "独立体验审查"],
         "acceptance": ["无需安装即可打开", "智能体工作循环可操作", "权限与人审门禁真实可见",
                        "失败重试与人工接管可演示", "成果和验证证据可检查"]}},
    {"key": "document-authoring", "name": "专业文档", "category": "经营与协作", "sort": 31,
     "description": "把材料整理为结构严谨、版式规范、可直接提交的正式 Word 文档。",
     "positionIds": ["p_office", "p_solution", "p_pm"],
     "intentHints": ["word", "文档", "公文", "制度", "正式报告", "建议书", "总结材料"],
     "requiredCapabilities": ["files"], "defaultPluginKey": "document-studio",
     "outputContract": {
         "kind": "document", "summary": "交付可直接提交、事实边界清楚且版式完整的 Word 文档。",
         "deliverables": ["正式 Word 文档", "内容与版式审校结论"],
         "acceptance": ["文件可正常打开", "结构完整", "事实与假设分开", "版式一致"]}},
    {"key": "presentation-production", "name": "演示文稿", "category": "经营与协作", "sort": 32,
     "description": "围绕听众和场合制作故事线清晰、视觉统一、可直接演讲的 PowerPoint。",
     "positionIds": ["p_office", "p_solution", "p_pm", "p_design"],
     "intentHints": ["ppt", "pptx", "演示稿", "汇报材料", "路演", "课件", "幻灯片"],
     "requiredCapabilities": ["files"], "defaultPluginKey": "presentation-studio",
     "outputContract": {
         "kind": "presentation", "summary": "交付可直接演讲、逐页验过的 PowerPoint。",
         "deliverables": ["正式演示文稿", "故事线与视觉审查结论"],
         "acceptance": ["文件可正常打开", "重点清楚", "适合投屏", "无溢出和残留占位符"]}},
    {"key": "spreadsheet-analysis", "name": "表格与数据", "category": "研究与分析", "sort": 33,
     "description": "整理原始数据、明确指标口径并交付公式和图表可复核的 Excel 工作簿。",
     "positionIds": ["p_data", "p_office", "p_solution"],
     "intentHints": ["excel", "xlsx", "表格分析", "数据清洗", "透视表", "公式", "台账"],
     "requiredCapabilities": ["files"], "defaultPluginKey": "spreadsheet-analyst",
     "outputContract": {
         "kind": "spreadsheet", "summary": "交付保留来源、口径明确且关键数字可复核的 Excel。",
         "deliverables": ["分析工作簿", "口径与数据质量说明", "独立复核结论"],
         "acceptance": ["文件可正常打开", "源数据可追溯", "公式无错误", "结论与数据一致"]}},
    {"key": "meeting-followup", "name": "会议到行动", "category": "经营与协作", "sort": 34,
     "description": "把会议材料整理成忠于原文的纪要、决策和可追踪行动清单。",
     "positionIds": ["p_office", "p_pm", "p_solution"],
     "intentHints": ["会议纪要", "会议记录", "会议转写", "行动项", "会后跟进"],
     "requiredCapabilities": ["files"], "defaultPluginKey": "meeting-to-action",
     "outputContract": {
         "kind": "meeting-result", "summary": "交付正式纪要和有负责人、时间与完成标准的行动清单。",
         "deliverables": ["会议纪要", "行动项工作簿", "忠实性复核结论"],
         "acceptance": ["不编造决策和责任人", "分歧与待确认项保留", "行动项可追踪"]}},
    {"key": "knowledge-synthesis", "name": "材料研读与综述", "category": "研究与分析", "sort": 35,
     "description": "从多份材料中提取事实、识别版本冲突并形成带来源定位的知识综述。",
     "positionIds": ["p_research", "p_solution", "p_office"],
     "intentHints": ["材料综述", "资料汇总", "多份材料", "制度汇总", "知识整理", "材料对比"],
     "requiredCapabilities": ["files"], "defaultPluginKey": "knowledge-synthesis",
     "outputContract": {
         "kind": "knowledge-brief", "summary": "交付关键结论可回到原材料定位的知识综述。",
         "deliverables": ["知识综述", "来源映射", "冲突与未知项清单"],
         "acceptance": ["来源可定位", "版本冲突不被隐藏", "事实与推断分开", "不访问未授权材料"]}},
    {"key": "research-analysis", "name": "调研与研究", "category": "研究与分析", "sort": 40,
     "description": "围绕明确问题检索来源、整理证据、分析并形成可复核结论。",
     "positionIds": ["p_research", "p_data", "p_solution"],
     "intentHints": ["研究", "调研", "文献", "证据", "数据分析", "行业分析", "竞品分析", "研究报告"],
     "requiredCapabilities": ["browser", "files"], "defaultPluginKey": "deep-research",
     "outputContract": {
         "kind": "evidence-report", "summary": "报告中的关键结论能够追溯到来源、数据或推理过程。",
         "deliverables": ["研究问题与范围", "来源清单", "分析过程", "结论与限制"],
         "acceptance": ["来源可追溯", "事实与判断分开", "结论回应研究问题", "不确定性明确"]}},
    {"key": "solution-design", "name": "方案策划", "category": "方案与咨询", "sort": 50,
     "description": "澄清目标和约束，形成有依据、可比较、可执行的业务或技术方案。",
     "positionIds": ["p_solution", "p_pm", "p_design"],
     "intentHints": ["方案", "规划", "咨询", "投标", "汇报", "路线图", "可行性", "建议书"],
     "requiredCapabilities": ["browser", "files"], "defaultPluginKey": "ai-errand",
     "outputContract": {
         "kind": "proposal", "summary": "方案说明目标、依据、取舍、实施路径和验收方式。",
         "deliverables": ["问题定义", "现状与约束", "备选方案", "推荐方案", "实施计划"],
         "acceptance": ["目标和边界清楚", "关键判断有依据", "取舍可解释", "行动项可执行"]}},
    {"key": "general-office", "name": "综合办公", "category": "经营与协作", "sort": 90,
     "description": "整理文档、表格、汇报、会议纪要、日报周报等日常工作。",
     "positionIds": ["p_office"],
     "intentHints": ["文档", "材料", "ppt", "表格", "总结", "日报", "周报", "会议纪要", "整理", "邮件"],
     "requiredCapabilities": ["files"], "defaultPluginKey": "ai-errand",
     "outputContract": {
         "kind": "office-artifact", "summary": "交付可直接使用的办公成果，并保留来源和关键处理说明。",
         "deliverables": ["最终成果文件", "处理说明"],
         "acceptance": ["内容完整", "格式可用", "关键信息准确", "文件可正常打开"]}},
]


_KEY_RE = re.compile(r"^[a-z][a-z0-9-]{1,79}$")
_CAP_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")


def _items(value, *, limit: int, length: int) -> list[str]:
    out: list[str] = []
    for raw in value or []:
        item = str(raw or "").strip()[:length]
        if item and item not in out:
            out.append(item)
        if len(out) >= limit:
            break
    return out


def _contract(value) -> dict:
    raw = dict(value or {})
    return {
        "kind": str(raw.get("kind") or "artifact").strip()[:40] or "artifact",
        "summary": str(raw.get("summary") or "").strip()[:300],
        "deliverables": _items(raw.get("deliverables"), limit=16, length=120),
        "acceptance": _items(raw.get("acceptance"), limit=16, length=180),
    }


def profession_api(
    row: models.Position, *, mine: bool = False, inherited: bool = False
) -> dict:
    return {
        "id": row.id, "orgId": row.org_id, "name": row.name,
        "category": row.category or "", "description": row.description or "",
        "competencies": list(row.competencies or []), "sort": row.sort,
        "isSystem": bool(row.is_system), "mine": bool(mine),
        "inherited": bool(inherited),
    }

def scenario_api(row: models.WorkScenario, *, inherited: bool = False) -> dict:
    return {
        "id": row.id, "orgId": row.org_id, "key": row.key, "name": row.name,
        "category": row.category or "", "description": row.description or "",
        "positionIds": list(row.position_ids or []),
        "intentHints": list(row.intent_hints or []),
        "requiredCapabilities": list(row.required_capabilities or []),
        "defaultPluginKey": row.default_plugin_key or "",
        "outputContract": _contract(row.output_contract),
        "enabled": bool(row.enabled), "isSystem": bool(row.is_system),
        "inherited": bool(inherited), "sort": row.sort,
    }


async def _org_chain(session: AsyncSession, org_id: str | None) -> list[str]:
    """Return the root-to-current organization inheritance chain, safely handling missing links and
    cycles.
    """
    if not org_id:
        return []
    parents = dict((await session.execute(select(
        models.OrgUnit.id, models.OrgUnit.parent_id))).all())
    chain: list[str] = []
    seen: set[str] = set()
    current = org_id
    while current and current not in seen:
        seen.add(current)
        chain.append(current)
        current = parents.get(current)
    chain.reverse()
    return chain


def effective_plugin_options(
    rows: Iterable[dict], chain: Iterable[str]
) -> list[dict]:
    """Resolve same-key plugins from platform through ancestors to the current organization,
    preferring the nearest configuration.
    """
    order = {None: -1, **{
        org_id: index for index, org_id in enumerate(chain or [])}}
    effective: dict[str, dict] = {}
    for row in sorted(rows, key=lambda item: (
        order.get(item.get("orgId"), -1), int(item.get("updatedAt") or 0))):
        key = str(row.get("key") or "")
        if key:
            effective[key] = row
    return sorted(effective.values(), key=lambda item: (
        str(item.get("name") or item.get("key") or "").lower(),
        str(item.get("key") or "")))


async def _effective_plugin(
    session: AsyncSession, org_id: str | None, key: str
) -> am.Plugin | None:
    chain = await _org_chain(session, org_id)
    rows = list((await session.execute(select(am.Plugin).where(
        am.Plugin.key == key,
        or_(am.Plugin.org_id.is_(None),
            am.Plugin.org_id.in_(chain or {"__none__"})),
    ).order_by(am.Plugin.updated_at.desc()))).scalars().all())
    if not rows:
        return None
    order = {None: -1, **{
        item: index for index, item in enumerate(chain)}}
    return max(rows, key=lambda row: order.get(row.org_id, -1))


async def profession_rows(session: AsyncSession, org_id: str | None) -> list[models.Position]:
    chain = await _org_chain(session, org_id)
    query = select(models.Position).where(or_(
        models.Position.org_id.is_(None),
        models.Position.org_id.in_(chain or {"__none__"}),
    ))
    rows = list((await session.execute(query)).scalars().all())
    rows.sort(key=lambda row: (row.sort, row.name.lower()))
    return rows


async def scenario_rows(
    session: AsyncSession, org_id: str | None, *, include_disabled: bool = False
) -> list[models.WorkScenario]:
    chain = await _org_chain(session, org_id)
    query = select(models.WorkScenario).where(or_(
        models.WorkScenario.org_id.is_(None),
        models.WorkScenario.org_id.in_(chain or {"__none__"}),
    ))
    rows = list((await session.execute(query)).scalars().all())
    order = {None: -1, **{oid: index for index, oid in enumerate(chain)}}
    effective: dict[str, models.WorkScenario] = {}
    for row in sorted(rows, key=lambda item: order.get(item.org_id, -1)):
        effective[row.key] = row
    out = [row for row in effective.values() if include_disabled or row.enabled]
    out.sort(key=lambda row: (row.sort, row.name.lower()))
    return out


def _matched_hints(text: str, scenario: models.WorkScenario) -> list[str]:
    low = str(text or "").lower()
    return [hint for hint in (scenario.intent_hints or []) if str(hint).lower() in low]


def recommend_from_rows(
    text: str,
    scenarios: Iterable[models.WorkScenario],
    position_ids: Iterable[str] = (),
    *,
    explicit_key: str = "",
    project_id: str = "",
) -> dict:
    rows = list(scenarios)
    if not rows:
        return {}
    if explicit_key:
        chosen = next((row for row in rows if row.key == explicit_key), None)
        if chosen:
            return {"scenario": scenario_api(chosen), "matchedBy": "explicit",
                    "reason": "使用你确认的工作场景"}

    positions = set(str(item) for item in position_ids or [])
    ranked = []
    for row in rows:
        hits = _matched_hints(text, row)
        score = sum(4 + min(len(str(hint)), 6) for hint in hits)
        overlap = positions.intersection(row.position_ids or [])
        if overlap:
            score += 2
        if project_id and row.category == "研发交付":
            score += 2
        ranked.append((score, len(hits), -row.sort, row, hits, overlap))
    ranked.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    score, _count, _sort, chosen, hits, overlap = ranked[0]

    matched_by = "intent"
    if score <= 2:
        profile_choice = next((
            item for item in ranked if item[5] and item[3].key != "general-office"), None)
        if profile_choice:
            _score, _count, _sort, chosen, hits, overlap = profile_choice
            matched_by = "profession"
        else:
            chosen = next((row for row in rows if row.key == "general-office"), rows[0])
            hits, overlap = [], set()
            matched_by = "fallback"

    if hits:
        reason = "识别到“" + "、".join(str(item) for item in hits[:3]) + "”"
    elif overlap:
        reason = "结合当前承办人的职业画像"
    else:
        reason = "未发现需要专门方法的信号，先按通用办公场景处理"
    return {"scenario": scenario_api(chosen), "matchedBy": matched_by, "reason": reason}


async def recommend(
    session: AsyncSession,
    text: str,
    org_id: str | None,
    position_ids: Iterable[str] = (),
    *,
    explicit_key: str = "",
    project_id: str = "",
) -> dict:
    return recommend_from_rows(
        text, await scenario_rows(session, org_id), position_ids,
        explicit_key=explicit_key, project_id=project_id)


async def catalog_for_user(
    session: AsyncSession,
    org_id: str | None,
    position_ids: Iterable[str],
    *,
    text: str = "",
    explicit_key: str = "",
    project_id: str = "",
    include_disabled: bool = False,
) -> dict:
    mine = set(str(item) for item in position_ids or [])
    profiles = await profession_rows(session, org_id)
    scenarios = await scenario_rows(session, org_id, include_disabled=include_disabled)
    result = recommend_from_rows(
        text, [row for row in scenarios if row.enabled], mine,
        explicit_key=explicit_key, project_id=project_id)
    return {
        "professions": [profession_api(
            row, mine=row.id in mine,
            inherited=bool(org_id and row.org_id != org_id)) for row in profiles],
        "myProfessionIds": sorted(mine),
        "scenarios": [scenario_api(
            row, inherited=bool(org_id and row.org_id != org_id)) for row in scenarios],
        "recommendation": result,
    }


async def _owner_context(session: AsyncSession, owner_id: str | None) -> tuple[str | None, list[str]]:
    if not owner_id:
        return None, []
    client = await session.get(models.Client, owner_id)
    user = await session.get(models.User, client.user_ref) if client and client.user_ref else None
    return (user.org_id if user else None), list(user.positions or []) if user else []


def routing_snapshot(result: dict) -> dict:
    scene = dict(result.get("scenario") or {})
    if not scene:
        return {}
    return {
        "schemaVersion": 1,
        "scenarioKey": scene.get("key") or "",
        "scenarioName": scene.get("name") or "",
        "category": scene.get("category") or "",
        "matchedBy": result.get("matchedBy") or "",
        "reason": result.get("reason") or "",
        "professionIds": list(scene.get("positionIds") or []),
        "requiredAgentCapabilities": list(scene.get("requiredCapabilities") or []),
        "defaultPluginKey": scene.get("defaultPluginKey") or "",
        "outputContract": _contract(scene.get("outputContract")),
    }


async def enrich_task_data(
    session: AsyncSession,
    owner_id: str | None,
    data: dict,
    *,
    org_id: str | None = None,
    position_ids: Iterable[str] | None = None,
) -> dict:
    out = dict(data or {})
    if org_id is None and position_ids is None:
        org_id, positions = await _owner_context(session, owner_id)
    else:
        positions = list(position_ids or [])
    text = "\n".join([
        str(out.get("title") or ""), str(out.get("note") or ""),
        " ".join(str(item) for item in (out.get("tags") or []))])
    result = await recommend(
        session, text, org_id, positions,
        explicit_key=str(out.get("workScenarioKey") or ""),
        project_id=str(out.get("projectId") or ""))
    snapshot = routing_snapshot(result)
    if snapshot:
        # Recommendations describe the work; they must not erase the user's
        # chosen Agent/model or explicit direct-vs-workflow decision.
        selected = out.get("workRouting")
        selected = selected if isinstance(selected, dict) else {}
        context = selected.get("executionContext")
        if isinstance(context, dict) and context.get("strategy") in {"direct", "workflow", "plugin"}:
            from .execution_context import public
            snapshot["executionContext"] = public(context)
            snapshot["selectedStrategy"] = context["strategy"]
            binding = selected.get("workflowBindingId")
            if context["strategy"] == "workflow" and binding:
                snapshot["workflowBindingId"] = str(binding)[:80]
        out["workScenarioKey"] = snapshot["scenarioKey"]
        out["workScenarioName"] = snapshot["scenarioName"]
        out["workRouting"] = snapshot
    return out


async def save_profession(
    session: AsyncSession,
    body: dict,
    org_id: str | None,
    current: models.Position | None = None,
) -> models.Position:
    """Save a professional profile without granting platform permissions."""
    from uuid import uuid4

    name = str(body.get("name", current.name if current else "") or "").strip()[:48]
    if not name:
        raise ValueError("请填写职业名称")
    query = select(models.Position).where(
        models.Position.org_id.is_(None) if org_id is None
        else models.Position.org_id == org_id,
        func.lower(models.Position.name) == name.lower(),
    )
    duplicate = (await session.execute(query.limit(1))).scalar_one_or_none()
    if duplicate is not None and (current is None or duplicate.id != current.id):
        raise ValueError("当前组织已经有同名职业画像")
    row = current or models.Position(
        id="pos_" + uuid4().hex[:12], org_id=org_id, is_system=False)
    row.name = name
    row.category = str(body.get(
        "category", current.category if current else "") or "").strip()[:40]
    row.description = str(body.get(
        "description", current.description if current else "") or "").strip()[:400]
    row.competencies = _items(
        body.get("competencies", current.competencies if current else []),
        limit=30, length=80)
    row.sort = max(0, min(int(body.get(
        "sort", current.sort if current else 0) or 0), 9999))
    if current is None:
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def delete_profession(session: AsyncSession, row: models.Position) -> str:
    """Delete an unused organization profile, returning empty on success."""
    if row.is_system or row.org_id is None:
        return "平台职业是只读基线，不能删除"
    user_positions = list((await session.execute(select(
        models.User.positions))).scalars().all())
    if any(row.id in (positions or []) for positions in user_positions):
        return "仍有员工使用这个职业画像"
    scenario_positions = list((await session.execute(select(
        models.WorkScenario.position_ids))).scalars().all())
    if any(row.id in (positions or []) for positions in scenario_positions):
        return "仍有工作场景引用这个职业画像"
    await session.delete(row)
    await session.commit()
    return ""


async def validate_profession_ids(
    session: AsyncSession, org_id: str | None, value
) -> list[str]:
    """Normalize profile IDs and reject references outside the current organization inheritance
    scope.
    """
    position_ids = _items(value, limit=100, length=36)
    visible_positions = {
        row.id for row in await profession_rows(session, org_id)}
    if any(item not in visible_positions for item in position_ids):
        raise ValueError("职业画像不属于当前员工所在组织")
    return position_ids


async def validate_scenario(
    session: AsyncSession, body: dict, org_id: str | None,
    current: models.WorkScenario | None = None,
) -> dict:
    key = str((current.key if current else body.get("key")) or "").strip().lower()
    if not _KEY_RE.fullmatch(key):
        raise ValueError("场景标识只用小写字母、数字和短横线，且以字母开头")
    name = str(body.get("name", current.name if current else "") or "").strip()[:100]
    if not name:
        raise ValueError("请填写工作场景名称")
    enabled = bool(body.get("enabled", current.enabled if current else True))
    position_ids = await validate_profession_ids(
        session, org_id,
        body.get("positionIds", current.position_ids if current else []))

    intent_hints = _items(
        body.get("intentHints", current.intent_hints if current else []),
        limit=40, length=60)
    capabilities = _items(
        body.get("requiredCapabilities", current.required_capabilities if current else []),
        limit=50, length=64)
    if any(not _CAP_RE.fullmatch(item) for item in capabilities):
        raise ValueError("能力标识格式不正确")
    if any(cli_from_name(item) for item in capabilities):
        raise ValueError("请填写浏览、仓库、办公等能力，不要绑定具体 Agent 底座")
    contract = _contract(body.get(
        "outputContract", current.output_contract if current else {}))
    if enabled and not (position_ids or intent_hints):
        raise ValueError("启用的场景至少要配置适用职业或识别关键词")
    if enabled and not (
        contract["summary"] and contract["deliverables"] and contract["acceptance"]
    ):
        raise ValueError("启用的场景必须配置交付摘要、成果物和验收标准")

    plugin_key = str(body.get(
        "defaultPluginKey", current.default_plugin_key if current else "") or "").strip()[:100]
    if plugin_key:
        plugin = await _effective_plugin(session, org_id, plugin_key)
        if plugin is None:
            raise ValueError("默认工作流不存在，请先导入对应插件")
        if enabled and not plugin.enabled:
            raise ValueError("默认工作流尚未启用，请先启用或清空默认工作流")
    return {
        "key": key, "name": name,
        "category": str(body.get("category", current.category if current else "") or "").strip()[:40],
        "description": str(body.get(
            "description", current.description if current else "") or "").strip()[:500],
        "position_ids": position_ids,
        "intent_hints": intent_hints,
        "required_capabilities": capabilities,
        "default_plugin_key": plugin_key,
        "output_contract": contract,
        "enabled": enabled,
        "sort": max(0, min(int(body.get(
            "sort", current.sort if current else 0) or 0), 9999)),
    }

async def save_scenario(
    session: AsyncSession,
    body: dict,
    org_id: str | None,
    current: models.WorkScenario | None = None,
) -> models.WorkScenario:
    values = await validate_scenario(session, body, org_id, current)
    query = select(models.WorkScenario).where(models.WorkScenario.key == values["key"])
    query = query.where(
        models.WorkScenario.org_id.is_(None) if org_id is None
        else models.WorkScenario.org_id == org_id)
    duplicate = (await session.execute(query)).scalar_one_or_none()
    if duplicate is not None and (current is None or duplicate.id != current.id):
        raise ValueError("这个场景标识已经存在")
    row = current or models.WorkScenario(org_id=org_id, key=values["key"])
    for field, value in values.items():
        setattr(row, field, value)
    if current is None:
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def bootstrap(session: AsyncSession) -> None:
    """Seed platform profiles and scenarios; organization scenarios override matching keys."""
    for item in PROFILE_DEFINITIONS:
        row = await session.get(models.Position, item["id"])
        if row is None:
            row = models.Position(id=item["id"], is_system=True)
            session.add(row)
        row.org_id = None
        row.name = item["name"]
        row.category = item["category"]
        row.description = item["description"]
        row.competencies = list(item["competencies"])
        row.sort = item["sort"]
        row.is_system = True

    for item in SCENARIO_DEFINITIONS:
        row = (await session.execute(select(models.WorkScenario).where(
            models.WorkScenario.org_id.is_(None),
            models.WorkScenario.key == item["key"]).limit(1))).scalar_one_or_none()
        if row is None:
            row = models.WorkScenario(org_id=None, key=item["key"], is_system=True)
            session.add(row)
        row.name = item["name"]
        row.category = item["category"]
        row.description = item["description"]
        row.position_ids = list(item["positionIds"])
        row.intent_hints = list(item["intentHints"])
        row.required_capabilities = list(item["requiredCapabilities"])
        row.default_plugin_key = item["defaultPluginKey"]
        row.output_contract = _contract(item["outputContract"])
        row.enabled = True
        row.is_system = True
        row.sort = item["sort"]
    await session.commit()
