"""
نقطة الدخول لـ UserBot — المرحلة الأولى فقط.
لا مراقبة مجموعات، لا auto-join، لا auto-admin، لا permissions management،
لا scraping، لا broadcasting. فقط: تسجيل دخول + heartbeat دوري.
"""
import asyncio

from config import validate, HEARTBEAT_INTERVAL_SECONDS
from telegram_client import build_client, ensure_logged_in
from api_client import send_heartbeat, close_session


async def heartbeat_loop(username):
    while True:
        await send_heartbeat(username)
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)


async def main():
    print("[USERBOT] Starting...")
    validate()

    client = build_client()
    print("[USERBOT] Connecting to Telegram...")
    await ensure_logged_in(client)
    print("[USERBOT] Connected successfully")

    me = await client.get_me()
    username = me.username or str(me.id)
    print(f"[USERBOT] Logged in as: @{username}")
    print("[USERBOT] Ready")

    hb_task = asyncio.create_task(heartbeat_loop(username))
    try:
        await client.run_until_disconnected()
    finally:
        hb_task.cancel()
        await close_session()


if __name__ == "__main__":
    asyncio.run(main())
