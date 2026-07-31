'use strict';
/**
 * 🖥️ handlers/group_pro_panel.js — اللوحة الاحترافية الشاملة
 * ──────────────────────────────────────────────────────────────
 * البوابة الموحّدة لكل مزايا الإدارة الاحترافية:
 *   🛡 الحماية الذكية | 🔒 الأقفال | ⚖️ سلّم العقوبات | 🚷 الكلمات المحظورة
 *   ✅ التحقق | 🎭 الرتب | 📋 السجلات | 📊 الإحصائيات | 🤖 تحليل AI
 *
 * كل الأزرار تستخدم بادئة gpx_ — وتُفتح من لوحة القروب (gp_view_)
 * أو مباشرة داخل القروب عبر أمر /الحماية.
 */

const db = require('../database/group_pro_db');
const protection = require('./group_protection');
const roles = require('./group_roles');
const logsMod = require('./group_logs');
const { build: kbBuild, btn: kbBtn } = require('../utils/keyboard');
const { eos } = require('../utils/helpers');
const { setState, delState } = require('../utils/stateManager');

// ══════════════════════════════════════════════════════════
// 🔧 أدوات مساعدة
// ══════════════════════════════════════════════════════════
function splitChatId(data) {
  const m = data.match(/^(.*)_(-?\d+)$/);
  if (!m) return [data, null];
  return [m[1], parseInt(m[2])];
}

async function checkAccess(ctx, chatId, rest) {
  if (ctx.isOwner) return true;
  try {
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    if (['administrator', 'creator'].includes(member?.status)) return true;
  } catch (_) {}

  if (rest === 'gpx_home' || rest === 'gpx_stats' || rest === 'gpx_aisummary') {
    const role = await roles.getEffectiveRole(ctx, chatId, ctx.from.id);
    return !!role;
  }

  let perm = 'logs';
  if (rest.startsWith('gpx_role'))    perm = 'roles';
  else if (rest.startsWith('gpx_log'))   perm = 'logs';
  else if (rest.startsWith('gpx_lock'))  perm = 'lock';
  else if (rest.startsWith('gpx_punish'))perm = 'punish';
  else if (rest.startsWith('gpx_word'))  perm = 'words';
  else if (rest.startsWith('gpx_resetviol')) perm = 'punish';
  else if (rest.startsWith('gpx_verify'))perm = 'protection';
  else if (rest.startsWith('gpx_tog') || rest.startsWith('gpx_setadv') || rest === 'gpx_prot' || rest === 'gpx_protadv') perm = 'protection';

  return roles.hasPerm(ctx, chatId, ctx.from.id, perm);
}

// ══════════════════════════════════════════════════════════
// 🛡 قائمة مفاتيح الحماية
// ══════════════════════════════════════════════════════════
const PROT_TOGGLES = [
  { key: 'anti_spam',      label: '🚯 مكافحة السبام' },
  { key: 'anti_link',      label: '🔗 مكافحة الروابط' },
  { key: 'anti_flood',     label: '🌊 مكافحة الفلود' },
  { key: 'anti_duplicate', label: '🔁 مكافحة التكرار' },
  { key: 'anti_forward',   label: '↪️ مكافحة التوجيه' },
  { key: 'anti_mention',   label: '📛 مكافحة المنشن الجماعي' },
  { key: 'anti_words',     label: '🚷 مكافحة الكلمات المحظورة' },
  { key: 'anti_caps',      label: '🔠 مكافحة الحروف الكبيرة' },
  { key: 'anti_edit',      label: '✏️ مكافحة تعديل المخالفات' },
  { key: 'anti_bot',       label: '🤖 مكافحة البوتات غير المصرّحة' },
  // ── حماية متقدمة ──
  { key: 'anti_short_link', label: '🔗 مكافحة الروابط المختصرة' },
  { key: 'anti_invite',     label: '📨 مكافحة روابط الدعوة' },
  { key: 'anti_media',      label: '🖼 مكافحة الصور والفيديوهات' },
  { key: 'anti_file',       label: '📁 مكافحة الملفات والمستندات' },
  { key: 'anti_raid',      label: '🌊 مكافحة الانضمام الجماعي (Raid)' },
];

