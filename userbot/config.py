"""
الإعدادات — تُقرأ من متغيرات البيئة فقط. لا يوجد أي credential مكتوب بالكود.
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

API_ID = os.environ.get("API_ID", "")
API_HASH = os.environ.get("API_HASH", "")
PHONE_NUMBER = os.environ.get("PHONE_NUMBER", "")
SESSION = os.environ.get("SESSION", "userbot_session")
# ✅ جديد: StringSession — الطريقة الموصى بها لبيئة غير تفاعلية بدون قرص دائم (Railway).
# إن كانت فارغة، يُستخدم ملف الجلسة المحلي (SESSION أعلاه) كما كان سابقاً — للتشغيل المحلي فقط.
SESSION_STRING = os.environ.get("SESSION_STRING", "")

LWSS_INTERNAL_URL = os.environ.get("LWSS_INTERNAL_URL", "http://localhost:3000")
USERBOT_INTERNAL_SECRET = os.environ.get("USERBOT_INTERNAL_SECRET", "")

HEARTBEAT_INTERVAL_SECONDS = int(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "30"))


def validate():
    missing = []
    if not API_ID:
        missing.append("API_ID")
    if not API_HASH:
        missing.append("API_HASH")
    if not PHONE_NUMBER:
        missing.append("PHONE_NUMBER")
    if not USERBOT_INTERNAL_SECRET:
        missing.append("USERBOT_INTERNAL_SECRET")
    if missing:
        raise SystemExit(
            "[USERBOT] FATAL: missing required environment variables: " + ", ".join(missing)
        )
