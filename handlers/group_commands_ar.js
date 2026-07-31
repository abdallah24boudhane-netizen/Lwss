'use strict';
/**
 * ⌨️ handlers/group_commands_ar.js — أوامر الإدارة بالعربية
 * ──────────────────────────────────────────────────────────────
 * أوامر نصية بدون "/" — تُستخدم بالرد على رسالة العضو:
 *
 *   حظر [سبب]            — حظر العضو
 *   فك حظر / رفع حظر       — رفع الحظر
 *   طرد [سبب]            — طرد العضو
 *   كتم [مدة]            — كتم العضو (مثال: كتم 1h)
 *   فك كتم / رفع كتم       — رفع الكتم
 *   تحذير [سبب]          — تحذير العضو
 *   تحذيراته              — عرض تحذيرات العضو
 *   فك تحذير / مسح تحذير    — حذف كل تحذيرات العضو
 *   حذف                  — حذف الرسالة المردود عليها
 *   تثبيت                 — تثبيت الرسالة المردود عليها
 *   فك تثبيت / إلغاء تثبيت  — إلغاء تثبيت كل الرسائل
 *
 *   رتبة + / رتبة -        — ترقية/تخفيض رتبة العضو درجة واحدة
 *                            (في سلسلة: مدير ⇄ مشرف عام ⇄ مشرف حماية
 *                             ⇄ مشرف محتوى ⇄ مساعد إداري ⇄ بلا رتبة)
 *
 * كل أمر يتحقق من صلاحية الرتبة عبر group_roles (hasPerm) —
 * يشمل: مدير، مشرف عام، مشرف حماية، مشرف محتوى، مساعد إداري —
 * بالإضافة لمشرفي تيليجرام والمالك تلقائياً.
 *
 * كل إجراء يُسجَّل في 📋 السجلات (group_logs).
 */

const { warnMember, showWarns, clearWarns, banMember, unbanMember, muteMember, unmuteMember } = require('./group_admin');
const { getTarget, parseDuration, isTgAdmin, _reply, delCmd } = require('./group_commands');
const roles = require('./group_roles');
const rolesDb = require('../database/group_pro_db');
const logsMod = require('./group_logs');

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

// ── صلاحية: مدير/مشرف تيليجرام دائماً مسموح + رتب مخصّصة ──
async function canDo(ctx, permKey) {
  return roles.hasPerm(ctx, ctx.chat.id, ctx.from.id, permKey);
}

function log(ctx, type, target, details) {
  logsMod.logAction({ telegram: ctx.telegram }, ctx.chat.id, type, {
    actorId: ctx.from.id, actorName: ctx.from.first_name || '',
    targetId: target?.id, targetName: target?.name || '',
    details: details || '',
  }).catch(() => {});
}

// السبب: كل ما بعد كلمة الأمر، عند الرد فقط (وإلا نطرح أول كلمة @/ID)
function extractReason(ctx) {
  const rest = (ctx.match && ctx.match[1]) ? ctx.match[1].trim() : '';
  if (!rest) return '';
  if (ctx.message.reply_to_message) return rest;
  const parts = rest.split(/\s+/);
  if (parts[0].startsWith('@') || /^\d+$/.test(parts[0])) return parts.slice(1).join(' ').trim();
  return rest;
}

// المدة (للكتم): أول كلمة على شكل رقم[m/h/d]
function extractDuration(ctx) {
  const rest = (ctx.match && ctx.match[1]) ? ctx.match[1].trim() : '';
  if (!rest) return null;
  const tokens = ctx.message.reply_to_message ? rest.split(/\s+/) : rest.split(/\s+/).slice(1);
  for (const t of tokens) if (/^\d+(m|h|d)?$/i.test(t)) return t;
  return null;
}

