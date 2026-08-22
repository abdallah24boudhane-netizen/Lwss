'use strict';

const { cacheGet, cacheSet, cacheClear, cacheGetAsync, cacheSetAsync } = require('../utils/cache');
const guard        = require('../utils/channelGuard');
const startHandler = require('../handlers/start');
const { getSetting, get: dbGet } = require('../database/db');
const { get, run } = require('../database/db');

// ✅ OWNER_ID إجباري من .env — لا fallback hardcoded
const OWNER_ID = parseInt(process.env.OWNER_ID || '0');
if (!OWNER_ID || isNaN(OWNER_ID)) {
  console.error('FATAL: OWNER_ID missing in .env');
  process.exit(1);
}
const isOwner = uid => parseInt(uid) === OWNER_ID;

const _userBuf = new Map();

function bufferUser(uid, firstName, lastName, username) {
  _userBuf.set(uid, { id: uid, first_name: firstName || '', last_name: lastName || '', username: username || '' });
  if (_userBuf.size >= 500) flushUsers();
}

async function flushUsers() {
  if (!_userBuf.size) return;
  const entries = [..._userBuf.values()];
  _userBuf.clear();
  if (!entries.length) return;
  const ph = entries.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4},CURRENT_TIMESTAMP)`).join(',');
  const params = entries.flatMap(e => [e.id, e.first_name, e.last_name, e.username]);
  try {
    await run(
      `INSERT INTO users(id,first_name,last_name,username,last_active) VALUES ${ph}
       ON CONFLICT(id) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username,last_active=CURRENT_TIMESTAMP`,
      params
    );
  } catch (_) {}
}

const _bufT = setInterval(flushUsers, 10000);
_bufT.unref();

const _admCache = new Map();
const ADM_TTL = 7200000; // 2 ساعة

async function getAdminInfo(uid) {
  const now = Date.now();
  const c = _admCache.get(uid);
  if (c && now - c.ts < ADM_TTL) return c.data;
  const row = await get('SELECT * FROM admins WHERE user_id=$1', [uid]);
  const data = row
    ? { isAdmin: true, perms: (row.permissions || '').split(',').map(p => p.trim()) }
    : { isAdmin: false, perms: [] };
  _admCache.set(uid, { data, ts: now });
  return data;
}

global.invalidateAdmin = uid => _admCache.delete(uid);
global.invalidateBan   = uid => cacheClear('ban_' + uid);

async function authMiddleware(ctx, next) {
  const uid = ctx.from?.id;
  if (!uid) return next();

  ctx.uid     = uid;
  ctx.isOwner = isOwner(uid);
  bufferUser(uid, ctx.from.first_name, ctx.from.last_name, ctx.from.username);

  if (ctx.isOwner) {
    ctx.isAdmin    = true;
    ctx.adminPerms = ['full'];
    return next();
  }

  // ⚡ CALLBACK FAST PATH — كل شيء من الكاش بدون await
  if (ctx.callbackQuery) {
    const cachedAdmin = _admCache.get(uid);
    const cachedBan   = cacheGet('ban_' + uid);
    const cachedSub   = cacheGet('sub_ok_' + uid);
    // 🔧 FIX: cacheGet ترجّع null لما ما تكون بالكاش (مو undefined) — الشرط القديم
    // (!== undefined) كان صحيح دايماً حتى لو ما فيه كاش فعلي، فيتجاوز فحص الحظر بالكامل
    // لأي تفاعل بأزرار (callback). صار يتحقق فعلاً إذا كان محفوظ بالكاش أو لأ.
    if (cachedAdmin && cachedBan !== null && (cachedSub === true || ctx.chat?.type !== 'private')) {
      ctx.isAdmin    = cachedAdmin.data.isAdmin;
      ctx.adminPerms = cachedAdmin.data.perms;
      if (!ctx.isAdmin && cachedBan === 1) {
        if (ctx.callbackQuery) return ctx.answerCbQuery('🚫 أنت محظور').catch(() => {});
        return; // رسالة عادية — تجاهل بصمت
      }
      return next();
    }
  }

  // 🔧 FIX: كان يفحص جدول user_bans اللي ما موجود أصلاً بقاعدة البيانات (SELECT فاشل
  // على كل رسالة). نظام الحظر الحقيقي والشغّال بالمشروع هو global_bans (شوف
  // handlers/group_advanced.js — عنده أوامر حظر/فك حظر فعلية). حظر دائم بدون
  // تاريخ انتهاء (نفس افتراض global_bans بكل مكان تاني يُستخدم فيه).
  const banCached = await cacheGetAsync('ban_' + uid);
  const [info, banRow] = await Promise.all([
    getAdminInfo(uid),
    banCached === null ? get('SELECT user_id FROM global_bans WHERE user_id=$1 LIMIT 1', [uid]).catch(()=>null) : Promise.resolve(null),
  ]);
  ctx.isAdmin    = info.isAdmin;
  ctx.adminPerms = info.perms;

  if (!ctx.isAdmin) {
    let banned = banCached;
    // 🔧 FIX: كان الشرط (=== undefined) بس cacheGetAsync ترجّع null دايماً لما ما
    // يكون بالكاش — يعني هذا الشرط ما كان يصير true أبداً، فالنتيجة ما كانت تتخزّن
    // بالكاش إطلاقاً، والاستعلام كان يتكرر على كل رسالة بدل مرة كل ساعة.
    if (banned === null) {
      banned = banRow ? 1 : 0; // global_bans: وجود صف = محظور (ما فيه عمود is_banned)
      await cacheSetAsync('ban_' + uid, banned, 3600000); // 60min — يُحفظ في Redis
    }
    if (banned === 1) {
      return ctx.reply('🚫 أنت محظور من استخدام البوت.').catch(() => {});
    }
  }

  if (global.maintenanceMode && !ctx.isOwner && !ctx.isAdmin) {
    // ✅ كاش 60 ثانية لتجنب DB query على كل طلب
    if (!global._maintMsgCache || Date.now() - global._maintMsgCache.ts > 60000) {
      const { getSetting } = require('../database/db');
      const [customMsg, endTime, groupsExempt] = await Promise.all([
        getSetting('maintenance_msg').catch(() => null),
        getSetting('maintenance_end').catch(() => null),
        getSetting('maintenance_groups_exempt').catch(() => null),
      ]);
      let msg = customMsg || '🔧 البوت تحت الصيانة حالياً لتحسين الخدمة.';
      if (endTime) msg += `\n\n⏱ الوقت المتوقع للعودة: ${endTime}`;
      msg += '\n\nنعتذر عن الإزعاج 🙏';
      global._maintMsgCache = { msg, ts: Date.now(), groupsExempt: groupsExempt === 'true' };
    }
    // استثناء القروبات إن كان مفعّلاً (صيانة الخاص فقط)
    if (global._maintMsgCache.groupsExempt && ctx.chat?.type !== 'private') {
      return next();
    }
    return ctx.reply(global._maintMsgCache.msg).catch(() => {});
  }

  // 🔐 تحقق من الاشتراك في القنوات المطلوبة (الخاص فقط)
  try {
    const chatType = ctx.chat?.type;
    if (!ctx.isOwner && !ctx.isAdmin && chatType === 'private') {
      const cbData = ctx.callbackQuery?.data;

      // ✅ البنك مفتوح للجميع في الخاص
      const BANK_CMDS = ['بنك','محفظتي','بطاقتي','كشف','ديوني','سداد','الاثرياء','أثرياء','اثرياء'];
      const msgTxt = (ctx.message?.text||'').trim();
      const isBankCmd = BANK_CMDS.includes(msgTxt)
        || /^تحويل\s+\d/i.test(msgTxt)
        || /^قرض/i.test(msgTxt)
        || /^استثمار/i.test(msgTxt)
        || /^سحب استثمار/i.test(msgTxt)
        || (cbData && cbData.startsWith('bankpro:'));
      if (isBankCmd) return next();
      
      if (cbData === 'check_subscription') {
        // ⚡ أجب فوراً + امسح الكاش + افحص من جديد
        ctx.answerCbQuery('🔄 جاري التحقق...').catch(()=>{});
        await guard.clearSubCache(uid);
        // تأخير صغير للتأكد إن Telegram سجّل الاشتراك
        await new Promise(r => setTimeout(r, 1500));
        const res = await guard.checkAllChannels({ telegram: ctx.telegram }, uid);
        if (res.ok) {
          ctx.answerCbQuery('✅ مرحباً بك!').catch(() => {});
          ctx.deleteMessage().catch(() => {});
          const name = ctx.from?.first_name || 'Student';
          return startHandler.showWelcome(ctx.telegram, ctx.chat.id, ctx.from, name);
        }
        // لم يشترك بعد
        ctx.answerCbQuery('❌ لم تشترك بعد! اشترك أولاً ثم تحقق', { show_alert: true }).catch(() => {});
        const { text, buttons } = guard.buildSubscribeMessage(res.missing, ctx.from?.first_name);
        return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } })
          .catch(() => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(()=>{}));
      }

      if (!cbData || !cbData.startsWith('del_channel_')) {
        // ✅ تحقق دائماً — الكاش 30 ثانية فقط
        const subCached = require('../utils/cache').cacheGet('sub_ok_' + uid);
        if (!subCached) {
          const res2 = await guard.checkAllChannels({ telegram: ctx.telegram }, uid);
          if (!res2.ok) {
            guard.clearSubCache(uid); // لا كاش للمحجوبين
            const { text, buttons } = guard.buildSubscribeMessage(res2.missing, ctx.from?.first_name);
            if (cbData) {
              ctx.answerCbQuery('❌ يجب الاشتراك أولاً', { show_alert: true }).catch(()=>{});
              return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } })
                .catch(() => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(()=>{}));
            }
            // احذف الرسالة السابقة إذا موجودة
            const _subMsgId = require('../utils/cache').cacheGet('sub_msg_' + uid);
            if (_subMsgId) {
              ctx.telegram.deleteMessage(ctx.chat.id, _subMsgId).catch(() => {});
            }
            const _newMsg = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => null);
            if (_newMsg) require('../utils/cache').cacheSet('sub_msg_' + uid, _newMsg.message_id, 300000);
            return;
          }
        }
      }
    }
  } catch(_) {}

  // 🎮 Daily login — مرة واحدة فقط بالذاكرة
  if (!global._dlCache) global._dlCache = new Map();
  const today = new Date().toISOString().slice(0,10);
  const dlKey = uid + '_' + today;
  if (!global._dlCache.has(dlKey)) {
    global._dlCache.set(dlKey, 1);
    if (global._dlCache.size > 50000) {
      // احذف أقدم 10000 مدخل بدل مسح الكل
      const arr = [...global._dlCache.keys()].slice(0, 10000);
      arr.forEach(k => global._dlCache.delete(k));
    }
    try { const {checkDailyLogin}=require('../database/points'); checkDailyLogin(uid).catch(()=>{}); } catch(_){}
  }
  return next();
}

module.exports = { authMiddleware, isOwner, OWNER_ID };
