'use strict';
/**
 * 🤫 handlers/whisper.js — نظام الهمسة (Whisper System)
 * ──────────────────────────────────────────────────────────────
 * رسالة سرية بين عضوين بنفس القروب:
 *   - إرسال: رد على رسالة الشخص واكتب "همسة <النص>" (بـ / أو بدونها)
 *             أو "همسة @username <النص>"
 *   - عرض:   زر "🤫 عرض الهمسة" — المستلم فقط يقدر يفتحه.
 *
 * ملاحظة تصميم: التريغر "همسة" مسجَّل عبر bot.hears() (نص عادي) وليس
 * bot.command() — لأن تيليجرام لا يضع entity من نوع bot_command على
 * أوامر بحروف عربية (تحققت من هذا بكود مكتبة telegraf نفسها)، فـ
 * bot.command('همسة', ...) ما راح يشتغل إطلاقاً. bot.hears() يتحقق من
 * النص مباشرة، يشتغل بـ/ وبدونها، ونفس أسلوب باقي أوامر القروب العربية
 * بهذا المشروع (مثال: "قفل صور" بدون /).
 */

const wdb = require('../database/whisper_db');
const { escMd } = require('../utils/common');
const { btn, build } = require('../utils/keyboard');

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

function delCmd(ctx) { setTimeout(() => ctx.deleteMessage().catch(() => {}), 1500); }

function tempReply(ctx, text, delay = 8000) {
  const threadId = ctx.message?.message_thread_id;
  ctx.reply(text, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) })
    .then(m => { if (m && delay) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), delay); })
    .catch(() => {});
}

// ── تحديد الهدف: من الرد، أو من @username عبر group_members (نفس أسلوب
// getTarget بـ handlers/group_commands.js — مُعاد هنا محلياً لتفادي فرضيات
// تقسيم النص المختلفة بين "/ban @user" و"همسة @user نص طويل") ──
async function resolveTarget(ctx) {
  const replyMsg = ctx.message.reply_to_message;
  if (replyMsg?.from) {
    return { id: replyMsg.from.id, name: replyMsg.from.first_name || 'مستخدم', isBot: !!replyMsg.from.is_bot };
  }
  const raw = (ctx.match?.[1] || '').trim().split(/\s+/)[0];
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { id: parseInt(raw, 10), name: 'ID:' + raw, isBot: false };
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

// ── استخراج نص الهمسة (يستثني توكن اليوزرنيم لو موجود) ──
function extractContent(ctx, viaReply) {
  const captured = (ctx.match?.[1] || '').trim();
  if (viaReply) return captured; // كل النص بعد "همسة" هو المحتوى
  // مو رد: أول توكن كان يوزرنيم/آيدي، الباقي هو المحتوى
  return captured.split(/\s+/).slice(1).join(' ').trim();
}

async function handleWhisperCommand(ctx) {
  if (!isGroup(ctx)) return; // الهمسة مفهومها داخل قروب فقط
  delCmd(ctx); // يشيل أمر "همسة" الأصلي بعد لحظة — ما يبقى النص الظاهر بالقروب

  const viaReply = !!ctx.message.reply_to_message;
  const target = await resolveTarget(ctx);

  if (!target) {
    return tempReply(ctx, '❌ قم بالرد على رسالة شخص أو حدد المستخدم الذي تريد إرسال الهمسة إليه.\n\nمثال: `همسة @username نص الرسالة`');
  }
  if (target.isBot) {
    return tempReply(ctx, '❌ ما تقدر تبعث همسة لبوت.');
  }

  const content = extractContent(ctx, viaReply);
  if (!content) {
    return tempReply(ctx, '❌ اكتب الرسالة التي تريد إرسالها.');
  }

  if (target.id === ctx.from.id) {
    const allowed = await wdb.isSelfAllowed().catch(() => false);
    if (!allowed) return tempReply(ctx, '❌ لا يمكنك إرسال همسة لنفسك.');
  }

  const ttl = await wdb.getTtlMinutes().catch(() => wdb.DEFAULT_TTL_MIN);
  let whisper;
  try {
    whisper = await wdb.createWhisper({
      chatId: ctx.chat.id,
      senderId: ctx.from.id,
      senderName: ctx.from.first_name || '',
      receiverId: target.id,
      receiverName: target.name || '',
      content,
      ttlMinutes: ttl,
    });
  } catch (e) {
    require('../utils/logger').error('[Whisper] create failed:', e.message); // ⚠️ لا نطبع محتوى الهمسة بالـlogs أبداً
    return tempReply(ctx, '⚠️ تعذر إرسال الهمسة، حاول مرة أخرى.');
  }

  const threadId = ctx.message?.message_thread_id;
  const text = '🤫 *لديك همسة سرية*\n\n👤 إلى: ' + escMd(target.name || 'مستخدم') + '\n⏳ تنتهي خلال ' + ttl + ' دقيقة';
  const kb = build([[btn('🤫 عرض الهمسة', 'whisper:' + whisper.id)]]);

  try {
    const sent = await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...kb,
    });
    if (sent) await wdb.setMessageId(whisper.id, sent.message_id);
  } catch (e) {
    require('../utils/logger').error('[Whisper] teaser send failed:', e.message);
  }
}

