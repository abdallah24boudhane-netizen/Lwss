'use strict';
/**
 * 📥 handlers/forward_organizer.js
 * أي مستخدم يعمل forward لملف/صورة/فيديو في الخاص
 * يتبعث مباشرة لـ owner مع معلومات المُرسل، بدون أسئلة
 */

const logger = require('../utils/logger');
const OWNER_ID = parseInt(process.env.OWNER_ID || '0');

// dedup — كل رسالة تُعالج مرة واحدة فقط
const _seen = new Set();
function isDup(msgId, fromId) {
  const key = msgId + '_' + fromId;
  if (_seen.has(key)) return true;
  _seen.add(key);
  setTimeout(() => _seen.delete(key), 30000);
  return false;
}

function isForwarded(msg) {
  return !!(msg.forward_date || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name || msg.forward_origin);
}

function extractFile(msg) {
  if (msg.document) return { type: 'document', file_id: msg.document.file_id, name: msg.document.file_name || 'ملف' };
  if (msg.photo)    return { type: 'photo',    file_id: msg.photo[msg.photo.length - 1].file_id, name: 'صورة' };
  if (msg.video)    return { type: 'video',    file_id: msg.video.file_id, name: msg.video.file_name || 'فيديو' };
  if (msg.audio)    return { type: 'audio',    file_id: msg.audio.file_id, name: msg.audio.file_name || 'صوت' };
  if (msg.voice)    return { type: 'voice',    file_id: msg.voice.file_id, name: 'رسالة صوتية' };
  if (msg.sticker)  return { type: 'sticker',  file_id: msg.sticker.file_id, name: 'ستيكر' };
  if (msg.animation) return { type: 'animation', file_id: msg.animation.file_id, name: 'GIF' };
  if (msg.text)     return { type: 'text', text: msg.text };
  return null;
}

function getForwardSourceName(msg) {
  if (msg.forward_from) {
    return [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ');
  }
  if (msg.forward_from_chat) return msg.forward_from_chat.title || 'قناة/قروب';
  if (msg.forward_sender_name) return msg.forward_sender_name;
  if (msg.forward_origin) {
    const o = msg.forward_origin;
    if (o.sender_user) return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    if (o.chat) return o.chat.title || 'قناة/قروب';
    if (o.sender_user_name) return o.sender_user_name;
  }
  return 'مصدر مخفي';
}

// ── استقبال أي ملف/صورة/فيديو/نص (forward أو عادي) ──
async function handleForward(ctx) {
  if (ctx.chat?.type !== 'private') return false;
  if (ctx.from?.id === OWNER_ID) return false; // لا نعيد إرسال رسائل الـ owner لنفسه
  if (!OWNER_ID) return false;

  const msg = ctx.message;
  if (!msg?.message_id) return false;
  if (isDup(msg.message_id, ctx.from.id)) return false;
  const file = extractFile(msg);
  if (!file) return false;

  const fwd = isForwarded(msg);
  const sender = ctx.from;
  const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || 'مستخدم';
  const senderTag = sender.username ? '@' + sender.username : ('ID: ' + sender.id);

  let caption = `📥 *${fwd ? 'ملف مُعاد توجيهه' : 'رسالة من مستخدم'}*\n━━━━━━━━━━━━━━━━\n\n`;
  caption += `👤 من: [${senderName}](tg://user?id=${sender.id}) (${senderTag})\n`;
  if (fwd) {
    const origSource = getForwardSourceName(msg);
    caption += `📡 المصدر الأصلي: *${origSource}*\n`;
  }
  if (file.type !== 'text') {
    const typeLabels = { document: '📄 مستند', photo: '🖼 صورة', video: '🎬 فيديو', audio: '🎵 صوت', voice: '🎤 رسالة صوتية', sticker: '🎭 ستيكر', animation: '🎞 GIF' };
    caption += `📄 النوع: ${typeLabels[file.type] || file.type}`;
    if (file.name && !['ملف','صورة','فيديو','صوت','رسالة صوتية','ستيكر','GIF'].includes(file.name)) {
      caption += `\n📎 الاسم: \`${file.name}\``;
    }
    if (msg.caption) caption += `\n\n💬 *التعليق:*\n${msg.caption}`;
  }

  const replyKb = { reply_markup: { inline_keyboard: [[{ text: '💬 رد على ' + senderName, callback_data: 'reply_user_' + sender.id }]] } };

  try {
    if (file.type === 'text') {
      await ctx.telegram.sendMessage(OWNER_ID, caption + `\n\n💬 *النص:*\n${file.text}`, { parse_mode: 'Markdown', ...replyKb });
    } else {
      const sendMap = {
        document:  'sendDocument',
        photo:     'sendPhoto',
        video:     'sendVideo',
        audio:     'sendAudio',
        voice:     'sendVoice',
        sticker:   'sendSticker',
        animation: 'sendAnimation',
      };
      const method = sendMap[file.type];
      if (!method) return false;
      if (file.type === 'sticker') {
        await ctx.telegram.sendSticker(OWNER_ID, file.file_id);
        await ctx.telegram.sendMessage(OWNER_ID, caption, { parse_mode: 'Markdown', ...replyKb });
      } else {
        await ctx.telegram[method](OWNER_ID, file.file_id, { caption, parse_mode: 'Markdown', ...replyKb });
      }
    }
  } catch (e) {
    logger.error('[ForwardOrganizer]', e.message);
    return false;
  }

  return true;
}

module.exports = { handleForward };