const ADV_FIELDS = [
  { key: 'flood_limit',    label: 'حد رسائل الفلود',        min: 2,  max: 20,   unit: 'رسالة' },
  { key: 'flood_window',   label: 'نافذة زمن الفلود',       min: 2,  max: 30,   unit: 'ثانية' },
  { key: 'mention_limit',  label: 'حد المنشن في الرسالة',   min: 1,  max: 20,   unit: 'منشن' },
  { key: 'caps_percent',   label: 'نسبة الحروف الكبيرة',    min: 30, max: 100,  unit: '%' },
  { key: 'caps_min_len',   label: 'أقل طول لفحص الكابس',    min: 5,  max: 100,  unit: 'حرف' },
  { key: 'max_msg_len',    label: 'أقصى طول للرسالة (0=∞)', min: 0,  max: 4000, unit: 'حرف' },
  { key: 'dup_window_sec', label: 'نافذة مكافحة التكرار',   min: 5,  max: 300,  unit: 'ثانية' },
];

const LOCK_LABELS = {
  sticker: '🎭 الملصقات', gif: '🎞 الصور المتحركة', link: '🔗 الروابط', forward: '↪️ إعادة التوجيه',
  photo: '🖼 الصور', video: '🎬 الفيديو', voice: '🎤 الصوتيات/المقاطع', poll: '📊 الاستطلاعات',
  file: '📄 الملفات', chat: '💬 الدردشة بالكامل',
};

const ACTION_CYCLE = ['warn', 'mute_10', 'mute_60', 'mute_360', 'mute_1440', 'kick', 'ban', 'none'];
const LADDER_LEVELS = ['1', '2', '3', '4', '5'];
const WINDOW_CYCLE = [6, 12, 24, 48, 72, 168];
const VERIFY_TIMEOUTS = [1, 2, 3, 5, 10, 15, 30];

