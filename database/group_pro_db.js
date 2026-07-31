'use strict';
/**
 * 🗄️ database/group_pro_db.js
 * ──────────────────────────────────────────────────────────────
 * قاعدة بيانات نظام الإدارة الاحترافي للقروبات:
 *   - الحماية الذكية   (group_protection)
 *   - سجل المخالفات     (group_violations)
 *   - السجلات الإدارية  (group_logs)
 *   - الرتب المخصصة    (group_roles)
 *   - التحقق من الأعضاء (group_verify)
 *   - الكلمات المحظورة  (يعاد استخدام blacklist_words الموجود)
 *   - أقفال الوسائط     (يعاد استخدام group_locks الموجود)
 *
 * كل الدوال هنا "إضافية" — لا تعدّل أي جدول قديم بشكل غير متوافق.
 */

const { run, all, get } = require('./db');
const logger = require('../utils/logger');

// ══════════════════════════════════════════════════════════
// ⚙️ الإعدادات الافتراضية لنظام الحماية
// ══════════════════════════════════════════════════════════
const DEFAULT_SETTINGS = Object.freeze({
  // ── الحماية الأساسية ──
  anti_spam:       false,
  anti_link:       false,
  anti_flood:      false,
  anti_forward:    false,
  anti_mention:    false,
  anti_bot:        false,
  anti_edit:       false,
  anti_words:      false,
  anti_caps:       false,
  anti_duplicate:  false,
  anti_raid:       false,

  // ── حماية متقدمة (جديد) ──
  anti_short_link: false,  // روابط مختصرة (bit.ly/tinyurl/etc)
  anti_invite:     false,  // روابط دعوة تيليجرام (t.me/+...)
  anti_media:      false,  // الصور والفيديوهات
  anti_file:       false,  // الملفات والمستندات

  // ── عتبات (Thresholds) ──
  flood_limit:     5,    // عدد الرسائل
  flood_window:    5,    // ثواني
  mention_limit:   4,    // منشن في رسالة واحدة
  caps_percent:    70,   // % حروف كبيرة لتفعيل anti_caps
  caps_min_len:    15,   // أقل طول رسالة يتم فيه فحص الكابس
  max_msg_len:     0,    // 0 = بلا حدود — مكافحة الرسائل الطويلة
  dup_window_sec:  60,   // نافذة التكرار لنفس العضو

  // ── روابط مسموحة (دومينات) ──
  link_whitelist:  [],

  // ── التحقق من الأعضاء الجدد ──
  verify_enabled:  false,
  verify_timeout:  5,    // دقائق

  // ── سلّم العقوبات الذكي: عدد المخالفات → الإجراء ──
  // الإجراءات الممكنة: warn | mute_<دقائق> | kick | ban | none
  punish_ladder: { '1': 'warn', '2': 'warn', '3': 'mute_60', '4': 'mute_1440', '5': 'ban' },
  violation_window_hours: 24, // نافذة تصفير عدّاد المخالفات

  // ── السجلات ──
  log_enabled: true,
});

