"""Authorization boundary for read-only remote screen sessions.

Pixel production remains a client capability. The Hub owns the grant,
expiration and ticket; it never accepts keyboard, pointer, clipboard or file
commands through this API.
"""
from __future__ import annotations

import hashlib
import asyncio
import json
import math
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, get_session
from ..deps import current_client, identity_only
from ..models import Client
from ..services import device_auth, native_discovery
from ..remote_screen_models import RemoteScreenGrant

router = APIRouter(prefix="/api/v1/remote-screen", tags=["remote-screen"])
_TTL = timedelta(minutes=5)
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


class _MediaHub:
    """Bounded media fan-out with an encrypted cross-process relay when enabled.

    A local-only Hub keeps the low-latency in-process path. In cluster mode,
    frames use the existing encrypted Redis connection as an ephemeral Pub/Sub
    channel so a source and viewer may be attached to different Hub workers.
    Durable grants and all authorization checks remain in the database.
    """

    def __init__(self):
        self._lock = asyncio.Lock()
        self._sources: dict[str, WebSocket] = {}
        self._viewers: dict[str, set[WebSocket]] = {}
        self._relays: dict[str, tuple[object, asyncio.Task]] = {}
        self._controls: dict[str, tuple[object, asyncio.Task]] = {}

    @staticmethod
    def _cluster_enabled() -> bool:
        from ..services.cluster_bus import bus
        return bool(bus.enabled and bus.healthy and bus.redis is not None)

    @staticmethod
    def _channel(grant_id: str) -> str:
        from ..services.cluster_bus import bus
        return bus.key("remote-screen-media", grant_id)

    @staticmethod
    def _control_channel(grant_id: str) -> str:
        from ..services.cluster_bus import bus
        return bus.key("remote-screen-control", grant_id)

    async def add_source(self, grant_id: str, websocket: WebSocket) -> bool:
        async with self._lock:
            if grant_id in self._sources:
                return False
            self._sources[grant_id] = websocket
            self._viewers.setdefault(grant_id, set())
        try:
            await self._ensure_control(grant_id)
        except Exception:
            await self.remove(grant_id, websocket)
            raise
        return True

    async def _ensure_relay(self, grant_id: str) -> None:
        if not self._cluster_enabled():
            return
        from ..services.cluster_bus import bus
        async with self._lock:
            if grant_id in self._relays:
                return
            pubsub = bus.redis.pubsub(ignore_subscribe_messages=True)
            try:
                await pubsub.subscribe(self._channel(grant_id))
            except Exception:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass
                raise
            task = asyncio.create_task(self._relay_loop(grant_id, pubsub),
                                       name="remote-screen-relay")
            self._relays[grant_id] = (pubsub, task)

    async def _ensure_control(self, grant_id: str) -> None:
        if not self._cluster_enabled():
            return
        from ..services.cluster_bus import bus
        async with self._lock:
            if grant_id in self._controls:
                return
            pubsub = bus.redis.pubsub(ignore_subscribe_messages=True)
            try:
                await pubsub.subscribe(self._control_channel(grant_id))
            except Exception:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass
                raise
            task = asyncio.create_task(self._control_loop(grant_id, pubsub),
                                       name="remote-screen-control")
            self._controls[grant_id] = (pubsub, task)

    async def add_viewer(self, grant_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._viewers.setdefault(grant_id, set()).add(websocket)
        try:
            await self._ensure_control(grant_id)
            await self._ensure_relay(grant_id)
        except Exception:
            await self.remove(grant_id, websocket)
            raise

    async def _close_channel(self, entries: dict, grant_id: str) -> None:
        async with self._lock:
            entry = entries.pop(grant_id, None)
        if entry is None:
            return
        pubsub, task = entry
        if task is not asyncio.current_task() and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        try:
            await pubsub.aclose()
        except AttributeError:
            try:
                await pubsub.close()
            except Exception:
                pass
        except Exception:
            pass

    async def _close_relay(self, grant_id: str) -> None:
        await self._close_channel(self._relays, grant_id)

    async def _close_control(self, grant_id: str) -> None:
        await self._close_channel(self._controls, grant_id)

    async def remove(self, grant_id: str, websocket: WebSocket) -> None:
        close_relay = False
        close_control = False
        source_removed = False
        async with self._lock:
            if self._sources.get(grant_id) is websocket:
                self._sources.pop(grant_id, None)
                source_removed = True
            viewers = self._viewers.get(grant_id)
            if viewers is not None:
                viewers.discard(websocket)
                if not viewers:
                    self._viewers.pop(grant_id, None)
                    close_relay = True
            if grant_id not in self._sources and grant_id not in self._viewers:
                close_control = True
        if source_removed:
            await self._publish_end(grant_id)
            await self._detach(grant_id)
            return
        if close_relay:
            await self._close_relay(grant_id)
        if close_control:
            await self._close_control(grant_id)

    async def _detach(self, grant_id: str) -> None:
        async with self._lock:
            source = self._sources.pop(grant_id, None)
            viewers = list(self._viewers.pop(grant_id, set()))
            relay = self._relays.pop(grant_id, None)
            control = self._controls.pop(grant_id, None)
        for websocket in ([source] if source is not None else []) + viewers:
            try:
                if websocket in viewers:
                    await websocket.send_json({"type": "ended"})
                await websocket.close(code=1000)
            except Exception:
                pass
        for entry in (relay, control):
            if entry is None:
                continue
            pubsub, task = entry
            if task is not asyncio.current_task() and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            try:
                await pubsub.aclose()
            except AttributeError:
                try:
                    await pubsub.close()
                except Exception:
                    pass
            except Exception:
                pass

    async def _publish_end(self, grant_id: str) -> None:
        if self._cluster_enabled():
            from ..services.cluster_bus import bus
            try:
                await bus.redis.publish(
                    self._control_channel(grant_id),
                    bus.codec.encode({"kind": "ended", "grantId": grant_id}),
                )
            except Exception:
                pass

    async def stop(self, grant_id: str) -> None:
        await self._publish_end(grant_id)
        await self._detach(grant_id)

    async def _frame_local(self, grant_id: str, metadata: dict, payload: bytes) -> None:
        async with self._lock:
            viewers = list(self._viewers.get(grant_id, set()))
        if not viewers:
            return
        results = await asyncio.gather(*(
            asyncio.wait_for(_send_frame(viewer, metadata, payload), 2)
            for viewer in viewers
        ), return_exceptions=True)
        for viewer, result in zip(viewers, results):
            if isinstance(result, BaseException):
                await self.remove(grant_id, viewer)

    async def _relay_loop(self, grant_id: str, pubsub) -> None:
        from ..services.cluster_bus import bus
        try:
            while True:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0)
                if not message:
                    await asyncio.sleep(0)
                    continue
                if message.get("type") != "message":
                    continue
                try:
                    packet = bus.codec.decode(message.get("data", b""))
                except Exception:
                    continue
                if (packet.get("kind") != "frame"
                        or packet.get("grantId") != grant_id):
                    continue
                metadata = packet.get("metadata")
                payload = packet.get("payload")
                if not isinstance(metadata, dict) or not isinstance(payload, bytes):
                    continue
                if (len(payload) < 10 or len(payload) > 384 * 1024
                        or not payload.startswith(b"\xff\xd8")
                        or not payload.endswith(b"\xff\xd9")):
                    continue
                # Drain frames already queued while the viewer was busy and
                # display only the newest one. This bounds visual latency and
                # prevents a slow browser from replaying stale screenshots.
                while True:
                    newer = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=0)
                    if not newer or newer.get("type") != "message":
                        break
                    try:
                        candidate = bus.codec.decode(newer.get("data", b""))
                    except Exception:
                        continue
                    if (candidate.get("kind") != "frame"
                            or candidate.get("grantId") != grant_id):
                        continue
                    candidate_metadata = candidate.get("metadata")
                    candidate_payload = candidate.get("payload")
                    if (
                        isinstance(candidate_metadata, dict)
                        and isinstance(candidate_payload, bytes)
                        and 10 <= len(candidate_payload) <= 384 * 1024
                        and candidate_payload.startswith(b"\xff\xd8")
                        and candidate_payload.endswith(b"\xff\xd9")
                    ):
                        metadata, payload = candidate_metadata, candidate_payload
                await self._frame_local(grant_id, metadata, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._detach(grant_id)
        finally:
            async with self._lock:
                current = self._relays.get(grant_id)
                if current is not None and current[1] is asyncio.current_task():
                    self._relays.pop(grant_id, None)

    async def _control_loop(self, grant_id: str, pubsub) -> None:
        from ..services.cluster_bus import bus
        try:
            while True:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0)
                if not message or message.get("type") != "message":
                    await asyncio.sleep(0)
                    continue
                try:
                    packet = bus.codec.decode(message.get("data", b""))
                except Exception:
                    continue
                if (packet.get("kind") == "ended"
                        and packet.get("grantId") == grant_id):
                    await self._detach(grant_id)
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._detach(grant_id)
        finally:
            async with self._lock:
                current = self._controls.get(grant_id)
                if current is not None and current[1] is asyncio.current_task():
                    self._controls.pop(grant_id, None)

    async def frame(self, grant_id: str, metadata: dict, payload: bytes) -> bool:
        if self._cluster_enabled():
            from ..services.cluster_bus import bus
            try:
                await bus.redis.publish(
                    self._channel(grant_id),
                    bus.codec.encode({"kind": "frame", "grantId": grant_id,
                                      "metadata": metadata, "payload": payload}),
                )
                return True
            except Exception:
                await self._detach(grant_id)
                return False
        await self._frame_local(grant_id, metadata, payload)
        return True


