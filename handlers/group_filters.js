'use strict';
/**
 * 🎯 handlers/group_filters.js — نظام الفلاتر الذكي
 * ──────────────────────────────────────────────────────────────
 * مثل Rose/Combot: المشرف يعرّف نمط نص → البوت يرد تلقائياً
 * بنص/صورة/ملف/ستيكر + إجراء اختياري (تحذير/كتم/حذف...)
 *
 * الأوامر:
 *   /filter [trigger] [رد]   — إضافة فلتر (أو رد على ملف/صورة)
 *   /filters                  — عرض كل الفلاتر
 *   /delfilter [trigger]      — حذف فلتر
 *   /clearfilters             — حذف كل الفلاتر
 *
 * بالعربية:
 *   فلتر / الفلاتر / احذف فلتر
 */

const { run, get, all } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

const FILTERS_TTL = 120000; // 2 دقيقة

const FILTER_ACTIONS = {
  none:   '—',
  warn:   '⚠️ تحذير',
  mute:   '🔇 كتم 10د',
  delete: '🗑 حذف',
  kick:   '🦵 طرد',
  ban:    '🚫 حظر',
};

// ══════════════════════════════════════════════════════════
// 🗄️ Migration
// ══════════════════════════════════════════════════════════
async function migrateFilters() {
  await run(`CREATE TABLE IF NOT EXISTS group_filters (
    id          SERIAL PRIMARY KEY,
    chat_id     BIGINT NOT NULL,
    trigger     TEXT NOT NULL,
    response    TEXT,
    file_id     TEXT,
    file_type   TEXT,
    action      TEXT DEFAULT 'none',
    buttons     TEXT,
    created_by  BIGINT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(chat_id, trigger)
  )`).catch(e => logger.debug('[filters migrate]', e.message));
  await run('CREATE INDEX IF NOT EXISTS idx_grp_filters ON group_filters(chat_id)').catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🔍 جلب فلاتر القروب (مع كاش)
// ══════════════════════════════════════════════════════════
async function getFilters(chatId) {
  const ck = 'gf_' + chatId;
  let f = cacheGet(ck);
  if (f) return f;
  f = await all('SELECT * FROM group_filters WHERE chat_id=$1 ORDER BY trigger', [chatId]).catch(() => []);
  cacheSet(ck, f, FILTERS_TTL);
  return f;
}
function clearFiltersCache(chatId) { cacheClear('gf_' + chatId); }

// ══════════════════════════════════════════════════════════
// ⚙️ إضافة فلتر
// ══════════════════════════════════════════════════════════
async function addFilter(chatId, trigger, data) {
  const { response, fileId, fileType, action, buttons, createdBy } = data;
  await run(
    `INSERT INTO group_filters(chat_id,trigger,response,file_id,file_type,action,buttons,created_by,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT(chat_id,trigger) DO UPDATE SET
       response=$3,file_id=$4,file_type=$5,action=$6,buttons=$7,created_by=$8,created_at=NOW()`,
    [chatId, trigger.toLowerCase(), response||null, fileId||null, fileType||null,
     action||'none', buttons ? JSON.stringify(buttons) : null, createdBy||null]
  );
  clearFiltersCache(chatId);
}

async function deleteFilter(chatId, trigger) {
  await run('DELETE FROM group_filters WHERE chat_id=$1 AND trigger=$2', [chatId, trigger.toLowerCase()]);
  clearFiltersCache(chatId);
}

async function clearAllFilters(chatId) {
  await run('DELETE FROM group_filters WHERE chat_id=$1', [chatId]);
  clearFiltersCache(chatId);
}

// ══════════════════════════════════════════════════════════
// 🚀 فحص رسالة ضد الفلاتر (يُستدعى من middleware)
// ══════════════════════════════════════════════════════════
async function checkFilters(ctx) {
  if (!ctx.message || !ctx.from || ctx.from.is_bot) return false;
  const chat = ctx.chat;
  if (!['group', 'supergroup'].includes(chat?.type)) return false;
  if (ctx.isAdmin || ctx.isOwner) return false;

  const txt = (ctx.message.text || ctx.message.caption || '').toLowerCase().trim();
  if (!txt) return false;

  const filters = await getFilters(chat.id);
  if (!filters.length) return false;

  // مطابقة نمط (كلمة أو عبارة كاملة داخل الرسالة)
  const matched = filters.find(f => {
    const t = f.trigger.toLowerCase();
    // exact word match (not just substring)
    return new RegExp('(?:^|\\s|[.,!?؟،])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|\\s|[.,!?؟،])').test(' ' + txt + ' ')
      || txt === t;
  });
  if (!matched) return false;

  // إجراء (قبل الرد)
  if (matched.action && matched.action !== 'none') {
    await executeFilterAction(ctx, chat.id, ctx.from.id, matched.action, matched.trigger);
  }

  // إرسال الرد
  await sendFilterResponse(ctx, chat.id, matched);
  return true;
}

async function executeFilterAction(ctx, chatId, uid, action, trigger) {
  try {
    if (action === 'delete') {
      await ctx.deleteMessage().catch(() => {});
    } else if (action === 'warn') {
      const { warnMember } = require('./group_admin');
      await warnMember(ctx, chatId, uid, 'فلتر: ' + trigger);
    } else if (action === 'mute') {
      const { muteMember } = require('./group_admin');
      await muteMember(ctx, chatId, uid, 10);
    } else if (action === 'kick') {
      await ctx.telegram.banChatMember(chatId, uid).catch(() => {});
      await ctx.telegram.unbanChatMember(chatId, uid).catch(() => {});
    } else if (action === 'ban') {
      await ctx.telegram.banChatMember(chatId, uid).catch(() => {});
    }
  } catch(e) { logger.debug('[filter action]', e.message); }
}

async function sendFilterResponse(ctx, chatId, filter) {
  try {
    const buttons = filter.buttons ? JSON.parse(filter.buttons) : null;
    const kb = buttons ? { inline_keyboard: buttons } : undefined;
    const opts = { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id, reply_markup: kb };

    if (filter.file_id && filter.file_type) {
      const caption = filter.response || '';
      const captOpts = { ...opts, caption };
      if (filter.file_type === 'photo')    await ctx.replyWithPhoto(filter.file_id, captOpts).catch(() => {});
      else if (filter.file_type === 'video')   await ctx.replyWithVideo(filter.file_id, captOpts).catch(() => {});
      else if (filter.file_type === 'document') await ctx.replyWithDocument(filter.file_id, captOpts).catch(() => {});
      else if (filter.file_type === 'sticker') await ctx.replyWithSticker(filter.file_id).catch(() => {});
      else if (filter.file_type === 'audio')   await ctx.replyWithAudio(filter.file_id, captOpts).catch(() => {});
      else if (filter.file_type === 'voice')   await ctx.replyWithVoice(filter.file_id, captOpts).catch(() => {});
    } else if (filter.response) {
      await ctx.reply(filter.response, { ...opts, disable_web_page_preview: true }).catch(() => {});
    }
  } catch(e) { logger.debug('[filter send]', e.message); }
}

// ══════════════════════════════════════════════════════════
// 📟 Parse /filter command
// trigger = first word/phrase in quotes, rest = response
// /filter trigger text   or   /filter "multi word" text
// reply to media to attach it
// ══════════════════════════════════════════════════════════
function parseTriggerAndResponse(text) {
  // إزالة الأمر (/filter أو /فلتر)
  let rest = text.replace(/^\/\S+\s*/, '').trim();
  if (!rest) return null;

  let trigger, response;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) return null;
    trigger  = rest.slice(1, end).trim().toLowerCase();
    response = rest.slice(end + 1).trim();
  } else {
    const parts = rest.split(/\s+/);
    trigger  = parts[0].toLowerCase();
    response = parts.slice(1).join(' ').trim();
  }
  return trigger ? { trigger, response: response || null } : null;
}

