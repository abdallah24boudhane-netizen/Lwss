'use strict';
// ══════════════════════════════════════════════════════════
// 👑 نظام الترقية الاحترافي — ترقية عضو لأدمن حقيقي بتيليجرام
// + لوحة صلاحيات تفاعلية (🟢/🔴 لكل صلاحية)
// ملف مستقل تماماً — لا يلمس group_protection.js
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

// 🔑 الصلاحيات القابلة للتبديل من اللوحة (can_manage_chat يبقى مفعّل دايماً كأساس)
const PERM_LIST = [
  ['can_change_info',      '✏️ تعديل معلومات القروب'],
  ['can_delete_messages',  '🗑 حذف الرسائل'],
  ['can_invite_users',     '🔗 دعوة أعضاء'],
  ['can_restrict_members', '🚫 تقييد/حظر الأعضاء'],
  ['can_pin_messages',     '📌 تثبيت الرسائل'],
  ['can_promote_members',  '👑 ترقية أعضاء آخرين'],
  ['can_manage_video_chats','🎥 إدارة المكالمات الجماعية'],
  ['can_manage_topics',    '🧵 إدارة المواضيع'],
];

async function getTarget(ctx) {
  const msg = ctx.message;
  if (msg.reply_to_message?.from) {
    const u = msg.reply_to_message.from;
    return { id: u.id, name: u.first_name || 'عضو' };
  }
  const args = (msg.text || '').split(/\s+/).slice(1);
  const raw = args[0];
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { id: parseInt(raw), name: 'ID:' + raw };
  if (raw.startsWith('@')) {
    try {
      const { get } = require('../database/db');
      const uname = raw.replace('@', '');
      const row = await get(
        'SELECT user_id, first_name FROM group_members WHERE chat_id=$1 AND username ILIKE $2 LIMIT 1',
        [ctx.chat.id, uname]
      );
      if (row) return { id: row.user_id, name: row.first_name || raw };
    } catch (e) { /* ignore */ }
  }
  return null;
}

function buildPanelKb(chatId, targetId, flags) {
  const rows = PERM_LIST.map(([key, label]) =>
    [{ text: (flags[key] ? '🟢 ' : '🔴 ') + label, callback_data: 'gp_promo_tog_' + key + '_' + chatId + '_' + targetId }]
  );
  rows.push([{ text: 'إغلاق', callback_data: 'gp_promo_close' }]);
  return { inline_keyboard: rows };
}

function panelText(target) {
  return '👑 *لوحة صلاحيات الأدمن*\n━━━━━━━━━━━━━━━━━━\n👤 ' + target.name + '\n🆔 `' + target.id + '`\n\nاضغط على أي صلاحية لتفعيلها/تعطيلها:';
}

async function promoteHandler(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return ctx.reply('🚫 للمشرفين فقط.').catch(() => {});
  const target = await getTarget(ctx);
  if (!target) return ctx.reply('⚠️ رُد على رسالة العضو، أو اكتب: ترقية @username').catch(() => {});

  const chatId = ctx.chat.id;
  const baseFlags = { can_manage_chat: true };
  try {
    await ctx.telegram.promoteChatMember(chatId, target.id, baseFlags);
  } catch (e) {
    return ctx.reply('❌ تعذّرت الترقية: ' + (e.description || e.message) + '\n⚠️ تأكد أن البوت أدمن بصلاحية "تعيين مشرفين".').catch(() => {});
  }

  const flags = {};
  for (const [key] of PERM_LIST) flags[key] = false;

  ctx.reply(panelText(target), {
    parse_mode: 'Markdown',
    reply_markup: buildPanelKb(chatId, target.id, flags),
  }).catch(() => {});
}

async function handleCallback(ctx, data) {
  if (data === 'gp_promo_close') {
    return ctx.deleteMessage().catch(() => {});
  }

  const rest = data.replace('gp_promo_tog_', '');
  const parts = rest.split('_');
  const targetId = Number(parts.pop());
  const chatId = Number(parts.pop());
  const permKey = parts.join('_');

  if (!(await isTgAdminOrOwner(ctx))) {
    return ctx.answerCbQuery('🚫 ليس لديك صلاحية', { show_alert: true }).catch(() => {});
  }

  let current;
  try {
    current = await ctx.telegram.getChatMember(chatId, targetId);
  } catch (e) {
    return ctx.answerCbQuery('❌ تعذر جلب حالة العضو', { show_alert: true }).catch(() => {});
  }
  if (!current || current.status !== 'administrator') {
    return ctx.answerCbQuery('⚠️ العضو لم يعد أدمن', { show_alert: true }).catch(() => {});
  }

  const flags = {};
  for (const [key] of PERM_LIST) flags[key] = !!current[key];
  flags[permKey] = !flags[permKey];
  flags.can_manage_chat = true;

  try {
    await ctx.telegram.promoteChatMember(chatId, targetId, flags);
  } catch (e) {
    return ctx.answerCbQuery('❌ ' + (e.description || e.message), { show_alert: true }).catch(() => {});
  }

  const target = { id: targetId, name: current.user?.first_name || 'عضو' };
  await ctx.editMessageText(panelText(target), {
    parse_mode: 'Markdown',
    reply_markup: buildPanelKb(chatId, targetId, flags),
  }).catch(() => {});
  ctx.answerCbQuery('✅ تم التحديث').catch(() => {});
}

function setupPromoteCommands(bot) {
  bot.hears(/^ترقية(?:\s+.+)?$/i, promoteHandler);
}

module.exports = { setupPromoteCommands, handleCallback };
