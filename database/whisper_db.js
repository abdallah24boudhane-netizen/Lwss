'use strict';
const { run, get, getSetting, setSetting } = require('./db');

const DEFAULT_TTL_MIN = 10;

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

async function createWhisper({ chatId, senderId, senderName, receiverId, receiverName, content, contentType, fileId, ttlMinutes }) {
  const row = await get(
    `INSERT INTO whispers(chat_id, sender_id, sender_name, receiver_id, receiver_name, content, content_type, file_id, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8, NOW() + ($9 || ' minutes')::interval)
     RETURNING id, expires_at`,
    [chatId, senderId, senderName || '', receiverId, receiverName || '', content || '', contentType || 'text', fileId || null, String(ttlMinutes || DEFAULT_TTL_MIN)]
  );
  return row;
}

async function setMessageId(id, messageId) {
  await run('UPDATE whispers SET message_id=$1 WHERE id=$2', [messageId, id]).catch(() => {});
}

async function getWhisper(id) {
  return get('SELECT * FROM whispers WHERE id=$1', [id]);
}

async function markOpenedIfFirst(id) {
  await run('UPDATE whispers SET opened=1, opened_at=COALESCE(opened_at, NOW()) WHERE id=$1', [id]).catch(() => {});
}

async function claimSingleOpen(id) {
  return get(
    `UPDATE whispers SET opened=1, opened_at=NOW()
     WHERE id=$1 AND opened=0
     RETURNING *`,
    [id]
  );
}

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
