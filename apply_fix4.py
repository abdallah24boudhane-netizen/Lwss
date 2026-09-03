import sys
def patch(path, before, after, label, marker):
    with open(path, encoding='utf-8') as f: c = f.read()
    if before not in c:
        print(('✅ ' + label + ': مطبّق مسبقاً') if marker in c else ('❌ ' + label + ': ما لقيت نقطة الإدراج'))
        if marker not in c: sys.exit(1)
        return
    c = c.replace(before, after, 1)
    with open(path, 'w', encoding='utf-8') as f: f.write(c)
    print('✅ ' + label + ': تم')

patch('handlers/music.js',
"""    } catch(e) {
      if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
      const msg = e.message?.includes('كبير') ? `❌ ${e.message}` :
                  e.message?.includes('YouTube') ? '❌ لم يُعثر على الأغنية في YouTube' :
                  '❌ فشل التحميل، جرّب أغنية أخرى.';
      ctx.reply(msg).catch(()=>{});
    } finally {""",
"""    } catch(e) {
      require('../utils/logger').error('[Music DL] ' + (e.message || e) + (e.stderr ? ' | stderr: ' + String(e.stderr).slice(0,300) : ''));
      if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
      const msg = e.message?.includes('كبير') ? `❌ ${e.message}` :
                  e.message?.includes('YouTube') ? '❌ لم يُعثر على الأغنية في YouTube' :
                  '❌ فشل التحميل، جرّب أغنية أخرى.';
      ctx.reply(msg).catch(()=>{});
    } finally {""",
  "music.js (تسجيل سبب الفشل)", "[Music DL]")

patch('handlers/music.js',
"""function buildResultsMsg(tracks, query) {
  let text = `🎵 *نتائج البحث عن:* _${escMd(query)}_\\n━━━━━━━━━━━━━━━━━━\\n\\n`;
  tracks.forEach((t, i) => {
    const dur = fmtDur(t.duration);
    text += `${i+1}. 🎵 *${escMd(t.title)}*\\n`;
    text += `   👤 ${escMd(t.artist?.name || '?')}`;
    if (dur) text += `  ⏱ ${dur}`;
    text += '\\n';
  });
  text += '\\n_اضغط على أغنية لتحميلها كاملاً_ 🎶';
  return text;
}""",
"""function buildResultsMsg(tracks, query) {
  return `🎵 *نتائج البحث عن:* _${escMd(query)}_\\n━━━━━━━━━━━━━━━━━━\\n\\n_اضغط على أغنية بالأسفل لتحميلها كاملاً_ 🎶`;
}""",
  "music.js (تبسيط نص النتائج)", "اضغط على أغنية بالأسفل")

print('')
print('✅ خلصت')
