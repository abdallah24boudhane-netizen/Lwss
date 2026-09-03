'use strict';
// ══════════════════════════════════════════════════════════════
//  🎮 أكسيو أو فيريتي — المحرك الرئيسي
// ══════════════════════════════════════════════════════════════

const CFG = require('./config');
const state = require('./state');
const fairness = require('./fairness');
const texts = require('./texts');
const kb = require('./keyboards');
const tdb = require('./db');
const logger = require('../../utils/logger');

let BOT = null;
function init(bot) { BOT = bot; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeSend(chatId, text, extra) {
  try { return await BOT.telegram.sendMessage(chatId, text, Object.assign({ parse_mode: 'Markdown' }, extra)); }
  catch (e) { logger.warn('[ToD] sendMessage: ' + e.message); return null; }
}

function isOver(session) { return session.ended || !state.sessions.has(session.chatId); }

async function loadSettingsInto(session) {
  const row = await tdb.getSettings(session.chatId);
  session.settings = {
    registration: row.reg_timeout,
    asker_prompt: CFG.DEFAULT_TIMERS.ASKER_PROMPT,
    choice: row.choice_timeout,
    submit: row.submit_timeout,
    answer: row.answer_timeout,
    banter: row.banter_timeout,
    min_players: row.min_players,
    delete_offtopic: row.delete_offtopic,
    fairness_enabled: row.fairness_enabled,
  };
  return session.settings;
}

// ══════════════════ التسجيل ══════════════════
async function createSession(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) {
    return ctx.reply('🎮 لعبة أكسيو أو فيريتي تُلعب داخل القروبات فقط!').catch(() => {});
  }
  if (state.getSession(ctx.chat.id)) {
    return ctx.reply('⚠️ توجد غرفة/لعبة أكسيو أو فيريتي نشطة في هذا القروب بالفعل.').catch(() => {});
  }
  const owner = { id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username };
  const session = state.createSession(ctx.chat.id, ctx.chat.title, owner);
  await loadSettingsInto(session);

  const replyOpts = { parse_mode: 'Markdown' };
  if (ctx.message?.message_id) replyOpts.reply_to_message_id = ctx.message.message_id;
  const msg = await ctx.reply(texts.registrationText(session), replyOpts);
  session.regMsgId = msg?.message_id;
  await tdb.saveSessionSnapshot(session);

  if (session.settings.registration > 0) {
    session.regTimer = setTimeout(async () => {
      const s = state.getSession(ctx.chat.id);
      if (!s || s.status !== 'registration') return;
      state.destroySession(ctx.chat.id);
      await tdb.deleteSessionSnapshot(ctx.chat.id);
      await safeSend(ctx.chat.id, texts.sessionCancelledText('⏰ انتهت مهلة التسجيل ولم يبدأ المنشئ اللعبة.'));
    }, session.settings.registration);
  }
}

async function refreshRegMsg(session) {
  if (!session.regMsgId) return;
  await BOT.telegram.editMessageText(session.chatId, session.regMsgId, undefined, texts.registrationText(session), { parse_mode: 'Markdown' }).catch(() => {});
}

async function joinSession(ctx, next) {
  const session = state.getSession(ctx.chat.id);
  if (!session || session.status !== 'registration') return next();
  const uid = ctx.from.id;
  if (session.players.has(uid)) return; // مستهلك بصمت
  if (session.players.size >= CFG.MAX_PLAYERS) {
    return ctx.reply('🚫 الغرفة مكتملة!').catch(() => {});
  }
  state.addPlayer(session, { id: uid, first_name: ctx.from.first_name, username: ctx.from.username });
  await refreshRegMsg(session);
  await tdb.saveSessionSnapshot(session);
}

async function cancelSession(ctx, next) {
  const session = state.getSession(ctx.chat.id);
  if (!session || session.status !== 'registration') return next();
  if (ctx.from.id !== session.ownerId && !ctx.isAdmin && !ctx.isOwner) return next();
  if (session.regTimer) clearTimeout(session.regTimer);
  state.destroySession(ctx.chat.id);
  await tdb.deleteSessionSnapshot(ctx.chat.id);
  await safeSend(ctx.chat.id, texts.sessionCancelledText('أُلغيت بواسطة ' + (ctx.from.first_name || 'مستخدم') + '.'));
}

