'use strict';


function normalizeArabic(q) {
  return q
    .replace(/[ً-ٟ]/g, '') // حذف التشكيل
    .replace(/^ال/, '')                // حذف ال التعريف
    .replace(/[أإآا]/g, 'ا')          // توحيد الألف
    .replace(/ة/g, 'ه')               // ة → ه
    .replace(/ى/g, 'ي')               // ى → ي
    .trim().toLowerCase();
}

const express = require('express');
// ── Cached Admin Check ──
const _adminCache = new Map();
const { cacheGetAsync: _cgA, cacheSetAsync: _csA } = require('../utils/cache');
async function _isAdmin(uid) {
  const now = Date.now();
  const hit = _adminCache.get(uid);
  if (hit && now - hit.ts < 7200000) return hit.v;
  // فحص Redis أولاً
  const rHit = await _cgA('adm_' + uid).catch(() => null);
  if (rHit !== null && rHit !== undefined) {
    _adminCache.set(uid, { v: !!rHit, ts: now });
    return !!rHit;
  }
  const row = await get('SELECT permissions FROM admins WHERE user_id=$1', [uid]).catch(() => null);
  const v = !!row;
  _adminCache.set(uid, { v, ts: now });
  await _csA('adm_' + uid, v ? 1 : 0, 7200000).catch(() => {});
  return v;
}
function _isOwnerUid(uid) {
  return String(uid) === String(process.env.OWNER_ID || '0');
}
async function _checkAdmin(uid) {
  return _isOwnerUid(uid) || await _isAdmin(uid);
}

// ── API Cache Helper ──
const _AC = (key, ttl, fn) => async (req, res, next) => {
  try {
    const hit = cacheGet(key + (req.query ? JSON.stringify(req.query) : ''));
    if (hit) return res.json(hit);
    const data = await fn(req);
    cacheSet(key + (req.query ? JSON.stringify(req.query) : ''), data, ttl);
    res.json(data);
  } catch(e) { next(e); }
};

// ── Async error wrapper — يمنع unhandled rejections ──
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();
const { verifyWebApp } = require('../utils/webapp_auth');
const { rateLimit } = require('../utils/apiRateLimit');
// ✅ RBAC مركزي — نفس نظام الصلاحيات الموجود في database/admins.js (ALL_PERMS/hasPerm)
// كل admin route أدناه يجب أن يستخدم requirePerm('<perm>') أو requireOwner() بدل الفحص الثنائي القديم.
const { requirePerm, requireOwner } = require('../middlewares/rbac');

// ── Global rate limit: 60 req/min per user ──
router.use(rateLimit(60, 60000));
const content = require('../database/content');
const filesDb = require('../database/files');
const interactions = require('../database/interactions');
const usersDb = require('../database/users');
const { smartSearch } = require('../handlers/group');
const { cacheGet, cacheSet, cacheMGet } = require('../utils/cache');
const { all, get, run } = require('../database/db');

// ─── Auth middleware ────────────────────────────────
function auth(req, res, next) {
  const initData = req.headers['x-init-data'] || req.query.initData || '';
  const user = verifyWebApp(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.tgUser = user;
  next();
}

// ─── Endpoints ──────────────────────────────────────
router.get('/specialties', auth, async (req, res) => {
  const specs = await content.getSpecs();
  res.json(specs);
});

router.get('/years/:spId', auth, async (req, res) => {
  const data = await content.getYears(req.params.spId);
  res.json(data);
});

router.get('/semesters/:yrId', auth, async (req, res) => {
  res.json(await content.getSemesters(req.params.yrId));
});

router.get('/subjects/:smId', auth, async (req, res) => {
  res.json(await content.getSubjects(req.params.smId));
});

router.get('/categories/:sbId', auth, async (req, res) => {
  res.json(await content.getCategories(req.params.sbId));
});

router.get('/files/:catId', auth, async (req, res) => {
  res.json(await filesDb.getFiles(req.params.catId));
});

router.get('/file/:id', auth, async (req, res) => {
  const f = await filesDb.getFile(parseInt(req.params.id));
  if (!f) return res.status(404).json({ error: 'Not found' });
  const [rating, fav, comments] = await Promise.all([
    interactions.getAvgRating(parseInt(req.params.id)),
    interactions.isFav(parseInt(req.tgUser.id), req.params.id),
    get('SELECT COUNT(*) as c FROM comments WHERE file_id=$1 AND is_deleted=0', [parseInt(req.params.id)]).then(r => r?.c || 0),
  ]);
  res.json({ ...f, rating, fav, comments });
});

router.get('/search', auth, async (req, res) => {
  const q = (req.query.q || '').slice(0, 80);
  if (q.length < 2) return res.json([]);
  const key = 'api_search_' + q.toLowerCase();
  let cached = cacheGet(key);
  if (!cached) { cached = await smartSearch(q, 20); cacheSet(key, cached, 300000); }
  res.json(cached);
});

router.get('/profile', auth, async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const OWNER_ID = parseInt(process.env.OWNER_ID || '0');
  const isOwner = parseInt(uid) === OWNER_ID;
  const adm = await get('SELECT permissions FROM admins WHERE user_id=$1', [uid]);
  const [dlCount, favCount, cmtCount, ratingCount, spRow] = await Promise.all([
    interactions.getUserDownloadCount(uid),
    get('SELECT COUNT(*) as c FROM favorites WHERE user_id=$1', [uid]).then(r => r?.c || 0),
    get('SELECT COUNT(*) as c FROM comments WHERE user_id=$1 AND is_deleted=0', [uid]).then(r => r?.c || 0),
    get('SELECT COUNT(*) as c FROM ratings WHERE user_id=$1', [uid]).then(r => r?.c || 0),
    usersDb.getSpecialty(uid),
  ]);
  const sp = spRow?.specialty_id ? await content.getSpec(spRow.specialty_id) : null;
  res.json({ user: req.tgUser, dlCount, favCount, cmtCount, ratingCount, specialty: sp, isAdmin: isOwner || !!adm, isOwner });
});