function detectMediaFromReply(replyMsg) {
  if (!replyMsg) return null;
  if (replyMsg.photo)    return { fileId: replyMsg.photo.slice(-1)[0].file_id, fileType: 'photo' };
  if (replyMsg.video)    return { fileId: replyMsg.video.file_id,    fileType: 'video' };
  if (replyMsg.document) return { fileId: replyMsg.document.file_id, fileType: 'document' };
  if (replyMsg.sticker)  return { fileId: replyMsg.sticker.file_id,  fileType: 'sticker' };
  if (replyMsg.audio)    return { fileId: replyMsg.audio.file_id,    fileType: 'audio' };
  if (replyMsg.voice)    return { fileId: replyMsg.voice.file_id,    fileType: 'voice' };
  return null;
}

// ══════════════════════════════════════════════════════════
// 🎛 تعيين إجراء الفلتر (action picker)
// ══════════════════════════════════════════════════════════
function buildActionPicker(chatId, trigger) {
  const rows = Object.entries(FILTER_ACTIONS).map(([key, label]) => [{
    text: label,
    callback_data: 'gf_setaction_' + key + '_' + chatId + '_' + Buffer.from(trigger).toString('base64').slice(0, 20),
  }]);
  return rows;
}

// ══════════════════════════════════════════════════════════
// 📋 عرض قائمة الفلاتر
// ══════════════════════════════════════════════════════════
async function showFilters(ctx, chatId) {
  const filters = await getFilters(chatId);
  if (!filters.length) {
    return ctx.reply('📭 *لا توجد فلاتر بعد*\n\nاستخدم:\n`/filter trigger رد`\nلإضافة فلتر تلقائي.', { parse_mode: 'Markdown' }).catch(() => {});
  }
  let text = '🎯 *فلاتر القروب* (' + filters.length + ')\n━━━━━━━━━━━━━━━━\n\n';
  filters.forEach((f, i) => {
    text += (i + 1) + '. `' + f.trigger + '`';
    if (f.action && f.action !== 'none') text += ' — ' + (FILTER_ACTIONS[f.action] || f.action);
    if (f.file_type) text += ' 📎';
    text += '\n';
  });
  text += '\n`/delfilter trigger` — لحذف فلتر\n`/clearfilters` — حذف الكل';
  return ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// ⌨️ تسجيل الأوامر
// ══════════════════════════════════════════════════════════
function setupFilters(bot) {
  migrateFilters().catch(() => {});

  // /filter trigger response
  bot.command(['filter', 'فلتر', 'addfilter'], async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    const isAdm = ctx.isOwner || ctx.isAdmin || await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
      .then(m => ['administrator','creator'].includes(m.status)).catch(() => false);
    if (!isAdm) return;
    setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000);

    const parsed = parseTriggerAndResponse(ctx.message.text || '');
    if (!parsed) {
      return ctx.reply(
        '📖 *كيفية إضافة فلتر:*\n\n`/filter trigger رد نصي`\n\nأو رد على صورة/ملف:\n`/filter trigger`\n\n💡 لفلتر متعدد الكلمات:\n`/filter "مرحبا يا" أهلاً!`',
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    const { trigger, response } = parsed;
    const replyMsg = ctx.message.reply_to_message;
    const media = detectMediaFromReply(replyMsg);
    const captionFromReply = replyMsg ? (replyMsg.caption || replyMsg.text || '') : '';

    const finalResponse = response || captionFromReply || null;

    if (!finalResponse && !media) {
      return ctx.reply('⚠️ يجب إضافة رد نصي أو الرد على ملف/صورة.').catch(() => {});
    }

    // عرض picker للإجراء
    const kb = buildActionPicker(ctx.chat.id, trigger);
    kb.push([{ text: '⏭ بدون إجراء', callback_data: 'gf_setaction_none_' + ctx.chat.id + '_' + Buffer.from(trigger).toString('base64').slice(0, 20) }]);

    // حفظ مؤقت للبيانات
    require('../utils/cache').cacheSet(
      'gfpend_' + ctx.chat.id + '_' + trigger,
      { response: finalResponse, media, createdBy: ctx.from.id },
      300000
    );

    return ctx.reply(
      '🎯 *فلتر جديد:* `' + trigger + '`\n\nاختر الإجراء عند التفعيل:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
    ).catch(() => {});
  });

  // /delfilter trigger
  bot.command(['delfilter', 'delfilter', 'rmfilter'], async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    const isAdm = ctx.isOwner || ctx.isAdmin || await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
      .then(m => ['administrator','creator'].includes(m.status)).catch(() => false);
    if (!isAdm) return;
    setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000);
    const trigger = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim().toLowerCase();
    if (!trigger) return ctx.reply('⚠️ `/delfilter trigger`', { parse_mode: 'Markdown' }).catch(() => {});
    await deleteFilter(ctx.chat.id, trigger);
    const m = await ctx.reply('🗑 تم حذف فلتر: `' + trigger + '`', { parse_mode: 'Markdown' }).catch(() => null);
    if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
  });

  // Arabic: احذف فلتر [trigger]
  bot.hears(/^احذف فلتر (.+)$/, async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    const isAdm = ctx.isOwner || ctx.isAdmin || await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
      .then(m => ['administrator','creator'].includes(m.status)).catch(() => false);
    if (!isAdm) return;
    const trigger = (ctx.match[1] || '').trim().toLowerCase();
    if (!trigger) return;
    await deleteFilter(ctx.chat.id, trigger);
    setTimeout(() => ctx.deleteMessage().catch(() => {}), 500);
    const m = await ctx.reply('🗑 تم حذف فلتر: `' + trigger + '`', { parse_mode: 'Markdown' }).catch(() => null);
    if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
  });

  // /clearfilters
  bot.command(['clearfilters', 'clearallfilters'], async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    if (!ctx.isOwner && !ctx.isAdmin) return;
    await clearAllFilters(ctx.chat.id);
    setTimeout(() => ctx.deleteMessage().catch(() => {}), 500);
    const m = await ctx.reply('🗑 تم حذف كل الفلاتر.').catch(() => null);
    if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
  });
  bot.hears(/^(مسح_الفلاتر|احذف كل الفلاتر)$/, async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    if (!ctx.isOwner && !ctx.isAdmin) return;
    await clearAllFilters(ctx.chat.id);
    const m = await ctx.reply('🗑 تم حذف كل الفلاتر.').catch(() => null);
    if (m) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
  });

  // /filters — عرض القائمة
  bot.command(['filters', 'الفلاتر', 'listfilters'], async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    setTimeout(() => ctx.deleteMessage().catch(() => {}), 1000);
    return showFilters(ctx, ctx.chat.id);
  });
  bot.hears('الفلاتر', async ctx => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) return;
    return showFilters(ctx, ctx.chat.id);
  });
}

