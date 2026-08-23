'use strict';
const { all, run } = require('../database/db');
const { cacheGet, cacheSet, cacheClear, cacheClearPrefix } = require('./cache');

// ──────────────────────────────────────────
//  تحقق من اشتراك مستخدم في قناة واحدة
// ──────────────────────────────────────────
async function _checkOne(bot, userId, channelId) {
  try {
    const m = await bot.telegram.getChatMember(channelId, userId);
    return ['member', 'administrator', 'creator', 'restricted'].includes(m?.status);
  } catch (e) {
    const msg = e?.message || '';
    // البوت مش ادمن في القناة → نفتح (لا نعاقب المستخدم)
    if (msg.includes('bot is not a member') ||
        msg.includes('bot was kicked')      ||
        msg.includes('CHANNEL_PRIVATE')     ||
        msg.includes('chat not found')      ||
        msg.includes('Invalid peer')        ||
        msg.includes('not enough rights')   ||
        msg.includes('_ADMIN_REQUIRED')     ||
        msg.includes('USER_NOT_PARTICIPANT') ||
        msg.includes('PARTICIPANT_ID_INVALID')) {
      console.warn('[ChannelGuard] skip check (bot not admin):', channelId);
      return true;
    }
    // rate limit → انتظر وأعد
    if (msg.includes('Too Many Requests') || msg.includes('FLOOD_WAIT')) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const m2 = await bot.telegram.getChatMember(channelId, userId);
        return ['member','administrator','creator','restricted'].includes(m2?.status);
      } catch (_) { return true; }
    }
    // مستخدم مش موجود = مش مشترك
    if (msg.includes('user not found') || msg.includes('participant not found')) return false;
    // أي خطأ آخر → نفتح
    console.warn('[ChannelGuard] unknown error, opening:', channelId, msg);
    return true;
  }
}

// ──────────────────────────────────────────
//  جلب القنوات من DB مع cache
// ──────────────────────────────────────────
async function getChannels() {
  const hit = cacheGet('req_channels');
  if (hit) return hit;
  const rows = await all(
    'SELECT * FROM required_channels WHERE is_active=1 ORDER BY id'
  ).catch(() => []);
  cacheSet('req_channels', rows, 120_000);
  return rows;
}

// ──────────────────────────────────────────
//  تحقق من كل القنوات لمستخدم
// ──────────────────────────────────────────
async function checkAllChannels(bot, userId) {
  // cache إيجابي
  const ck = 'sub_ok_' + userId;
  if (cacheGet(ck) === true) return { ok: true, missing: [] };

  const channels = await getChannels();
  if (!channels.length) return { ok: true, missing: [] };

  const results = await Promise.all(
    channels.map(async ch => {
      // اسم القناة
      let name = cacheGet('chname_' + ch.channel_id) || ch.channel_name;
      if (!name || /^-?\d+$/.test(name)) {
        try {
          const info = await bot.telegram.getChat(ch.channel_id);
          name = info.title || info.username || ch.channel_name;
          cacheSet('chname_' + ch.channel_id, name, 86_400_000);
        } catch (_) {}
      }
      const subscribed = await Promise.race([
        _checkOne(bot, userId, ch.channel_id),
        new Promise(r => setTimeout(() => r(true), 5000)), // timeout = نفتح
      ]);
      return { ...ch, channel_name: name, subscribed };
    })
  );

  const missing = results.filter(c => !c.subscribed);
  // ⚡ PERF FIX: كانت 30 ثانية بس — أقصر كاش بكل المشروع (البقية كلها 5 دقايق+)،
  // يعني كل ضغطة زر بعد 30 ثانية سكوت = رحلة getChatMember حقيقية جديدة لكل
  // قناة مطلوبة قبل ما يرد. صارت 5 دقايق زي باقي فحوصات الأدمن/الحظر بالمشروع.
  // المقايضة: لو حد سحب اشتراكه، بياخد له لحد 5 دقايق (بدل 30 ثا) يرجع يُمنع.
  if (!missing.length) cacheSet(ck, true, 300_000);
  else cacheClear(ck);
  return { ok: missing.length === 0, missing };
}