// ── معالجة زر "عرض الهمسة" — يُستدعى من bot/callbacks.js لما data يبدأ بـ whisper: ──
async function handleOpenCallback(ctx, data) {
  const id = parseInt(data.slice('whisper:'.length), 10);
  if (!Number.isFinite(id)) {
    return ctx.answerCbQuery('❌ بيانات غير صالحة.', { show_alert: true }).catch(() => {});
  }

  const w = await wdb.getWhisper(id).catch(() => null);
  if (!w) {
    return ctx.answerCbQuery('❌ الهمسة غير موجودة أو تم حذفها.', { show_alert: true }).catch(() => {});
  }
  // 🔐 لازم تنتمي لنفس القروب اللي انضغط فيه الزر
  if (String(w.chat_id) !== String(ctx.chat?.id)) {
    return ctx.answerCbQuery('❌ هذي الهمسة مو من هذا القروب.', { show_alert: true }).catch(() => {});
  }
  if (new Date(w.expires_at).getTime() < Date.now()) {
    return ctx.answerCbQuery('⏳ انتهت صلاحية هذه الهمسة.', { show_alert: true }).catch(() => {});
  }
  // 🔐 الفحص الأساسي: بس المستلم الحقيقي
  if (Number(ctx.from.id) !== Number(w.receiver_id)) {
    return ctx.answerCbQuery('❌ هذه الهمسة ليست موجهة إليك.', { show_alert: true }).catch(() => {});
  }

  const openOnce = await wdb.isOpenOnce().catch(() => false);
  let content = w.content;

  if (openOnce) {
    // فتح ذرّي (atomic) — يمنع فتح مزدوج لو ضغط الزر مرتين بسرعة/بالتوازي
    const claimed = await wdb.claimSingleOpen(id).catch(() => null);
    if (!claimed) {
      // إما اتفتحت قبل هالضغطة بالضبط، أو سبق فُتحت فعلاً
      return ctx.answerCbQuery('⏳ سبق فتح هذه الهمسة، ما تقدر تفتحها مرة ثانية.', { show_alert: true }).catch(() => {});
    }
    content = claimed.content;
  } else {
    await wdb.markOpenedIfFirst(id); // بس لتسجيل الإحصائية، ما يمنع إعادة الفتح
  }

  // Telegram alert limit ≈ 200 حرف — لو أطول، نجرب رسالة خاصة
  if (content.length <= 190) {
    return ctx.answerCbQuery('🤫 ' + content, { show_alert: true }).catch(() => {});
  }

  try {
    await ctx.telegram.sendMessage(ctx.from.id, '🤫 *همسة من ' + escMd(w.sender_name || 'مستخدم') + ':*\n\n' + content, { parse_mode: 'Markdown' });
    return ctx.answerCbQuery('✅ بعثتلك الهمسة بالخاص.').catch(() => {});
  } catch (_) {
    // ما بدأ محادثة خاصة مع البوت — نرجع لـalert بنص مختصر بدل ما نفشل بصمت
    const botUn = ctx.botInfo?.username || '';
    return ctx.answerCbQuery(
      '🤫 ' + content.slice(0, 150) + '…\n\n(الرسالة طويلة — ابدأ محادثة خاصة مع @' + botUn + ' لعرضها كاملة)',
      { show_alert: true }
    ).catch(() => {});
  }
}

// ── أوامر إعداد بسيطة (owner فقط) ──
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
      return ctx.reply('⏳ المدة الحالية: ' + cur + ' دقيقة.\n\nلتغييرها: `/whisperttl 15`', { parse_mode: 'Markdown' }).catch(() => {});
    }
    await wdb.setTtlMinutes(n);
    return ctx.reply('✅ صارت مدة صلاحية الهمسة ' + n + ' دقيقة.').catch(() => {});
  });
}

function register(bot) {
  // تريغر "همسة" أو "/همسة" — يشتغل بأي مكان بالنص (^...$) مع محتوى اختياري بعده
  bot.hears(/^\/?همسة(?:\s+([\s\S]+))?$/i, handleWhisperCommand);
  registerSettingsCommands(bot);
}

module.exports = {
  register,
  handleOpenCallback,
  cleanup: wdb.cleanupExpired,
};
