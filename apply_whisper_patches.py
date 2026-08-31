import sys

def patch(path, before, after, label):
    with open(path, encoding='utf-8') as f:
        c = f.read()
    if after in c:
        print('✅ ' + label + ': مطبّق مسبقاً')
        return
    if before not in c:
        print('❌ ' + label + ': ما لقيت نقطة الإدراج — ابعت محتوى الملف')
        sys.exit(1)
    c = c.replace(before, after, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(c)
    print('✅ ' + label + ': تم')

db_before = """  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS user_xp (
    user_id   BIGINT PRIMARY KEY,
    xp        INTEGER DEFAULT 0,
    level     INTEGER DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
"""
db_after = db_before + """
  // 🤫 نظام الهمسة (Whisper) — رسائل سرية بين أعضاء نفس القروب
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS whispers (
    id            SERIAL PRIMARY KEY,
    chat_id       BIGINT NOT NULL,
    message_id    BIGINT,
    sender_id     BIGINT NOT NULL,
    sender_name   TEXT,
    receiver_id   BIGINT NOT NULL,
    receiver_name TEXT,
    content       TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT NOW(),
    expires_at    TIMESTAMP NOT NULL,
    opened        SMALLINT DEFAULT 0,
    opened_at     TIMESTAMP
  )`); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_whispers_expires  ON whispers(expires_at)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_whispers_receiver ON whispers(receiver_id)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
"""
patch('database/db.js', db_before, db_after, 'database/db.js (جدول whispers)')

idx_before = "require('./handlers/tod').register(bot);\n"
idx_after  = idx_before + "require('./handlers/whisper').register(bot); // 🤫 نظام الهمسة — نفس سبب التسجيل المبكر\n"
patch('index.js', idx_before, idx_after, 'index.js (تسجيل whisper)')

cb_before = """      return;
    }

    const data = cbRes(_raw);"""
cb_after = """      return;
    }

    // 🤫 نظام الهمسة — نفس نمط todadm: (تفويض مباشر، لا حاجة لـcodec/epoch معقّد)
    if (_raw.startsWith('whisper:')) {
      try {
        return await require('../handlers/whisper').handleOpenCallback(ctx, _raw);
      } catch (e) {
        require('../utils/logger').error('[Whisper CB] ' + e.message);
        return ctx.answerCbQuery('⚠️ خطأ مؤقت.').catch(() => {});
      }
    }

    const data = cbRes(_raw);"""
patch('bot/callbacks.js', cb_before, cb_after, 'bot/callbacks.js (توجيه whisper:)')

sch_before = "  try { await run(\"DELETE FROM logs WHERE created_at < NOW() - INTERVAL '30 days'\"); } catch (_) {}\n}"
sch_after  = "  try { await run(\"DELETE FROM logs WHERE created_at < NOW() - INTERVAL '30 days'\"); } catch (_) {}\n  try { await require('../handlers/whisper').cleanup(); } catch (_) {} // 🤫 همسات منتهية (بدون setInterval منفصل لكل همسة)\n}"
patch('utils/scheduler.js', sch_before, sch_after, 'utils/scheduler.js (تنظيف الهمسات)')

print('')
print('✅ خلصت كل التعديلات')
