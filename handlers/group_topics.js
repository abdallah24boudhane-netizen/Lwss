'use strict';
// ══════════════════════════════════════════════════════════
// 🧵 إدارة المواضيع (Topics) — ملف مستقل، لا يلمس group_protection.js
// ══════════════════════════════════════════════════════════

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

async function isTgAdminOrOwner(ctx) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

function getThreadId(ctx) {
  return ctx.message?.message_thread_id || null;
}

function reply(ctx, text, delay = 10000) {
  const threadId = getThreadId(ctx);
  ctx.reply(text, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) })
    .then(m => { if (m && delay) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), delay); })
    .catch(() => {});
}

async function ensureForum(ctx) {
  try {
    const chat = await ctx.telegram.getChat(ctx.chat.id);
    if (!chat.is_forum) {
      reply(ctx, '⚠️ نظام "المواضيع" (Topics) غير مفعّل بهذا القروب من إعدادات تيليجرام.');
      return false;
    }
    return true;
  } catch (e) {
    reply(ctx, '❌ تعذر التحقق من إعدادات القروب.');
    return false;
  }
}

function setupTopicCommands(bot) {
  // 🧵 موضوع → معلومات الموضوع الحالي
  const infoHandler = async ctx => {
    if (!isGroup(ctx)) return;
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, 'ℹ️ أنت الآن في المحادثة العامة، مش داخل موضوع (Topic).');
    reply(ctx, '🧵 *الموضوع الحالي*\n━━━━━━━━━━━━━━━━━━\n🆔 `' + threadId + '`');
  };
  bot.command('topic', infoHandler);
  bot.hears(/^موضوع$/i, infoHandler);

  // 🆕 موضوع انشاء <اسم>
  const createHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    if (!(await ensureForum(ctx))) return;
    const text = ctx.message.text || '';
    const name = text.replace(/^\/?topic\s+create\s*/i, '').replace(/^موضوع\s+انشاء\s*/i, '').trim();
    if (!name) return reply(ctx, '⚠️ اكتب: موضوع انشاء <الاسم>');
    try {
      const topic = await ctx.telegram.callApi('createForumTopic', { chat_id: ctx.chat.id, name });
      reply(ctx, '✅ تم إنشاء الموضوع: *' + name + '*\n🆔 `' + topic.message_thread_id + '`');
    } catch (e) {
      reply(ctx, '❌ تعذر الإنشاء: ' + (e.description || e.message) + '\n⚠️ تأكد أن البوت أدمن بصلاحية "إدارة المواضيع"');
    }
  };
  bot.hears(/^موضوع\s+انشاء\s+(.+)$/i, createHandler);
  bot.hears(/^\/?topic\s+create\s+(.+)$/i, createHandler);

  // 🔒 موضوع اغلاق (يغلق الموضوع الحالي)
  const closeHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد إغلاقه.');
    try {
      await ctx.telegram.callApi('closeForumTopic', { chat_id: ctx.chat.id, message_thread_id: threadId });
      reply(ctx, '🔒 تم إغلاق الموضوع.');
    } catch (e) {
      reply(ctx, '❌ تعذر الإغلاق: ' + (e.description || e.message));
    }
  };
  bot.hears(/^موضوع\s+اغلاق$/i, closeHandler);

  // 🔓 موضوع فتح (يعيد فتح الموضوع الحالي)
  const reopenHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد فتحه.');
    try {
      await ctx.telegram.callApi('reopenForumTopic', { chat_id: ctx.chat.id, message_thread_id: threadId });
      reply(ctx, '🔓 تم إعادة فتح الموضوع.');
    } catch (e) {
      reply(ctx, '❌ تعذر الفتح: ' + (e.description || e.message));
    }
  };
  bot.hears(/^موضوع\s+فتح$/i, reopenHandler);

  // ✏️ موضوع تسمية <اسم جديد>
  const renameHandler = async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await isTgAdminOrOwner(ctx))) return reply(ctx, '🚫 للمشرفين فقط.');
    const threadId = getThreadId(ctx);
    if (!threadId) return reply(ctx, '⚠️ هذا الأمر يُستخدم داخل الموضوع المراد تسميته.');
    const text = ctx.message.text || '';
    const name = text.replace(/^موضوع\s+تسمية\s*/i, '').trim();
    if (!name) return reply(ctx, '⚠️ اكتب: موضوع تسمية <الاسم الجديد>');
    try {
      await ctx.telegram.callApi('editForumTopic', { chat_id: ctx.chat.id, message_thread_id: threadId, name });
      reply(ctx, '✏️ تم تعديل اسم الموضوع إلى: *' + name + '*');
    } catch (e) {
      reply(ctx, '❌ تعذر التعديل: ' + (e.description || e.message));
    }
  };
  bot.hears(/^موضوع\s+تسمية\s+(.+)$/i, renameHandler);

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

module.exports = { setupTopicCommands, getThreadId, handleCallback };
