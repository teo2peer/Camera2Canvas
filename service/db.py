"""Async SQLite store for captured drawings.

Schema is intentionally minimal: drawing id, palette JSON, file paths,
dimensions, source label, and a ``deleted`` flag (soft-delete only —
admins remove drawings from the visible collage but the PNG stays on
disk for forensic recovery).
"""
import logging
import aiosqlite
import json
import time
from pathlib import Path
from .config import DB_PATH

log = logging.getLogger("service.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS drawings (
  id TEXT PRIMARY KEY,
  created_at REAL NOT NULL,
  palette TEXT NOT NULL,
  file_path TEXT NOT NULL,
  thumb_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drawings_created ON drawings(created_at);
"""


async def init():
    log.debug("opening sqlite at %s", DB_PATH)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def add_drawing(rec: dict):
    log.debug("db insert id=%s source=%s", rec.get("id"), rec.get("source"))
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO drawings (id, created_at, palette, file_path, thumb_path, width, height, source, deleted) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
            (
                rec["id"],
                rec.get("created_at", time.time()),
                json.dumps(rec["palette"]),
                rec["file_path"],
                rec["thumb_path"],
                rec["width"],
                rec["height"],
                rec.get("source", "overhead"),
            ),
        )
        await db.commit()


async def list_active():
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT id, palette, file_path, width, height FROM drawings WHERE deleted=0 ORDER BY created_at"
        )
        rows = await cur.fetchall()
    return [
        {
            "id": r[0],
            "palette": json.loads(r[1]),
            "file_path": r[2],
            "width": r[3],
            "height": r[4],
        }
        for r in rows
    ]


async def soft_delete(ids: list[str]):
    if not ids:
        return
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE drawings SET deleted=1 WHERE id IN ({','.join('?'*len(ids))})",
            ids,
        )
        await db.commit()


async def soft_delete_oldest(n: int):
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT id FROM drawings WHERE deleted=0 ORDER BY created_at LIMIT ?", (n,)
        )
        ids = [r[0] for r in await cur.fetchall()]
    await soft_delete(ids)
    return ids
