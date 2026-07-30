// ══════════════════════════════════════════════════════════
// 🚪 طلبات الانضمام (Join Requests)
// ملف مستقل بالكامل — لا يلمس group_protection.js إطلاقاً
// ══════════════════════════════════════════════════════════
const logsMod = require('./group_logs');

// 📥 عند وصول طلب انضمام جديد: نشر بطاقة بالقروب مع زري قبول/رفض
function registerJoinRequests(bot) {
  bot.on('chat_join_request', async ctx => {
    try {
      const req = ctx.chatJoinRequest || ctx.update?.chat_join_request;
      if (!req) return;
      const chatId = req.chat.id;
      const user = req.from;
      const name  = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'مستخدم';
      const uname = user.username ? '@' + user.username : '—';

      let text = '🚪 *طلب انضمام جديد*\n━━━━━━━━━━━━━━━━━━\n';
      text += '👤 ' + name + '\n';
      text += '🔗 ' + uname + '\n';
      text += '🆔 `' + user.id + '`\n';
      if (req.bio) text += '📝 ' + req.bio.substring(0, 200) + '\n';

      const kb = {
        inline_keyboard: [[
          { text: '✅ قبول', callback_data: 'gp_jreq_ok_' + chatId + '_' + user.id },
          { text: '❌ رفض',  callback_data: 'gp_jreq_no_' + chatId + '_' + user.id },
        ]],
      };
      await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
    } catch (e) { /* silent */ }
  });
}

// 🎛️ معالجة ضغط زر القبول/الرفض
async function handleCallback(ctx, data) {
  const uid = Number(ctx.uid || ctx.from?.id);
  const ownerId = Number(process.env.OWNER_ID);
  const isAccept = data.startsWith('gp_jreq_ok_');
  const rest = data.replace(isAccept ? 'gp_jreq_ok_' : 'gp_jreq_no_', '');
  const parts = rest.split('_');
  const chatId = Number(parts[0]);
  const userId = Number(parts[1]);

  // ✅ تحقق صلاحية حقيقي server-side — نفس نمط checkGroupAdmin في group_panel.js
  if (uid !== ownerId) {
    try {
      const member = await ctx.telegram.getChatMember(chatId, uid);
      if (!['administrator', 'creator'].includes(member?.status)) {
        return ctx.answerCbQuery('🚫 ليس لديك صلاحية إدارة هذا القروب', { show_alert: true }).catch(() => {});
      }
    } catch (e) {
      return ctx.answerCbQuery('🚫 تعذر التحقق من صلاحياتك', { show_alert: true }).catch(() => {});
    }
  }

  try {
    if (isAccept) {
      await ctx.telegram.approveChatJoinRequest(chatId, userId);
    } else {
      await ctx.telegram.declineChatJoinRequest(chatId, userId);
    }

    logsMod.logAction({ telegram: ctx.telegram }, chatId, 'join_request', {
      actorId: uid, actorName: ctx.from?.first_name || '',
      targetId: userId,
      details: isAccept ? '✅ تم قبول طلب الانضمام' : '❌ تم رفض طلب الانضمام',
    }).catch(() => {});

    await ctx.editMessageText(
      (isAccept ? '✅ *تم قبول الطلب*' : '❌ *تم رفض الطلب*') + '\n🆔 `' + userId + '`',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    await ctx.answerCbQuery(isAccept ? '✅ تم القبول' : '❌ تم الرفض').catch(() => {});
  } catch (e) {
    return ctx.answerCbQuery('❌ ' + e.message, { show_alert: true }).catch(() => {});
  }
}

module.exports = { registerJoinRequests, handleCallback };
