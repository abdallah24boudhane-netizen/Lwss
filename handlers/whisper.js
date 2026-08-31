'use strict';
/**
 * 🤫 handlers/whisper.js — نظام الهمسة (Whisper System) v2
 * ──────────────────────────────────────────────────────────────
 * التدفّق الجديد:
 *   1) رد على رسالة الشخص بالقروب واكتب "همسة" (بدون أي محتوى).
 *   2) البوت يحذف رسالة التريغر فوراً ويرسل لك بالخاص طلب كتابة النص.
 *   3) تكتب نص الهمسة بالخاص — ما يظهر بالقروب إطلاقاً ولا للحظة.
 *   4) يظهر بالقروب تيزر واحد فيه: من ← إلى، وزر "عرض الهمسة".
 * المستلم بس يقدر يفتح الزر ويشوف المحتوى (Alert أو رسالة خاصة لو طويل).
 */

const wdb = require('../database/whisper_db');
const { escMd } = require('../utils/common');
const { btn, build } = require('../utils/keyboard');

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

function delCmd(ctx) { setTimeout(() => ctx.deleteMessage().catch(() => {}), 800); }

function tempReply(ctx, text, delay = 8000) {
  const threadId = ctx.message?.message_thread_id;
  ctx.reply(text, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) })
    .then(m => { if (m && delay) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), delay); })
    .catch(() => {});
}

// ── تحديد الهدف: من الرد (الطريقة الأساسية)، أو @username كـ fallback ──
async function resolveTarget(ctx) {
  const replyMsg = ctx.message.reply_to_message;
  if (replyMsg?.from) {
    return { id: replyMsg.from.id, name: replyMsg.from.first_name || 'مستخدم', isBot: !!replyMsg.from.is_bot };
  }
  const raw = (ctx.match?.[1] || '').trim().split(/\s+/)[0];
  if (!raw) return null;
  if (raw.startsWith('@')) {
    const uname = raw.slice(1);
    try {
      const { get } = require('../database/db');
      const row = await get(
        'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 AND username ILIKE $2 LIMIT 1',
        [ctx.chat.id, uname]
      );
      if (row) return { id: row.user_id, name: row.first_name || raw, isBot: false };
    } catch (_) { /* ignore */ }
  }
  return null;
}

// ── الخطوة 1: تريغر "همسة" داخل القروب — يفتح محادثة كتابة بالخاص ──
async function handleWhisperCommand(ctx, next) {
  if (!isGroup(ctx)) return next ? next() : undefined;
  delCmd(ctx);

  const target = await resolveTarget(ctx);
  if (!target) {
    return tempReply(ctx, '❌ رد على رسالة الشخص الذي تريد إرسال همسة له، ثم اكتب: همسة');
  }
  if (target.isBot) {
    return tempReply(ctx, '❌ ما تقدر تبعث همسة لبوت.');
  }
  if (target.id === ctx.from.id) {
    const allowed = await wdb.isSelfAllowed().catch(() => false);
    if (!allowed) return tempReply(ctx, '❌ لا يمكنك إرسال همسة لنفسك.');
  }

  const senderId = ctx.from.id;
  const groupChatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id || null;

  try {
    await ctx.telegram.sendMessage(
      senderId,
      '🤫 *اكتب رسالة الهمسة التي تريد إرسالها إلى ' + escMd(target.name || 'مستخدم') + ':*\n\n_(أو /cancel للإلغاء)_',
      { parse_mode: 'Markdown' }
    );
  } catch (_) {
    return tempReply(ctx, '⚠️ افتح محادثة خاصة مع البوت أولاً (اضغط على اسمي وابدأ محادثة)، ثم أعد المحاولة.', 10000);
  }

  await require('../utils/stateManager').setState(senderId, {
    type: 'whisper_compose',
    chatId: groupChatId,
    threadId,
    targetId: target.id,
    targetName: target.name || '',
  });
}

// ── الخطوة 2: استقبال نص الهمسة بالخاص وإرسال التيزر بالقروب ──
function registerComposeHandler(bot) {
  bot.on('message', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    const uid = ctx.from?.id;
    if (!uid) return next();

    const state = require('../utils/stateManager').getState(uid);
    if (!state || state.type !== 'whisper_compose') return next();

    const text = (ctx.message.text || ctx.message.caption || '').trim();
    if (text === '/cancel') {
      await require('../utils/stateManager').delState(uid);
      return ctx.reply('❌ تم إلغاء الهمسة.').catch(() => {});
    }
    if (!text) {
      return ctx.reply('⚠️ اكتب نص الهمسة (نص فقط حالياً).').catch(() => {});
    }

    await require('../utils/stateManager').delState(uid);

    const ttl = await wdb.getTtlMinutes().catch(() => wdb.DEFAULT_TTL_MIN);
    let whisper;
    try {
      whisper = await wdb.createWhisper({
        chatId: state.chatId,
        senderId: uid,
        senderName: ctx.from.first_name || '',
        receiverId: state.targetId,
        receiverName: state.targetName || '',
        content: text,
        ttlMinutes: ttl,
      });
    } catch (e) {
      require('../utils/logger').error('[Whisper] create failed:', e.message);
      return ctx.reply('⚠️ تعذر إرسال الهمسة، حاول مرة أخرى.').catch(() => {});
    }

    // التيزر بالقروب — يظهر المرسل والمستقبل، بدون سطر المهلة
    const teaserText =
      '🤫 *همسة سرية*\n\n' +
      '👤 من: ' + escMd(ctx.from.first_name || 'مستخدم') + '\n' +
      '👤 إلى: ' + escMd(state.targetName || 'مستخدم');
    const kb = build([[btn('🤫 عرض الهمسة', 'whisper:' + whisper.id)]]);

    try {
      const sent = await ctx.telegram.sendMessage(state.chatId, teaserText, {
        parse_mode: 'Markdown',
        ...(state.threadId ? { message_thread_id: state.threadId } : {}),
        ...kb,
      });
      if (sent) await wdb.setMessageId(whisper.id, sent.message_id);
      await ctx.reply('✅ تم إرسال همستك بنجاح!').catch(() => {});
    } catch (e) {
      require('../utils/logger').error('[Whisper] teaser send failed:', e.message);
      await ctx.reply('⚠️ تعذر إرسال الهمسة إلى القروب.').catch(() => {});
    }
  });
}