async def _send_frame(websocket: WebSocket, metadata: dict, payload: bytes) -> None:
    await websocket.send_json(metadata)
    await websocket.send_bytes(payload)


_media = _MediaHub()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _epoch(value: datetime) -> float:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _owner(client: Client) -> str:
    owner = str(client.user_ref or "").strip()
    if not owner:
        raise HTTPException(403, "设备尚未绑定企业账号")
    return owner


async def _grant(grant_id: str, client: Client, session: AsyncSession) -> RemoteScreenGrant:
    row = await session.scalar(select(RemoteScreenGrant).where(RemoteScreenGrant.id == grant_id))
    if row is None or row.owner_user_id != _owner(client) or client.id not in {row.viewer_client_id, row.source_client_id}:
        raise HTTPException(404, "看屏授权不存在")
    if _epoch(row.expires_at) <= _now().timestamp() and row.state not in {"stopped", "expired"}:
        row.state = "expired"
        await session.commit()
    return row


def _json(row: RemoteScreenGrant, source_name: str = "") -> dict:
    return {
        "id": row.id, "sourceClientId": row.source_client_id,
        "sourceName": source_name, "state": row.state,
        "permission": "view", "canControl": False,
        "expiresAt": _epoch(row.expires_at),
    }


@router.get("/sources")
async def screen_sources(client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    owner = _owner(client)
    rows = list((await session.scalars(select(Client).where(
        Client.user_ref == owner, Client.id != client.id, Client.auth_state == "active"
    ).order_by(Client.last_seen_at.desc(), Client.id.asc()).limit(50))).all())
    now = _now()
    from ..realtime import hub
    online_devices = hub.online_devices()
    items = []
    for row in rows:
        online = row.id in online_devices or bool(row.last_seen_at and (now - (row.last_seen_at if row.last_seen_at.tzinfo else row.last_seen_at.replace(tzinfo=timezone.utc))).total_seconds() <= 45)
        items.append({
            "id": row.id, "name": row.name or "我的电脑", "online": online,
            "capability": "read-only-screen-v1", "platform": row.platform or "",
            "lastSeen": _epoch(row.last_seen_at) if row.last_seen_at else 0,
        })
    return {"items": items}


@router.post("/requests")
async def create_screen_request(
    body: dict = Body(default_factory=dict), client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    owner = _owner(client)
    source_id = str(body.get("sourceClientId") or "").strip()
    if not source_id or len(source_id) > 64 or source_id == client.id:
        raise HTTPException(422, "请选择另一台已登录的电脑")
    source = await session.scalar(select(Client).where(Client.id == source_id, Client.user_ref == owner, Client.auth_state == "active"))
    if source is None:
        raise HTTPException(404, "这台电脑不属于当前账号")
    # Keep cleanup out of empty discovery polls. Each creation cleans at most
    # 100 expired rows for this source; expiry is also enforced on every read
    # and media authorization, independently of cleanup progress.
    expired = select(RemoteScreenGrant.id).where(
        RemoteScreenGrant.source_client_id == source.id,
        RemoteScreenGrant.owner_user_id == owner,
        RemoteScreenGrant.state.in_(["pending", "active"]),
        RemoteScreenGrant.expires_at <= _now(),
    ).order_by(RemoteScreenGrant.expires_at).limit(100)
    await session.execute(update(RemoteScreenGrant).where(
        RemoteScreenGrant.id.in_(expired)).values(state="expired"),
        execution_options={"synchronize_session": False})
    row = RemoteScreenGrant(owner_user_id=owner, viewer_client_id=client.id, source_client_id=source.id,
                            state="pending", permission="view", can_control=False, expires_at=_now() + _TTL)
    session.add(row); await session.commit()
    await native_discovery.wake(source.id, owner, "remote-screen")
    return _json(row, source.name or "我的电脑")


@router.get("/requests")
@identity_only
async def source_screen_requests(
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    """Return pending and active grants for this desktop to explicitly approve."""
    owner = _owner(client)
    rows = list((await session.scalars(select(RemoteScreenGrant).where(
        RemoteScreenGrant.owner_user_id == owner,
        RemoteScreenGrant.source_client_id == client.id,
        RemoteScreenGrant.state.in_(["pending", "active"]),
        RemoteScreenGrant.expires_at > _now(),
    ).order_by(RemoteScreenGrant.created_at.asc(), RemoteScreenGrant.id.asc()).limit(20))).all())
    if not rows:
        return {"items": []}
    viewer_ids = {row.viewer_client_id for row in rows}
    viewers = {
        viewer.id: viewer for viewer in (await session.execute(select(Client.id, Client.name).where(
            Client.id.in_(viewer_ids), Client.user_ref == owner
        ))).all()
    }
    items = []
    for row in rows:
        viewer = viewers.get(row.viewer_client_id)
        items.append({
            **_json(row, viewer.name if viewer else "mobile"),
            "viewerClientId": row.viewer_client_id,
            "viewerName": viewer.name if viewer else "mobile",
        })
    return {"items": items}


@router.get("/requests/{grant_id}")
async def screen_request(grant_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _grant(grant_id, client, session)
    source = await session.get(Client, row.source_client_id)
    return _json(row, source.name if source else "我的电脑")


@router.post("/requests/{grant_id}/approve")
async def approve_screen_request(grant_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _grant(grant_id, client, session)
    if client.id != row.source_client_id:
        raise HTTPException(403, "只有来源电脑可以同意看屏")
    if row.state != "pending":
        return _json(row)
    row.state = "active"; row.activated_at = _now(); await session.commit()
    return _json(row)


@router.post("/requests/{grant_id}/stop")
async def stop_screen_request(grant_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _grant(grant_id, client, session)
    row.state = "stopped"; row.stopped_at = _now(); row.ticket_hash = ""; await session.commit()
    await _media.stop(grant_id)
    await native_discovery.wake(row.source_client_id, row.owner_user_id, "remote-screen")
    return {"ok": True, **_json(row)}


@router.post("/requests/{grant_id}/ticket")
async def screen_ticket(grant_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _grant(grant_id, client, session)
    if client.id != row.viewer_client_id:
        raise HTTPException(403, "只有申请设备可以获取看屏票据")
    if row.state != "active":
        raise HTTPException(409, "等待来源电脑明确同意看屏")
    ticket = secrets.token_urlsafe(32); row.ticket_hash = hashlib.sha256(ticket.encode()).hexdigest()
    await session.commit()
    return {"role": "viewer", "permission": "view", "ticket": ticket, "expiresAt": _epoch(row.expires_at)}


@router.websocket("/media")
async def screen_media(websocket: WebSocket):
    """Serve the read-only viewer and desktop source halves of one grant.

    The source can publish JPEG frames only after authenticating its device
    session and an active, same-account grant. The viewer can send heartbeat
    pings only; it never gets a command path.
    """
    await websocket.accept()
    from ..services.cluster_bus import bus
    if bus.enabled and not bus.healthy:
        await websocket.close(code=1013)
        return
    grant_id = ""
    try:
        message = await websocket.receive_json()
        if not isinstance(message, dict):
            await websocket.close(code=4403)
            return
        if message.get("type") == "auth" and isinstance(message.get("ticket"), str):
            ticket_hash = hashlib.sha256(message["ticket"].encode()).hexdigest()
            async with SessionLocal() as session:
                row = await session.scalar(select(RemoteScreenGrant).where(
                    RemoteScreenGrant.ticket_hash == ticket_hash,
                    RemoteScreenGrant.state == "active",
                ))
                if row is None or row.expires_at <= _now():
                    await websocket.close(code=4403)
                    return
                grant_id = row.id
            await _media.add_viewer(grant_id, websocket)
            await websocket.send_json({"type": "ready", "role": "viewer", "permission": "view"})
            last_check = time.monotonic()
            while True:
                value = await websocket.receive()
                if value.get("type") == "websocket.disconnect":
                    return
                if value.get("text") not in {"{\"type\":\"ping\"}", "{\"type\": \"ping\"}"}:
                    await websocket.close(code=4403)
                    return
                if time.monotonic() - last_check >= 15:
                    async with SessionLocal() as session:
                        current = await session.scalar(select(RemoteScreenGrant).where(
                            RemoteScreenGrant.id == grant_id,
                            RemoteScreenGrant.state == "active",
                        ))
                    if current is None or current.expires_at <= _now():
                        await websocket.close(code=4403)
                        return
                    last_check = time.monotonic()
        elif message.get("type") == "source-auth":
            device = str(message.get("device") or "").strip()
            session_token = str(message.get("session") or "").strip()
            grant_id = str(message.get("grantId") or "").strip()
            if not device or not session_token or not grant_id:
                await websocket.close(code=4403)
                return
            async with SessionLocal() as session:
                try:
                    source = await device_auth.client_from_transport(
                        session, device, device_session=session_token,
                        secret="", allow_legacy=False,
                    )
                except device_auth.DeviceAuthError:
                    source = None
                row = await session.scalar(select(RemoteScreenGrant).where(
                    RemoteScreenGrant.id == grant_id,
                    RemoteScreenGrant.source_client_id == device,
                    RemoteScreenGrant.state == "active",
                )) if source is not None else None
                if source is None or row is None or row.owner_user_id != str(source.user_ref or "") or row.expires_at <= _now():
                    await websocket.close(code=4403)
                    return
            if not await _media.add_source(grant_id, websocket):
                await websocket.close(code=4409)
                return
            await websocket.send_json({"type": "ready", "role": "source", "permission": "view"})
            sequence = 0
            pending = None
            last_check = time.monotonic()
            while True:
                value = await websocket.receive()
                if value.get("type") == "websocket.disconnect":
                    return
                if time.monotonic() - last_check >= 15:
                    async with SessionLocal() as session:
                        try:
                            current_source = await device_auth.client_from_transport(
                                session, device, device_session=session_token,
                                secret="", allow_legacy=False,
                            )
                        except device_auth.DeviceAuthError:
                            current_source = None
                        current = await session.scalar(select(RemoteScreenGrant).where(
                            RemoteScreenGrant.id == grant_id,
                            RemoteScreenGrant.source_client_id == device,
                            RemoteScreenGrant.state == "active",
                        )) if current_source is not None else None
                    if current is None or current.expires_at <= _now():
                        await websocket.close(code=4403)
                        return
                    last_check = time.monotonic()
                if value.get("text") is not None:
                    try:
                        packet = json.loads(value["text"])
                    except (TypeError, ValueError):
                        await websocket.close(code=4403)
                        return
                    if packet == {"type": "ping"}:
                        continue
                    if (
                        packet.get("type") != "frame" or pending is not None
                        or not isinstance(packet.get("sequence"), int)
                        or packet["sequence"] <= sequence
                        or not isinstance(packet.get("width"), int)
                        or not isinstance(packet.get("height"), int)
                        or not 1 <= packet["width"] <= 1280
                        or not 1 <= packet["height"] <= 1280
                        or not isinstance(packet.get("at"), (int, float))
                        or not math.isfinite(float(packet["at"]))
                    ):
                        await websocket.close(code=4403)
                        return
                    pending = {
                        "type": "frame", "sequence": packet["sequence"],
                        "width": packet["width"], "height": packet["height"],
                        "at": packet["at"],
                    }
                    continue
                payload = value.get("bytes")
                if payload is None or pending is None or not isinstance(payload, bytes):
                    await websocket.close(code=4403)
                    return
                if (
                    len(payload) < 10 or len(payload) > 384 * 1024
                    or not payload.startswith(b"\xff\xd8")
                    or not payload.endswith(b"\xff\xd9")
                ):
                    await websocket.close(code=4403)
                    return
                sequence = pending["sequence"]
                if not await _media.frame(grant_id, pending, payload):
                    await websocket.close(code=1013)
                    return
                pending = None
        else:
            await websocket.close(code=4403)
            return
    except (WebSocketDisconnect, ValueError, TypeError, KeyError):
        return
    finally:
        if grant_id:
            await _media.remove(grant_id, websocket)

