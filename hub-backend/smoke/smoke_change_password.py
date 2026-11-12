"""Isolated client change-password smoke: auth, validation, session revocation."""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
import tempfile


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-change-pw-")
_root = Path(_tmp.name)
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + (_root / ".smoke-change-pw.db").as_posix()
)
os.environ["AUTH_SECRET"] = "change-pw-smoke-secret-with-enough-entropy"
os.environ["DEVICE_AUTH_COMPAT"] = "false"

import httpx  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app import automation_models, models, project_context_models  # noqa: E402,F401
from app.auth import hash_password  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402


checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


def login_body(device: str, account: str, password: str, platform="win32") -> dict:
    return {
        "device": device,
        "account": account,
        "password": password,
        "displayName": "Smoke Employee",
        "name": "Smoke workstation",
        "platform": platform,
        "version": "smoke",
        "workRoot": "C:/SoduWork/work",
    }


async def enroll(client: httpx.AsyncClient, device: str, key: str):
    return await client.post(
        "/api/v1/clients/enroll",
        headers={"X-Device-Key": key},
        json={
            "device": device,
            "name": "Smoke workstation",
            "platform": "win32",
            "version": "smoke",
        },
    )


async def login(
    client: httpx.AsyncClient,
    device: str,
    key: str,
    account: str,
    password: str,
    platform: str = "win32",
):
    return await client.post(
        "/api/v1/client-auth/login",
        headers={"X-Device-Key": key},
        json=login_body(device, account, password, platform),
    )


async def change_password(
    client: httpx.AsyncClient,
    token: str,
    current: str,
    new: str,
):
    return await client.post(
        "/api/v1/client-auth/change-password",
        headers={"Authorization": "Device " + token},
        json={"currentPassword": current, "newPassword": new},
    )


async def run() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    account = "employee.pw"
    old_password = "Employee-pass-123"
    new_password = "Employee-new-456"
    device_1 = "change-pw-device-1"
    device_2 = "change-pw-device-2"
    key_1 = "p" * 48
    key_2 = "q" * 48
    # Existing username compatibility remains; account creation now requires
    # the explicit email registration flow covered by test_email_auth.
    async with SessionLocal() as session:
        session.add(models.User(username=account, password_hash=hash_password(old_password),
                                display_name="Smoke Employee", is_active=True))
        await session.commit()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://soduwork.test",
    ) as client:
        enroll_1 = await enroll(client, device_1, key_1)
        ok(enroll_1.status_code == 200, "device-1 enrollment failed")
        enroll_2 = await enroll(client, device_2, key_2)
        ok(enroll_2.status_code == 200, "device-2 enrollment failed")

        first = await login(client, device_1, key_1, account, old_password)
        ok(first.status_code == 200, "device-1 first sign-in failed")
        # A phone and a desktop coexist; another desktop now revokes the first.
        # Password rotation must still revoke every active device category.
        second = await login(client, device_2, key_2, account, old_password, platform="android")
        ok(second.status_code == 200, "device-2 sign-in failed")
        token_1 = first.json()["session"]
        token_2 = second.json()["session"]
        headers_1 = {"Authorization": "Device " + token_1}

        # 1. unauthenticated request must be rejected
        anon = await client.post(
            "/api/v1/client-auth/change-password",
            json={"currentPassword": old_password, "newPassword": new_password},
        )
        ok(anon.status_code == 401, "change-password without a session was accepted")

        # 2. wrong current password
        wrong_current = await change_password(
            client, token_1, "Wrong-pass-123", new_password)
        ok(wrong_current.status_code == 403,
           "wrong current password was not rejected: " + wrong_current.text)
        ok(wrong_current.json().get("detail", {}).get("code") == "PASSWORD_MISMATCH",
           "wrong-current-password error code is missing")

        # 3. too-short new password
        too_short = await change_password(
            client, token_1, old_password, "Ab1")
        ok(too_short.status_code == 422,
           "short new password was accepted: " + too_short.text)
        ok(too_short.json().get("detail", {}).get("code") == "PASSWORD_TOO_SHORT",
           "too-short error code is missing")

        # 4. unchanged password
        unchanged = await change_password(
            client, token_1, old_password, old_password)
        ok(unchanged.status_code == 422,
           "unchanged password was accepted: " + unchanged.text)
        ok(unchanged.json().get("detail", {}).get("code") == "PASSWORD_UNCHANGED",
           "unchanged error code is missing")

        # 5. successful change revokes every active session of the account
        changed = await change_password(
            client, token_1, old_password, new_password)
        ok(changed.status_code == 200, "change-password failed: " + changed.text)
        data = changed.json()
        ok(data.get("ok") is True, "success payload lacks ok=true")
        ok(data.get("logoutRequired") is True, "logoutRequired is not set")
        ok(data.get("signedOutDevices", 0) >= 2,
           "not every active device was signed out: " + str(data))

        me_1 = await client.get("/api/v1/client-auth/me", headers=headers_1)
        # Pending devices return 403 and stale session versions return 401; both invalidate the session.
        ok(me_1.status_code in (401, 403),
           "device-1 old session survived the change: " + str(me_1.status_code))
        me_2 = await client.get(
            "/api/v1/client-auth/me",
            headers={"Authorization": "Device " + token_2},
        )
        ok(me_2.status_code in (401, 403),
           "device-2 session survived the change: " + str(me_2.status_code))

        # 6. old password no longer works; new password does
        old_try = await login(client, device_1, key_1, account, old_password)
        ok(old_try.status_code == 401, "old password still signs in")

        new_try = await login(client, device_1, key_1, account, new_password)
        ok(new_try.status_code == 200, "new password sign-in failed")
        ok(new_try.json().get("created") is False,
           "existing employee was re-registered by new sign-in")
        fresh_token = new_try.json()["session"]
        fresh_me = await client.get(
            "/api/v1/client-auth/me",
            headers={"Authorization": "Device " + fresh_token},
        )
        ok(fresh_me.status_code == 200 and
           fresh_me.json().get("user", {}).get("username") == account,
           "session issued after the change is unusable")

    # 7. audit trail
    async with SessionLocal() as session:
        rows = (await session.execute(
            select(models.AuditLog)
            .where(models.AuditLog.action == "client.password.change")
        )).scalars().all()
        ok(len(rows) == 1, "audit row for the change is missing: " + str(len(rows)))

    print(f"change-password smoke OK: {checks} checks")


if __name__ == "__main__":
    asyncio.run(run())
    asyncio.run(engine.dispose())
    # Windows may release SQLite handles slightly after connections close.
    # Retry temporary cleanup briefly without invalidating an otherwise successful test.
    try:
        _tmp.cleanup()
    except OSError:
        time.sleep(0.5)
        try:
            _tmp.cleanup()
        except OSError:
            pass  # Leave delayed temporary cleanup to the OS without hiding the successful result.
