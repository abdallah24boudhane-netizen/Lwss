'use strict';
/**
 * ════════════════════════════════════════════
 *  🎵 handlers/music.js — Music Search + Download
 *  Deezer للبحث + yt-dlp للتحميل الكامل
 * ════════════════════════════════════════════
 */
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEEZER_SEARCH = q =>
  `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=8`;

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const TMP_DIR    = os.tmpdir();
const MAX_SIZE   = 45 * 1024 * 1024;
const DL_TIMEOUT = 90_000;

const fmtDur = s => s ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : '';
const escMd  = t => (t||'').replace(/[*_`\[\]()~>#+=|{}.!\-]/g,'\\$&');

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'TalineBot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function ytSearch(query) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH,
      [`ytsearch5:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--quiet'],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(err);
        const results = stdout.trim().split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
          .filter(Boolean);
        resolve(results);
      }
    );
  });
}

function ytDownload(videoId, outBase) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, [
      `https://www.youtube.com/watch?v=${videoId}`,
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '5',
      '-o', outBase,
      '--no-playlist', '--quiet', '--no-warnings',
      '--max-filesize', '45m',
    ], { timeout: DL_TIMEOUT }, (err) => {
      if (err) return reject(err);
      resolve(outBase + '.mp3');
    });
  });
}

function encodeTitle(s) {
  return encodeURIComponent((s||'').substring(0,20)).substring(0,30);
}

function buildResultsMsg(tracks, query) {
  return `🎵 *نتائج البحث عن:* _${escMd(query)}_\n━━━━━━━━━━━━━━━━━━\n\n_اضغط على أغنية بالأسفل لتحميلها كاملاً_ 🎶`;
}

function buildResultsKb(tracks) {
  return tracks.map((t, i) => [{
    text: `${i+1}. ${t.title.substring(0,28)} — ${(t.artist?.name||'').substring(0,18)}`,
    callback_data: `music_dl_${t.id}_${encodeTitle(t.title)}_${encodeTitle(t.artist?.name||'')}`,
  }]);
}

exports.handleSearch = async (ctx) => {
  const raw = ctx.message?.text || '';
  const query = raw
    .replace(/^🎵\s*/,'')
    .replace(/^موسيقى\s*/i,'')
    .replace(/^أغنية\s*/i,'')
    .replace(/^اغنية\s*/i,'')
    .trim();

  if (!query || query.length < 2) {
    return ctx.reply(
      '🎵 *البحث عن أغنية*\n\nاكتب: `🎵 اسم الأغنية`\nمثال: `🎵 دق 3 دقات`',
      { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
    ).catch(()=>{});
  }

  const loading = await ctx.reply(
    `🔍 جارٍ البحث عن: _${escMd(query)}_...`,
    { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(()=>null);

  try {
    const data   = await apiGet(DEEZER_SEARCH(query));
    const tracks = (data.data || []).slice(0, 8);

    if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});

    if (!tracks.length) {
      return ctx.reply(`❌ لا توجد نتائج لـ *${escMd(query)}*`,
        { parse_mode:'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(()=>{});
    }

    const kb = buildResultsKb(tracks);
    kb.push([{ text: '❌ إغلاق', callback_data: 'music_close' }]);

    return ctx.reply(buildResultsMsg(tracks, query), {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message?.message_id,
      reply_markup: { inline_keyboard: kb },
    }).catch(()=>{});

  } catch(e) {
    console.error('[Music] Search error:', e.message);
    if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
    return ctx.reply('❌ فشل البحث: ' + e.message).catch(()=>{});
  }
};

exports.handleCallback = async (ctx) => {
  const data = ctx.callbackQuery?.data || '';

  if (data === 'music_close') {
    await ctx.answerCbQuery('').catch(()=>{});
    return ctx.deleteMessage().catch(()=>{});
  }

  if (data.startsWith('music_dl_')) {
    const parts    = data.replace('music_dl_','').split('_');
    const deezerId = parts[0];
    const title    = decodeURIComponent(parts[1] || 'أغنية');
    const artist   = decodeURIComponent(parts[2] || '');

    await ctx.answerCbQuery('⏳ جارٍ التحميل...').catch(()=>{});

    const loading = await ctx.reply(
      `⬇️ جارٍ تحميل *${escMd(title)}*...\n_قد يستغرق حتى دقيقة_`,
      { parse_mode:'Markdown' }
    ).catch(()=>null);

    let outFile = null;
    try {
      const ytResults = await ytSearch(`${title} ${artist} audio`.trim());
      if (!ytResults.length) throw new Error('لا نتائج على YouTube');

      const videoId = ytResults[0].id;
      const ydur    = ytResults[0].duration;

      const tmpBase = path.join(TMP_DIR, `music_${Date.now()}_${videoId}`);
      outFile = await ytDownload(videoId, tmpBase);

      if (!fs.existsSync(outFile)) throw new Error('الملف لم يُنشأ');
      const size = fs.statSync(outFile).size;
      if (size > MAX_SIZE) throw new Error(`الملف كبير جداً (${Math.round(size/1024/1024)}MB)`);

      if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});

      let cover = null;
      try {
        const deezerTrack = await apiGet(`https://api.deezer.com/track/${deezerId}`);
        cover = deezerTrack.album?.cover_medium;
      } catch(_) {}

      const caption =
        `🎵 *${escMd(title)}*\n` +
        (artist ? `👤 *${escMd(artist)}*\n` : '') +
        (ydur   ? `⏱ ${fmtDur(ydur)}\n`    : '') +
        `\n🤖 @${ctx.botInfo?.username || 'TalineBot'}`;

      await ctx.replyWithAudio(
        { source: outFile },
        {
          caption,
          parse_mode: 'Markdown',
          title,
          performer: artist,
          thumb: cover ? { url: cover } : undefined,
        }
      );

    } catch(e) {
      require('../utils/logger').error('[Music DL] ' + (e.message || e) + (e.stderr ? ' | stderr: ' + String(e.stderr).slice(0,300) : ''));
      if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
      const msg = e.message?.includes('كبير') ? `❌ ${e.message}` :
                  e.message?.includes('YouTube') ? '❌ لم يُعثر على الأغنية في YouTube' :
                  '❌ فشل التحميل، جرّب أغنية أخرى.';
      ctx.reply(msg).catch(()=>{});
    } finally {
      if (outFile && fs.existsSync(outFile)) fs.unlink(outFile, ()=>{});
    }
  }
};
