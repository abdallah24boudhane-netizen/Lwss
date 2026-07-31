path = "handlers/group_topics.js"
s = open(path, encoding="utf-8").read()

old = r"""  bot.hears(/^موضوع\s+تسمية\s+(.+)$/i, renameHandler);
}

module.exports = { setupTopicCommands, getThreadId };"""

new = r"""  bot.hears(/^موضوع\s+تسمية\s+(.+)$/i, renameHandler);

  // 🗑 موضوع حذف — يطلب تأكيد قبل التنفيذ (عملية بلا رجعة)
  const deleteHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد حذفه.');
    const kb = {
      inline_keyboard: [[
        { text: '🗑 نعم، احذف نهائياً', callback_data: 'gp_topicdel_yes_' + ctx.chat.id + '_' + threadId },
        { text: '❌ إلغاء',            callback_data: 'gp_topicdel_no_'  + ctx.chat.id + '_' + threadId },
      ]],
    };
    ctx.reply('⚠️ *تأكيد حذف الموضوع*\nهذا الإجراء *نهائي ولا يمكن التراجع عنه* — سيُحذف الموضوع وكل رسائله.\nمتأكد؟',
      { parse_mode: 'Markdown', reply_markup: kb, message_thread_id: threadId }).catch(() => {});
  };
  bot.hears(/^موضوع\s+حذف$/i, deleteHandler);
}

// 🎛️ تأكيد/إلغاء حذف الموضوع (يُستدعى من bot/callbacks.js)
async function handleCallback(ctx, data) {
  const isYes = data.startsWith('gp_topicdel_yes_');
  const rest = data.replace(isYes ? 'gp_topicdel_yes_' : 'gp_topicdel_no_', '');
  const parts = rest.split('_');
  const chatId = Number(parts[0]);
  const threadId = Number(parts[1]);

  if (!(await isTgAdminOrOwnerFor(ctx, chatId))) {
    return ctx.answerCbQuery('🚫 ليس لديك صلاحية', { show_alert: true }).catch(() => {});
  }

  if (!isYes) {
    await ctx.editMessageText('❌ تم إلغاء الحذف.').catch(() => {});
    return ctx.answerCbQuery('تم الإلغاء').catch(() => {});
  }

  try {
    await ctx.telegram.callApi('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId });
    await ctx.editMessageText('🗑 تم حذف الموضوع نهائياً.').catch(() => {});
    await ctx.answerCbQuery('🗑 تم الحذف').catch(() => {});
  } catch (e) {
    await ctx.answerCbQuery('❌ تعذر الحذف: ' + (e.description || e.message), { show_alert: true }).catch(() => {});
  }
}

// نفس فحص isTgAdminOrOwner، بس لـ chatId مررّر صراحة (مو من ctx.chat الحالي)
async function isTgAdminOrOwnerFor(ctx, chatId) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(chatId, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

module.exports = { setupTopicCommands, getThreadId, handleCallback };"""

if old not in s:
    print("❌ FAILED — النص القديم غير مطابق")
else:
    s = s.replace(old, new)
    open(path, "w", encoding="utf-8").write(s)
    print("✅ تم إضافة موضوع حذف + دالة التأكيد بأمان")
