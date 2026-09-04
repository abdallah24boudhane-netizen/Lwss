'use strict';
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const logger = require('../utils/logger');

const DEEZER_SEARCH = q =>
  `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=8`;

function _resolveYtdlpPath() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const bundled = path.join(__dirname, '..', '.bin', 'yt-dlp');
  return fs.existsSync(bundled) ? bundled : 'yt-dlp';
}
const YTDLP_PATH  = _resolveYtdlpPath();
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '';
const TMP_DIR    = os.tmpdir();
const MAX_SIZE   = 45 * 1024 * 1024;
const DL_TIMEOUT = 90_000;
const MAX_CANDIDATES = 2;

const fmtDur = s => s ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : '';
const escMd  = t => (t||'').replace(/[*_`\[\]()~>#+=|{}.!\-]/g,'\\$&');

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'TalineBot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let _depsCache = null;

function _probe(bin, versionFlag) {
  return new Promise(resolve => {
    execFile(bin, [versionFlag], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function checkDependencies(force = false) {
  if (_depsCache && !force) return _depsCache;
  const [ytOk, ffOk] = await Promise.all([
    _probe(YTDLP_PATH, '--version'),
    _probe(FFMPEG_PATH, '-version'),
  ]);
  _depsCache = { ytdlp: ytOk, ffmpeg: ffOk };
  if (!ytOk) {
    logger.error('[Music] DEPENDENCY MISSING: yt-dlp not found/executable (path:', YTDLP_PATH,
      '). Music downloads will fail for every song until this is installed.');
  }
  if (!ffOk) {
    logger.error('[Music] DEPENDENCY MISSING: ffmpeg not found/executable (path:', FFMPEG_PATH,
      '). Audio extraction will fail for every song until this is installed.');
  }
  if (ytOk && ffOk) logger.info('[Music] dependency check OK: yt-dlp and ffmpeg are available. (yt-dlp path: ' + YTDLP_PATH + ')');
  return _depsCache;
}
exports.checkDependencies = checkDependencies;

function ytSearch(query) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH,
      [`ytsearch5:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--quiet',
       '--extractor-args', 'youtube:player_client=android,web'],
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

const BOT_CHECK_RE = /sign in to confirm|not a bot|confirm you.?re not a bot/i;

function ytDownload(videoId, outBase, playerClient) {
  return new Promise((resolve, reject) => {
    const args = [
      `https://www.youtube.com/watch?v=${videoId}`,
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '5',
      '-o', outBase,
      '--no-playlist', '--quiet', '--no-warnings',
      '--max-filesize', '45m',
    ];
    if (FFMPEG_PATH !== 'ffmpeg') args.push('--ffmpeg-location', FFMPEG_PATH);
    if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);
    if (playerClient) args.push('--extractor-args', `youtube:player_client=${playerClient}`);

    execFile(YTDLP_PATH, args, { timeout: DL_TIMEOUT }, (err, _stdout, stderr) => {
      if (err) {
        err.ytStderr  = (stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ');
        err.isBotCheck = BOT_CHECK_RE.test(stderr || '');
        return reject(err);
      }
      resolve(outBase + '.mp3');
    });
  });
}

function cleanupTmpPrefix(tmpBase) {
  if (!tmpBase) return;
  const dir = path.dirname(tmpBase);
  const prefix = path.basename(tmpBase);
  fs.readdir(dir, (err, files) => {
    if (err) return;
    for (const f of files) {
      if (f.startsWith(prefix)) fs.unlink(path.join(dir, f), () => {});
    }
  });
}

function encodeTitle(s, maxRaw) {
  // نقصّ النص الخام قبل التشفير فقط — القص بعد التشفير قد يقطع رمزاً مشفّراً (%XX) في المنتصف
  // ويسبب 'URI malformed' لاحقاً عند فك التشفير.
  return encodeURIComponent((s||'').substring(0, maxRaw || 12));
}

function buildResultsMsg(tracks, query) {
  let text = `🎵 *نتائج البحث عن:* _${escMd(query)}_\n━━━━━━━━━━━━━━━━━━\n\n`;
  tracks.forEach((t, i) => {
    const dur = fmtDur(t.duration);
    text += `${i+1}. 🎵 *${escMd(t.title)}*\n`;
    text += `   👤 ${escMd(t.artist?.name || '?')}`;
    if (dur) text += `  ⏱ ${dur}`;
    text += '\n';
  });
  text += '\n_اضغط على أغنية لتحميلها كاملاً_ 🎶';
  return text;
}

function buildResultsKb(tracks) {
  return tracks.map((t, i) => [{
    text: `${i+1}. ${t.title.substring(0,28)} — ${(t.artist?.name||'').substring(0,18)}`,
    callback_data: `music_dl_${t.id}_${encodeTitle(t.title,12)}_${encodeTitle(t.artist?.name||'',10)}`,
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
    logger.error('[Music] Search error:', e.message);
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
    const safeDecode = s => { try { return decodeURIComponent(s); } catch(_) { return s || ''; } };
    const title    = safeDecode(parts[1] || 'أغنية');
    const artist   = safeDecode(parts[2] || '');

    await ctx.answerCbQuery('⏳ جارٍ التحميل...').catch(()=>{});

    const deps = await checkDependencies();
    if (!deps.ytdlp || !deps.ffmpeg) {
      const missing = [!deps.ytdlp && 'yt-dlp', !deps.ffmpeg && 'ffmpeg'].filter(Boolean).join(', ');
      logger.error('[Music] Aborting download — missing dependency:', missing);
      return ctx.reply(
        `⚠️ ميزة تحميل الأغاني غير مهيأة حالياً على الخادم (مكوّن مفقود: ${missing}).\nتم إبلاغ الفريق التقني.`
      ).catch(()=>{});
    }

    const loading = await ctx.reply(
      `⬇️ جارٍ تحميل *${escMd(title)}*...\n_قد يستغرق حتى دقيقة_`,
      { parse_mode:'Markdown' }
    ).catch(()=>null);

    let outFile  = null;
    let tmpBase  = null;
    let ydur     = null;
    let lastErr  = null;

    try {
      const ytResults = await ytSearch(`${title} ${artist} audio`.trim());
      if (!ytResults.length) throw new Error('لا نتائج على YouTube');

      for (const cand of ytResults.slice(0, MAX_CANDIDATES)) {
        tmpBase = path.join(TMP_DIR, `music_${Date.now()}_${cand.id}`);
        let candFile = null;
        for (const client of [null, 'android']) {
          try {
            candFile = await ytDownload(cand.id, tmpBase, client);
            break;
          } catch (e) {
            lastErr = e;
            logger.error('[Music] download attempt failed:', {
              videoId: cand.id,
              client: client || 'default',
              code: e.code || null,
              botCheck: !!e.isBotCheck,
              message: e.message,
              ytStderr: e.ytStderr || undefined,
            });
            cleanupTmpPrefix(tmpBase);
            if (!e.isBotCheck) break;
          }
        }
        if (!candFile) continue;
        try {
          if (!fs.existsSync(candFile)) throw new Error('الملف لم يُنشأ');
          const size = fs.statSync(candFile).size;
          if (size > MAX_SIZE) {
            fs.unlink(candFile, ()=>{});
            throw new Error(`الملف كبير جداً (${Math.round(size/1024/1024)}MB)`);
          }
          outFile = candFile;
          ydur    = cand.duration;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          logger.error('[Music] post-download validation failed:', { videoId: cand.id, message: e.message });
          cleanupTmpPrefix(tmpBase);
        }
      }

      if (!outFile) {
        if (lastErr && lastErr.code === 'ENOENT') await checkDependencies(true);
        throw lastErr || new Error('فشل كل محاولات التحميل');
      }

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
      logger.error('[Music] Download failed for', JSON.stringify(title), '-', e.message,
        e.code ? `(code: ${e.code})` : '', e.ytStderr ? `stderr: ${e.ytStderr}` : '');
      if (loading) ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
      const msg = e.message?.includes('كبير') ? `❌ ${e.message}` :
                  e.message?.includes('YouTube') ? '❌ لم يُعثر على الأغنية في YouTube' :
                  '❌ فشل التحميل، جرّب أغنية أخرى.';
      ctx.reply(msg).catch(()=>{});
    } finally {
      if (outFile && fs.existsSync(outFile)) fs.unlink(outFile, ()=>{});
      cleanupTmpPrefix(tmpBase);
    }
  }
};
