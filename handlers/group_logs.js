'use strict';
/**
 * 📋 handlers/group_logs.js — نظام السجلات الاحترافي
 * ──────────────────────────────────────────────────────────────
 * يسجّل كل الأحداث الإدارية في جدول group_logs، ويرسلها
 * مباشرة إلى قناة السجل (log_channel) إن كانت معيّنة عبر /setlog.
 */

const db = require('../database/group_pro_db');
const { get } = require('../database/db');
const { build: kbBuild, btn: kbBtn } = require('../utils/keyboard');
const { eos } = require('../utils/helpers');
const { cacheGet, cacheSet } = require('../utils/cache');
const logger = require('../utils/logger');

const PAGE_SIZE = 8;

// ══════════════════════════════════════════════════════════
// 🏷️ أنواع السجلات
// ══════════════════════════════════════════════════════════
const LOG_TYPES = {
  ban:            { emoji: '🚫', label: 'حظر' },
  unban:          { emoji: '🔓', label: 'رفع حظر' },
  kick:           { emoji: '🦵', label: 'طرد' },
  mute:           { emoji: '🔇', label: 'كتم' },
  unmute:         { emoji: '🔊', label: 'رفع كتم' },
  warn:           { emoji: '⚠️', label: 'تحذير' },
  unwarn:         { emoji: '➖', label: 'إزالة تحذير' },
  delete_msg:     { emoji: '🗑', label: 'حذف رسالة' },
  pin:            { emoji: '📌', label: 'تثبيت رسالة' },
  unpin:          { emoji: '📍', label: 'إلغاء تثبيت' },
  settings:       { emoji: '⚙️', label: 'تغيير إعدادات' },
  role_change:    { emoji: '🎭', label: 'تغيير رتبة' },
  lock_change:    { emoji: '🔒', label: 'تغيير قفل' },
  lock_delete:    { emoji: '🔒', label: 'حذف محتوى مقفول' },
  word_change:    { emoji: '🚷', label: 'كلمة محظورة' },
  verify_pass:    { emoji: '✅', label: 'تحقق ناجح' },
  verify_fail:    { emoji: '⛔', label: 'تحقق فاشل' },
  violation:      { emoji: '🛡', label: 'مخالفة حماية' },
  admin_join:     { emoji: '👮', label: 'مشرف جديد' },
  admin_leave:    { emoji: '🚪', label: 'خروج مشرف' },
  broadcast:      { emoji: '📢', label: 'بث رسالة' },
};

const CATEGORY_GROUPS = [
  { key: 'ban',        label: '🚫 الحظر والطرد',   types: ['ban', 'unban', 'kick'] },
  { key: 'mute',       label: '🔇 الكتم',          types: ['mute', 'unmute'] },
  { key: 'warn',       label: '⚠️ التحذيرات',      types: ['warn', 'unwarn'] },
  { key: 'delete_msg', label: '🗑 حذف الرسائل',    types: ['delete_msg'] },
  { key: 'pin',        label: '📌 التثبيت',        types: ['pin', 'unpin'] },
  { key: 'lock',       label: '🔒 الأقفال',         types: ['lock_change', 'lock_delete'] },
  { key: 'violation',  label: '🛡 مخالفات الحماية', types: ['violation'] },
  { key: 'settings',   label: '⚙️ الإعدادات',      types: ['settings', 'word_change'] },
  { key: 'role_change',label: '🎭 الرتب',          types: ['role_change'] },
  { key: 'verify',     label: '✅ التحقق',          types: ['verify_pass', 'verify_fail'] },
  { key: 'admins',     label: '👮 المشرفون',       types: ['admin_join', 'admin_leave'] },
];

