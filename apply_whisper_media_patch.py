def patch(path, before, after, label):
    with open(path, encoding='utf-8') as f:
        c = f.read()
    if after in c:
        print('✅ ' + label + ': مطبّق مسبقاً')
        return
    if before not in c:
        print('❌ ' + label + ': ما لقيت نقطة الإدراج')
        raise SystemExit(1)
    c = c.replace(before, after, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(c)
    print('✅ ' + label + ': تم')

before = """  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_whispers_expires  ON whispers(expires_at)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_whispers_receiver ON whispers(receiver_id)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
"""
after = before + """  try { if(pg) await pg.query('ALTER TABLE whispers ADD COLUMN IF NOT EXISTS content_type TEXT DEFAULT \\'text\\''); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE whispers ADD COLUMN IF NOT EXISTS file_id TEXT'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
"""
patch('database/db.js', before, after, 'database/db.js (أعمدة content_type/file_id)')
