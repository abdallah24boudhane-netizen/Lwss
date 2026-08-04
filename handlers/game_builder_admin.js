'use strict';
const { run, get, all } = require('../database/db');
const { invalidateKeywordsCache } = require('./game_builder');

function isOwner(ctx) { return ctx.uid === parseInt(process.env.OWNER_ID); }
async function setState(uid, st) { return require('../utils/stateManager').setState(uid, st); }
async function delState(uid) { return require('../utils/stateManager').delState(uid); }

async function showHome(ctx) {
  if (!isOwner(ctx)) return;
  const games = await all('SELECT id, name, keyword, is_active FROM custom_games ORDER BY id DESC').catch(() => []);
  let text = '🎮 <b>منشئ الألعاب</b>\n━━━━━━━━━━━━━━━━━━\n';
  text += games.length ? `عدد الألعاب: <b>${games.length}</b>\n\nاختر لعبة للإدارة، أو أنشئ لعبة جديدة:` : 'مافيش ألعاب حالياً. أنشئ أول وحدة 👇';
  const rows = games.map(g => ([{ text: (g.is_active ? '🟢' : '🔴') + ' ' + g.name + ' — ' + g.keyword, callback_data: 'cg_view_' + g.id }]));
  rows.push([{ text: '➕ لعبة جديدة', callback_data: 'cg_newgame' }]);
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (ctx.callbackQuery) { await ctx.editMessageText(text, opts).catch(() => {}); return ctx.answerCbQuery().catch(() => {}); }
  return ctx.reply(text, opts).catch(() => {});
}

