#!/bin/sh
# 🛡️ طبقة أمان: pm2 يشغّل هذا السكربت (sh موجود دايماً على أي نظام لينكس، لا يفشل بالتشغيل إطلاقاً).
# لو python3 غير متوفر، نطبع خطأ واضح بالـ logs ونضل ساكتين (sleep) بدل كراش/إيقاف كل الخدمة.
set -u
if ! command -v python3 >/dev/null 2>&1; then
  echo "[USERBOT] FATAL: python3 not found in PATH. Staying idle (will NOT crash the main bot)." >&2
  exec sleep infinity
fi
exec python3 main.py
