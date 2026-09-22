"""
الإعدادات — تُقرأ من متغيرات البيئة، مع كشف تلقائي للبورت الحقيقي لبوت الدراسة
(Node) عبر ملف مشترك، لأن Railway قد يحقن PORT ديناميكياً بشكل لا يظهر بمتغيرات
البيئة الثابتة. لا يوجد أي credential مكتوب بالكود.
"""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

API_ID = os.environ.get("API_ID", "")
API_HASH = os.environ.get("API_HASH", "")
PHONE_NUMBER = os.environ.get("PHONE_NUMBER", "")
SESSION = os.environ.get("SESSION", "userbot_session")
SESSION_STRING = os.environ.get("SESSION_STRING", "")


def _detect_internal_url():
    # 1) أولوية لملف .internal_port اللي يكتبه index.js فور نجاح app.listen() —
    #    مصدر الحقيقة الوحيد الموثوق للبورت الفعلي.
    try:
        port_file = Path(__file__).resolve().parent.parent / ".internal_port"
        if port_file.exists():
            port = port_file.read_text().strip()
            if port.isdigit():
                return f"http://localhost:{port}"
    except Exception:
        pass
    # 2) احتياطي: متغيّر البيئة كما كان سابقاً.
    return os.environ.get("LWSS_INTERNAL_URL", "http://localhost:3000")


LWSS_INTERNAL_URL = _detect_internal_url()
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