async function startNewGame(ctx) {
  if (!isOwner(ctx)) return;
  await setState(ctx.uid, { type: 'cg_new_name' });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply('🎮 اسم اللعبة الجديدة:\n_(أو /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
}

async function handleText(ctx, txt, state) {
  if (txt === '/cancel') { await delState(ctx.uid); return ctx.reply('❌ تم الإلغاء.').catch(() => {}); }

  if (state.type === 'cg_new_name') {
    await setState(ctx.uid, { type: 'cg_new_keyword', name: txt.trim() });
    return ctx.reply('🔑 الكلمة المفتاحية اللي تبدأ اللعبة (كلمة وحدة بلا مسافات):\n_(أو /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (state.type === 'cg_new_keyword') {
    await setState(ctx.uid, { type: 'cg_new_desc', name: state.name, keyword: txt.trim() });
    return ctx.reply('📝 وصف مختصر للعبة (يبان جنب الكلمة المفتاحية فقائمة الألعاب):\n_(أو /skip)_', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (state.type === 'cg_new_desc') {
    const description = txt === '/skip' ? '' : txt.trim();
    try {
      const row = await get('INSERT INTO custom_games(name, keyword, description, created_by) VALUES($1,$2,$3,$4) RETURNING id', [state.name, state.keyword, description, ctx.uid]);
      invalidateKeywordsCache();
      await delState(ctx.uid);
      await ctx.reply('✅ اللعبة "' + state.name + '" اتخلقت! (رقمها #' + row.id + ')\n\nدروك زيدلها سؤال:', {
        reply_markup: { inline_keyboard: [[{ text: '➕ إضافة سؤال', callback_data: 'cg_newq_' + row.id }]]}
      }).catch(() => {});
    } catch (e) {
      await delState(ctx.uid);
      const msg = e.message.includes('unique') ? 'هذي الكلمة مستعملة فلعبة أخرى.' : e.message;
      await ctx.reply('❌ فشل الإنشاء: ' + msg).catch(() => {});
    }
    return;
  }

  if (state.type === 'cg_q_content') {
    const msg = ctx.message;
    let content_type = 'text', content_text = '', file_id = null;
    if (msg.photo)          { content_type = 'photo';     file_id = msg.photo[msg.photo.length - 1].file_id; content_text = msg.caption || ''; }
    else if (msg.video)     { content_type = 'video';     file_id = msg.video.file_id; content_text = msg.caption || ''; }
    else if (msg.animation) { content_type = 'animation'; file_id = msg.animation.file_id; content_text = msg.caption || ''; }
    else if (msg.audio)     { content_type = 'audio';     file_id = msg.audio.file_id; content_text = msg.caption || ''; }
    else if (msg.voice)     { content_type = 'voice';     file_id = msg.voice.file_id; }
    else if (msg.document)  { content_type = 'document';  file_id = msg.document.file_id; content_text = msg.caption || ''; }
    else if (msg.sticker)   { content_type = 'sticker';   file_id = msg.sticker.file_id; }
    else                    { content_type = 'text';      content_text = txt; }
    await setState(ctx.uid, { ...state, type: 'cg_q_question', content_type, content_text, file_id });
    return ctx.reply('❓ نص السؤال (يظهر تحت المحتوى)، أو اكتب /skip لتجاوزه:').catch(() => {});
  }

  if (state.type === 'cg_q_question') {
    const question_text = txt === '/skip' ? '' : txt;
    await setState(ctx.uid, { ...state, type: 'cg_q_answers', question_text });
    return ctx.reply('✅ الإجابات الصحيحة، افصل بينها بفاصلة (,):\nمثال: `الجزائر, Algeria, algeria`', { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (state.type === 'cg_q_answers') {
    const answers = txt.split(',').map(a => a.trim()).filter(Boolean);
    if (!answers.length) return ctx.reply('⚠️ لازم إجابة وحدة على الأقل.').catch(() => {});
    await setState(ctx.uid, { ...state, type: 'cg_q_reward', answers });
    return ctx.reply('💰 قيمة المكافأة (رقم، أو 0 بلا مكافأة):').catch(() => {});
  }

  if (state.type === 'cg_q_reward') {
    const reward = parseInt(txt);
    if (isNaN(reward) || reward < 0) return ctx.reply('⚠️ اكتب رقم صحيح.').catch(() => {});
    await setState(ctx.uid, { ...state, type: 'cg_q_time', reward });
    return ctx.reply('⏱ الوقت المسموح للإجابة بالثواني (افتراضي 60، اكتب /skip):').catch(() => {});
  }

  if (state.type === 'cg_q_time') {
    const time_limit = txt === '/skip' ? 60 : parseInt(txt);
    if (isNaN(time_limit) || time_limit < 10) return ctx.reply('⚠️ الحد الأدنى 10 ثواني.').catch(() => {});
    try {
      await run(
        `INSERT INTO custom_game_questions(game_id, content_type, content_text, file_id, question_text, answers, reward, time_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [state.gameId, state.content_type, state.content_text || '', state.file_id, state.question_text || '', JSON.stringify(state.answers), state.reward, time_limit]
      );
      await delState(ctx.uid);
      await ctx.reply('✅ تم إضافة السؤال!', {
        reply_markup: { inline_keyboard: [[{ text: '➕ سؤال آخر', callback_data: 'cg_newq_' + state.gameId }, { text: '📋 عرض اللعبة', callback_data: 'cg_view_' + state.gameId }]]}
      }).catch(() => {});
    } catch (e) {
      await delState(ctx.uid);
      await ctx.reply('❌ فشل: ' + e.message).catch(() => {});
    }
    return;
  }
  return false;
}

async function viewGame(ctx, gameId) {
  if (!isOwner(ctx)) return;
  const game = await get('SELECT * FROM custom_games WHERE id=$1', [gameId]).catch(() => null);
  if (!game) return ctx.answerCbQuery('❌ اللعبة غير موجودة', { show_alert: true }).catch(() => {});
  const questions = await all('SELECT id, question_text, is_active, reward FROM custom_game_questions WHERE game_id=$1 ORDER BY id', [gameId]).catch(() => []);
  let text = `🎮 <b>${game.name}</b>\n🔑 الكلمة: <code>${game.keyword}</code>\n${game.is_active ? '🟢 مفعّلة' : '🔴 معطّلة'}\n━━━━━━━━━━━━━━━━━━\n📋 الأسئلة: <b>${questions.length}</b>`;
  const rows = questions.slice(0, 15).map(q => ([{ text: (q.is_active ? '🟢' : '🔴') + ' #' + q.id + ' — ' + (q.question_text ? q.question_text.slice(0, 25) : '(بلا سؤال نصي)') + ' 💰' + q.reward, callback_data: 'cg_qview_' + q.id + '_' + gameId }]));
  rows.push([{ text: '➕ سؤال جديد', callback_data: 'cg_newq_' + gameId }]);
  rows.push([{ text: game.is_active ? '🔴 تعطيل اللعبة' : '🟢 تفعيل اللعبة', callback_data: 'cg_toggle_' + gameId }, { text: '🗑 حذف اللعبة', callback_data: 'cg_delgame_' + gameId }]);
  rows.push([{ text: '◀️ رجوع', callback_data: 'cg_home' }]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }).catch(() => {});
  return ctx.answerCbQuery().catch(() => {});
}

async function toggleGame(ctx, gameId) {
  if (!isOwner(ctx)) return;
  await run('UPDATE custom_games SET is_active = 1 - is_active WHERE id=$1', [gameId]).catch(() => {});
  invalidateKeywordsCache();
  return viewGame(ctx, gameId);
}
async function deleteGame(ctx, gameId) {
  if (!isOwner(ctx)) return;
  await run('DELETE FROM custom_games WHERE id=$1', [gameId]).catch(() => {});
  invalidateKeywordsCache();
  await ctx.answerCbQuery('🗑 تم الحذف').catch(() => {});
  return showHome(ctx);
}
async function toggleQuestion(ctx, qId, gameId) {
  if (!isOwner(ctx)) return;
  await run('UPDATE custom_game_questions SET is_active = 1 - is_active WHERE id=$1', [qId]).catch(() => {});
  return viewGame(ctx, gameId);
}
async function deleteQuestion(ctx, qId, gameId) {
  if (!isOwner(ctx)) return;
  await run('DELETE FROM custom_game_questions WHERE id=$1', [qId]).catch(() => {});
  return viewGame(ctx, gameId);
}
async function viewQuestion(ctx, qId, gameId) {
  if (!isOwner(ctx)) return;
  const q = await get('SELECT * FROM custom_game_questions WHERE id=$1', [qId]).catch(() => null);
  if (!q) return ctx.answerCbQuery('❌ غير موجود', { show_alert: true }).catch(() => {});
  let answers = []; try { answers = JSON.parse(q.answers); } catch {}
  const text = `❓ <b>سؤال #${q.id}</b>\n━━━━━━━━━━━━━━━━━━\n📎 النوع: ${q.content_type}\n💬 السؤال: ${q.question_text || '—'}\n✅ الإجابات: ${answers.join(', ')}\n💰 المكافأة: ${q.reward}\n⏱ الوقت: ${q.time_limit}ث\n${q.is_active ? '🟢 مفعّل' : '🔴 معطّل'}`;
  const rows = [[{ text: q.is_active ? '🔴 تعطيل' : '🟢 تفعيل', callback_data: 'cg_qtoggle_' + qId + '_' + gameId }, { text: '🗑 حذف', callback_data: 'cg_qdel_' + qId + '_' + gameId }], [{ text: '◀️ رجوع للعبة', callback_data: 'cg_view_' + gameId }]];
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }).catch(() => {});
  return ctx.answerCbQuery().catch(() => {});
}

async function startNewQuestion(ctx, gameId) {
  if (!isOwner(ctx)) return;
  await setState(ctx.uid, { type: 'cg_q_content', gameId: parseInt(gameId) });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply('📎 ابعت المحتوى (نص/صورة/فيديو/GIF/صوت/فويس/ملف/ملصق):\n_(أو /cancel)_', { parse_mode: 'Markdown' }).catch(() => {});
}

async function handleCallback(ctx, data) {
  if (data === 'cg_home') return showHome(ctx);
  if (data === 'cg_newgame') return startNewGame(ctx);
  if (data.startsWith('cg_newq_')) return startNewQuestion(ctx, data.replace('cg_newq_', ''));
  if (data.startsWith('cg_view_')) return viewGame(ctx, data.replace('cg_view_', ''));
  if (data.startsWith('cg_toggle_')) return toggleGame(ctx, data.replace('cg_toggle_', ''));
  if (data.startsWith('cg_delgame_')) return deleteGame(ctx, data.replace('cg_delgame_', ''));
  if (data.startsWith('cg_qview_')) { const [, qId, gId] = data.match(/cg_qview_(\d+)_(\d+)/) || []; return viewQuestion(ctx, qId, gId); }
  if (data.startsWith('cg_qtoggle_')) { const [, qId, gId] = data.match(/cg_qtoggle_(\d+)_(\d+)/) || []; return toggleQuestion(ctx, qId, gId); }
  if (data.startsWith('cg_qdel_')) { const [, qId, gId] = data.match(/cg_qdel_(\d+)_(\d+)/) || []; return deleteQuestion(ctx, qId, gId); }
  return false;
}

function setup(bot) {
  bot.command(['newgame', 'العاب_ادارة', 'منشئ_الالعاب'], showHome);
  bot.hears(/^(منشئ الالعاب|ادارة الالعاب)$/, showHome);
}

module.exports = { setup, showHome, handleCallback, handleText };
