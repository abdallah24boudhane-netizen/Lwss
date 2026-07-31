'use strict';
// ══════════════════════════════════════════════════════════
// 🧹 طرد البوتات / الحسابات المحذوفة — ملف مستقل تماماً
// ══════════════════════════════════════════════════════════
const { all } = require('../database/db');

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

async function isTgAdminOrOwner(ctx) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 📋 كشف البوتات — قراءة من DB فقط، سريعة وما تضغطش على تيليجرام
async function listBots(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return ctx.reply('🚫 للمشرفين فقط.').catch(() => {});
  const bots = await all(
    'SELECT user_id, first_name, username FROM group_members WHERE chat_id=$1 AND is_bot=1 LIMIT 200',
    [ctx.chat.id]
  ).catch(() => []);
  if (!bots.length) return ctx.reply('🤖 لا يوجد بوتات مسجّلة في هذا القروب.').catch(() => {});
  let text = '🤖 *البوتات المسجّلة* (' + bots.length + ')\n━━━━━━━━━━━━━━━━━━\n';
  text += bots.map(b => '• ' + (b.first_name || 'بوت') + (b.username ? ' (@' + b.username + ')' : '') + ' — `' + b.user_id + '`').join('\n');
  ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
}

// 🦵 طرد البوتات (أو الحسابات المحذوفة) — يتحقق حياً قبل أي طرد
async function kickBatch(ctx, mode) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return ctx.reply('🚫 للمشرفين فقط.').catch(() => {});
  const chatId = ctx.chat.id;
  const botId = ctx.botInfo?.id;

  let candidates;
  if (mode === 'bots') {
    candidates = await all(
      'SELECT user_id FROM group_members WHERE chat_id=$1 AND is_bot=1 LIMIT 200',
      [chatId]
    ).catch(() => []);
  } else {
    // ⚠️ لا يوجد عمود مخصص للحسابات المحذوفة — نتحقق حياً لكل عضو (heuristic: first_name = "Deleted Account")
    // هذا ليس موثقاً رسمياً من تيليجرام، بس هو الأسلوب الشائع المستخدم في أغلب البوتات المشابهة
    candidates = await all(
      'SELECT user_id FROM group_members WHERE chat_id=$1 AND (is_bot=0 OR is_bot IS NULL) LIMIT 300',
      [chatId]
    ).catch(() => []);
  }

  if (!candidates.length) {
    return ctx.reply(mode === 'bots' ? '📭 لا يوجد بوتات لطردها.' : '📭 لا يوجد أعضاء لفحصهم.').catch(() => {});
  }

  const progressMsg = await ctx.reply('⏳ جارٍ الفحص... 0/' + candidates.length).catch(() => null);
  let kicked = 0, checked = 0;

  for (const c of candidates) {
    checked++;
    if (Number(c.user_id) === Number(botId)) continue; // ما نطردش روحنا
    try {
      const member = await ctx.telegram.getChatMember(chatId, c.user_id);
      if (!member || !['member', 'restricted'].includes(member.status)) continue; // خرج أصلاً أو أدمن، نتخطاه
      const isDeleted = mode === 'deleted' && member.user?.first_name === 'Deleted Account' && !member.user?.username;
      const isBotMatch = mode === 'bots' && member.user?.is_bot;
      if (mode === 'bots' && !isBotMatch) continue;
      if (mode === 'deleted' && !isDeleted) continue;

      await ctx.telegram.banChatMember(chatId, c.user_id);
      await ctx.telegram.unbanChatMember(chatId, c.user_id, { only_if_banned: true }).catch(() => {});
      kicked++;
    } catch (e) { /* تجاهل عضو فردي وكمل الباقي */ }

    if (progressMsg && checked % 20 === 0) {
      await ctx.telegram.editMessageText(chatId, progressMsg.message_id, null,
        '⏳ جارٍ الفحص... ' + checked + '/' + candidates.length + ' (طُرد ' + kicked + ')'
      ).catch(() => {});
    }
    await sleep(150); // احترام حدود تيليجرام — لا Promise.all بلا حدود
  }

  const finalText = mode === 'bots'
    ? '🤖 تم طرد *' + kicked + '* بوت.'
    : '👻 تم طرد *' + kicked + '* حساب محذوف' + (kicked === 0 ? '\n\n⚠️ ملاحظة: كشف الحسابات المحذوفة يعتمد على heuristic غير موثّق رسمياً من تيليجرام، فقد لا يكون دقيقاً 100%.' : '');

  if (progressMsg) {
    await ctx.telegram.editMessageText(chatId, progressMsg.message_id, null, finalText, { parse_mode: 'Markdown' }).catch(() => {});
  } else {
    ctx.reply(finalText, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

function setupCleanupCommands(bot) {
  bot.hears(/^طرد البوتات$/i, ctx => kickBatch(ctx, 'bots'));
  bot.hears(/^طرد المحذوفين$/i, ctx => kickBatch(ctx, 'deleted'));
  bot.hears(/^كشف البوتات$/i, listBots);
}

module.exports = { setupCleanupCommands };