function setupArabicModCommands(bot) {

  // ══════════════════════════════════════════
  // 🚫 حظر
  // ══════════════════════════════════════════
  bot.hears(/^حظر(?:\s+(.+))?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'ban'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «حظر» مع سبب اختياري.', 6000);
    const reason = extractReason(ctx);
    await banMember(ctx, ctx.chat.id, target.id, reason);
    log(ctx, 'ban', target, reason);
  });

  // ══════════════════════════════════════════
  // 🔓 فك حظر / رفع حظر
  // ══════════════════════════════════════════
  bot.hears(/^(?:فك|رفع)\s*حظر(?:\s+(.+))?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'ban'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو أو اكتب: فك حظر @username', 6000);
    await unbanMember(ctx, ctx.chat.id, target.id);
    log(ctx, 'unban', target, '');
  });

  // ══════════════════════════════════════════
  // 🦵 طرد
  // ══════════════════════════════════════════
  bot.hears(/^طرد(?:\s+(.+))?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'ban'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «طرد» مع سبب اختياري.', 6000);
    const reason = extractReason(ctx);
    try {
      await ctx.telegram.banChatMember(ctx.chat.id, target.id);
      await ctx.telegram.unbanChatMember(ctx.chat.id, target.id);
      const m = await ctx.reply(
        '🦵 *' + target.name + '* طُرد من المجموعة' + (reason ? '\n📝 ' + reason : ''),
        { parse_mode: 'Markdown' }
      ).catch(() => null);
      if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 15000);
      log(ctx, 'kick', target, reason);
    } catch (e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });

  // ══════════════════════════════════════════
  // 🔇 كتم
  // ══════════════════════════════════════════
  bot.hears(/^كتم(?:\s+(.+))?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'mute'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «كتم» أو «كتم 1h».', 6000);
    const minutes = parseDuration(extractDuration(ctx));
    await muteMember(ctx, ctx.chat.id, target.id, minutes);
    const durText = minutes < 60 ? minutes + ' دقيقة' : minutes < 1440 ? (minutes / 60) + ' ساعة' : (minutes / 1440) + ' يوم';
    log(ctx, 'mute', target, durText);
  });

  // ══════════════════════════════════════════
  // 🔊 فك كتم / رفع كتم
  // ══════════════════════════════════════════
  bot.hears(/^(?:فك|رفع)\s*كتم(?:\s+(.+))?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'mute'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو أو اكتب: فك كتم @username', 6000);
    await unmuteMember(ctx, ctx.chat.id, target.id);
    log(ctx, 'unmute', target, '');
  });

  // ══════════════════════════════════════════
  // ⚠️ تحذير
  // ══════════════════════════════════════════
  bot.hears(/^تحذير(?:\s+(.+))?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'warn'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «تحذير» مع سبب اختياري.', 6000);
    const reason = extractReason(ctx);
    await warnMember(ctx, ctx.chat.id, target.id, reason);
    log(ctx, 'warn', target, reason);
  });

  // ══════════════════════════════════════════
  // 📋 تحذيراته
  // ══════════════════════════════════════════
  bot.hears(/^تحذيرات[ه]?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'warn'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «تحذيراته».', 6000);
    await showWarns(ctx, ctx.chat.id, target.id);
  });

  // ══════════════════════════════════════════
  // ➖ فك تحذير / مسح تحذير
  // ══════════════════════════════════════════
  bot.hears(/^(?:فك|مسح)\s*تحذير(?:ات)?$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'warn'))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «فك تحذير».', 6000);
    await clearWarns(ctx, ctx.chat.id, target.id);
    log(ctx, 'unwarn', target, '');
  });

  // ══════════════════════════════════════════
  // 🗑 حذف (الرسالة المردود عليها)
  // ══════════════════════════════════════════
  bot.hears('حذف', async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'delete'))) return;
    const replyTo = ctx.message.reply_to_message;
    delCmd(ctx);
    if (!replyTo) return _reply(ctx, '⚠️ رُد على الرسالة المطلوب حذفها واكتب «حذف».', 6000);
    const target = replyTo.from ? { id: replyTo.from.id, name: replyTo.from.first_name || 'عضو' } : null;
    const snippet = (replyTo.text || replyTo.caption || '').substring(0, 60) || '[وسائط]';
    await ctx.telegram.deleteMessage(ctx.chat.id, replyTo.message_id).catch(() => {});
    log(ctx, 'delete_msg', target, snippet);
  });

  // ══════════════════════════════════════════
  // 📌 تثبيت (الرسالة المردود عليها)
  // ══════════════════════════════════════════
  bot.hears('تثبيت', async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'pin'))) return;
    const replyTo = ctx.message.reply_to_message;
    delCmd(ctx);
    if (!replyTo) return _reply(ctx, '⚠️ رُد على الرسالة المطلوب تثبيتها واكتب «تثبيت».', 6000);
    try {
      await ctx.telegram.pinChatMessage(ctx.chat.id, replyTo.message_id, { disable_notification: false });
      const target = replyTo.from ? { id: replyTo.from.id, name: replyTo.from.first_name || 'عضو' } : null;
      log(ctx, 'pin', target, (replyTo.text || replyTo.caption || '').substring(0, 60));
    } catch (e) { _reply(ctx, '❌ فشل التثبيت: ' + e.message, 6000); }
  });

  // ══════════════════════════════════════════
  // 📍 فك تثبيت / إلغاء تثبيت
  // ══════════════════════════════════════════
  bot.hears(/^(?:فك|الغاء|إلغاء)\s*تثبيت$/, async ctx => {
    if (!isGroup(ctx)) return;
    if (!(await canDo(ctx, 'pin'))) return;
    delCmd(ctx);
    try {
      await ctx.telegram.unpinAllChatMessages(ctx.chat.id);
      _reply(ctx, '✅ تم إلغاء تثبيت كل الرسائل.', 5000);
      log(ctx, 'unpin', null, '');
    } catch (e) { _reply(ctx, '❌ ' + e.message, 5000); }
  });

  // ══════════════════════════════════════════
  // ⬆️ رتبة + — ترقية درجة واحدة
  // ══════════════════════════════════════════
  bot.hears(/^رتب[ةه]\s*\+$/, async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «رتبة +».', 6000);

    const chain = roles.ROLE_ORDER; // [manager, super_admin, protection_admin, content_admin, assistant]
    const current = await rolesDb.getRole(ctx.chat.id, target.id);
    const idx = current ? chain.indexOf(current) : chain.length;

    if (idx <= 0) {
      return _reply(ctx, '⚠️ *' + target.name + '* في أعلى رتبة بالفعل (' + roles.roleLabel(current) + ').', 6000);
    }

    const newRole = chain[idx - 1];
    await rolesDb.setRole(ctx.chat.id, target.id, newRole, ctx.from.id);
    roles.clearRoleCache(ctx.chat.id, target.id);
    log(ctx, 'role_change', target, '⬆️ ترقية إلى ' + roles.roleLabel(newRole));
    _reply(ctx, '⬆️ تمت ترقية *' + target.name + '* إلى *' + roles.roleLabel(newRole) + '*', 8000);
  });

  // ══════════════════════════════════════════
  // ⬇️ رتبة - — تخفيض درجة واحدة
  // ══════════════════════════════════════════
  bot.hears(/^رتب[ةه]\s*-$/, async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    const target = await getTarget(ctx);
    delCmd(ctx);
    if (!target) return _reply(ctx, '⚠️ رُد على رسالة العضو ثم اكتب «رتبة -».', 6000);

    const chain = roles.ROLE_ORDER;
    const current = await rolesDb.getRole(ctx.chat.id, target.id);
    if (!current) return _reply(ctx, '⚠️ *' + target.name + '* لا يملك رتبة لتُخفّض.', 6000);

    const idx = chain.indexOf(current);
    if (idx === chain.length - 1) {
      await rolesDb.removeRole(ctx.chat.id, target.id);
      roles.clearRoleCache(ctx.chat.id, target.id);
      log(ctx, 'role_change', target, '⬇️ إزالة الرتبة (' + roles.roleLabel(current) + ')');
      return _reply(ctx, '⬇️ تمت إزالة رتبة *' + target.name + '* (' + roles.roleLabel(current) + ').', 8000);
    }

    const newRole = chain[idx + 1];
    await rolesDb.setRole(ctx.chat.id, target.id, newRole, ctx.from.id);
    roles.clearRoleCache(ctx.chat.id, target.id);
    log(ctx, 'role_change', target, '⬇️ تخفيض إلى ' + roles.roleLabel(newRole));
    _reply(ctx, '⬇️ تم تخفيض *' + target.name + '* إلى *' + roles.roleLabel(newRole) + '*', 8000);
  });

  // ══════════════════════════════════════════
  // 🧹 مسح جماعي للرتب
  // ══════════════════════════════════════════
  const clearRolesHandler = (roleKey, label) => async ctx => {
    if (!isGroup(ctx) || !(await isTgAdmin(ctx))) return;
    delCmd(ctx);
    const count = await roles.clearRoles(ctx.chat.id, roleKey);
    log(ctx, 'roles_bulk_clear', { id: ctx.from.id, name: ctx.from.first_name || '' }, '🧹 مسح ' + label + ' (' + count + ')');
    _reply(ctx, '🧹 تم مسح *' + label + '* — العدد: *' + count + '*', 8000);
  };
  bot.hears(/^مسح الادمنيه$/i, clearRolesHandler(null, 'كل الرتب الإدارية'));
  bot.hears(/^مسح المدراء$/i, clearRolesHandler('manager', roles.ROLE_LABELS.manager));
  bot.hears(/^مسح المشرفين العامين$/i, clearRolesHandler('super_admin', roles.ROLE_LABELS.super_admin));
  bot.hears(/^مسح مشرفي الحمايه$/i, clearRolesHandler('protection_admin', roles.ROLE_LABELS.protection_admin));
  bot.hears(/^مسح مشرفي المحتوى$/i, clearRolesHandler('content_admin', roles.ROLE_LABELS.content_admin));
  bot.hears(/^مسح المساعدين$/i, clearRolesHandler('assistant', roles.ROLE_LABELS.assistant));
}

module.exports = { setupArabicModCommands };
