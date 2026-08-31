'use strict';
/**
 * 🤫 database/whisper_db.js
 * ──────────────────────────────────────────────────────────────
 * قاعدة بيانات نظام الهمسة (رسائل سرية بين عضوين بنفس القروب).
 * الجدول (whispers) يُنشأ ضمن initSchema الرئيسية بـ database/db.js
 * (نفس التسلسل، عشان يكون موجود 100% من أول إقلاع — لا تهيئة كسولة).
 */

const { run, get, getSetting, setSetting } = require('./db');

const DEFAULT_TTL_MIN = 10;

// ── إعدادات قابلة للتعديل (مخزّنة بجدول settings العام) ──
async function getTtlMinutes() {
  const v = await getSetting('whisper_ttl_min');
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
}
async function setTtlMinutes(min) { return setSetting('whisper_ttl_min', String(min)); }

async function isOpenOnce() {
  const v = await getSetting('whisper_open_once');
  return v === '1';
}
async function setOpenOnce(on) { return setSetting('whisper_open_once', on ? '1' : '0'); }

async function isSelfAllowed() {
  const v = await getSetting('whisper_allow_self');
  return v === '1';
}
async function setSelfAllowed(on) { return setSetting('whisper_allow_self', on ? '1' : '0'); }

// ── إنشاء همسة جديدة ──
async function createWhisper({ chatId, senderId, senderName, receiverId, receiverName, content, ttlMinutes }) {
  const row = await get(
    `INSERT INTO whispers(chat_id, sender_id, sender_name, receiver_id, receiver_name, content, expires_at)
     VALUES($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' minutes')::interval)
     RETURNING id, expires_at`,
    [chatId, senderId, senderName || '', receiverId, receiverName || '', content, String(ttlMinutes || DEFAULT_TTL_MIN)]
  );
  return row; // { id, expires_at }
}

async function setMessageId(id, messageId) {
  await run('UPDATE whispers SET message_id=$1 WHERE id=$2', [messageId, id]).catch(() => {});
}

async function getWhisper(id) {
  return get('SELECT * FROM whispers WHERE id=$1', [id]);
}

// ── فتح الهمسة (يقرأ فقط — يُستخدم بوضع "فتح متعدد") ──
async function markOpenedIfFirst(id) {
  // أول فتح فقط يسجَّل وقته (عشان opened_at يعكس أول فتح حقيقي)
  await run('UPDATE whispers SET opened=1, opened_at=COALESCE(opened_at, NOW()) WHERE id=$1', [id]).catch(() => {});
}

// ── فتح ذرّي (atomic) بوضع "مرة واحدة فقط" — يمنع Race Condition عند ضغط متكرر/متزامن ──
// يرجّع الصف فقط لو *هذا* الاستدعاء هو اللي نجح يفتحها أول مرة، وإلا null
async function claimSingleOpen(id) {
  return get(
    `UPDATE whispers SET opened=1, opened_at=NOW()
     WHERE id=$1 AND opened=0
     RETURNING *`,
    [id]
  );
}

// ── تنظيف دوري (يُستدعى من utils/scheduler.js — لا setTimeout منفصل لكل همسة) ──
async function cleanupExpired() {
  await run("DELETE FROM whispers WHERE expires_at < NOW() - INTERVAL '1 day'").catch(() => {});
}

module.exports = {
  getTtlMinutes, setTtlMinutes,
  isOpenOnce, setOpenOnce,
  isSelfAllowed, setSelfAllowed,
  createWhisper, setMessageId, getWhisper,
  markOpenedIfFirst, claimSingleOpen,
  cleanupExpired,
  DEFAULT_TTL_MIN,
};
