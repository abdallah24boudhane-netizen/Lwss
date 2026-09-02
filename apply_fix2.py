import sys

def patch(path, before, after, label, already_marker=None):
    with open(path, encoding='utf-8') as f:
        c = f.read()
    marker = already_marker if already_marker else after
    if before not in c:
        if marker in c:
            print('✅ ' + label + ': مطبّق مسبقاً')
        else:
            print('❌ ' + label + ': ما لقيت نقطة الإدراج — ابعت محتوى المكان المتوقع')
            sys.exit(1)
        return
    c = c.replace(before, after, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(c)
    print('✅ ' + label + ': تم')

patch('handlers/manage.js',
  "  rows.push([back('mg_main')[0]]);\n",
  "  rows.push(back('mg_menu'));\n",
  "manage.js (زر رجوع mg_main→mg_menu)",
  already_marker="mg_main")

patch('handlers/manage.js',
"""      } else if (msg.sticker) {
        await ctx.telegram.sendSticker(targetId, msg.sticker.file_id);
      } else if (msg.document) {""",
"""      } else if (msg.sticker) {
        await ctx.telegram.sendSticker(targetId, msg.sticker.file_id);
      } else if (msg.voice) {
        await ctx.telegram.sendVoice(targetId, msg.voice.file_id);
      } else if (msg.document) {""",
  "manage.js (فرع voice)",
  already_marker="else if (msg.voice)")

patch('bot/messages.js',
"""  bot.on('message', async (ctx, next) => {
    const _mid = ctx.message?.message_id + '_' + (ctx.from?.id || '');
    if (isDupMsg(_mid)) return;

    if (ctx.chat?.type === 'private' && ctx.from?.id === OWNER_ID && ctx.message?.text?.startsWith('!'))
      return ownerH.handle(ctx, ctx.message.text);

""",
"""  bot.on('message', async (ctx, next) => {
    const _mid = ctx.message?.message_id + '_' + (ctx.from?.id || '');
    if (isDupMsg(_mid)) return;

    // 🔧 FIX: حالة "💬 تواصل مع المستخدم" (admin_contact) منطقها جاهز وكامل
    // بـ manage.handleText (نص/صورة/فيديو/ستيكر/مستند) — بس كانت تُستدعى بس من
    // داخل bot.on('text')، فأي رسالة مو نصية (صورة/فيديو/صوت/ستيكر) ما توصلها
    // إطلاقاً. هذا الفحص هنا (على مستوى bot.on('message') العام، يغطي كل الأنواع)
    // يسد الفجوة بدون ما يمس أي state تاني (كل الفحوصات التانية مقيّدة بنوعها).
    if (ctx.chat?.type === 'private') {
      const _acState = require('../utils/stateManager').getState(ctx.uid);
      if (_acState?.type === 'admin_contact') {
        await manage.handleText(ctx, _acState);
        return;
      }
    }

    if (ctx.chat?.type === 'private' && ctx.from?.id === OWNER_ID && ctx.message?.text?.startsWith('!'))
      return ownerH.handle(ctx, ctx.message.text);

""",
  "bot/messages.js (توجيه admin_contact لكل الأنواع)",
  already_marker="🔧 FIX: حالة \"💬 تواصل مع المستخدم\"")

print('')
print('✅ خلصت كل التعديلات')
