'use strict';
// ══════════════════════════════════════════════════════════
// 📄 ملف PDF عام لأمر "اوامر" — يُعيَّن من الخاص من طرف المالك فقط
// ويشتغل على كل القروبات دفعة واحدة
// ══════════════════════════════════════════════════════════
const { run: dbRun, get: dbGet } = require('../database/db');

let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS global_help_file(
      id INTEGER PRIMARY KEY DEFAULT 1,
      file_id TEXT,
      set_by BIGINT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  } catch (e) { /* موجود أصلاً غالباً */ }
  _tableReady = true;
}

async function getGlobalHelpFileId() {
  await ensureTable();
  const row = await dbGet('SELECT file_id FROM global_help_file WHERE id=1', []).catch(() => null);
  return row?.file_id || null;
}

function isOwner(ctx) {
  return Number(ctx.from?.id) === Number(process.env.OWNER_ID);
}

async function setHandler(ctx) {
  if (ctx.chat?.type !== 'private') return; // ✅ من الخاص فقط
  if (!isOwner(ctx)) return ctx.reply('🚫 هذا الأمر للمالك فقط.').catch(() => {});
  const doc = ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply('⚠️ رُد على ملف (PDF أو أي مستند) بهذا الأمر: تعيين الاوامر').catch(() => {});
  await ensureTable();
  await dbRun(
    `INSERT INTO global_help_file(id, file_id, set_by, updated_at) VALUES(1,$1,$2,NOW())
     ON CONFLICT(id) DO UPDATE SET file_id=$1, set_by=$2, updated_at=NOW()`,
    [doc.file_id, ctx.from.id]
  ).catch(() => {});
  ctx.reply('✅ تم تعيين هذا الملف كملف "اوامر" العام — كل عضو بأي قروب يكتب "اوامر" رح يوصله من الآن.').catch(() => {});
}

async function clearHandler(ctx) {
  if (ctx.chat?.type !== 'private') return;
  if (!isOwner(ctx)) return ctx.reply('🚫 هذا الأمر للمالك فقط.').catch(() => {});
  await ensureTable();
  await dbRun('DELETE FROM global_help_file WHERE id=1', []).catch(() => {});
  ctx.reply('🗑 تم حذف الملف العام — رجعت لوحة الأزرار الافتراضية بكل القروبات.').catch(() => {});
}

function setupHelpPdfCommands(bot) {
  bot.hears(/^تعيين (ملف )?الاوامر$/i, setHandler);
  bot.hears(/^حذف (ملف )?الاوامر$/i, clearHandler);
}

module.exports = { setupHelpPdfCommands, getGlobalHelpFileId };