router.get('/latest', auth, async (req, res) => {
  res.json(await filesDb.recentFiles(20));
});

router.post('/fav/:id', auth, async (req, res) => {
  const uid = parseInt(req.tgUser.id), fid = req.params.id;
  const isFav = await interactions.isFav(uid, fid);
  if (isFav) await interactions.removeFav(uid, fid);
  else await interactions.addFav(uid, fid);
  res.json({ fav: !isFav });
});

// إرسال الملف للمستخدم عبر البوت
router.post('/send/:id', auth, async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const fid = parseInt(req.params.id);

  // Cache الملف 10 دقائق
  const _ck = 'file_' + fid;
  let f = cacheGet(_ck);
  if (!f) { f = await filesDb.getFile(fid); if (f) cacheSet(_ck, f, 600000); }
  if (!f) return res.status(404).json({ error: 'Not found' });

  const bot = global.__bot;
  if (!bot) return res.status(500).json({ error: 'Bot unavailable' });

  // ✅ رد فوري للعميل — لا ينتظر Telegram
  res.json({ ok: true });

  // إرسال في الخلفية
  setImmediate(async () => {
    try {
      const cap = `📄 *${f.title}*${f.cat_name ? '\n📁 ' + f.cat_name : ''}${f.sub_name ? ' | 📖 ' + f.sub_name : ''}`;
      if      (f.file_type === 'link')  await bot.telegram.sendMessage (uid, cap + '\n\n🔗 ' + f.file_id, { parse_mode: 'Markdown' });
      else if (f.file_type === 'photo') await bot.telegram.sendPhoto   (uid, f.file_id, { caption: cap, parse_mode: 'Markdown' });
      else                              await bot.telegram.sendDocument(uid, f.file_id, { caption: cap, parse_mode: 'Markdown' });
      filesDb.incDownloads(fid);
      interactions.addHistory(uid, String(fid)).catch(() => {});
      try { require('../handlers/xp').onDownload(bot, uid).catch(()=>{}); } catch(_) {}
      try { if(f.uploaded_by && f.uploaded_by !== uid) require('../handlers/xp').onFileDownloaded(bot, f.uploaded_by).catch(()=>{}); } catch(_) {}
    } catch(e) {
      // أرسل خطأ للمستخدم مباشرة
      bot.telegram.sendMessage(uid, '❌ حدث خطأ أثناء إرسال الملف، حاول مجدداً.').catch(() => {});
    }
  });
});

