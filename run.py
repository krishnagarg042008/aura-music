#!/usr/bin/env python3
"""
Production entrypoint for AURA Music.
Reads configuration from environment variables (PORT, HOST, WORKERS)
and starts the uvicorn ASGI server.
"""
import os
import sys
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0")
    workers = int(os.environ.get("WORKERS", 1))

    print("=" * 60)
    print("  ✦ AURA SPATIAL MUSIC SERVER ✦")
    print(f"  Listening on: http://{host}:{port}")
    print(f"  Workers: {workers}")
    print("=" * 60)

    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        workers=workers,
        access_log=True,
        loop="asyncio",
    )
