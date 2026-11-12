"""Bound background migration work without queueing transcript-sized requests.

Limits are per Hub worker. Database version checks still arbitrate independent
workers; this gate protects foreground traffic, not distributed correctness.
"""
from contextlib import contextmanager
from threading import Lock

from fastapi import HTTPException

_lock = Lock()
_active = set()
MAX_ACTIVE = 2


@contextmanager
def reserve(kind, identity):
    key = (kind, identity)
    with _lock:
        if key in _active or len(_active) >= MAX_ACTIVE:
            raise HTTPException(429, "会话迁移正在进行，请稍后重试", headers={"Retry-After": "5"})
        _active.add(key)
    try:
        yield
    finally:
        with _lock:
            _active.discard(key)