router.get('/favorites', auth, async (req, res) => {
  try {
    const _favCk = 'favs_' + req.tgUser.id;
    const _favHit = cacheGet(_favCk);
    if (_favHit) return res.json(_favHit);
    const rows = await all(`SELECT f.*, s.name as sub_name FROM favorites fv JOIN files f ON f.id=fv.file_id LEFT JOIN subjects s ON s.id=(SELECT semester_id FROM categories c JOIN subjects sb ON sb.id=c.subject_id WHERE c.id=f.category_id LIMIT 1) WHERE fv.user_id=$1 AND f.is_deleted=0 ORDER BY f.uploaded_at DESC`, [parseInt(req.tgUser.id)]);
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.get('/comments/:id', auth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const rows = await all(
      `SELECT c.*, u.first_name FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.file_id=$1 AND c.is_deleted=0
       ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [parseInt(req.params.id), limit, offset]
    );
    const total = await get(
      'SELECT COUNT(*) as cnt FROM comments WHERE file_id=$1 AND is_deleted=0',
      [parseInt(req.params.id)]
    );
    res.json({ comments: rows, total: parseInt(total?.cnt || 0), limit, offset });
  } catch(e) { res.json([]); }
});

router.post('/comment/:id', auth, async (req, res) => {
  try {
    const { text } = sanitizeBody(req.body, { text: 500 });
    if (!text || text.trim().length < 1) return res.status(400).json({ error: 'empty' });
    await run(`INSERT INTO comments(file_id,user_id,text) VALUES($1,$2,$3)`, [req.params.id, parseInt(req.tgUser.id), text.trim()]);
    try { require('../handlers/xp').onComment(global.__bot, parseInt(req.tgUser.id)).catch(()=>{}); } catch(_) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/rate/:id', auth, async (req, res) => {
  try {
    const { rating } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'invalid' });
    await run(`INSERT INTO ratings(user_id,file_id,rating) VALUES($1,$2,$3) ON CONFLICT(user_id,file_id) DO UPDATE SET rating=$3`, [parseInt(req.tgUser.id), req.params.id, rating]);
    const _rCk = 'rating_' + req.params.id;
  let avg = cacheGet(_rCk);
  if (!avg) { avg = await get(`SELECT AVG(rating) as avg, COUNT(*) as cnt FROM ratings WHERE file_id=$1`, [parseInt(req.params.id)]); if(avg) cacheSet(_rCk, avg, 300000); }
    try { require('../handlers/xp').onRating(global.__bot, parseInt(req.tgUser.id)).catch(()=>{}); } catch(_) {}
    res.json({ ok: true, avg: avg.avg, cnt: avg.cnt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ℹ️ إعلامي فقط (لا يكشف بيانات حساسة) — يبقى فحص "أدمن بشكل عام" كافياً هنا،
// لأن الغرض منه هو إخبار الواجهة الأمامية بحالة/صلاحيات المستخدم نفسه فقط.
router.get('/admin/check', auth, async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  if (!await _checkAdmin(uid)) return res.status(403).json({ error: 'forbidden' });
  const isOwner = _isOwnerUid(uid);
  const adm = await get('SELECT permissions FROM admins WHERE user_id=$1', [uid]).catch(() => null);
  res.json({ ok: true, isOwner, perms: adm?.permissions || (isOwner ? 'full' : '') });
});

router.get('/admin/stats', auth, requirePerm('view_users'), async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const isOwner = _isOwnerUid(uid);
  try {
    const _statsCk = 'admin_stats';
    const _statsCached = cacheGet(_statsCk);
    if (_statsCached) return res.json(_statsCached);
    const [users, files, downloads, favs, comments, specs, admins] = await Promise.all([
      get('SELECT COUNT(*) as c FROM users WHERE is_banned=0'),
      get('SELECT COUNT(*) as c FROM files WHERE is_deleted=0'),
      get('SELECT COALESCE(SUM(downloads),0) as c FROM files WHERE is_deleted=0'),
      get('SELECT COUNT(*) as c FROM favorites'),
      get('SELECT COUNT(*) as c FROM comments WHERE is_deleted=0'),
      get('SELECT COUNT(*) as c FROM specialties WHERE is_deleted=0'),
      get('SELECT COUNT(*) as c FROM admins'),
    ]);
    const [recentUsers, topFiles, bannedCount] = await Promise.all([
      all('SELECT id,first_name,last_name,username,last_active,joined_at FROM users ORDER BY joined_at DESC LIMIT 10'),
      all('SELECT f.id,f.title,f.downloads,f.file_type FROM files f WHERE f.is_deleted=0 ORDER BY f.downloads DESC LIMIT 10'),
      get('SELECT COUNT(*) as c FROM users WHERE is_banned=1'),
    ]);
    const _statsResult = { users: users.c, files: files.c, downloads: downloads.c, favs: favs.c, comments: comments.c, specs: specs.c, admins: admins.c, banned: bannedCount.c, recentUsers, topFiles };
    cacheSet(_statsCk, _statsResult, 120000);
    res.json(_statsResult);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/users', auth, requirePerm('view_users'), async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const isOwner = _isOwnerUid(uid);
  const q = req.query.q || '';
  const page = parseInt(req.query.page || '0');
  const limit = 20;
  let rows;
  if (q) {
    rows = await all(
      `SELECT *, similarity(first_name, $3) as sim
       FROM users
       WHERE first_name ILIKE $1 OR username ILIKE $1 OR id::text=$2 OR first_name % $3
       ORDER BY sim DESC, joined_at DESC LIMIT $4 OFFSET $5`,
      [`%${q}%`, q, normalizeArabic(q), limit, page * limit]
    );
  } else {
    rows = await all(`SELECT * FROM users ORDER BY joined_at DESC LIMIT $1 OFFSET $2`, [limit, page * limit]);
  }
  res.json(rows);
});

// ✅ RBAC: كانت owner-only بدون سبب رغم وجود صلاحية 'ban_users' مخصصة لهذا الإجراء
// بالضبط ضمن ALL_PERMS — أصبحت الآن مربوطة بالصلاحية الصحيحة (Owner يبقى مسموحاً دائماً تلقائياً).
router.post('/admin/ban/:id', auth, requirePerm('ban_users'), async (req, res) => {
  const { ban } = req.body;
  await run('UPDATE users SET is_banned=$1 WHERE id=$2', [ban ? 1 : 0, parseInt(req.params.id)]);
  res.json({ ok: true });
});

router.get('/admin/files', auth, requirePerm('add_content'), async (req, res) => {
  const rows = await all(`SELECT f.*,c.name as cat_name FROM files f LEFT JOIN categories c ON c.id=f.category_id WHERE f.is_deleted=0 ORDER BY f.uploaded_at DESC LIMIT 50`);
  res.json(rows);
});

router.post('/admin/delfile/:id', auth, requirePerm('delete'), async (req, res) => {
  await run('UPDATE files SET is_deleted=1 WHERE id=$1', [parseInt(req.params.id)]);
  res.json({ ok: true });
});

// ═══ ADMIN ADVANCED ROUTES ═══

router.get('/admin/groups', auth, requirePerm('manage_groups'), async (req, res) => {
  try {
    const rows = await all(`SELECT gc.*, sp.name as sp_name, COUNT(gm.user_id) as members FROM group_chats gc LEFT JOIN specialties sp ON gc.specialty_id=sp.id LEFT JOIN group_members gm ON gc.chat_id=gm.chat_id GROUP BY gc.chat_id, gc.title, gc.specialty_id, gc.notify_new_files, gc.joined_at, sp.name ORDER BY members DESC`);
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ✅ RBAC: كانت owner-only رغم وجود صلاحية 'broadcast' مخصصة لهذا بالضبط ضمن ALL_PERMS —
// أصبحت مربوطة بالصلاحية الصحيحة (Owner يبقى مسموحاً دائماً تلقائياً عبر requirePerm).
router.post('/admin/broadcast', auth, requirePerm('broadcast'), async (req, res) => {
  const _sb308 = sanitizeBody(req.body, { text: 2000 }); const { text, target, specialtyId } = _sb308;
  if (!text) return res.status(400).json({ error: 'no text' });
  try {
    const usersDb = require('../database/users');
    const ids = target === 'groups'
      ? (specialtyId && specialtyId !== '0'
          ? (await all('SELECT chat_id as id FROM group_chats WHERE specialty_id=$1', [specialtyId])).map(r => r.id)
          : (await all('SELECT chat_id as id FROM group_chats')).map(r => r.id))
      : await usersDb.allIds();
    const bot = global.__bot;
    let sent = 0, failed = 0;
    const chunks = [];
    for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(id =>
        bot.telegram.sendMessage(id, text, { parse_mode: 'Markdown' })
          .then(() => sent++)
          .catch(() => failed++)
      ));
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ ok: true, sent, failed, total: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/specialties', auth, requirePerm('add_content'), async (req, res) => {
  const rows = await all('SELECT * FROM specialties WHERE is_deleted=0 ORDER BY id');
  res.json(rows);
});

router.get('/admin/reports', auth, requirePerm('add_content'), async (req, res) => {
  try {
    const rows = await all(`SELECT r.*, f.title as file_title, u.first_name FROM reports r LEFT JOIN files f ON f.id=r.file_id LEFT JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 30`);
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.post('/admin/report/:id/resolve', auth, requirePerm('add_content'), async (req, res) => {
  await run('UPDATE reports SET status=$1 WHERE id=$2', [req.body.status || 'resolved', parseInt(req.params.id)]);
  res.json({ ok: true });
});

// 🔒 حساس جداً: إدارة قائمة الأدمنية نفسها تبقى Owner-only دائماً — لا صلاحية أدمن تمنح هذا،
// لمنع privilege-escalation (أدمن يضيف/يحذف أدمنية آخرين).
router.get('/admin/admins', auth, requireOwner(), async (req, res) => {
  const rows = await all(`SELECT a.*, u.first_name, u.username FROM admins a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.added_at DESC`);
  res.json(rows);
});

router.post('/admin/removeadmin/:id', auth, requireOwner(), async (req, res) => {
  await run('DELETE FROM admins WHERE user_id=$1', [parseInt(req.params.id)]);
  res.json({ ok: true });
});
// ══════════════════════════════════════════════════════════════════
// أضف هذا كاملاً في routes/api.js قبل سطر module.exports = router;
// ══════════════════════════════════════════════════════════════════

// ─── رفع صورة/فيديو من الجهاز مباشرة ────────────────────────────
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

router.post('/admin/upload-media', (req, res, next) => {
  // ✅ تحقق HMAC حقيقي بدل قراءة uid بدون تحقق
  const initData = req.headers['x-init-data'] || '';
  const user = require('../utils/webapp_auth').verifyWebApp(initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.tgUser = user;
  next();
}, requirePerm('add_content'), upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file' });

    const isVideo = file.mimetype.startsWith('video/');
    const bot = global.__bot;
    if (!bot) return res.status(500).json({ error: 'bot not ready' });

    // أرسل للبوت باش نحصل على file_id
    let result;
    if (isVideo) {
      result = await bot.telegram.sendVideo(
        parseInt(process.env.OWNER_ID),
        { source: file.buffer, filename: file.originalname || 'video.mp4' },
        { caption: '📤 رفع إعلان' }
      );
    } else {
      result = await bot.telegram.sendPhoto(
        parseInt(process.env.OWNER_ID),
        { source: file.buffer, filename: file.originalname || 'image.jpg' },
        { caption: '📤 رفع إعلان' }
      );
    }

    // استخرج file_id
    const fileId = isVideo
      ? result.video?.file_id
      : (result.photo?.[result.photo.length - 1]?.file_id);

    if (!fileId) return res.status(500).json({ error: 'no file_id returned' });

    res.json({
      ok: true,
      file_id: fileId,
      type: isVideo ? 'video' : 'image'
    });

  } catch(e) {
    console.error('[upload-media]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── إصلاح بروفايل المستخدم (للأونر/أدمن) ──────────────────────
// احذف أو استبدل الـ route القديم /admin/user/:id/profile بهذا:
router.get('/admin/user/:id/profile', auth, requirePerm('view_users'), async (req, res) => {
  try {
    const targetId = req.params.id;

    // ── جلب المستخدم بدون specialty join ──
    const user = await get('SELECT * FROM users WHERE id=$1', [parseInt(targetId)]);
    if (!user) return res.status(404).json({ error: 'not found' });

    // ── جلب اسم التخصص بشكل منفصل ──
    let specialtyName = null;
    if (user.specialty_id) {
      const sp = await get('SELECT name FROM specialties WHERE id=$1', [user.specialty_id]).catch(() => null);
      specialtyName = sp?.name || null;
    }

    // ── إحصائيات ──
    const [pts, dlC, favC, cmtC, ratC] = await Promise.all([
      get('SELECT * FROM user_points WHERE user_id=$1', [parseInt(targetId)]).catch(() => null),
      get('SELECT COALESCE(downloads_count,0) as c FROM user_points WHERE user_id=$1', [parseInt(targetId)]).catch(() => ({ c: 0 })),
      get('SELECT COUNT(*) as c FROM favorites WHERE user_id=$1', [parseInt(targetId)]).catch(() => ({ c: 0 })),
      get('SELECT COUNT(*) as c FROM comments WHERE user_id=$1', [parseInt(targetId)]).catch(() => ({ c: 0 })),
      get('SELECT COUNT(*) as c FROM ratings WHERE user_id=$1', [parseInt(targetId)]).catch(() => ({ c: 0 })),
    ]);

    const isAdm = await get('SELECT * FROM admins WHERE user_id=$1', [parseInt(targetId)]).catch(() => null);

    res.json({
      id: user.id,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      username: user.username || null,
      is_banned: user.is_banned || false,
      joined_at: user.joined_at,
      specialty_name: specialtyName,
      total_points: pts?.total_points || 0,
      streak_days: pts?.streak_days || 0,
      downloads_count: parseInt(dlC?.c || 0),
      favs_count: parseInt(favC?.c || 0),
      comments_count: parseInt(cmtC?.c || 0),
      ratings_count: parseInt(ratC?.c || 0),
      is_admin: !!isAdm,
      permissions: isAdm?.permissions || null,
      is_owner: parseInt(targetId) === OWNER_ID,
    });
  } catch(e) {
    console.error('[profile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── بروفايل عام (لكل مستخدم) ────────────────────────────────────
router.get('/user/:id/profile', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const user = await get('SELECT * FROM users WHERE id=$1', [targetId]);
    if (!user) return res.status(404).json({ error: 'not found' });

    let specialtyName = null;
    if (user.specialty_id) {
      const sp = await get('SELECT name FROM specialties WHERE id=$1', [user.specialty_id]).catch(() => null);
      specialtyName = sp?.name || null;
    }

    const [pts, dlC, cmtC] = await Promise.all([
      get('SELECT total_points, streak_days FROM user_points WHERE user_id=$1', [targetId]).catch(() => null),
      get('SELECT COALESCE(downloads_count,0) as c FROM user_points WHERE user_id=$1', [targetId]).catch(() => ({ c: 0 })),
      get('SELECT COUNT(*) as c FROM comments WHERE user_id=$1', [targetId]).catch(() => ({ c: 0 })),
    ]);

    const isAdm = await get('SELECT permissions FROM admins WHERE user_id=$1', [targetId]).catch(() => null);
    const OWNER_ID = parseInt(process.env.OWNER_ID || '0');

    res.json({
      id: user.id,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      username: user.username || null,
      joined_at: user.joined_at,
      specialty_name: specialtyName,
      total_points: pts?.total_points || 0,
      streak_days: pts?.streak_days || 0,
      downloads_count: parseInt(dlC?.c || 0),
      comments_count: parseInt(cmtC?.c || 0),
      is_admin: !!isAdm,
      is_owner: targetId === OWNER_ID,
      permissions: isAdm?.permissions || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── قائمة الأدمنز العامة ─────────────────────────────────────────
router.get('/admins/public', auth, async (req, res) => {
  try {
    const OWNER_ID = parseInt(process.env.OWNER_ID || '0');
    const rows = await all(
      `SELECT a.user_id, a.permissions, a.added_at,
              u.first_name, u.last_name, u.username
       FROM admins a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.added_at ASC`
    );
    const ownerUser = await get('SELECT first_name, last_name, username FROM users WHERE id=$1', [OWNER_ID]).catch(() => null);
    const result = [];
    if (ownerUser) result.push({ ...ownerUser, user_id: OWNER_ID, permissions: 'owner', is_owner: true });
    result.push(...rows.filter(r => r.user_id !== OWNER_ID));
    res.json(result);
  } catch(e) { res.json([]); }
});

// ══════════════════════════════════════════════════════════════════
// routes_missing.js — أضف هذا كاملاً في api.js قبل module.exports
// ══════════════════════════════════════════════════════════════════

// ─── ملفات حديثة حسب التخصص ──────────────────────────────────────
router.get('/latest/specialty/:spId', auth, async (req, res) => {
  try {
    const spId = parseInt(req.params.spId);
    const rows = await all(
      `SELECT f.*, c.name as cat_name, s.name as sub_name, s.id as sub_id,
              sem.name as sem_name, y.name as year_name,
              f.downloads,
              COALESCE(r.avg,0) as rating_avg
       FROM files f
       JOIN categories c ON c.id = f.category_id
       JOIN subjects s ON s.id = c.subject_id
       JOIN semesters sem ON sem.id = s.semester_id
       JOIN years y ON y.id = sem.year_id
       LEFT JOIN (SELECT file_id, AVG(rating)::numeric(3,1) as avg FROM ratings GROUP BY file_id) r ON r.file_id=f.id
       WHERE y.specialty_id = $1::bigint
       ORDER BY f.uploaded_at DESC LIMIT 8`,
      [spId]
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ─── تحديث بروفايل المستخدم (الاسم فقط) ─────────────────────────
router.post('/profile/update', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const { first_name, last_name } = sanitizeBody(req.body, { first_name: 64, last_name: 64 });
    if (first_name) {
      await run(
        'UPDATE users SET first_name=$1, last_name=$2 WHERE id=$3',
        [first_name.trim(), (last_name||'').trim(), uid]
      ).catch(() => {}); // silently fail if column doesn't exist
    }
    const { cacheClear } = require('../utils/cache');
    cacheClear('prof_' + uid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── تحديث التخصص ────────────────────────────────────────────────
// (إذا لم يكن موجوداً مسبقاً)
router.post('/profile/specialty', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const { specialtyId } = req.body;
    await run('UPDATE users SET specialty_id=$1 WHERE id=$2', [specialtyId||null, uid]);
    const { cacheClear } = require('../utils/cache');
    cacheClear('prof_' + uid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── نقاط المستخدم ───────────────────────────────────────────────
router.get('/points/me', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const pts = await require('../database/points').getPoints(uid).catch(() => null);
    const rank = await require('../database/points').getUserRank(uid).catch(() => 999);
    const dlC = await get('SELECT COALESCE(downloads_count,0) as c FROM user_points WHERE user_id=$1',[uid]).catch(()=>({c:0}));
    const cmtC = await get('SELECT COUNT(*) as c FROM comments WHERE user_id=$1',[uid]).catch(()=>({c:0}));
    const ratC = await get('SELECT COUNT(*) as c FROM ratings WHERE user_id=$1',[uid]).catch(()=>({c:0}));
    res.json({
      total_points: pts?.total_points || 0,
      streak_days: pts?.streak_days || 0,
      downloads_count: parseInt(dlC?.c||0),
      comments_count: parseInt(cmtC?.c||0),
      ratings_count: parseInt(ratC?.c||0),
      rank: rank || 999,
    });
  } catch(e) { res.json({ total_points:0,downloads_count:0,comments_count:0,ratings_count:0,streak_days:0,rank:999 }); }
});

router.get('/points/rank', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const rank = await require('../database/points').getUserRank(uid).catch(() => 999);
    res.json({ rank: rank || 999 });
  } catch(e) { res.json({ rank: 999 }); }
});

router.get('/points/leaderboard', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit||'20'), 50);
    const lb = await require('../database/points').getLeaderboard(limit).catch(() => []);
    res.json(lb);
  } catch(e) { res.json([]); }
});

router.post('/points/daily', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const awarded = await require('../database/points').checkDailyLogin(uid).catch(() => false);
    // Also award XP for daily login
    if (awarded) {
      try { require('../handlers/xp').onDailyLogin(global.__bot, uid).catch(()=>{}); } catch(_) {}
    }
    res.json({ ok: true, awarded });
  } catch(e) { res.json({ ok: false }); }
});

// ─── سجل التحميل ─────────────────────────────────────────────────
router.get('/history', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const rows = await all(
      `SELECT f.*, c.name as cat_name, s.name as sub_name
       FROM history h
       JOIN files f ON f.id = h.file_id
       LEFT JOIN categories c ON c.id = f.category_id
       LEFT JOIN subjects s ON s.id = c.subject_id
       WHERE h.user_id=$1 AND f.is_deleted=0
       ORDER BY h.viewed_at DESC
       LIMIT 30`,
      [uid]
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ─── لايك التعليق ────────────────────────────────────────────────
router.post('/comment/:id/like', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const cid = parseInt(req.params.id);
    const ex = await get('SELECT 1 FROM comment_likes WHERE user_id=$1 AND comment_id=$2',[uid,cid]).catch(()=>null);
    if (ex) {
      await run('DELETE FROM comment_likes WHERE user_id=$1 AND comment_id=$2',[uid,cid]);
      await run('UPDATE comments SET likes=GREATEST(0,COALESCE(likes,0)-1) WHERE id=$1',[cid]).catch(()=>{});
      res.json({ liked: false });
    } else {
      await run('INSERT INTO comment_likes(user_id,comment_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[uid,cid]);
      await run('UPDATE comments SET likes=COALESCE(likes,0)+1 WHERE id=$1',[cid]).catch(()=>{});
      res.json({ liked: true });
    }
  } catch(e) { res.json({ liked: false }); }
});

// ─── إضافة مشرف جديد ──────────────────────────────────────────────
// 🔒 Owner-only (إدارة الأدمنية أنفسهم لا تُمنح لأي صلاحية أدمن — يمنع privilege escalation).
// ✅ RBAC fix: لم يعد يمنح 'full' تلقائياً عند عدم تحديد صلاحيات. يُعاد استخدام
// database/admins.js:add() الموجود مسبقاً (بدل SQL خام مباشر هنا) لأنه يطبّق
// sanitizePerms() ويرفض أي قيمة غير معروفة ضمن ALL_PERMS (fail-closed).
router.post('/admin/addadmin', auth, requireOwner(), async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const { userId, permissions } = req.body;
  const targetId = parseInt(userId);
  if (!userId || !Number.isFinite(targetId)) return res.status(400).json({ error: 'userId required' });
  if (!permissions || !String(permissions).trim()) {
    return res.status(400).json({ error: 'permissions required — يجب تحديد الصلاحيات صراحة، لا يوجد افتراضي "full"' });
  }
  try {
    const adminsDb = require('../database/admins');
    const clean = adminsDb.sanitizePerms(permissions);
    if (!clean) {
      return res.status(400).json({ error: 'invalid permissions — تحقق من القيم المسموحة', valid: Object.keys(adminsDb.ALL_PERMS) });
    }
    await adminsDb.add(targetId, uid, clean);
    res.json({ ok: true, permissions: clean });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── الإعلانات العامة ────────────────────────────────────────────
router.get('/ads', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const userRow = await get('SELECT specialty_id FROM users WHERE id=$1',[uid]).catch(()=>null);
    const spId = userRow?.specialty_id || null;
    const rows = await all(
      `SELECT * FROM ads WHERE is_deleted=0
       AND (specialty_id IS NULL${spId ? ' OR specialty_id=$1' : ''})
       ORDER BY is_pinned DESC, created_at DESC LIMIT 30`,
      spId ? [spId] : []
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ─── القنوات ─────────────────────────────────────────────────────
router.get('/channels', auth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM channels WHERE is_deleted=0 ORDER BY sort_order ASC, id DESC');
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ─── إنشاء إعلان ─────────────────────────────────────────────────
router.post('/admin/ads', auth, requirePerm('add_content'), async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const _sb753 = sanitizeBody(req.body, { title: 200, body: 2000, icon: 200, link: 500, image_url: 500, video_url: 500 }); const { title, body, icon, link, specialty_id, is_pinned, image_url, video_url } = _sb753;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    await run(
      `INSERT INTO ads(title,body,icon,link,specialty_id,is_pinned,created_by,image_url,video_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [title, body||null, icon||'📌', link||null, specialty_id||null, is_pinned?1:0, uid, image_url||null, video_url||null]
    );
    res.json({ ok: true });
  } catch(e) {
    // fallback بدون video_url إذا العمود غير موجود
    try {
      await run(
        `INSERT INTO ads(title,body,icon,link,specialty_id,is_pinned,created_by,image_url)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [title, body||null, icon||'📌', link||null, specialty_id||null, is_pinned?1:0, uid, image_url||video_url||null]
      );
      res.json({ ok: true });
    } catch(e2) { res.status(500).json({ error: e2.message }); }
  }
});

router.post('/admin/ads/:id/delete', auth, requirePerm('add_content'), async (req, res) => {
  try { await run('UPDATE ads SET is_deleted=1 WHERE id=$1',[parseInt(req.params.id)]); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── إنشاء قناة ──────────────────────────────────────────────────
router.post('/admin/channels', auth, requirePerm('add_content'), async (req, res) => {
  const uid = parseInt(req.tgUser.id);
  const { name, description, link, icon, members_count } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await run(
      'INSERT INTO channels(name,description,link,icon,members_count,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [name, description||null, link||null, icon||'📺', members_count||null, uid]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bundle Routes (API) ───────────────────────────────────────────

router.get('/bundles', auth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT b.*, COUNT(bf.id) as files_count
       FROM bundles b LEFT JOIN bundle_files bf ON bf.bundle_id = b.id
       WHERE b.is_deleted = 0
       GROUP BY b.id ORDER BY b.created_at DESC`
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.get('/bundles/category/:catId', auth, async (req, res) => {
  try {
    const _bck = 'bundles_cat_' + req.params.catId;
    const _bch = cacheGet(_bck); if (_bch) return res.json(_bch);
    const rows = await all(
      `SELECT b.*, COUNT(bf.id) as files_count
       FROM bundles b
       LEFT JOIN bundle_files bf ON bf.bundle_id = b.id
       WHERE b.category_id = $1 AND b.is_deleted = 0
       GROUP BY b.id ORDER BY b.created_at DESC`,
      [parseInt(req.params.catId)]
    );
    cacheSet(_bck, rows, 300000);
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.get('/bundles/:id', auth, async (req, res) => {
  try {
    const _bdk = 'bundle_' + req.params.id;
    const _bdh = cacheGet(_bdk); if (_bdh) return res.json(_bdh);
    const b = await get('SELECT * FROM bundles WHERE id=$1 AND is_deleted=0', [parseInt(req.params.id)]);
    if (!b) return res.status(404).json({ error: 'not found' });
    const files = await all(
      `SELECT f.* FROM files f
       JOIN bundle_files bf ON bf.file_id::int = f.id
       WHERE bf.bundle_id=$1 AND f.is_deleted=0
       ORDER BY bf.sort_order ASC`,
      [parseInt(req.params.id)]
    );
    const _bdRes = { ...b, files };
    cacheSet(_bdk, _bdRes, 300000);
    res.json(_bdRes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/send-bundle/:id', auth, async (req, res) => {
  try {
    const uid = parseInt(req.tgUser.id);
    const bot = global.__bot;
    if (!bot) return res.status(500).json({ error: 'Bot unavailable' });
    const b = await get('SELECT * FROM bundles WHERE id=$1 AND is_deleted=0', [parseInt(req.params.id)]);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const files = await all(
      `SELECT f.* FROM files f
       JOIN bundle_files bf ON bf.file_id::int = f.id
       WHERE bf.bundle_id=$1 AND f.is_deleted=0
       ORDER BY bf.sort_order ASC`,
      [parseInt(req.params.id)]
    );
    res.json({ ok: true });
    setImmediate(async () => {
      try {
        await bot.telegram.sendMessage(uid, `📦 *${b.title}*`, { parse_mode: 'Markdown' });
        for (const f of files) {
          try {
            if      (f.file_type === 'photo') await bot.telegram.sendPhoto(uid, f.file_id, { caption: f.title });
            else if (f.file_type === 'link')  await bot.telegram.sendMessage(uid, `🔗 ${f.title}\n${f.file_id}`);
            else                              await bot.telegram.sendDocument(uid, f.file_id, { caption: f.title });
          } catch(_) {}
          await new Promise(r => setTimeout(r, 300));
        }
        await bot.telegram.sendMessage(uid, `✅ اكتملت الحزمة: ${files.length} ملف`);
      } catch(_) {}
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Global Error Handler ──
router.use((err, req, res, next) => {
  const logger = require('../utils/logger');
  logger.error('[API]', err.message, { url: req.url, uid: req.tgUser?.id });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;

// ── Input length sanitizer (injected fix) ──
function sanitizeBody(obj, limits = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'string') {
      const max = limits[k] || 1000;
      out[k] = v.slice(0, max).trim();
    } else {
      out[k] = v;
    }
  }
  return out;
}