async function startGame(ctx, next) {
  const session = state.getSession(ctx.chat.id);
  if (!session || session.status !== 'registration') return next();
  if (ctx.from.id !== session.ownerId) return next();
  const min = session.settings.min_players || CFG.MIN_PLAYERS;
  if (session.players.size < min) {
    return ctx.reply(texts.notEnoughPlayersText(min, session.players.size)).catch(() => {});
  }
  if (session.regTimer) clearTimeout(session.regTimer);
  session.status = 'active';
  await safeSend(ctx.chat.id, '🚀 *بدأت اللعبة!* استعدّوا...');
  await tdb.saveSessionSnapshot(session);
  runRoundLoop(session).catch(e => {
    logger.error('[ToD] runRoundLoop crashed: ' + e.message);
    safeSend(session.chatId, '⚠️ حدث خطأ غير متوقع وتم إيقاف اللعبة.');
    state.destroySession(session.chatId);
    tdb.deleteSessionSnapshot(session.chatId).catch(() => {});
  });
}

// ══════════════════ بطاقة الجولة (رسالة واحدة متطورة) ══════════════════
// تبني نص بطاقة الجولة حسب ما وصلت إليه المعلومات حتى الآن — بدل إرسال
// رسائل منفصلة لكل مرحلة، نعدّل رسالة واحدة طوال الجولة (تقليل الفوضى + سرعة الرد)
function roundCardText(session, asker, answerer, info) {
  const lines = [
    `🎯 *الجولة ${session.round}*`, '',
    `🎤 *السائل:* ${texts.mention(asker)}`,
    `🙋 *المجيب:* ${texts.mention(answerer)}`,
  ];

  if (info.choiceTimedOut) {
    lines.push('', `⏰ *${texts.esc(answerer.name)}* لم يختر في الوقت المحدد.`);
    return lines.join('\n');
  }
  if (!info.mode) {
    lines.push('', `${texts.mention(answerer)}، اختر:`);
    return lines.join('\n');
  }

  const modeLabel = info.mode === 'truth' ? '💬 فيريتي (سؤال صادق)' : '🔥 أكسيو (تحدي)';
  lines.push('', `✅ اختار ${texts.mention(answerer)}: *${modeLabel}*`);

  if (info.submitTimedOut) {
    lines.push('', `⏰ *${texts.esc(asker.name)}* لم يكتب السؤال/التحدي في الوقت المحدد.`);
    return lines.join('\n');
  }
  if (!info.askContent) {
    const kind = info.mode === 'truth' ? 'سؤالاً صادقاً' : 'تحدياً مناسباً';
    lines.push('', `${texts.mention(asker)}، اكتب ${kind} بصيغة:`, '`سل` ثم النص — مثال: `سل كم عمرك؟`');
    return lines.join('\n');
  }

  lines.push('', `"${texts.esc(info.askContent)}"`);

  if (info.answerTimedOut) {
    lines.push('', `⏰ *${texts.esc(answerer.name)}* لم يُجب في الوقت المحدد.`);
  } else if (info.answerContent) {
    lines.push('', `✅ *إجابة ${texts.esc(answerer.name)}:* "${texts.esc(info.answerContent)}"`);
  } else {
    lines.push('', `${texts.mention(answerer)}، أجب بصيغة: \`اجب\` ثم النص — مثال: \`اجب 20 سنة\``);
  }

  if (info.banterSecs) {
    lines.push('', `💬 الدردشة مفتوحة الآن لمدة ${info.banterSecs} ثانية...`);
  }
  return lines.join('\n');
}

