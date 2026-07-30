'use strict';
/**
 * 🎭 handlers/group_roles.js — نظام الرتب والصلاحيات المتقدم
 * ──────────────────────────────────────────────────────────────
 * رتب جاهزة:
 *   manager           👑 مدير           — كل الصلاحيات
 *   super_admin       🛡️ مشرف عام       — كل شيء إلا إدارة الرتب
 *   protection_admin  🔰 مشرف حماية     — الحظر/الكتم/التحذير/الحماية/السجلات
 *   content_admin     📚 مشرف محتوى     — التثبيت/الحذف/الترحيب/البث
 *   assistant         🤝 مساعد إداري    — تحذير وحذف فقط + عرض السجلات
 */

const db = require('../database/group_pro_db');
const { build: kbBuild, btn: kbBtn } = require('../utils/keyboard');
const { eos } = require('../utils/helpers');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');

// ══════════════════════════════════════════════════════════
// 📜 تعريف الرتب والصلاحيات
// ══════════════════════════════════════════════════════════
const ROLE_ORDER = ['manager', 'super_admin', 'protection_admin', 'content_admin', 'assistant'];

const ROLE_LABELS = {
  manager:          '👑 مدير',
  super_admin:      '🛡️ مشرف عام',
  protection_admin: '🔰 مشرف حماية',
  content_admin:    '📚 مشرف محتوى',
  assistant:        '🤝 مساعد إداري',
};

// مفاتيح الصلاحيات
const PERM_LABELS = {
  ban:        'حظر/طرد الأعضاء',
  mute:       'كتم/تفعيل الأعضاء',
  warn:       'تحذير الأعضاء',
  delete:     'حذف الرسائل',
  pin:        'تثبيت الرسائل',
  protection: 'إعدادات الحماية',
  punish:     'سلّم العقوبات',
  words:      'الكلمات المحظورة',
  lock:       'أقفال الوسائط',
  welcome:    'الترحيب والوداع',
  broadcast:  'البث للقروب',
  logs:       'عرض السجلات',
  roles:      'إدارة الرتب',
  settings:   'الإعدادات العامة',
};

const ALL_PERMS_TRUE  = Object.fromEntries(Object.keys(PERM_LABELS).map(k => [k, true]));
const ALL_PERMS_FALSE = Object.fromEntries(Object.keys(PERM_LABELS).map(k => [k, false]));

const ROLE_PERMS = {
  manager:          { ...ALL_PERMS_TRUE },
  super_admin:      { ...ALL_PERMS_TRUE, roles: false },
  protection_admin: { ...ALL_PERMS_FALSE, ban: true, mute: true, warn: true, delete: true, protection: true, punish: true, words: true, lock: true, logs: true },
  content_admin:    { ...ALL_PERMS_FALSE, pin: true, delete: true, welcome: true, broadcast: true, logs: true },
  assistant:        { ...ALL_PERMS_FALSE, warn: true, delete: true, logs: true },
};

// ══════════════════════════════════════════════════════════
// 🔍 تحديد الرتبة الفعلية للمستخدم
// ══════════════════════════════════════════════════════════
async function getEffectiveRole(ctx, chatId, userId) {
  const OWNER_ID = parseInt(process.env.OWNER_ID || '0');
  if (parseInt(userId) === OWNER_ID) return 'manager';

  // كاش قصير لتقليل الاستعلامات
  const ck = 'role_' + chatId + '_' + userId;
  const cached = cacheGet(ck);
  if (cached !== null) return cached;

  let role = await db.getRole(chatId, userId).catch(() => null);

  if (!role) {
    try {
      const member = await ctx.telegram.getChatMember(chatId, userId).catch(() => null);
      if (member?.status === 'creator') role = 'manager';
      else if (member?.status === 'administrator') role = 'super_admin';
    } catch (_) {}
  }

  cacheSet(ck, role || null, 120000);
  return role || null;
}

async function hasPerm(ctx, chatId, userId, permKey) {
  if (ctx?.isOwner) return true;
  const role = await getEffectiveRole(ctx, chatId, userId);
  if (!role) return false;
  const perms = ROLE_PERMS[role];
  return !!(perms && perms[permKey]);
}

function clearRoleCache(chatId, userId) {
  cacheClear('role_' + chatId + '_' + userId);
}

function roleLabel(roleKey) {
  return ROLE_LABELS[roleKey] || '👤 عضو';
}

