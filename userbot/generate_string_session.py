import sys
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from config import API_ID, API_HASH, SESSION

RAW = "--raw" in sys.argv

async def main():
    client = TelegramClient(SESSION, int(API_ID), API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print("❌ الجلسة الحالية غير مسجّلة — شغّل main.py أول.", file=sys.stderr)
        sys.exit(1)
    s = StringSession.save(client.session)
    if RAW:
        print(s, end="")
    else:
        print("\n" + "="*60)
        print("SESSION_STRING:")
        print("="*60)
        print(s)
        print("="*60 + "\n")
    await client.disconnect()

asyncio.run(main())
