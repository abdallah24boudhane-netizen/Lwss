"""
عميل غير متزامن (async) للتواصل مع الـ Internal API الخاص ببوت Lwss.
"""
import time

import aiohttp

from config import LWSS_INTERNAL_URL, USERBOT_INTERNAL_SECRET

_session = None


def _get_session():
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession()
    return _session


async def close_session():
    global _session
    if _session is not None and not _session.closed:
        await _session.close()


async def send_heartbeat(username):
    url = LWSS_INTERNAL_URL.rstrip("/") + "/internal/userbot/heartbeat"
    payload = {
        "status": "online",
        "username": username or "",
        "timestamp": time.time(),
    }
    headers = {"X-Internal-Secret": USERBOT_INTERNAL_SECRET}
    timeout = aiohttp.ClientTimeout(total=10)

    try:
        session = _get_session()
        async with session.post(url, json=payload, headers=headers, timeout=timeout) as resp:
            if 200 <= resp.status < 300:
                return True
            print(f"[USERBOT] heartbeat rejected by server (HTTP {resp.status})")
            return False
    except Exception as e:
        print(f"[USERBOT] heartbeat failed: {type(e).__name__}: {e}")
        return False