// ══════════════════════════════════════════════════════════
// ✍️ تسجيل حدث + الإرسال لقناة السجل
// ══════════════════════════════════════════════════════════
async function logAction(bot, chatId, type, data = {}) {
  const { actorId, actorName, targetId, targetName, details } = data;
  db.addLog(chatId, type, actorId, actorName, targetId, targetName, details).catch(() => {});

  try {
    const settings = await require('./group_protection').getSettings(chatId).catch(() => null);
    if (settings && settings.log_enabled === false) return;

    let logChannel = cacheGet('logch_' + chatId);
    if (logChannel === null) {
      const g = await get('SELECT log_channel FROM group_chats WHERE chat_id=$1', [chatId]).catch(() => null);
      logChannel = g?.log_channel || '';
      cacheSet('logch_' + chatId, logChannel, 300000);
    }
    if (!logChannel) return;

    const text = formatLogText(type, data, chatId);
    await bot.telegram.sendMessage(logChannel, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(e => {
      logger.debug('[GroupLogs] send fail: ' + e.message);
    });
  } catch (e) {
    logger.debug('[GroupLogs] ' + e.message);
  }
}

function mention(id, name) {
  if (!id) return name || '—';
  return '[' + (name || 'مستخدم') + '](tg://user?id=' + id + ')';
}

function formatLogText(type, data, chatId) {
  const info = LOG_TYPES[type] || { emoji: '📌', label: type };
  const time = new Date().toLocaleString('ar-DZ', { hour12: false });
  let text = info.emoji + ' *' + info.label + '*\n━━━━━━━━━━━━━━━━━━\n';
  if (data.actorId)  text += '👮 المنفّذ: ' + mention(data.actorId, data.actorName) + '\n';
  if (data.targetId) text += '🎯 الهدف: '   + mention(data.targetId, data.targetName) + '\n';
  if (data.details)  text += '📝 ' + data.details + '\n';
  text += '🕐 ' + time;
  return text;
}

// ══════════════════════════════════════════════════════════
// 🖥️ واجهة السجلات
// ══════════════════════════════════════════════════════════
async function showLogsMenu(ctx, chatId) {
  const counts = await db.getLogTypeCounts(chatId);
  const countMap = {};
  for (const c of counts) countMap[c.log_type] = c.cnt;
  const total = counts.reduce((s, c) => s + c.cnt, 0);

  let text = '📋 *سجلات القروب*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += '📊 إجمالي السجلات: *' + total + '*\n\n';
  text += 'اختر تصنيفاً لعرضه:';

  const rows = CATEGORY_GROUPS.map(c => {
    const cnt = c.types.reduce((s, t) => s + (countMap[t] || 0), 0);
    return [kbBtn(c.label + ' (' + cnt + ')', 'gpx_logcat_' + c.key + '_0_' + chatId)];
  });
  rows.push([kbBtn('📤 تصدير كل السجلات (txt)', 'gpx_logexport_' + chatId)]);
  rows.push([kbBtn('◀️ رجوع', 'gp_view_' + chatId)]);

  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function showLogsList(ctx, chatId, catKey, page) {
  page = parseInt(page) || 0;
  const cat = CATEGORY_GROUPS.find(c => c.key === catKey);
  if (!cat) return showLogsMenu(ctx, chatId);

  // نجمع السجلات من كل الأنواع في هذا التصنيف
  const allLogs = [];
  for (const t of cat.types) {
    const rows = await db.getLogs(chatId, t, 50, 0);
    allLogs.push(...rows);
  }
  allLogs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const totalPages = Math.max(1, Math.ceil(allLogs.length / PAGE_SIZE));
  const pageLogs = allLogs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  let text = cat.label + '\n━━━━━━━━━━━━━━━━━━\n\n';
  if (!pageLogs.length) {
    text += '_لا توجد سجلات في هذا التصنيف._';
  } else {
    for (const log of pageLogs) {
      const info = LOG_TYPES[log.log_type] || { emoji: '📌', label: log.log_type };
      const time = new Date(log.created_at).toLocaleString('ar-DZ', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      text += info.emoji + ' *' + info.label + '*';
      if (log.target_name) text += ' — ' + log.target_name;
      text += '\n   _' + time + '_';
      if (log.details) text += ' • ' + log.details.substring(0, 60);
      text += '\n\n';
    }
    text += '📄 صفحة ' + (page + 1) + '/' + totalPages;
  }

  const navRow = [];
  if (page > 0) navRow.push(kbBtn('◀️ السابق', 'gpx_logcat_' + catKey + '_' + (page - 1) + '_' + chatId));
  if (page + 1 < totalPages) navRow.push(kbBtn('التالي ▶️', 'gpx_logcat_' + catKey + '_' + (page + 1) + '_' + chatId));

  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([kbBtn('◀️ رجوع للسجلات', 'gpx_logs_' + chatId)]);

  return eos(ctx, text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...kbBuild(rows) });
}

// ══════════════════════════════════════════════════════════
// 📤 تصدير السجلات (txt)
// ══════════════════════════════════════════════════════════
async function exportLogsFile(ctx, chatId) {
  await ctx.answerCbQuery('⏳ جاري التصدير...').catch(() => {});
  const logs = await db.getLogs(chatId, 'all', 1000, 0);
  if (!logs.length) {
    return ctx.reply('📭 لا توجد سجلات لتصديرها.').catch(() => {});
  }

  let out = 'سجلات القروب: ' + chatId + '\n';
  out += 'تم التصدير: ' + new Date().toLocaleString('ar-DZ') + '\n';
  out += '═'.repeat(40) + '\n\n';

  for (const log of logs.reverse()) {
    const info = LOG_TYPES[log.log_type] || { emoji: '📌', label: log.log_type };
    const time = new Date(log.created_at).toLocaleString('ar-DZ', { hour12: false });
    out += '[' + time + '] ' + info.emoji + ' ' + info.label + '\n';
    if (log.actor_name)  out += '  المنفّذ: ' + log.actor_name + ' (' + log.actor_id + ')\n';
    if (log.target_name) out += '  الهدف: '   + log.target_name + ' (' + log.target_id + ')\n';
    if (log.details)     out += '  ' + log.details + '\n';
    out += '\n';
  }

  try {
    await ctx.replyWithDocument(
      { source: Buffer.from(out, 'utf-8'), filename: 'group_logs_' + chatId + '.txt' },
      { caption: '📤 *تصدير سجلات القروب*\n📊 العدد: ' + logs.length, parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ فشل التصدير: ' + e.message).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════
// 🔁 Callback router
// ══════════════════════════════════════════════════════════
async function handleCallback(ctx, data, chatId) {
  if (data.startsWith('gpx_logs_'))   return showLogsMenu(ctx, chatId);
  if (data.startsWith('gpx_logcat_')) {
    const rest = data.replace('gpx_logcat_', '');
    const m = rest.match(/^(.+)_(\d+)_(-?\d+)$/);
    if (!m) return showLogsMenu(ctx, chatId);
    return showLogsList(ctx, chatId, m[1], m[2]);
  }
  if (data.startsWith('gpx_logexport_')) return exportLogsFile(ctx, chatId);
  return false;
}

module.exports = {
  LOG_TYPES, CATEGORY_GROUPS,
  logAction, formatLogText,
  showLogsMenu, showLogsList, exportLogsFile,
  handleCallback,
};
