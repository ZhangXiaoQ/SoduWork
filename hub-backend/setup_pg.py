# -*- coding: utf-8 -*-
"""Provision a dedicated SoduWork PostgreSQL database and backend environment configuration. Read
credentials from the configured relay environment without printing them or placing them in
command arguments; leave unrelated project databases untouched.
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import urllib.parse

RELAY_ENV = r"C:\Program Files\code\relay\.env"
DB_NAME = "soduwork_hub"
HB = os.path.dirname(os.path.abspath(__file__))


def read_dsn() -> tuple[str, str, str, int]:
    text = open(RELAY_ENV, encoding="utf-8", errors="replace").read()
    m = re.search(r"postgres://([^:]+):([^@]+)@([^:/]+):(\d+)/", text)
    if not m:
        raise SystemExit("relay/.env 里没找到 postgres 连接串")
    user, pwd, host, port = m.group(1), m.group(2), m.group(3), int(m.group(4))
    return user, pwd, host, port


async def main() -> int:
    import asyncpg
    user, pwd, host, port = read_dsn()
    print("PG 目标：%s@%s:%d（口令已读取，不显示）" % (user, host, port))
    # Connect to an existing database before creating the dedicated database.
    conn = await asyncpg.connect(user=user, password=pwd, host=host, port=port,
                                 database="postgres", timeout=15)
    try:
        exists = await conn.fetchval("select 1 from pg_database where datname=$1", DB_NAME)
        if exists:
            print("库已存在：", DB_NAME)
        else:
            await conn.execute('CREATE DATABASE "%s"' % DB_NAME)
            print("已建库：", DB_NAME)
        ver = await conn.fetchval("select version()")
        print("服务端：", str(ver).split(",")[0])
    finally:
        await conn.close()

    # Verify the new database with a real write/read permission check.
    c2 = await asyncpg.connect(user=user, password=pwd, host=host, port=port,
                               database=DB_NAME, timeout=15)
    try:
        await c2.execute("create table if not exists _soduwork_probe(k text primary key, v text)")
        await c2.execute("insert into _soduwork_probe(k,v) values('probe','ok') "
                         "on conflict (k) do update set v=excluded.v")
        got = await c2.fetchval("select v from _soduwork_probe where k='probe'")
        await c2.execute("drop table _soduwork_probe")
        print("读写探针：", got)
    finally:
        await c2.close()

    url = "postgresql+asyncpg://%s:%s@%s:%d/%s" % (
        urllib.parse.quote(user), urllib.parse.quote(pwd), host, port, DB_NAME)
    env_path = os.path.join(HB, ".env")
    lines = []
    if os.path.exists(env_path):
        lines = [x for x in open(env_path, encoding="utf-8").read().splitlines()
                 if not x.startswith("DATABASE_URL=")]
    lines.insert(0, "# 后端数据库：公司开发环境 PostgreSQL（用户定：不用 SQLite）")
    lines.insert(1, "DATABASE_URL=" + url)
    open(env_path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("已写 hub-backend/.env（DATABASE_URL 指向 %s，口令在文件里，.env 已 gitignore）" % DB_NAME)
    return 0


sys.exit(asyncio.run(main()))