// ══════════════════ حلقة الجولات ══════════════════
async function runRoundLoop(session) {
  while (true) {
    if (isOver(session)) return;
    session.round++;

    // 🔧 إعادة تحميل الإعدادات في كل جولة — يضمن مزامنة فورية مع لوحة التحكم
    await loadSettingsInto(session).catch(() => {});

    const asker = fairness.pickAsker(session, session.settings.fairness_enabled);
    if (!asker) { await endSession(session, 'لا يوجد لاعبون كافون للمتابعة.'); return; }
    const answerer = fairness.pickAnswerer(session, asker.id, session.settings.fairness_enabled);
    if (!answerer) { await endSession(session, 'لا يوجد لاعبون كافون للمتابعة.'); return; }

    session.currentAsker = asker.id;
    session.currentAnswerer = answerer.id;
    session.mode = null;

    const info = {};
    state.nextEpoch(session);
    const cardMsg = await safeSend(session.chatId, roundCardText(session, asker, answerer, info), { reply_markup: kb.choiceKeyboard(session) });
    if (!cardMsg) {
      logger.warn('[ToD] تعذّر الإرسال للقروب — إنهاء الجلسة: ' + session.chatId);
      await endSession(session, 'تعذّر إرسال رسائل لهذا القروب (البوت رُبما أُزيل منه).');
      return;
    }
    const cardId = cardMsg?.message_id;

    async function updateCard(removeKb) {
      if (!cardId) return;
      const opts = { parse_mode: 'Markdown' };
      if (removeKb) opts.reply_markup = { inline_keyboard: [] };
      await BOT.telegram.editMessageText(session.chatId, cardId, undefined, roundCardText(session, asker, answerer, info), opts).catch(() => {});
    }

    // ── 1) المجيب يختار أكسيو أو فيريتي ──
    await state.createWaiter(session, 'choice', answerer.id, session.settings.choice);
    if (isOver(session)) return;
    if (!session.mode) {
      info.choiceTimedOut = true;
      answerer.timeouts = (answerer.timeouts || 0) + 1;
      session.lastAnswerer = answerer.id; // 🔧 يستبعده الاختيار القادم من تكرار نفس المجيب
      await updateCard(true);
      await sleep(1500);
      continue;
    }
    info.mode = session.mode;
    await updateCard(true);

    // ── 2) السائل يكتب السؤال/التحدي بصيغة "سل ..." ──
    const content = await state.waitForMessage(session, 'asker_submit', asker.id, session.settings.submit, state.extractAsk);
    if (isOver(session)) return;
    if (content === null) {
      info.submitTimedOut = true;
      asker.timeouts = (asker.timeouts || 0) + 1;
      session.lastAsker = asker.id; // 🔧 يستبعده الاختيار القادم من تكرار نفس السائل
      await updateCard();
      await sleep(1500);
      continue;
    }
    asker.askedCount = (asker.askedCount || 0) + 1;
    info.askContent = content;
    await updateCard();

    // ── 3) المجيب يجيب بصيغة "اجب ..." ──
    const answerText = await state.waitForMessage(session, 'answerer_reply', answerer.id, session.settings.answer, state.extractAnswer);
    if (isOver(session)) return;
    answerer.answeredCount = (answerer.answeredCount || 0) + 1;
    let timedOut = false;
    if (answerText === null) {
      info.answerTimedOut = true;
      answerer.timeouts = (answerer.timeouts || 0) + 1;
      timedOut = true;
    } else {
      info.answerContent = answerText;
      if (session.mode === 'dare') answerer.dareCompleted = (answerer.dareCompleted || 0) + 1;
      else answerer.truthCompleted = (answerer.truthCompleted || 0) + 1;
    }

    session.lastAsker = asker.id;
    session.lastAnswerer = answerer.id;

    // ── الدردشة — رسالة فتح منفصلة واضحة ──────────────────────
    session.status = 'banter';
    const banterMs = session.settings.banter || CFG.DEFAULT_TIMERS.BANTER;
    const banterSecs = Math.round(banterMs / 1000);
    info.banterSecs = banterSecs;
    await updateCard();

    // رسالة فتح الدردشة (مستقلة عن البطاقة)
    const openMsg = await safeSend(
      session.chatId,
      `💬 *الدردشة مفتوحة الآن!*\n⏱️ لديكم *${banterSecs}* ثانية للتعليق والضحك 😄`
    );

    // عمليات الخلفية بالتوازي مع انتظار الدردشة
    Promise.all([
      tdb.applyRoundStats({ userId: asker.id, firstName: asker.name, username: asker.username, asked: true }),
      tdb.applyRoundStats({
        userId: answerer.id, firstName: answerer.name, username: answerer.username, answered: true,
        dareDone: !timedOut && session.mode === 'dare', truthDone: !timedOut && session.mode === 'truth', timedOut,
      }),
      tdb.saveSessionSnapshot(session),
    ]).catch(e => logger.error('[ToD] background stats/snapshot: ' + e.message));

    await sleep(banterMs);
    if (isOver(session)) return;
    session.status = 'active';

    // حذف رسالة الفتح + إرسال رسالة إغلاق قصيرة
    if (openMsg) {
      await BOT.telegram.deleteMessage(session.chatId, openMsg.message_id).catch(() => {});
    }
    await safeSend(session.chatId, '🔇 انتهى وقت الدردشة — استعدّوا للجولة القادمة!');
    await sleep(1200);
  }
}