// ── معالجة زر "عرض الهمسة" ──
async function handleOpenCallback(ctx, data) {
  const id = parseInt(data.slice('whisper:'.length), 10);
  if (!Number.isFinite(id)) {
    return ctx.answerCbQuery('❌ بيانات غير صالحة.', { show_alert: true }).catch(() => {});
  }

  const w = await wdb.getWhisper(id).catch(() => null);
  if (!w) {
    return ctx.answerCbQuery('❌ الهمسة غير موجودة أو تم حذفها.', { show_alert: true }).catch(() => {});
  }
  if (String(w.chat_id) !== String(ctx.chat?.id)) {
    return ctx.answerCbQuery('❌ هذي الهمسة مو من هذا القروب.', { show_alert: true }).catch(() => {});
  }
  if (new Date(w.expires_at).getTime() < Date.now()) {
    return ctx.answerCbQuery('⏳ انتهت صلاحية هذه الهمسة.', { show_alert: true }).catch(() => {});
  }
  if (Number(ctx.from.id) !== Number(w.receiver_id)) {
    return ctx.answerCbQuery('❌ هذه الهمسة ليست موجهة إليك.', { show_alert: true }).catch(() => {});
  }

  const openOnce = await wdb.isOpenOnce().catch(() => false);
  let content = w.content;

  if (openOnce) {
    const claimed = await wdb.claimSingleOpen(id).catch(() => null);
    if (!claimed) {
      return ctx.answerCbQuery('⏳ سبق فتح هذه الهمسة، ما تقدر تفتحها مرة ثانية.', { show_alert: true }).catch(() => {});
    }
    content = claimed.content;
  } else {
    await wdb.markOpenedIfFirst(id);
  }

  if (content.length <= 190) {
    return ctx.answerCbQuery('🤫 ' + content, { show_alert: true }).catch(() => {});
  }

  try {
    await ctx.telegram.sendMessage(ctx.from.id, '🤫 *همسة من ' + escMd(w.sender_name || 'مستخدم') + ':*\n\n' + content, { parse_mode: 'Markdown' });
    return ctx.answerCbQuery('✅ بعثتلك الهمسة بالخاص.').catch(() => {});
  } catch (_) {
    const botUn = ctx.botInfo?.username || '';
    return ctx.answerCbQuery(
      '🤫 ' + content.slice(0, 150) + '…\n\n(الرسالة طويلة — ابدأ محادثة خاصة مع @' + botUn + ' لعرضها كاملة)',
      { show_alert: true }
    ).catch(() => {});
  }
}

// ── أوامر إعداد (owner فقط) ──
function registerSettingsCommands(bot) {
  bot.command('whisperonce', async ctx => {
    if (!ctx.isOwner) return;
    const cur = await wdb.isOpenOnce();
    await wdb.setOpenOnce(!cur);
    return ctx.reply(!cur ? '✅ الهمسة صارت تُفتح مرة وحدة بس.' : '✅ الهمسة صارت تُفتح أكثر من مرة (لين الانتهاء).').catch(() => {});
  });
  bot.command('whisperself', async ctx => {
    if (!ctx.isOwner) return;
    const cur = await wdb.isSelfAllowed();
    await wdb.setSelfAllowed(!cur);
    return ctx.reply(!cur ? '✅ صار مسموح للمستخدم يهمس لنفسه.' : '✅ صار ممنوع الهمس للنفس.').catch(() => {});
  });
  bot.command('whisperttl', async ctx => {
    if (!ctx.isOwner) return;
    const n = parseInt((ctx.message.text || '').split(/\s+/)[1], 10);
    if (!Number.isFinite(n) || n <= 0) {
      const cur = await wdb.getTtlMinutes();
      return ctx.reply('⏳ المدة الحالية: ' + cur + ' دقيقة (داخلية فقط — ما تظهر للمستخدمين).\n\nلتغييرها: `/whisperttl 15`', { parse_mode: 'Markdown' }).catch(() => {});
    }
    await wdb.setTtlMinutes(n);
    return ctx.reply('✅ صارت مدة صلاحية الهمسة ' + n + ' دقيقة.').catch(() => {});
  });
}

function register(bot) {
  bot.hears(/^\/?همسة(?:\s+([\s\S]+))?$/i, handleWhisperCommand);
  registerComposeHandler(bot);
  registerSettingsCommands(bot);
}

module.exports = {
  register,
  handleOpenCallback,
  cleanup: wdb.cleanupExpired,
};
