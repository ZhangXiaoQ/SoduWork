"""Read-only global gate for completing endpoint transcript migration.

Set DATABASE_URL explicitly; this command never creates tables, migrates rows,
prints message bodies, or selects an implicit production database.
"""
import argparse
import asyncio
import json
import os


async def audit():
    from app.db import SessionLocal, engine
    from app.services.conversation_content_inventory import audit as inventory
    from app.services.conversation_content import metadata_only
    try:
        async with SessionLocal() as session:
            result = await inventory(session)
            result["metadataOnly"] = metadata_only()
            result["complete"] = result["complete"] and result["metadataOnly"]
            return result
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Exit nonzero until the global migration gate is complete")
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL must be explicitly supplied")
    result = asyncio.run(audit())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 1 if args.check and not result["complete"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
