'use strict';
const { run, get, all } = require('../database/db');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');
const logger = require('../utils/logger');

const KEYWORDS_CACHE_KEY = 'cg_keywords_map';
const KEYWORDS_TTL = 60;
const _sessions = new Map();

function normAnswer(t) {
  return String(t || '').trim().toLowerCase()
    .replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').replace(/[.,!?؟،]/g, '');
}

async function getKeywordsMap() {
  const cached = cacheGet(KEYWORDS_CACHE_KEY);
  if (cached) return cached;
  const rows = await all('SELECT id, name, keyword FROM custom_games WHERE is_active=1').catch(() => []);
  const map = new Map(rows.map(r => [normAnswer(r.keyword), r]));
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

async function checkGameTrigger(ctx) {
  if (!['group', 'supergroup'].includes(ctx.chat?.type)) return false;
  const text = ctx.message?.text;
  if (!text) return false;
  if (_sessions.has(ctx.chat.id)) return false;

  const map = await getKeywordsMap();
  const game = map.get(normAnswer(text));
  if (!game) return false;

  const q = await get(
    `SELECT * FROM custom_game_questions WHERE game_id=$1 AND is_active=1 ORDER BY RANDOM() LIMIT 1`,
    [game.id]
  ).catch(() => null);

  if (!q) return ctx.reply('⚠️ لعبة "' + game.name + '" ما فيهاش أسئلة مفعّلة حالياً.').catch(() => {});

  let answers;
  try { answers = JSON.parse(q.answers); } catch { answers = [q.answers]; }
  if (!Array.isArray(answers) || !answers.length) {
    return ctx.reply('⚠️ خطأ فـ إعداد السؤال (بدون إجابات).').catch(() => {});
  }

  const timeLimit = Math.max(10, Math.min(q.time_limit || 60, 600));

  try {
    const opts = q.question_text ? { caption: q.question_text } : {};
    switch (q.content_type) {
      case 'photo':    await ctx.replyWithPhoto(q.file_id, opts); break;
      case 'video':    await ctx.replyWithVideo(q.file_id, opts); break;
      case 'animation':await ctx.replyWithAnimation(q.file_id, opts); break;
      case 'audio':    await ctx.replyWithAudio(q.file_id, opts); break;
      case 'voice':    await ctx.replyWithVoice(q.file_id); if (q.question_text) await ctx.reply(q.question_text); break;
      case 'document': await ctx.replyWithDocument(q.file_id, opts); break;
      case 'sticker':  await ctx.replyWithSticker(q.file_id); if (q.question_text) await ctx.reply(q.question_text); break;
      default:
        await ctx.reply((q.content_text || '') + (q.question_text ? '\n\n❓ ' + q.question_text : ''));
    }
  } catch (e) {
    logger.error('[game_builder] send content failed: ' + e.message);
    return ctx.reply('❌ خطأ فـ إرسال محتوى السؤال.').catch(() => {});
  }

  const timer = setTimeout(async () => {
    const s = _sessions.get(ctx.chat.id);
    if (!s || s.questionId !== q.id) return;
    _sessions.delete(ctx.chat.id);
    await ctx.reply('⏰ *انتهى الوقت!* محدش جاوب صح.\n✅ الإجابة: ' + answers[0], { parse_mode: 'Markdown' }).catch(() => {});
  }, timeLimit * 1000);

  _sessions.set(ctx.chat.id, {
    gameId: game.id, questionId: q.id, answers: answers.map(normAnswer),
    reward: q.reward || 0, timer, name: game.name,
  });

  return ctx.reply('⏱ عندك *' + timeLimit + '* ثانية للإجابة!', { parse_mode: 'Markdown' }).catch(() => {});
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
  const name = ctx.from.first_name || 'اللاعب';

  if (sess.reward > 0) {
    try {
      await run(
        'INSERT INTO bank_accounts(user_id, username, first_name, balance) VALUES($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET balance = bank_accounts.balance + $4',
        [uid, ctx.from.username || '', name, sess.reward]
      );
      await run(
        "INSERT INTO bank_transactions(from_id,to_id,amount,type,note) VALUES(0,$1,$2,'custom_game',$3)",
        [uid, sess.reward, 'لعبة: ' + sess.name]
      ).catch(() => {});
    } catch (e) {
      logger.error('[game_builder] reward failed: ' + e.message);
    }
  }

  return ctx.reply(
    '🎉 *إجابة صحيحة!*\n👤 ' + name + (sess.reward > 0 ? '\n💰 ربح: +' + sess.reward + '$' : ''),
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
  ).catch(() => {});
}

module.exports = { checkGameTrigger, checkGameAnswer, invalidateKeywordsCache, normAnswer };
