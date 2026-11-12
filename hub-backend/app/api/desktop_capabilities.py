"""Same-account mobile access to a selected desktop; never dispatch elsewhere."""
import json
import re
import hashlib

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select

from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..automation_models import RunnerNode
from ..services import runner_hub
from ..auth import sign_claims, verify_claims

router = APIRouter(prefix="/api/v1/desktop-capabilities", tags=["mobile"])
OPERATIONS = {"catalog", "library.call", "conversation.history", "skill.set", "plugin.get", "plugin.preflight", "plugin.install", "plugin.use"}


def digest(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def owner(client):
    if client.auth_state != "active" or not client.user_ref:
        raise HTTPException(403, "请先登录当前账号")
    return str(client.user_ref)


async def resolve(session, client, cid):
    uid = owner(client)
    target = await session.get(Client, cid, populate_existing=True)
    if not target or target.auth_state != "active" or target.user_ref != uid:
        raise HTTPException(404, "未找到当前账号的电脑")
    runner = runner_hub.for_client(cid)
    if runner is None:
        raise HTTPException(409, "这台电脑离线，请打开并登录同一账号；不会自动切换电脑")
    node = await session.get(RunnerNode, runner.id, populate_existing=True)
    if (not node or node.auth_state == "revoked" or node.management_state in {"retired", "pending_setup"}
            or node.client_id != cid or (node.owner_user_id and node.owner_user_id != uid)
            or str(runner.client_id or "") != str(node.client_id or "")
            or str(runner.owner_user_id or "") != str(node.owner_user_id or "")
            or str(runner.org_id or "") != str(node.org_id or "")):
        raise HTTPException(403, "电脑归属已变化，请重新选择")
    if "desktopCapabilities1" not in runner.caps:
        raise HTTPException(409, "请更新并重启这台电脑的 SoduWork，再刷新列表")
    return target, runner


@router.get("/targets")
async def targets(client=Depends(current_client), session=Depends(get_session)):
    uid = owner(client)
    nodes = (await session.scalars(select(RunnerNode).where(RunnerNode.client_id.is_not(None)))).all()
    ids = {node.client_id for node in nodes if node.auth_state != "revoked"
           and node.management_state not in {"retired", "pending_setup"}
           and (not node.owner_user_id or node.owner_user_id == uid)}
    rows = (await session.scalars(select(Client).where(Client.user_ref == uid,
                                                       Client.auth_state == "active"))).all()
    items = []
    for row in rows:
        if row.id not in ids:
            continue
        runner_id = ""
        library_ready = False
        history_ready = False
        try:
            _, live = await resolve(session, client, row.id)
            runner_id = live.id
            library_ready = "desktopLibrary1" in live.caps
            history_ready = "desktopHistory1" in live.caps
            ready, reason = True, ""
        except HTTPException as exc:
            ready, reason = False, str(exc.detail)
        items.append({"id": row.id, "runnerId": runner_id, "name": row.name or "本人电脑", "ready": ready, "libraryReady": library_ready, "historyReady": history_ready, "reason": reason})
    return {"items": items}


@router.post("/{cid}/requests")
async def request(cid: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    if (set(body) != {"requestId", "operation", "args"}
            or body.get("operation") not in OPERATIONS or not isinstance(body.get("args"), dict)
            or not isinstance(body.get("requestId"), str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", body["requestId"])
            or len(json.dumps(body).encode()) > 512_000):
        raise HTTPException(422, "操作内容不正确")
    uid = owner(client)
    _, runner = await resolve(session, client, cid)
    if body["operation"] == "library.call" and "desktopLibrary1" not in runner.caps:
        raise HTTPException(409, "请更新并重启这台电脑的 SoduWork 后使用资料库")
    if body["operation"] == "conversation.history" and "desktopHistory1" not in runner.caps:
        raise HTTPException(409, "请更新并重启这台电脑的 SoduWork 后访问本地会话")
    packet = {**body, "targetClientId": cid, "ownerUserId": uid}
    authorization = sign_claims({"uid": uid, "cid": cid, "digest": digest(packet)},
                                ttl_seconds=120, token_type="desktop-capability")
    try:
        result = await runner.call("desktop.capability", {**packet, "authorization": authorization}, timeout=95)
    except Exception as exc:
        raise HTTPException(504, "电脑未及时返回结果，请核对电脑状态后重试同一操作") from exc
    # A response arriving after account ownership or the connected Runner changes is not released.
    await session.refresh(client)
    if owner(client) != uid:
        raise HTTPException(403, "当前登录账号已变化")
    _, current = await resolve(session, client, cid)
    if current is not runner:
        raise HTTPException(409, "电脑连接已变化，请重新加载")
    if result.get("ok") is not True:
        raise HTTPException(409, result.get("error") or "电脑未完成操作")
    data = result.get("data") or {}
    if body["operation"] == "plugin.use" and data.get("sourceSessionId"):
        from ..account_conversation_models import AccountConversation
        from .account_conversations import _conversation_json
        row = await session.scalar(select(AccountConversation).where(
            AccountConversation.owner_user_id == uid, AccountConversation.source_client_id == cid,
            AccountConversation.source_session_id == data["sourceSessionId"],
            AccountConversation.deleted.is_(False)))
        if row:
            data = {**data, "conversation": _conversation_json(row, client.id)}
    return data


@router.post("/verify")
async def verify(body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    """The owning desktop verifies the Hub ticket before acting on private-pipe input."""
    claims = verify_claims(str(body.get("authorization") or ""), token_type="desktop-capability")
    packet = body.get("request")
    if (not claims or not isinstance(packet, dict) or claims.get("uid") != owner(client)
            or claims.get("cid") != client.id or claims.get("digest") != digest(packet)):
        raise HTTPException(403, "电脑操作授权已失效，请从手机重新发起")
    await resolve(session, client, client.id)
    return {"ok": True}


@router.post("/skill-selection")
async def skill_selection(body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    """Apply one signed PC preference under the existing device-selection lock."""
    await verify(body, client, session)
    packet = body["request"]
    args = packet.get("args", {})
    if (packet.get("operation") != "skill.set" or not isinstance(args, dict)
            or set(args) != {"name", "enabled"} or not isinstance(args["name"], str)
            or not 0 < len(args["name"]) <= 64 or type(args["enabled"]) is not bool):
        raise HTTPException(400, "技能开关内容不正确")
    from ..services import skills, skill_preferences
    from ..services.capability_catalog import skill_entry
    try:
        cfg, found = await skills.catalog_with_policy(session, client)
    except skills.PolicyChanged as exc:
        raise HTTPException(409, str(exc)) from exc
    allowed = set(cfg["allowed"]) | skills.BASELINE_SKILLS
    visible = {row["name"] for row in found if skill_entry(row, allowed, set())["available"]}
    if args["name"] not in visible:
        raise HTTPException(409, "这项技能当前不可用，请刷新目录")
    await session.refresh(client, with_for_update=True)
    # Recheck owner/online state after obtaining the lock; never replace other switches.
    await verify(body, client, session)
    chosen = skill_preferences.selected_names(client, [row for row in found if row["name"] in visible])
    if args["enabled"]:
        chosen.add(args["name"])
    else:
        chosen.discard(args["name"])
    skill_preferences.save_selection(client, sorted(chosen), found, visible)
    await session.commit()
    return {"ok": True, "name": args["name"], "enabled": args["name"] in client.skills}