// ══════════════════════════════════════════════════════════
// 🏗️ Migration
// ══════════════════════════════════════════════════════════
async function migrate() {
  const queries = [
    // إعدادات الحماية لكل قروب
    `CREATE TABLE IF NOT EXISTS group_protection (
       chat_id    BIGINT PRIMARY KEY,
       settings   TEXT NOT NULL DEFAULT '{}',
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,

    // سجل المخالفات (لكل مخالفة سجل مستقل)
    `CREATE TABLE IF NOT EXISTS group_violations (
       id         SERIAL PRIMARY KEY,
       chat_id    BIGINT NOT NULL,
       user_id    BIGINT NOT NULL,
       type       TEXT NOT NULL,
       action     TEXT DEFAULT '',
       reason     TEXT DEFAULT '',
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_grp_viol_user ON group_violations(chat_id, user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_grp_viol_type ON group_violations(chat_id, type)`,

    // السجلات الإدارية العامة (Logs)
    `CREATE TABLE IF NOT EXISTS group_logs (
       id          SERIAL PRIMARY KEY,
       chat_id     BIGINT NOT NULL,
       log_type    TEXT NOT NULL,
       actor_id    BIGINT,
       actor_name  TEXT DEFAULT '',
       target_id   BIGINT,
       target_name TEXT DEFAULT '',
       details     TEXT DEFAULT '',
       created_at  TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_grp_logs_chat ON group_logs(chat_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_grp_logs_type ON group_logs(chat_id, log_type, created_at DESC)`,

    // الرتب المخصصة لكل قروب
    `CREATE TABLE IF NOT EXISTS group_roles (
       id         SERIAL PRIMARY KEY,
       chat_id    BIGINT NOT NULL,
       user_id    BIGINT NOT NULL,
       role_key   TEXT NOT NULL,
       granted_by BIGINT,
       granted_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(chat_id, user_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_grp_roles_chat ON group_roles(chat_id)`,

    // التحقق من الأعضاء الجدد (Captcha)
    `CREATE TABLE IF NOT EXISTS group_verify (
       chat_id      BIGINT NOT NULL,
       user_id      BIGINT NOT NULL,
       first_name   TEXT DEFAULT '',
       status       TEXT DEFAULT 'pending',
       join_msg_id  BIGINT,
       deadline     TIMESTAMPTZ,
       created_at   TIMESTAMPTZ DEFAULT NOW(),
       PRIMARY KEY (chat_id, user_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_grp_verify_status ON group_verify(status, deadline)`,

    // الجداول القديمة — تأكيد وجودها (idempotent، قد تكون موجودة أصلاً)
    `CREATE TABLE IF NOT EXISTS blacklist_words(
       id SERIAL PRIMARY KEY, chat_id BIGINT, word TEXT,
       action TEXT DEFAULT 'delete', added_by BIGINT,
       UNIQUE(chat_id, word)
     )`,
    `CREATE TABLE IF NOT EXISTS group_locks(
       chat_id BIGINT PRIMARY KEY,
       lock_sticker SMALLINT DEFAULT 0, lock_gif SMALLINT DEFAULT 0,
       lock_link SMALLINT DEFAULT 0, lock_forward SMALLINT DEFAULT 0,
       lock_photo SMALLINT DEFAULT 0, lock_video SMALLINT DEFAULT 0,
       lock_voice SMALLINT DEFAULT 0, lock_poll SMALLINT DEFAULT 0
     )`,
    `ALTER TABLE group_locks ADD COLUMN IF NOT EXISTS lock_file SMALLINT DEFAULT 0`,
    `ALTER TABLE group_locks ADD COLUMN IF NOT EXISTS lock_chat SMALLINT DEFAULT 0`,
    `ALTER TABLE group_locks ADD COLUMN IF NOT EXISTS lock_invite SMALLINT DEFAULT 0`,
    `ALTER TABLE group_locks ADD COLUMN IF NOT EXISTS lock_pin SMALLINT DEFAULT 0`,
    `ALTER TABLE group_locks ADD COLUMN IF NOT EXISTS lock_info SMALLINT DEFAULT 0`,
  ];

  for (const q of queries) {
    await run(q, []).catch(e => {
      if (!/already exists|duplicate/i.test(e.message || '')) {
        logger.error('[GroupProDB Migration] ' + e.message);
      }
    });
  }

  // ترحيل تلقائي (مرة واحدة): استيراد anti_spam/anti_link/anti_flood
  // القديمة من group_chats إلى نظام الحماية الجديد — بدون أي فقدان للإعدادات
  try {
    const oldRows = await all(
      `SELECT gc.chat_id, gc.anti_spam, gc.anti_link, gc.anti_flood
         FROM group_chats gc
         LEFT JOIN group_protection gp ON gp.chat_id = gc.chat_id
        WHERE gp.chat_id IS NULL
          AND (gc.anti_spam=1 OR gc.anti_link=1 OR gc.anti_flood=1)`
    ).catch(() => []);
    for (const r of oldRows) {
      const seeded = {
        ...DEFAULT_SETTINGS,
        anti_spam:  !!r.anti_spam,
        anti_link:  !!r.anti_link,
        anti_flood: !!r.anti_flood,
      };
      await run(
        `INSERT INTO group_protection(chat_id, settings, updated_at) VALUES($1,$2,NOW())
         ON CONFLICT(chat_id) DO NOTHING`,
        [r.chat_id, JSON.stringify(seeded)]
      ).catch(() => {});
    }
    if (oldRows.length) logger.info('[GroupProDB] ✅ تم ترحيل إعدادات الحماية القديمة لـ ' + oldRows.length + ' قروب');
  } catch (_) {}

  logger.info('✅ [GroupProDB] Migration complete');
}

// ══════════════════════════════════════════════════════════
// ⚙️ إعدادات الحماية (settings JSON)
// ══════════════════════════════════════════════════════════
async function getRawSettings(chatId) {
  const row = await get('SELECT settings FROM group_protection WHERE chat_id=$1', [chatId]).catch(() => null);
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.settings || '{}');
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(chatId, settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await run(
    `INSERT INTO group_protection(chat_id, settings, updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(chat_id) DO UPDATE SET settings=$2, updated_at=NOW()`,
    [chatId, JSON.stringify(merged)]
  );
  return merged;
}

async function updateSettings(chatId, patch) {
  const cur = await getRawSettings(chatId);
  const merged = { ...cur, ...patch };
  await saveSettings(chatId, merged);
  return merged;
}

// ══════════════════════════════════════════════════════════
// ⚠️ المخالفات (Violations)
// ══════════════════════════════════════════════════════════
async function addViolation(chatId, userId, type, action, reason) {
  return run(
    `INSERT INTO group_violations(chat_id,user_id,type,action,reason,created_at)
     VALUES($1,$2,$3,$4,$5,NOW())`,
    [chatId, userId, type, action || '', reason || '']
  ).catch(e => logger.error('[GroupProDB addViolation] ' + e.message));
}

async function getViolationCount(chatId, userId, hours) {
  const r = await get(
    `SELECT COUNT(*)::int AS cnt FROM group_violations
      WHERE chat_id=$1 AND user_id=$2 AND created_at > NOW() - ($3 * INTERVAL '1 hour')`,
    [chatId, userId, hours || 24]
  ).catch(() => ({ cnt: 0 }));
  return parseInt(r?.cnt || 0);
}

async function resetViolations(chatId, userId) {
  return run('DELETE FROM group_violations WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
}

async function getViolationHistory(chatId, userId, limit) {
  return all(
    `SELECT type, action, reason, created_at FROM group_violations
      WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3`,
    [chatId, userId, limit || 10]
  ).catch(() => []);
}

async function getTopViolators(chatId, hours, limit) {
  return all(
    `SELECT user_id, COUNT(*)::int AS cnt FROM group_violations
      WHERE chat_id=$1 AND created_at > NOW() - ($2 * INTERVAL '1 hour')
      GROUP BY user_id ORDER BY cnt DESC LIMIT $3`,
    [chatId, hours || 24 * 7, limit || 10]
  ).catch(() => []);
}

async function getViolationStats(chatId, hours) {
  return all(
    `SELECT type, COUNT(*)::int AS cnt FROM group_violations
      WHERE chat_id=$1 AND created_at > NOW() - ($2 * INTERVAL '1 hour')
      GROUP BY type ORDER BY cnt DESC`,
    [chatId, hours || 24 * 7]
  ).catch(() => []);
}

// ══════════════════════════════════════════════════════════
// 📋 السجلات الإدارية (Logs)
// ══════════════════════════════════════════════════════════
async function addLog(chatId, logType, actorId, actorName, targetId, targetName, details) {
  return run(
    `INSERT INTO group_logs(chat_id,log_type,actor_id,actor_name,target_id,target_name,details,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [chatId, logType, actorId || null, actorName || '', targetId || null, targetName || '', details || '']
  ).catch(e => logger.error('[GroupProDB addLog] ' + e.message));
}

async function getLogs(chatId, logType, limit, offset) {
  if (logType && logType !== 'all') {
    return all(
      `SELECT * FROM group_logs WHERE chat_id=$1 AND log_type=$2
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [chatId, logType, limit || 10, offset || 0]
    ).catch(() => []);
  }
  return all(
    `SELECT * FROM group_logs WHERE chat_id=$1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [chatId, limit || 10, offset || 0]
  ).catch(() => []);
}

async function countLogs(chatId, logType) {
  if (logType && logType !== 'all') {
    const r = await get('SELECT COUNT(*)::int AS cnt FROM group_logs WHERE chat_id=$1 AND log_type=$2', [chatId, logType]).catch(() => ({ cnt: 0 }));
    return parseInt(r?.cnt || 0);
  }
  const r = await get('SELECT COUNT(*)::int AS cnt FROM group_logs WHERE chat_id=$1', [chatId]).catch(() => ({ cnt: 0 }));
  return parseInt(r?.cnt || 0);
}

async function getLogTypeCounts(chatId) {
  return all(
    `SELECT log_type, COUNT(*)::int AS cnt FROM group_logs WHERE chat_id=$1 GROUP BY log_type`,
    [chatId]
  ).catch(() => []);
}

// ══════════════════════════════════════════════════════════
// 🎭 الرتب المخصصة (Roles)
// ══════════════════════════════════════════════════════════
async function setRole(chatId, userId, roleKey, grantedBy) {
  return run(
    `INSERT INTO group_roles(chat_id,user_id,role_key,granted_by,granted_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT(chat_id,user_id) DO UPDATE SET role_key=$3, granted_by=$4, granted_at=NOW()`,
    [chatId, userId, roleKey, grantedBy || null]
  );
}

async function getRole(chatId, userId) {
  const r = await get('SELECT role_key FROM group_roles WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => null);
  return r?.role_key || null;
}

async function listRoles(chatId) {
  return all('SELECT * FROM group_roles WHERE chat_id=$1 ORDER BY granted_at DESC', [chatId]).catch(() => []);
}

async function removeRole(chatId, userId) {
  return run('DELETE FROM group_roles WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// 🚫 الكلمات المحظورة (يعاد استخدام blacklist_words)
// ══════════════════════════════════════════════════════════
async function addWord(chatId, word, addedBy) {
  return run(
    `INSERT INTO blacklist_words(chat_id,word,action,added_by) VALUES($1,$2,'delete',$3)
     ON CONFLICT(chat_id,word) DO NOTHING`,
    [chatId, word.toLowerCase(), addedBy || null]
  );
}

async function removeWord(chatId, word) {
  return run('DELETE FROM blacklist_words WHERE chat_id=$1 AND word=$2', [chatId, word.toLowerCase()]).catch(() => {});
}

async function listWords(chatId) {
  return all('SELECT word FROM blacklist_words WHERE chat_id=$1 ORDER BY word', [chatId]).catch(() => []);
}

async function countWords(chatId) {
  const r = await get('SELECT COUNT(*)::int AS cnt FROM blacklist_words WHERE chat_id=$1', [chatId]).catch(() => ({ cnt: 0 }));
  return parseInt(r?.cnt || 0);
}

// ══════════════════════════════════════════════════════════
// 🔒 أقفال الوسائط (يعاد استخدام group_locks)
// ══════════════════════════════════════════════════════════
const LOCK_TYPES = ['sticker', 'gif', 'link', 'forward', 'photo', 'video', 'voice', 'poll', 'file', 'chat', 'invite', 'pin', 'info'];

async function getLocks(chatId) {
  const r = await get('SELECT * FROM group_locks WHERE chat_id=$1', [chatId]).catch(() => null);
  const out = {};
  for (const t of LOCK_TYPES) out[t] = !!(r && r['lock_' + t]);
  return out;
}

async function setLock(chatId, type, value) {
  if (!LOCK_TYPES.includes(type)) return null;
  const col = 'lock_' + type;
  await run(
    `INSERT INTO group_locks(chat_id, ${col}) VALUES($1,$2)
     ON CONFLICT(chat_id) DO UPDATE SET ${col}=$2`,
    [chatId, value ? 1 : 0]
  );
  return true;
}

// ══════════════════════════════════════════════════════════
// ✅ التحقق من الأعضاء الجدد (Verify / Captcha)
// ══════════════════════════════════════════════════════════
async function addVerify(chatId, userId, firstName, joinMsgId, deadlineMinutes) {
  return run(
    `INSERT INTO group_verify(chat_id,user_id,first_name,status,join_msg_id,deadline,created_at)
     VALUES($1,$2,$3,'pending',$4, NOW() + ($5 * INTERVAL '1 minute'), NOW())
     ON CONFLICT(chat_id,user_id) DO UPDATE
       SET first_name=$3, status='pending', join_msg_id=$4,
           deadline=NOW() + ($5 * INTERVAL '1 minute'), created_at=NOW()`,
    [chatId, userId, firstName || '', joinMsgId || null, deadlineMinutes || 5]
  );
}

async function getVerify(chatId, userId) {
  return get('SELECT * FROM group_verify WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => null);
}

async function setVerifyStatus(chatId, userId, status) {
  return run('UPDATE group_verify SET status=$1 WHERE chat_id=$2 AND user_id=$3', [status, chatId, userId]).catch(() => {});
}

async function removeVerify(chatId, userId) {
  return run('DELETE FROM group_verify WHERE chat_id=$1 AND user_id=$2', [chatId, userId]).catch(() => {});
}

async function getExpiredVerifications() {
  return all(
    `SELECT * FROM group_verify WHERE status='pending' AND deadline IS NOT NULL AND deadline < NOW() LIMIT 100`
  ).catch(() => []);
}

// ══════════════════════════════════════════════════════════
// 🧹 تنظيف دوري — يبقي حجم الجداول معقولاً
// ══════════════════════════════════════════════════════════
async function cleanupOld() {
  try { await run("DELETE FROM group_violations WHERE created_at < NOW() - INTERVAL '30 days'"); } catch (_) {}
  try { await run("DELETE FROM group_logs WHERE created_at < NOW() - INTERVAL '60 days'"); } catch (_) {}
  try { await run("DELETE FROM group_verify WHERE status!='pending' AND created_at < NOW() - INTERVAL '3 days'"); } catch (_) {}
}

const _cleanupTimer = setInterval(() => cleanupOld().catch(() => {}), 6 * 60 * 60 * 1000); // كل 6 ساعات
_cleanupTimer.unref();

module.exports = {
  DEFAULT_SETTINGS,
  LOCK_TYPES,
  migrate,
  // settings
  getRawSettings, saveSettings, updateSettings,
  // violations
  addViolation, getViolationCount, resetViolations, getViolationHistory, getTopViolators, getViolationStats,
  // logs
  addLog, getLogs, countLogs, getLogTypeCounts,
  // roles
  setRole, getRole, listRoles, removeRole,
  // words
  addWord, removeWord, listWords, countWords,
  // locks
  getLocks, setLock,
  // verify
  addVerify, getVerify, setVerifyStatus, removeVerify, getExpiredVerifications,
  // cleanup
  cleanupOld,
};