// ══════════════════════════════════════════════════════════
// 🏠 الصفحة الرئيسية
// ══════════════════════════════════════════════════════════
async function showHome(ctx, chatId) {
  const [settings, locks, role] = await Promise.all([
    protection.getSettings(chatId),
    protection.getLocksCached(chatId),
    roles.getEffectiveRole(ctx, chatId, ctx.from.id),
  ]);
  const protCount = PROT_TOGGLES.filter(p => settings[p.key]).length;
  const lockCount = Object.values(locks).filter(Boolean).length;

  let text = '🛡 *لوحة الإدارة الاحترافية*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += '🔰 رتبتك: *' + roles.roleLabel(role || '') + '*\n';
  text += '🛡 الحماية المفعّلة: *' + protCount + '/' + PROT_TOGGLES.length + '*\n';
  text += '🔒 الأقفال المفعّلة: *' + lockCount + '/' + db.LOCK_TYPES.length + '*\n';
  text += '✅ التحقق من الأعضاء الجدد: *' + (settings.verify_enabled ? 'مفعّل' : 'معطّل') + '*\n\n';
  text += '👇 اختر القسم:';

  const rows = [
    [kbBtn('🛡 الحماية الذكية', 'gpx_prot_' + chatId), kbBtn('🔒 أقفال الوسائط', 'gpx_locks_' + chatId)],
    [kbBtn('⚖️ سلّم العقوبات', 'gpx_punish_' + chatId), kbBtn('🚷 الكلمات المحظورة', 'gpx_words_' + chatId)],
    [kbBtn('✅ التحقق من الأعضاء', 'gpx_verifycfg_' + chatId), kbBtn('🎭 الرتب والصلاحيات', 'gpx_roles_' + chatId)],
    [kbBtn('📋 السجلات', 'gpx_logs_' + chatId), kbBtn('📊 الإحصائيات', 'gpx_stats_' + chatId)],
    [kbBtn('🤖 تحليل ذكي (AI)', 'gpx_aisummary_' + chatId)],
    [kbBtn('◀️ رجوع للوحة القروب', 'gp_view_' + chatId)],
  ];
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ══════════════════════════════════════════════════════════
// 🛡 الحماية الذكية
// ══════════════════════════════════════════════════════════
async function showProtection(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  let text = '🛡 *نظام الحماية الذكي*\n━━━━━━━━━━━━━━━━━━\n\n_اضغط على أي ميزة لتفعيلها أو تعطيلها فوراً._';
  const rows = PROT_TOGGLES.map(p => [kbBtn((settings[p.key] ? '✅ ' : '⬜ ') + p.label, 'gpx_tog_' + p.key + '_' + chatId)]);
  rows.push([kbBtn('⚙️ إعدادات متقدمة (العتبات)', 'gpx_protadv_' + chatId)]);
  rows.push([kbBtn('◀️ رجوع', 'gpx_home_' + chatId)]);
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function toggleProtection(ctx, chatId, key) {
  const meta = PROT_TOGGLES.find(p => p.key === key);
  if (!meta) return showProtection(ctx, chatId);

  const settings = await protection.getSettings(chatId);
  const newVal = !settings[key];
  await protection.updateSettings(chatId, { [key]: newVal });

  logsMod.logAction({ telegram: ctx.telegram }, chatId, 'settings', {
    actorId: ctx.from.id, actorName: ctx.from.first_name || '',
    details: (newVal ? '✅ تفعيل ' : '⬜ تعطيل ') + meta.label,
  }).catch(() => {});

  ctx.answerCbQuery(newVal ? '✅ تم التفعيل' : '⬜ تم التعطيل').catch(() => {});
  return showProtection(ctx, chatId);
}

// ══════════════════════════════════════════════════════════
// ⚙️ الإعدادات المتقدمة (العتبات)
// ══════════════════════════════════════════════════════════
async function showAdvanced(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  let text = '⚙️ *إعدادات الحماية المتقدمة*\n━━━━━━━━━━━━━━━━━━\n\n';
  const rows = [];
  for (const f of ADV_FIELDS) {
    text += '• ' + f.label + ': *' + settings[f.key] + '* ' + (f.unit || '') + '\n';
    rows.push([kbBtn('✏️ ' + f.label + ': ' + settings[f.key], 'gpx_setadv_' + f.key + '_' + chatId)]);
  }
  rows.push([kbBtn('◀️ رجوع', 'gpx_prot_' + chatId)]);
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function promptAdv(ctx, chatId, field) {
  const meta = ADV_FIELDS.find(f => f.key === field);
  if (!meta) return showAdvanced(ctx, chatId);
  await setState(ctx.from.id, { type: 'gpx_adv', chatId, field });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply(
    '✏️ أرسل القيمة الجديدة لـ «' + meta.label + '»\n' +
    '📏 المدى المسموح: من *' + meta.min + '* إلى *' + meta.max + '* ' + (meta.unit || ''),
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🔒 أقفال الوسائط
// ══════════════════════════════════════════════════════════
async function showLocks(ctx, chatId) {
  const locks = await protection.getLocksCached(chatId);
  let text = '🔒 *أقفال الوسائط*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += '_عند التفعيل، يُمنع الأعضاء (غير المشرفين) من إرسال هذا النوع نهائياً._\n\n';
  text += '⚠️ الملصقات 🎭 والصور المتحركة 🎞 يتشاركان نفس قفل تيليجرام (قفل أحدهما يقفل الآخر تلقائياً).\n';
  text += '⚠️ الروابط 🔗 وإعادة التوجيه ↪️: تيليجرام لا يوفّر قفلاً مباشراً لهما، فيُحذف المحتوى فوراً بواسطة البوت.';
  const rows = db.LOCK_TYPES.map(t => [kbBtn((locks[t] ? '🔒 ' : '🔓 ') + LOCK_LABELS[t], 'gpx_locktog_' + t + '_' + chatId)]);
  rows.push([kbBtn('🔒 قفل الكل', 'gpx_lockall_' + chatId), kbBtn('🔓 فتح الكل', 'gpx_unlockall_' + chatId)]);
  rows.push([kbBtn('◀️ رجوع', 'gpx_home_' + chatId)]);
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// 🔒🔓 قفل/فتح كل الأنواع دفعة واحدة (يعتمد فقط على الأنواع المدعومة فعلياً حسب Telegram API)
async function toggleAllLocks(ctx, chatId, lockAll) {
  for (const t of db.LOCK_TYPES) {
    await db.setLock(chatId, t, lockAll);
  }
  protection.clearLocksCache(chatId);

  logsMod.logAction({ telegram: ctx.telegram }, chatId, 'lock_change', {
    actorId: ctx.from.id, actorName: ctx.from.first_name || '',
    details: lockAll ? '🔒 قفل الكل' : '🔓 فتح الكل',
  }).catch(() => {});

  const res = await protection.applyLockPermissions(ctx, chatId);
  const toast = res.ok
    ? (lockAll ? '🔒 تم قفل الكل على مستوى تيليجرام' : '🔓 تم فتح الكل على مستوى تيليجرام')
    : (lockAll ? '🔒 تم القفل في البوت — أعط البوت صلاحية "تقييد الأعضاء" للتطبيق الكامل' : '🔓 تم الفتح في البوت — أعط البوت صلاحية "تقييد الأعضاء" للتطبيق الكامل');

  ctx.answerCbQuery(toast, res.ok ? undefined : { show_alert: true }).catch(() => {});
  return showLocks(ctx, chatId);
}

async function toggleLock(ctx, chatId, type) {
  if (!db.LOCK_TYPES.includes(type)) return showLocks(ctx, chatId);
  const locks = await protection.getLocksCached(chatId);
  const newVal = !locks[type];
  await db.setLock(chatId, type, newVal);
  protection.clearLocksCache(chatId);

  logsMod.logAction({ telegram: ctx.telegram }, chatId, 'lock_change', {
    actorId: ctx.from.id, actorName: ctx.from.first_name || '',
    details: (newVal ? '🔒 قفل ' : '🔓 فتح ') + (LOCK_LABELS[type] || type),
  }).catch(() => {});

  let toast = newVal ? '🔒 تم القفل' : '🔓 تم الفتح';
  let alertMode = false;
  if (protection.PERMISSION_LOCK_MAP[type]) {
    const res = await protection.applyLockPermissions(ctx, chatId);
    if (res.ok) {
      toast = newVal ? '🔒 قُفل على مستوى تيليجرام' : '🔓 فُتح على مستوى تيليجرام';
    } else {
      alertMode = true;
      toast = newVal
        ? '🔒 تم تفعيل القفل في البوت (حذف فوري).\nلتطبيق القفل الكامل من تيليجرام: أعط البوت صلاحية "تقييد الأعضاء".'
        : '🔓 تم تعطيل القفل في البوت.\nلتطبيق الفتح على مستوى تيليجرام: أعط البوت صلاحية "تقييد الأعضاء".';
    }
  }

  ctx.answerCbQuery(toast, alertMode ? { show_alert: true } : undefined).catch(() => {});
  return showLocks(ctx, chatId);
}

// ══════════════════════════════════════════════════════════
// ⚖️ سلّم العقوبات الذكي
// ══════════════════════════════════════════════════════════
async function showPunish(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  const ladder = settings.punish_ladder || {};
  let text = '⚖️ *سلّم العقوبات الذكي*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += 'عند تكرار المخالفات لنفس العضو خلال *' + (settings.violation_window_hours || 24) + '* ساعة:\n\n';
  const rows = [];
  for (const lvl of LADDER_LEVELS) {
    const action = ladder[lvl] || 'warn';
    text += '🔢 المخالفة #' + lvl + ' ← *' + protection.actionLabel(action) + '*\n';
    rows.push([kbBtn('#' + lvl + ':  ' + protection.actionLabel(action) + '  (تغيير ↻)', 'gpx_punishcyc_' + lvl + '_' + chatId)]);
  }
  text += '➕ كل مخالفة بعد ذلك ← *' + protection.actionLabel(ladder['5'] || 'ban') + '*';
  rows.push([kbBtn('⏱ نافذة العدّاد: ' + (settings.violation_window_hours || 24) + ' ساعة (تغيير ↻)', 'gpx_punishwin_' + chatId)]);
  rows.push([kbBtn('◀️ رجوع', 'gpx_home_' + chatId)]);
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function cyclePunish(ctx, chatId, level) {
  if (!LADDER_LEVELS.includes(level)) return showPunish(ctx, chatId);
  const settings = await protection.getSettings(chatId);
  const ladder = { ...(settings.punish_ladder || {}) };
  const cur = ladder[level] || 'warn';
  const idx = ACTION_CYCLE.indexOf(cur);
  const next = ACTION_CYCLE[(idx + 1) % ACTION_CYCLE.length];
  ladder[level] = next;
  await protection.updateSettings(chatId, { punish_ladder: ladder });

  logsMod.logAction({ telegram: ctx.telegram }, chatId, 'settings', {
    actorId: ctx.from.id, actorName: ctx.from.first_name || '',
    details: '⚖️ المخالفة #' + level + ' ← ' + protection.actionLabel(next),
  }).catch(() => {});

  ctx.answerCbQuery('✅ ' + protection.actionLabel(next)).catch(() => {});
  return showPunish(ctx, chatId);
}

async function cycleWindow(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  const cur = settings.violation_window_hours || 24;
  const idx = WINDOW_CYCLE.indexOf(cur);
  const next = WINDOW_CYCLE[(idx + 1) % WINDOW_CYCLE.length] || WINDOW_CYCLE[0];
  await protection.updateSettings(chatId, { violation_window_hours: next });
  ctx.answerCbQuery('✅ ' + next + ' ساعة').catch(() => {});
  return showPunish(ctx, chatId);
}

// ══════════════════════════════════════════════════════════
// 🚷 الكلمات المحظورة
// ══════════════════════════════════════════════════════════
async function showWords(ctx, chatId) {
  const words = await db.listWords(chatId);
  let text = '🚷 *الكلمات المحظورة*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += '_عند تفعيل «مكافحة الكلمات المحظورة» من قسم الحماية، تُحذف فوراً كل رسالة تحتوي على إحدى هذه الكلمات._\n\n';
  text += '📊 العدد: *' + words.length + '*\n';
  if (words.length) {
    const shown = words.slice(0, 40).map(w => '`' + w.word + '`').join('، ');
    text += shown + (words.length > 40 ? '\n…' : '');
  } else {
    text += '_لا توجد كلمات محظورة حالياً._';
  }
  const rows = [
    [kbBtn('➕ إضافة كلمة', 'gpx_wordadd_' + chatId), kbBtn('🗑 حذف كلمة', 'gpx_wordrm_' + chatId)],
    [kbBtn('◀️ رجوع', 'gpx_home_' + chatId)],
  ];
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function promptWordAdd(ctx, chatId) {
  await setState(ctx.from.id, { type: 'gpx_word_add', chatId });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply('➕ أرسل الكلمة (أو العبارة القصيرة) المراد حظرها:').catch(() => {});
}

async function promptWordRm(ctx, chatId) {
  await setState(ctx.from.id, { type: 'gpx_word_rm', chatId });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply('🗑 أرسل الكلمة المراد حذفها من القائمة المحظورة:').catch(() => {});
}

// ══════════════════════════════════════════════════════════
// ✅ إعدادات التحقق من الأعضاء الجدد
// ══════════════════════════════════════════════════════════
async function showVerifyConfig(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  let text = '✅ *التحقق من الأعضاء الجدد*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += 'عند انضمام عضو جديد، يُطلب منه الضغط على زر "أنا لست بوت" خلال مهلة معيّنة،\n' +
          'وإلا يتم *طرده تلقائياً*. يساعد على مكافحة الحسابات الوهمية والبوتات.\n\n';
  text += '🔘 الحالة: *' + (settings.verify_enabled ? 'مفعّل ✅' : 'معطّل ⬜') + '*\n';
  text += '⏱ المهلة: *' + (settings.verify_timeout || 5) + (settings.verify_timeout === 1 ? ' دقيقة' : ' دقائق') + '*';

  const rows = [
    [kbBtn(settings.verify_enabled ? '⬜ تعطيل التحقق' : '✅ تفعيل التحقق', 'gpx_verifytog_' + chatId)],
    [kbBtn('⏱ تغيير المهلة (' + (settings.verify_timeout || 5) + ' د) ↻', 'gpx_verifytime_' + chatId)],
    [kbBtn('◀️ رجوع', 'gpx_home_' + chatId)],
  ];
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

async function toggleVerify(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  const newVal = !settings.verify_enabled;
  await protection.updateSettings(chatId, { verify_enabled: newVal });

  logsMod.logAction({ telegram: ctx.telegram }, chatId, 'settings', {
    actorId: ctx.from.id, actorName: ctx.from.first_name || '',
    details: (newVal ? '✅ تفعيل' : '⬜ تعطيل') + ' التحقق من الأعضاء الجدد',
  }).catch(() => {});

  ctx.answerCbQuery('✅ تم التحديث').catch(() => {});
  return showVerifyConfig(ctx, chatId);
}

async function cycleVerifyTimeout(ctx, chatId) {
  const settings = await protection.getSettings(chatId);
  const cur = settings.verify_timeout || 5;
  const idx = VERIFY_TIMEOUTS.indexOf(cur);
  const next = VERIFY_TIMEOUTS[(idx + 1) % VERIFY_TIMEOUTS.length] || VERIFY_TIMEOUTS[0];
  await protection.updateSettings(chatId, { verify_timeout: next });
  ctx.answerCbQuery('✅ ' + next + ' دقيقة').catch(() => {});
  return showVerifyConfig(ctx, chatId);
}

// ══════════════════════════════════════════════════════════
// 📊 إحصائيات الحماية
// ══════════════════════════════════════════════════════════
async function showStats(ctx, chatId) {
  if (ctx.callbackQuery) await ctx.answerCbQuery('').catch(() => {});
  const [stats24, stats7d, top, logCounts] = await Promise.all([
    db.getViolationStats(chatId, 24),
    db.getViolationStats(chatId, 24 * 7),
    db.getTopViolators(chatId, 24 * 7, 5),
    db.getLogTypeCounts(chatId),
  ]);

  let text = '📊 *إحصائيات الحماية*\n━━━━━━━━━━━━━━━━━━\n\n';
  text += '*🕐 آخر 24 ساعة:*\n';
  text += stats24.length ? stats24.map(s => '• ' + protection.violationLabel(s.type) + ': *' + s.cnt + '*').join('\n') : '_لا مخالفات_';
  text += '\n\n*📆 آخر 7 أيام:*\n';
  text += stats7d.length ? stats7d.map(s => '• ' + protection.violationLabel(s.type) + ': *' + s.cnt + '*').join('\n') : '_لا مخالفات_';

  if (top.length) {
    text += '\n\n*👤 الأكثر مخالفة (7 أيام):*\n';
    for (const v of top) {
      let name = 'مستخدم ' + v.user_id;
      try {
        const m = await ctx.telegram.getChatMember(chatId, v.user_id);
        if (m?.user?.first_name) name = m.user.first_name;
      } catch (_) {}
      text += '• ' + name + ': ' + v.cnt + '\n';
    }
  }

  const totalLogs = logCounts.reduce((s, c) => s + c.cnt, 0);
  text += '\n📋 إجمالي السجلات المسجّلة: *' + totalLogs + '*';

  const rows = [[kbBtn('🤖 تحليل ذكي AI', 'gpx_aisummary_' + chatId)], [kbBtn('◀️ رجوع', 'gpx_home_' + chatId)]];
  return eos(ctx, text, { parse_mode: 'Markdown', ...kbBuild(rows) });
}

// ══════════════════════════════════════════════════════════
// 🔁 معالجة النصوص (الإدخال من اللوحة)
// ══════════════════════════════════════════════════════════
async function handleText(ctx, txt, state) {
  const chatId = state.chatId;
  txt = (txt || '').trim();

  if (state.type === 'gpx_word_add') {
    delState(ctx.from.id).catch(() => {});
    if (!txt || txt.length > 50) return ctx.reply('⚠️ كلمة غير صالحة (الحد الأقصى 50 حرفاً).').catch(() => {});
    await db.addWord(chatId, txt, ctx.from.id);
    protection.clearWordsCache(chatId);
    logsMod.logAction({ telegram: ctx.telegram }, chatId, 'word_change', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '', details: '➕ إضافة كلمة محظورة: ' + txt,
    }).catch(() => {});
    await ctx.reply('✅ تمت الإضافة إلى القائمة المحظورة.').catch(() => {});
    return showWords(ctx, chatId);
  }

  if (state.type === 'gpx_word_rm') {
    delState(ctx.from.id).catch(() => {});
    await db.removeWord(chatId, txt.toLowerCase());
    protection.clearWordsCache(chatId);
    logsMod.logAction({ telegram: ctx.telegram }, chatId, 'word_change', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '', details: '🗑 حذف كلمة محظورة: ' + txt,
    }).catch(() => {});
    await ctx.reply('🗑 تم الحذف (إن كانت الكلمة موجودة).').catch(() => {});
    return showWords(ctx, chatId);
  }

  if (state.type === 'gpx_adv') {
    delState(ctx.from.id).catch(() => {});
    const field = state.field;
    const meta = ADV_FIELDS.find(f => f.key === field);
    const num = parseInt(txt);
    if (!meta || isNaN(num) || num < meta.min || num > meta.max) {
      await ctx.reply('⚠️ قيمة غير صالحة. يجب أن تكون رقماً صحيحاً بين *' + (meta?.min ?? 0) + '* و *' + (meta?.max ?? 0) + '*.', { parse_mode: 'Markdown' }).catch(() => {});
      return showAdvanced(ctx, chatId);
    }
    await protection.updateSettings(chatId, { [field]: num });
    logsMod.logAction({ telegram: ctx.telegram }, chatId, 'settings', {
      actorId: ctx.from.id, actorName: ctx.from.first_name || '', details: '⚙️ ' + meta.label + ' = ' + num,
    }).catch(() => {});
    await ctx.reply('✅ تم التحديث: ' + meta.label + ' = ' + num).catch(() => {});
    return showAdvanced(ctx, chatId);
  }

  return false;
}

// ══════════════════════════════════════════════════════════
// 🔁 موجّه الأزرار الرئيسي
// ══════════════════════════════════════════════════════════
async function handleCallback(ctx, data) {
  // زر التحقق من الأعضاء الجدد — متاح لكل عضو (للتحقق من نفسه فقط)
  if (data.startsWith('gpx_verify_')) {
    return require('./group_verify').handleVerifyClick(ctx, data);
  }

  const [rest, chatId] = splitChatId(data);
  if (chatId === null) return false;

  const allowed = await checkAccess(ctx, chatId, rest);
  if (!allowed) {
    return ctx.answerCbQuery('🚫 ليس لديك صلاحية لهذا الإجراء', { show_alert: true }).catch(() => {});
  }

  if (rest.startsWith('gpx_role')) return roles.handleCallback(ctx, data, chatId);
  if (rest.startsWith('gpx_log'))  return logsMod.handleCallback(ctx, data, chatId);

  if (rest === 'gpx_home')    return showHome(ctx, chatId);
  if (rest === 'gpx_prot')    return showProtection(ctx, chatId);
  if (rest === 'gpx_protadv') return showAdvanced(ctx, chatId);
  if (rest.startsWith('gpx_tog_'))     return toggleProtection(ctx, chatId, rest.replace('gpx_tog_', ''));
  if (rest.startsWith('gpx_setadv_'))  return promptAdv(ctx, chatId, rest.replace('gpx_setadv_', ''));

  if (rest === 'gpx_locks') return showLocks(ctx, chatId);
  if (rest.startsWith('gpx_locktog_')) return toggleLock(ctx, chatId, rest.replace('gpx_locktog_', ''));
  if (rest === 'gpx_lockall')   return toggleAllLocks(ctx, chatId, true);
  if (rest === 'gpx_unlockall') return toggleAllLocks(ctx, chatId, false);

  if (rest === 'gpx_punish') return showPunish(ctx, chatId);
  if (rest.startsWith('gpx_punishcyc_')) return cyclePunish(ctx, chatId, rest.replace('gpx_punishcyc_', ''));
  if (rest === 'gpx_punishwin') return cycleWindow(ctx, chatId);

  if (rest === 'gpx_words')   return showWords(ctx, chatId);
  if (rest === 'gpx_wordadd') return promptWordAdd(ctx, chatId);
  if (rest === 'gpx_wordrm')  return promptWordRm(ctx, chatId);

  if (rest === 'gpx_verifycfg')  return showVerifyConfig(ctx, chatId);
  if (rest === 'gpx_verifytog')  return toggleVerify(ctx, chatId);
  if (rest === 'gpx_verifytime') return cycleVerifyTimeout(ctx, chatId);

  if (rest === 'gpx_stats')     return showStats(ctx, chatId);
  if (rest === 'gpx_aisummary') return require('./group_ai_admin').showSummary(ctx, chatId);

  if (rest.startsWith('gpx_resetviol_')) return require('./group_commands_pro').handleResetViolationCallback(ctx, data);

  return false;
}

module.exports = {
  PROT_TOGGLES, ADV_FIELDS, LOCK_LABELS,
  showHome, showProtection, showAdvanced, showLocks, showPunish,
  showWords, showVerifyConfig, showStats,
  handleCallback, handleText,
  splitChatId,
};
