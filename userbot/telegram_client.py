"""
تغليف بسيط حول عميل Telethon — تسجيل الدخول فقط بهذه المرحلة.
لا يوجد أي مراقبة مجموعات، auto-join، auto-admin، أو scraping.

يدعم طريقتين للجلسة:
  1) SESSION_STRING (متغيّر بيئة) — StringSession، الطريقة الموصى بها على Railway
     (بيئة غير تفاعلية بدون قرص دائم موثوق ولا طرفية لإدخال كود SMS).
  2) ملف جلسة محلي (الطريقة القديمة) — يُستخدم فقط إذا SESSION_STRING فارغ،
     للتشغيل والتسجيل المحلي التفاعلي (مثلاً من Termux) لتوليد StringSession أول مرة.
"""
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError

from config import API_ID, API_HASH, PHONE_NUMBER, SESSION, SESSION_STRING


def build_client():
    if SESSION_STRING:
        return TelegramClient(StringSession(SESSION_STRING), int(API_ID), API_HASH)
    return TelegramClient(SESSION, int(API_ID), API_HASH)


async def ensure_logged_in(client):
    await client.connect()
    if not await client.is_user_authorized():
        if SESSION_STRING:
            # StringSession غير صالحة/منتهية على بيئة غير تفاعلية — لا يوجد input() ممكن هنا.
            raise SystemExit(
                "[USERBOT] FATAL: SESSION_STRING is set but not authorized. "
                "Generate a fresh one locally (interactive) and update the SESSION_STRING env var."
            )
        await client.send_code_request(PHONE_NUMBER)
        code = input("[USERBOT] Enter the login code sent to your Telegram app: ")
        try:
            await client.sign_in(PHONE_NUMBER, code)
        except SessionPasswordNeededError:
            password = input("[USERBOT] Two-step verification password: ")
            await client.sign_in(password=password)
