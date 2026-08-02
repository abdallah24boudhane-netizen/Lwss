'use strict';
// ══════════════════════════════════════════════════════════
// 📄 ملف PDF مخصص لأمر "اوامر" — الأدمن يرفع ملفه الخاص بدل لوحة الأزرار
// ملف مستقل تماماً
// ══════════════════════════════════════════════════════════
const { run: dbRun, get: dbGet } = require('../database/db');

function isGroup(ctx) { return ['group', 'supergroup'].includes(ctx.chat?.type); }

async function isTgAdminOrOwner(ctx) {
  const uid = ctx.from?.id;
  if (Number(uid) === Number(process.env.OWNER_ID)) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
    return ['administrator', 'creator'].includes(m?.status);
  } catch (e) { return false; }
}

let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS group_help_files(
      chat_id BIGINT PRIMARY KEY,
      file_id TEXT NOT NULL,
      set_by BIGINT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  } catch (e) { /* موجود أصلاً غالباً */ }
  _tableReady = true;
}

async function getHelpFileId(chatId) {
  await ensureTable();
  const row = await dbGet('SELECT file_id FROM group_help_files WHERE chat_id=$1', [chatId]).catch(() => null);
  return row?.file_id || null;
}

async function setHandler(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return ctx.reply('🚫 للمشرفين فقط.').catch(() => {});
  const doc = ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply('⚠️ رُد على ملف (PDF أو أي مستند) بهذا الأمر: تعيين ملف الاوامر').catch(() => {});
  await ensureTable();
  await dbRun(
    `INSERT INTO group_help_files(chat_id, file_id, set_by, updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(chat_id) DO UPDATE SET file_id=$2, set_by=$3, updated_at=NOW()`,
    [ctx.chat.id, doc.file_id, ctx.from.id]
  ).catch(() => {});
  ctx.reply('✅ تم تعيين هذا الملف — كل من يكتب "اوامر" رح يوصله مباشرة من الآن.').catch(() => {});
}

async function clearHandler(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isTgAdminOrOwner(ctx))) return ctx.reply('🚫 للمشرفين فقط.').catch(() => {});
  await ensureTable();
  await dbRun('DELETE FROM group_help_files WHERE chat_id=$1', [ctx.chat.id]).catch(() => {});
  ctx.reply('🗑 تم حذف الملف المخصص — رجعت لوحة الأزرار الافتراضية عند كتابة "اوامر".').catch(() => {});
}

function setupHelpPdfCommands(bot) {
  bot.hears(/^تعيين (ملف )?الاوامر$/i, setHandler);
  bot.hears(/^حذف (ملف )?الاوامر$/i, clearHandler);
}

module.exports = { setupHelpPdfCommands, getHelpFileId };