// ══════════════════════════════════════════════════════════
// 🖥️ واجهة إدارة الرتب
// ══════════════════════════════════════════════════════════
async function showRolesMenu(ctx, chatId) {
  const roles = await db.listRoles(chatId);

  let text = '🎭 *الرتب والصلاحيات*\n━━━━━━━━━━━━━━━━━━\n\n';
  if (!roles.length) {
    text += '_لا توجد رتب مخصّصة بعد._\n\n';
  } else {
    text += '📋 *الرتب الحالية:*\n';
    for (const r of roles) {
      text += '• ' + roleLabel(r.role_key) + ' — `' + r.user_id + '`\n';
    }
    text += '\n';
  }
  text += '💡 لإضافة رتبة: ردّ على رسالة العضو واكتب\n`/setrole [الرتبة]`\n\n';
  text += '🔖 *الرتب المتاحة:*\n';
  for (const k of ROLE_ORDER) text += '• `' + k + '` — ' + ROLE_LABELS[k] + '\n';

  const rows = [
    [kbBtn('➕ إضافة رتبة (رد على عضو)', 'gpx_roleadd_' + chatId)],
  ];
  if (roles.length) {
    rows.push([kbBtn('🗑 إزالة رتبة', 'gpx_rolerm_' + chatId)]);
  }
  rows.push([kbBtn('📜 شرح الصلاحيات', 'gpx_roleperms_' + chatId)]);
  rows.push([kbBtn('◀️ رجوع', 'gp_view_' + chatId)]);

  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showRolePerms(ctx, chatId) {
  let text = '📜 *جدول الصلاحيات لكل رتبة*\n━━━━━━━━━━━━━━━━━━\n\n';
  for (const roleKey of ROLE_ORDER) {
    text += ROLE_LABELS[roleKey] + '\n';
    const perms = ROLE_PERMS[roleKey];
    const granted = Object.keys(PERM_LABELS).filter(p => perms[p]);
    text += granted.length
      ? granted.map(p => '   ✅ ' + PERM_LABELS[p]).join('\n')
      : '   _لا صلاحيات_';
    text += '\n\n';
  }
  const rows = [[kbBtn('◀️ رجوع', 'gpx_roles_' + chatId)]];
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showRoleRemoveList(ctx, chatId) {
  const roles = await db.listRoles(chatId);
  if (!roles.length) return showRolesMenu(ctx, chatId);
  const rows = roles.map(r => [kbBtn('🗑 ' + roleLabel(r.role_key) + ' — ' + r.user_id, 'gpx_rolerm2_' + r.user_id + '_' + chatId)]);
  rows.push([kbBtn('◀️ رجوع', 'gpx_roles_' + chatId)]);
  return eos(ctx, '🗑 *اختر رتبة لإزالتها:*', { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ══════════════════════════════════════════════════════════
// ⌨️ أوامر /setrole و /removerole
// ══════════════════════════════════════════════════════════
async function handleSetRoleCommand(ctx) {
  const args = (ctx.message?.text || '').split(' ').slice(1);
  const target = ctx.message?.reply_to_message?.from;
  if (!target) {
    return ctx.reply(
      '⚠️ رد على رسالة العضو واكتب:\n`/setrole [رتبة]`\n\n' +
      '🔖 الرتب: ' + ROLE_ORDER.map(k => '`' + k + '`').join('، '),
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
  const roleKey = (args[0] || '').toLowerCase();
  if (!ROLE_ORDER.includes(roleKey)) {
    return ctx.reply(
      '⚠️ رتبة غير معروفة. اختر من:\n' + ROLE_ORDER.map(k => '`' + k + '` — ' + ROLE_LABELS[k]).join('\n'),
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
  await db.setRole(ctx.chat.id, target.id, roleKey, ctx.from.id);
  clearRoleCache(ctx.chat.id, target.id);

  const { addLog } = db;
  addLog(ctx.chat.id, 'role_change', ctx.from.id, ctx.from.first_name || '', target.id, target.first_name || '',
    'تعيين رتبة: ' + ROLE_LABELS[roleKey]).catch(() => {});

  const m = await ctx.reply(
    '✅ تم تعيين [' + (target.first_name || 'العضو') + '](tg://user?id=' + target.id + ') كـ *' + ROLE_LABELS[roleKey] + '*',
    { parse_mode: 'Markdown' }
  ).catch(() => null);
  if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 10000);
}

async function handleRemoveRoleCommand(ctx) {
  const target = ctx.message?.reply_to_message?.from;
  if (!target) return ctx.reply('⚠️ رد على رسالة العضو واكتب /removerole', { parse_mode: 'Markdown' }).catch(() => {});
  await db.removeRole(ctx.chat.id, target.id);
  clearRoleCache(ctx.chat.id, target.id);
  const m = await ctx.reply('✅ تم إزالة الرتبة عن [' + (target.first_name || 'العضو') + '](tg://user?id=' + target.id + ')', { parse_mode: 'Markdown' }).catch(() => null);
  if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 8000);
}

// ══════════════════════════════════════════════════════════
// 🔁 Callback / Text handlers (من اللوحة)
// ══════════════════════════════════════════════════════════
async function handleCallback(ctx, data, chatId) {
  if (data.startsWith('gpx_roles_'))    return showRolesMenu(ctx, chatId);
  if (data.startsWith('gpx_roleperms_')) return showRolePerms(ctx, chatId);
  if (data.startsWith('gpx_rolerm_'))   return showRoleRemoveList(ctx, chatId);

  if (data.startsWith('gpx_rolerm2_')) {
    const parts = data.replace('gpx_rolerm2_', '').split('_');
    const targetUid = parts[0];
    await db.removeRole(chatId, targetUid);
    clearRoleCache(chatId, targetUid);
    ctx.answerCbQuery('✅ تمت الإزالة').catch(() => {});
    return showRolesMenu(ctx, chatId);
  }

  if (data.startsWith('gpx_roleadd_')) {
    await require('../utils/stateManager').setState(ctx.from.id, { type: 'gpx_role_pick', chatId });
    return ctx.reply(
      '➕ *إضافة رتبة*\n\nاذهب للقروب وردّ على رسالة العضو بالأمر:\n`/setrole manager` أو `super_admin` أو `protection_admin` أو `content_admin` أو `assistant`\n\nمثال:\n`/setrole protection_admin`',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
  return false;
}

module.exports = {
  ROLE_ORDER, ROLE_LABELS, ROLE_PERMS, PERM_LABELS,
  getEffectiveRole, hasPerm, clearRoleCache, roleLabel,
  showRolesMenu, showRolePerms, showRoleRemoveList,
  handleSetRoleCommand, handleRemoveRoleCommand,
  handleCallback,
};
