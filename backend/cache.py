"""Lightweight bounded TTL caches and single-flight request coalescing."""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Generic, Hashable, Optional, TypeVar

T = TypeVar("T")


class BoundedTTLCache(Generic[T]):
    """In-memory LRU + TTL cache with bounded capacity."""

    def __init__(self, maxsize: int = 256, ttl: float = 1800.0) -> None:
        self.maxsize = max(1, maxsize)
        self.ttl = max(0.0, ttl)
        self._store: OrderedDict[Hashable, tuple[T, float]] = OrderedDict()

    def get(self, key: Hashable) -> Optional[T]:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if time.monotonic() >= expires_at:
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return value

    def set(self, key: Hashable, value: T, ttl: Optional[float] = None) -> None:
        effective_ttl = self.ttl if ttl is None else max(0.0, ttl)
        expires_at = time.monotonic() + effective_ttl
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = (value, expires_at)
        while len(self._store) > self.maxsize:
            self._store.popitem(last=False)

    def delete(self, key: Hashable) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()

    def __len__(self) -> int:
        now = time.monotonic()
        expired = [k for k, (_, exp) in self._store.items() if now >= exp]
        for k in expired:
            self._store.pop(k, None)
        return len(self._store)


class SingleFlight:
    """Coalesce concurrent async work per key using per-key asyncio locks."""

    def __init__(self) -> None:
        self._locks: dict[Hashable, asyncio.Lock] = {}

    def _get_lock(self, key: Hashable) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def run(self, key: Hashable, fn: Callable[[], Awaitable[Any]]) -> Any:
        lock = self._get_lock(key)
        async with lock:
            try:
                return await fn()
            finally:
                # Clean up idle lock entries when no one else is waiting
                if not lock.locked() and self._locks.get(key) is lock:
                    self._locks.pop(key, None)