// ══════════════════ إنهاء اللعبة ══════════════════
async function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  if (session.pendingCapture) session.pendingCapture.resolve(null);
  for (const w of Object.values(session.waiters)) { try { w.finish(); } catch (_) {} }
  await safeSend(session.chatId, texts.sessionEndedText(session, reason));
  await tdb.markGamePlayed([...session.players.keys()]);
  for (const uid of session.players.keys()) {
    const row = await tdb.getStatsForUser(uid).catch(() => null);
    if (row) {
      const fresh = await tdb.checkNewAchievements(uid, row);
      if (fresh.length) {
        const lines = fresh.map(a => `${a.emoji} ${a.name}`).join('\n');
        BOT.telegram.sendMessage(uid, `🎖️ *إنجازات جديدة في أكسيو أو فيريتي!*\n${lines}`, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  }
  await tdb.deleteSessionSnapshot(session.chatId);
  state.destroySession(session.chatId);
}

async function forceEnd(ctx, next) {
  const session = state.getSession(ctx.chat.id);
  if (!session) return next ? next() : undefined;
  const isOwnerOrAdmin = ctx.from.id === session.ownerId || ctx.isAdmin || ctx.isOwner;
  if (!isOwnerOrAdmin) return next ? next() : undefined;
  if (session.status === 'registration') {
    if (session.regTimer) clearTimeout(session.regTimer);
    state.destroySession(ctx.chat.id);
    await tdb.deleteSessionSnapshot(ctx.chat.id);
    return safeSend(ctx.chat.id, texts.sessionCancelledText('أُلغيت بواسطة ' + (ctx.from.first_name || 'مستخدم') + '.'));
  }
  await endSession(session, '🛑 أُنهيت بواسطة ' + (ctx.from.first_name || 'مشرف') + '.');
}

// ══════════════════ معالجة الرسائل أثناء اللعبة ══════════════════
async function handleGroupMessage(ctx) {
  const session = state.getSession(ctx.chat.id);
  if (!session || session.status === 'registration' || isOver(session)) return null;
  const uid = ctx.from.id;
  const text = (ctx.message?.text || '').trim();

  if (session.pendingCapture && session.pendingCapture.userId === uid) {
    const captured = state.feedCapture(session, uid, text);
    if (captured) return 'consumed';
  }

  if (session.status === 'active' && session.settings.delete_offtopic) {
    const isParticipant = uid === session.currentAsker || uid === session.currentAnswerer || uid === session.ownerId;
    const isAdminUser = !!(ctx.isAdmin || ctx.isOwner);
    if (!isParticipant && !isAdminUser) {
      await ctx.deleteMessage().catch(() => {});
      return 'consumed';
    }
  }
  return null;
}

// ══════════════════ ضغط زر الاختيار (أكسيو/فيريتي) ══════════════════
async function handleChoiceCallback(ctx, session, parsed) {
  const uid = ctx.from.id;
  if (uid !== session.currentAnswerer) {
    return ctx.answerCbQuery('🚫 هذا الاختيار ليس لك!', { show_alert: true }).catch(() => {});
  }
  if (session.mode) return ctx.answerCbQuery('✅ تم الاختيار مسبقاً.').catch(() => {});
  session.mode = parsed.arg === 'dare' ? 'dare' : 'truth';
  state.notifyWaiter(session, 'choice', uid);
  await ctx.answerCbQuery('✅ اخترت!').catch(() => {});
  // ملاحظة: بطاقة الجولة في runRoundLoop ستُعدَّل تلقائياً لتعكس الاختيار — لا حاجة لرسالة إضافية هنا
}

async function handleEndCallback(ctx, session) {
  const isOwnerOrAdmin = ctx.from.id === session.ownerId || ctx.isAdmin || ctx.isOwner;
  if (!isOwnerOrAdmin) return ctx.answerCbQuery('🚫 غير مسموح.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('🛑 جارٍ الإنهاء...').catch(() => {});
  await endSession(session, '🛑 أُنهيت بواسطة ' + (ctx.from.first_name || 'مشرف') + '.');
}

// ══════════════════ استعادة بعد إعادة التشغيل ══════════════════
async function resumeAllSessions() {
  const rows = await tdb.loadAllSnapshots();
  for (const row of rows) {
    try {
      const snap = row.snapshot;
      const owner = snap.players.find(p => p.id === snap.ownerId) || { id: snap.ownerId, name: 'مالك' };
      const session = state.createSession(snap.chatId, snap.chatTitle, owner);
      session.players.clear();
      session.playerOrder = [];
      for (const p of snap.players) {
        session.players.set(p.id, p);
        session.playerOrder.push(p.id);
      }
      session.round = snap.round || 0;
      await loadSettingsInto(session);

      // تحقق أن البوت لا يزال في القروب قبل الإرسال
      try {
        await BOT.telegram.getChat(snap.chatId);
      } catch(e) {
        logger.warn('[ToD] قروب غير موجود، تخطي: ' + snap.chatId);
        await tdb.deleteSnapshot(snap.chatId).catch(() => {});
        continue;
      }
      if (snap.status === 'registration') {
        session.status = 'registration';
        const msg = await safeSend(snap.chatId, '♻️ *تم استرجاع غرفة أكسيو أو فيريتي بعد إعادة تشغيل البوت*\n\n' + texts.registrationText(session));
        session.regMsgId = msg?.message_id;
      } else {
        session.status = 'active';
        await safeSend(snap.chatId, '🔄 *تمت إعادة تشغيل البوت أثناء جولة نشطة!*\nتم الحفاظ على اللاعبين والإحصائيات — جارٍ بدء جولة جديدة...');
        runRoundLoop(session).catch(e => logger.error('[ToD resume] ' + e.message));
      }
    } catch (e) {
      logger.error('[ToD] resume session error: ' + e.message);
    }
  }
  if (rows.length) logger.info(`✅ [ToD] استُرجعت ${rows.length} جلسة بعد إعادة التشغيل`);
}

async function cmdStats(ctx) {
  const row = await tdb.getStatsForUser(ctx.from.id);
  const { all } = require('../../database/db');
  const ach = await all('SELECT achievement_key FROM tod_achievements WHERE user_id=$1', [ctx.from.id]).catch(() => []);
  return ctx.reply(texts.statsText(row, ach), { parse_mode: 'Markdown' }).catch(() => {});
}

async function cmdRules(ctx) {
  return ctx.reply(texts.rulesText(), { parse_mode: 'Markdown' }).catch(() => {});
}

module.exports = {
  init, createSession, joinSession, cancelSession, startGame, forceEnd,
  handleGroupMessage, handleChoiceCallback, handleEndCallback,
  resumeAllSessions, cmdStats, cmdRules,
};