// ──────────────────────────────────────────
//  إضافة قناة
// ──────────────────────────────────────────
async function addChannel(channelId, channelName, channelUrl) {
  await run(
    `INSERT INTO required_channels(channel_id, channel_name, channel_url)
     VALUES($1,$2,$3)
     ON CONFLICT(channel_id) DO UPDATE
     SET channel_name=$2, channel_url=$3, is_active=1`,
    [channelId, channelName || channelId, channelUrl || '']
  );
  cacheClear('req_channels');
  cacheClear('chname_' + channelId);
  cacheClearPrefix('sub_ok_');
  console.log('[ChannelGuard] ✅ added:', channelId, channelName);
}

// ──────────────────────────────────────────
//  حذف قناة
// ──────────────────────────────────────────
async function removeChannel(id) {
  const sid = String(id);
  const col = (sid.startsWith('-') || sid.startsWith('@')) ? 'channel_id' : 'id';
  await run('UPDATE required_channels SET is_active=0 WHERE ' + col + '=$1', [sid]);
  cacheClear('req_channels');
  cacheClearPrefix('sub_ok_');
  console.log('[ChannelGuard] 🗑 removed:', sid);
}

// ──────────────────────────────────────────
//  رسالة الاشتراك
// ──────────────────────────────────────────
function buildSubscribeMessage(missing, userName) {
  const name  = userName || 'صديقي';
  const total = missing.length;
  let text = '🔐 *' + name + '، مرحباً!*\n\n';
  text += '━━━━━━━━━━━━━━━━\n';
  text += '📋 *يجب الاشتراك في ';
  text += (total === 1 ? 'هذه القناة' : total + ' قنوات') + ':*\n\n';
  missing.forEach((ch, i) => {
    const label = ch.channel_name && !/^-?\d+$/.test(ch.channel_name)
      ? ch.channel_name : 'القناة ' + (i + 1);
    text += (i + 1) + '. 📣 *' + label + '*\n';
  });
  text += '\n━━━━━━━━━━━━━━━━\n';
  text += '1️⃣ اضغط على القناة واشترك\n';
  text += '2️⃣ ارجع واضغط ✅ تحقق';
  const buttons = missing.map(ch => {
    const label = ch.channel_name && !/^-?\d+$/.test(ch.channel_name)
      ? ch.channel_name : 'اشترك 📣';
    const url = ch.channel_url || ('https://t.me/' + String(ch.channel_id).replace('@',''));
    return [{ text: '📣 ' + label, url }];
  });
  buttons.push([{ text: '✅ اشتركت — تحقق الآن', callback_data: 'check_subscription' }]);
  return { text, buttons };
}

// ──────────────────────────────────────────
//  تحقق إذا البوت ادمن
// ──────────────────────────────────────────
async function validateBotInChannel(bot, channelId) {
  try {
    const me  = await bot.telegram.getMe();
    const mbr = await bot.telegram.getChatMember(channelId, me.id);
    return { ok: ['administrator','creator'].includes(mbr?.status), status: mbr?.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ──────────────────────────────────────────
//  مسح cache مستخدم
// ──────────────────────────────────────────
async function clearSubCache(userId) {
  cacheClear('sub_ok_' + userId);
  try {
    const { getRedisClient } = require('./redisClient');
    const r = getRedisClient();
    if (r) await r.del('sub_ok_' + userId);
  } catch (_) {}
}

async function notifyUsersNewChannel(bot, channelName) {
  try {
    const users = await require('../database/db').all(
      `SELECT id FROM users WHERE is_banned=0 AND last_active > NOW() - INTERVAL '7 days' LIMIT 500`
    ).catch(() => []);
    if (!users.length) return;
    const text = '📢 *تنبيه!*\n\nتمت إضافة قناة جديدة للاشتراك الإجباري:\n📣 *' + channelName + '*\n\nيرجى الاشتراك للاستمرار.';
    for (let i = 0; i < users.length; i += 20) {
      await Promise.allSettled(
        users.slice(i, i+20).map(u =>
          bot.telegram.sendMessage(u.id, text, { parse_mode: 'Markdown' }).catch(() => {})
        )
      );
      if (i + 20 < users.length) await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) { console.error('[ChannelGuard] notify error:', e.message); }
}

module.exports = {
  getChannels, checkAllChannels, addChannel, removeChannel,
  buildSubscribeMessage, clearSubCache, notifyUsersNewChannel,
  validateBotInChannel,
};