// ══════════════════════════════════════════════════════════
// 🔁 معالج Callback: تعيين إجراء الفلتر
// ══════════════════════════════════════════════════════════
async function handleFilterCallback(ctx, data) {
  if (!data.startsWith('gf_setaction_')) return false;
  const rest    = data.replace('gf_setaction_', '');
  const parts   = rest.split('_');
  const action  = parts[0];
  const chatId  = parseInt(parts[1]);
  const triggerB64 = parts[2];
  let trigger;
  try { trigger = Buffer.from(triggerB64, 'base64').toString('utf8').slice(0, 50); } catch(_) { return false; }

  const pending = require('../utils/cache').cacheGet('gfpend_' + chatId + '_' + trigger);
  if (!pending) {
    return ctx.answerCbQuery('⏰ انتهت المهلة، أعد الأمر /filter', { show_alert: true }).catch(() => {});
  }

  const { response, media, createdBy } = pending;
  await addFilter(chatId, trigger, {
    response,
    fileId:    media?.fileId || null,
    fileType:  media?.fileType || null,
    action,
    createdBy,
  });

  require('../utils/cache').cacheClear('gfpend_' + chatId + '_' + trigger);
  await ctx.answerCbQuery('✅ تم حفظ الفلتر').catch(() => {});
  return ctx.editMessageText(
    '✅ *تم إضافة الفلتر*\n\n🎯 النمط: `' + trigger + '`\n⚡ الإجراء: ' + (FILTER_ACTIONS[action] || action) +
    (response ? '\n💬 الرد: ' + response.substring(0, 60) : '') +
    (media ? '\n📎 ملف: ' + media.fileType : ''),
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

module.exports = {
  setupFilters, checkFilters, handleFilterCallback,
  getFilters, addFilter, deleteFilter, clearAllFilters,
  migrateFilters, FILTER_ACTIONS,
};
