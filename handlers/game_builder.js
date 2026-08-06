'use strict';
const { run, get, all } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

const KEYWORDS_CACHE_KEY = 'cg_keywords_map';
const KEYWORDS_TTL = 60;
const _sessions = new Map();
const _lastQuestion = new Map();
const _lastShown = new Map();

function normAnswer(t) {
  return String(t || '').trim().toLowerCase()
    .replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').replace(/[.,!?؟،]/g, '');
}

async function getKeywordsMap() {
  const cached = cacheGet(KEYWORDS_CACHE_KEY);
  if (cached) return cached;
  const rows = await all('SELECT id, name, keyword, has_answer, show_answer, answer_display_seconds FROM custom_games WHERE is_active=1').catch(() => []);
  const map = new Map(rows.map(r => [normAnswer(r.keyword), {
    ...r,
    has_answer: Number(r.has_answer) || 0,
    show_answer: Number(r.show_answer) || 0,
    answer_display_seconds: Number(r.answer_display_seconds) || 0,
  }]));
  cacheSet(KEYWORDS_CACHE_KEY, map, KEYWORDS_TTL);
  return map;
}
function invalidateKeywordsCache() { cacheClear(KEYWORDS_CACHE_KEY); }

async function endSession(chatId) {
  const sess = _sessions.get(chatId);
  if (!sess) return;
  if (sess.timer) clearTimeout(sess.timer);
  _sessions.delete(chatId);
  return sess;
}

async function pickQuestion(gameId) {
  const lastId = _lastQuestion.get(gameId);
  let q = await get(
    `SELECT * FROM custom_game_questions
      WHERE game_id=$1 AND is_active=1 ${lastId ? 'AND id != $2' : ''}
      ORDER BY RANDOM() LIMIT 1`,
    lastId ? [gameId, lastId] : [gameId]
  ).catch(() => null);
  if (!q && lastId) {
    q = await get(
      `SELECT * FROM custom_game_questions WHERE game_id=$1 AND is_active=1 ORDER BY RANDOM() LIMIT 1`,
      [gameId]
    ).catch(() => null);
  }
  if (q) _lastQuestion.set(gameId, q.id);
  return q;
}

async function sendContent(ctx, q, replyToId) {
  const opts = { reply_to_message_id: replyToId, ...(q.question_text ? { caption: q.question_text } : {}) };
  switch (q.content_type) {
    case 'photo':    return ctx.replyWithPhoto(q.file_id, opts);
    case 'video':    return ctx.replyWithVideo(q.file_id, opts);
    case 'animation':return ctx.replyWithAnimation(q.file_id, opts);
    case 'audio':    return ctx.replyWithAudio(q.file_id, opts);
    case 'voice':    return ctx.replyWithVoice(q.file_id, opts);
    case 'document': return ctx.replyWithDocument(q.file_id, opts);
    case 'sticker':  return ctx.replyWithSticker(q.file_id, { reply_to_message_id: replyToId });
    default:
      return ctx.reply(q.content_text || (q.question_text || ''), { reply_to_message_id: replyToId });
  }
}

async function sendQuestion(ctx, game, q, replyToId) {
  if (!game.has_answer) {
    let sent;
    try { sent = await sendContent(ctx, q, replyToId); }
    catch (e) {
      logger.error('[game_builder] send content failed: ' + e.message);
      await ctx.reply('❌ خطأ فـ إرسال محتوى اللعبة.').catch(() => {});
      return null;
    }
    if (game.show_answer && q.explanation) {
      _lastShown.set(ctx.chat.id, {
        messageId: sent?.message_id, answerText: q.explanation,
        answerDisplaySeconds: game.answer_display_seconds || 0,
      });
    }
    return true;
  }

  let answers;
  try { answers = JSON.parse(q.answers); } catch { answers = [q.answers]; }
  if (!Array.isArray(answers) || !answers.length) {
    await ctx.reply('⚠️ خطأ فـ إعداد السؤال (بدون إجابات).').catch(() => {});
    return null;
  }
  const timeLimit = Math.max(10, Math.min(q.time_limit || 60, 600));

  let sent;
  try { sent = await sendContent(ctx, q, replyToId); }
  catch (e) {
    logger.error('[game_builder] send content failed: ' + e.message);
    await ctx.reply('❌ خطأ فـ إرسال محتوى السؤال.').catch(() => {});
    return null;
  }

  if (game.show_answer) {
    _lastShown.set(ctx.chat.id, {
      messageId: sent?.message_id, answerText: answers[0],
      answerDisplaySeconds: game.answer_display_seconds || 0,
    });
  }

  const startTime = Date.now();
  const timer = setTimeout(() => {
    const s = _sessions.get(ctx.chat.id);
    if (!s || s.questionId !== q.id) return;
    _sessions.delete(ctx.chat.id);
  }, timeLimit * 1000);

  _sessions.set(ctx.chat.id, {
    gameId: game.id, questionId: q.id, answers: answers.map(normAnswer),
    reward: q.reward || 0, timer, name: game.name, startTime,
  });
  return true;
}

async function checkGameTrigger(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  const text = ctx.message?.text;
  if (!text) return false;

  const map = await getKeywordsMap();
  const game = map.get(normAnswer(text));
  if (!game) return false;

  const existing = _sessions.get(ctx.chat.id);
  if (existing && existing.gameId !== game.id) return false;
  await endSession(ctx.chat.id);

  const q = await pickQuestion(game.id);
  if (!q) return ctx.reply('⚠️ لعبة "' + game.name + '" ما فيهاش محتوى مفعّل حالياً.').catch(() => {});

  return sendQuestion(ctx, game, q, ctx.message.message_id);
}

async function checkGameSkip(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  const text = ctx.message?.text?.trim();
  if (!/^وس$/i.test(text || '')) return false;

  const sess = _sessions.get(ctx.chat.id);
  if (!sess) return false;

  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (!['administrator', 'creator'].includes(member?.status)) return false;
  } catch { return false; }

  const gameId = sess.gameId;
  const game = await get('SELECT * FROM custom_games WHERE id=$1', [gameId]).catch(() => null);
  await endSession(ctx.chat.id);
  if (!game) return ctx.reply('⏭️ تم إلغاء السؤال.').catch(() => {});
  game.has_answer = Number(game.has_answer) || 0;
  game.show_answer = Number(game.show_answer) || 0;

  const q = await pickQuestion(gameId);
  if (!q) return ctx.reply('⏭️ تم الإلغاء — ما فيه محتوى آخر فهاذ اللعبة.').catch(() => {});

  return sendQuestion(ctx, game, q, ctx.message.message_id);
}

async function checkGameAnswer(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  const sess = _sessions.get(ctx.chat.id);
  if (!sess) return false;
  const text = ctx.message?.text;
  if (!text) return false;
  if (!sess.answers.includes(normAnswer(text))) return false;

  const won = _sessions.get(ctx.chat.id);
  if (!won || won.questionId !== sess.questionId) return false;
  await endSession(ctx.chat.id);

  const uid = ctx.from.id;
  const name = ctx.from.first_name || 'لاعب';
  const elapsed = ((Date.now() - sess.startTime) / 1000).toFixed(2);
  const mention = `[${name}](tg://user?id=${uid})`;

  let newBal = 0;
  if (sess.reward > 0) {
    try {
      const cur = await get('SELECT balance FROM pro_bank_accounts WHERE user_id=$1', [uid]).catch(() => null);
      const curBal = cur ? parseFloat(cur.balance || 0) : 0;
      newBal = curBal + sess.reward;
      await run(
        `INSERT INTO pro_bank_accounts(user_id, balance) VALUES($1,$2)
         ON CONFLICT(user_id) DO UPDATE SET balance = pro_bank_accounts.balance + $2`,
        [uid, sess.reward]
      );
    } catch (e) {
      logger.error('[game_builder] reward failed: ' + e.message);
    }
  }

  return ctx.reply(
    `• اجابة صحيحة ← ${mention}\n` +
    `• اللعبة ← ${sess.name}\n` +
    `• عدد الثواني ← ${elapsed}\n` +
    (sess.reward > 0 ? `• فلوسك ← (${Math.floor(newBal).toLocaleString()} DA 🤑)\n` : '') +
    `-`,
    { reply_to_message_id: ctx.message.message_id, parse_mode: 'Markdown' }
  ).catch(() => {});
}

async function checkAnswerReveal(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  const text = ctx.message?.text?.trim();
  if (!text || normAnswer(text) !== normAnswer('اجابة')) return false;

  const replyTo = ctx.message.reply_to_message;
  if (!replyTo) return false;

  const shown = _lastShown.get(ctx.chat.id);
  if (!shown || shown.messageId !== replyTo.message_id) return false;
  if (!shown.answerText) return false;

  const msg = await ctx.reply('📖 ' + shown.answerText, { reply_to_message_id: ctx.message.message_id }).catch(() => null);
  if (msg && shown.answerDisplaySeconds > 0) {
    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), shown.answerDisplaySeconds * 1000);
  }
  return true;
}

async function startGameById(ctx, gameId) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  const game = await get('SELECT * FROM custom_games WHERE id=$1 AND is_active=1', [gameId]).catch(() => null);
  if (!game) return ctx.answerCbQuery('⚠️ اللعبة غير متاحة حالياً', { show_alert: true }).catch(() => {});
  game.has_answer = Number(game.has_answer) || 0;
  game.show_answer = Number(game.show_answer) || 0;

  const existing = _sessions.get(ctx.chat.id);
  if (existing && existing.gameId !== game.id) {
    return ctx.answerCbQuery('⚠️ فيه لعبة تانية شغالة حالياً بهذا القروب', { show_alert: true }).catch(() => {});
  }
  await endSession(ctx.chat.id);

  const q = await pickQuestion(game.id);
  if (!q) return ctx.answerCbQuery('⚠️ لعبة "' + game.name + '" ما فيهاش محتوى مفعّل حالياً.', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('▶️ ' + game.name).catch(() => {});
  return sendQuestion(ctx, game, q, ctx.callbackQuery?.message?.message_id);
}

module.exports = { checkGameTrigger, checkGameAnswer, checkGameSkip, checkAnswerReveal, invalidateKeywordsCache, normAnswer, startGameById };
