'use strict';
const path   = require('path');
const logger = require('../utils/logger');

const USE_PG = !!process.env.DATABASE_URL;
let pgPool   = null;

// ── PostgreSQL Pool ──
function getPg() {
  if (pgPool) return pgPool;
  if (!USE_PG) return null;
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString:            process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
      max:                         15,   // 15 اتصال متزامن
      min:                         2,    // دائماً connection جاهزة
      idleTimeoutMillis:           20000,
      connectionTimeoutMillis:     3000,
      statement_timeout:           20000,
      keepAlive:                   true,
      keepAliveInitialDelayMillis: 10000,
    });

    pgPool.on('error', err => {
      // ✅ نسجّل الخطأ فقط — لا نحذف الـ pool لأن ذلك يسبب connection leak
      // الـ pool يعيد الاتصال تلقائياً
      logger.error('[DB] pool error (auto-recovering): ' + err.message);
    });

    // Keepalive ping كل 25 ثانية
    const _kpTimer = setInterval(() => {
      if (!pgPool) { clearInterval(_kpTimer); return; }
      pgPool.query('SELECT 1').catch(e => {
        // لا نحذف الـ pool — هو يعيد الاتصال تلقائياً
        require('../utils/logger').warn('[DB] keepalive failed (auto-recovering):', e.message);
      });
    }, 25000);
    _kpTimer.unref();

    logger.info('✅ PG Pool جاهز (max:15)');
    return pgPool;
  } catch(e) {
    logger.error('[DB] pool init error: ' + e.message);
    return null;
  }
}

// ── SQLite Fallback ──

async function getSQLite() {
  // SQLite disabled on Railway — PostgreSQL only
  return null;
}


// ── Public API ──
async function get(sql, params = []) {
  if (USE_PG) {
    const pool = getPg();
    if (!pool) throw new Error('No PG pool');
    try { const r = await pool.query(sql, params); return r.rows[0] || null; }
    catch(e) { logger.error('[DB] get: ' + e.message); throw e; }
  }
  const w = await getSQLite();
  if (!w) throw new Error('No SQLite');
  return sGet(w, sql, params);
}

async function all(sql, params = []) {
  if (USE_PG) {
    const pool = getPg();
    if (!pool) throw new Error('No PG pool');
    try { const r = await pool.query(sql, params); return r.rows; }
    catch(e) { logger.error('[DB] all: ' + e.message); throw e; }
  }
  const w = await getSQLite();
  if (!w) throw new Error('No SQLite');
  return sAll(w, sql, params);
}

async function run(sql, params = []) {
  // ⚡ Intercept download counter → batch بدل write مباشر
  if (
    sql.includes('downloads') &&
    (sql.includes('+ 1') || sql.includes('+1') || sql.includes('downloads+1') || sql.includes('downloads + 1')) &&
    sql.toLowerCase().includes('files')
  ) {
    const fid = params?.[0] ?? params?.[1];
    if (fid) { batchDownload(parseInt(fid)); return { changes: 1, lastID: 0 }; }
  }
  if (USE_PG) {
    const pool = getPg();
    if (!pool) throw new Error('No PG pool');
    try { await pool.query(sql, params); }
    catch(e) { logger.error('[DB] run: ' + e.message); throw e; }
    return;
  }
  const w = await getSQLite();
  if (!w) throw new Error('No SQLite');
  sRun(w, sql, params);
}

async function transaction(queries) {
  if (USE_PG) {
    const pool   = getPg();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { sql, params } of queries) await client.query(sql, params || []);
      await client.query('COMMIT');
    } catch(e) {
      await client.query('ROLLBACK').catch(err => { require('../utils/logger').debug("[silent]", err.message); });
      throw e;
    } finally { client.release(); }
    return;
  }
  const w = await getSQLite();
  if (!w) throw new Error('No SQLite');
  if (w.type === 'better') {
    const t = w.db.transaction(() => { for (const { sql, params } of queries) sRun(w, sql, params || []); });
    t();
  } else {
    for (const { sql, params } of queries) sRun(w, sql, params || []);
  }
}

// ── Schema ──
async function initSchema() {
  const pg = getPg();

  const TABLES = [
    "CREATE TABLE IF NOT EXISTS required_channels(id SERIAL PRIMARY KEY,channel_id TEXT NOT NULL UNIQUE,channel_name TEXT,channel_url TEXT,added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,is_active INTEGER DEFAULT 1)",
    "CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY,first_name TEXT,last_name TEXT,username TEXT,is_banned INTEGER DEFAULT 0,joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS admins(user_id BIGINT PRIMARY KEY,added_by BIGINT,permissions TEXT DEFAULT 'upload,add_content',specialty_id INTEGER DEFAULT 0,added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS specialties(id SERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,is_deleted INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS years(id SERIAL PRIMARY KEY,specialty_id INTEGER NOT NULL,name TEXT NOT NULL,is_deleted INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS semesters(id SERIAL PRIMARY KEY,year_id INTEGER NOT NULL,name TEXT NOT NULL,is_deleted INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS subjects(id SERIAL PRIMARY KEY,semester_id INTEGER NOT NULL,name TEXT NOT NULL,is_deleted INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS categories(id SERIAL PRIMARY KEY,subject_id INTEGER NOT NULL,name TEXT NOT NULL,is_deleted INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS files(id SERIAL PRIMARY KEY,category_id INTEGER NOT NULL,title TEXT NOT NULL,description TEXT DEFAULT '',file_id TEXT NOT NULL,file_type TEXT DEFAULT 'document',downloads INTEGER DEFAULT 0,uploaded_by BIGINT DEFAULT 0,is_deleted INTEGER DEFAULT 0,uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS favorites(user_id BIGINT,file_id INTEGER,PRIMARY KEY(user_id,file_id))",
    "CREATE TABLE IF NOT EXISTS history(id SERIAL PRIMARY KEY,user_id BIGINT,file_id INTEGER,viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS ratings(user_id BIGINT,file_id INTEGER,rating INTEGER,PRIMARY KEY(user_id,file_id))",
    "CREATE TABLE IF NOT EXISTS user_specialties(user_id BIGINT PRIMARY KEY,specialty_id INTEGER,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)",
    "CREATE TABLE IF NOT EXISTS bundles(id SERIAL PRIMARY KEY,category_id INTEGER NOT NULL,title TEXT NOT NULL,description TEXT DEFAULT '',downloads INTEGER DEFAULT 0,uploaded_by BIGINT DEFAULT 0,is_deleted INTEGER DEFAULT 0,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS bundle_files(id SERIAL PRIMARY KEY,bundle_id INTEGER NOT NULL,file_id TEXT NOT NULL,file_type TEXT DEFAULT 'document',title TEXT DEFAULT '')",
        `CREATE TABLE IF NOT EXISTS million_questions (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct CHAR(1) NOT NULL DEFAULT 'a',
      difficulty TEXT DEFAULT 'medium',
      category TEXT DEFAULT 'عام',
      used_count INTEGER DEFAULT 0,
      is_active SMALLINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE TABLE IF NOT EXISTS user_states(user_id BIGINT PRIMARY KEY,state TEXT NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS group_chats(chat_id BIGINT PRIMARY KEY,title TEXT,specialty_id INTEGER DEFAULT 0,notify_new_files INTEGER DEFAULT 1,joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS polls(id SERIAL PRIMARY KEY,chat_id BIGINT NOT NULL,created_by BIGINT,question TEXT,options TEXT,ends_at BIGINT,msg_id BIGINT,media_file_id TEXT,media_type TEXT,message_id BIGINT,is_closed INTEGER DEFAULT 0,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "ALTER TABLE polls ADD COLUMN IF NOT EXISTS options TEXT",
    "ALTER TABLE polls ADD COLUMN IF NOT EXISTS ends_at BIGINT",
    "ALTER TABLE polls ADD COLUMN IF NOT EXISTS msg_id BIGINT",
    "ALTER TABLE polls ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE",
    "CREATE TABLE IF NOT EXISTS poll_options(id SERIAL PRIMARY KEY,poll_id INTEGER NOT NULL,option_text TEXT NOT NULL,emoji TEXT DEFAULT '🔵',votes INTEGER DEFAULT 0,position INTEGER DEFAULT 1)",
    "CREATE TABLE IF NOT EXISTS poll_votes(poll_id INTEGER NOT NULL,option_id INTEGER NOT NULL,user_id BIGINT NOT NULL,voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(poll_id,user_id))",
    "CREATE TABLE IF NOT EXISTS ai_history(id SERIAL PRIMARY KEY,user_id BIGINT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS comments(id SERIAL PRIMARY KEY,file_id INTEGER NOT NULL,user_id BIGINT NOT NULL,text TEXT NOT NULL,is_deleted INTEGER DEFAULT 0,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS reports(id SERIAL PRIMARY KEY,file_id INTEGER NOT NULL,user_id BIGINT NOT NULL,reason TEXT,status TEXT DEFAULT 'pending',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS user_points(user_id BIGINT PRIMARY KEY,total_points INTEGER DEFAULT 0,downloads_count INTEGER DEFAULT 0,ratings_count INTEGER DEFAULT 0,comments_count INTEGER DEFAULT 0,streak_days INTEGER DEFAULT 0,last_activity_date DATE,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS group_members(chat_id BIGINT,user_id BIGINT,username TEXT,first_name TEXT,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(chat_id,user_id))",
    "CREATE TABLE IF NOT EXISTS group_notify_log(id SERIAL PRIMARY KEY,file_id INTEGER NOT NULL,chat_id BIGINT NOT NULL,sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE(file_id,chat_id))",
    "CREATE TABLE IF NOT EXISTS logs(id SERIAL PRIMARY KEY,user_id BIGINT,action TEXT,details TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS message_templates(id SERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,type TEXT DEFAULT 'text',content TEXT DEFAULT '',file_id TEXT DEFAULT '',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS scheduled_messages(id SERIAL PRIMARY KEY,template_id INTEGER,target TEXT DEFAULT 'all',specialty_id INTEGER DEFAULT 0,send_at TEXT,sent INTEGER DEFAULT 0,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS group_bot_msgs(id SERIAL PRIMARY KEY,chat_id BIGINT NOT NULL,message_id BIGINT NOT NULL,sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS group_welcome(chat_id BIGINT PRIMARY KEY,image_file_id TEXT,message TEXT,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS cache_store(key TEXT PRIMARY KEY,value TEXT,expires_at BIGINT)",
    "CREATE TABLE IF NOT EXISTS ads(id SERIAL PRIMARY KEY,title TEXT NOT NULL,body TEXT,icon TEXT DEFAULT '📌',link TEXT,specialty_id INTEGER,is_pinned INTEGER DEFAULT 0,is_deleted INTEGER DEFAULT 0,image_url TEXT,video_url TEXT,created_by BIGINT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS channels(id SERIAL PRIMARY KEY,name TEXT NOT NULL,description TEXT,link TEXT,icon TEXT DEFAULT '📺',members_count INTEGER,sort_order INTEGER DEFAULT 0,is_deleted INTEGER DEFAULT 0,created_by BIGINT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS comment_likes(user_id BIGINT NOT NULL,comment_id INTEGER NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,comment_id))",
    "CREATE TABLE IF NOT EXISTS downloads(id SERIAL PRIMARY KEY,user_id BIGINT NOT NULL,file_id INTEGER NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  ];

  for (const sql of TABLES) {
    try {
      if (pg) await pg.query(sql);
      else { const w = await getSQLite(); if (w) sRun(w, sql.replace(/SERIAL/g, 'INTEGER').replace(/BIGINT/g, 'INTEGER'), []); }
    } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  }

  // ── Indexes — الأصليين + الجدد المحسّنين ──
  if (pg) {
    const IDX = [
      "CREATE INDEX IF NOT EXISTS idx_files_category   ON files(category_id)",
      "CREATE INDEX IF NOT EXISTS idx_files_cat_del    ON files(category_id,is_deleted)",
      "CREATE INDEX IF NOT EXISTS idx_files_deleted    ON files(is_deleted)",
      "CREATE INDEX IF NOT EXISTS idx_files_downloads  ON files(downloads DESC)",
      "CREATE INDEX IF NOT EXISTS idx_files_uploader   ON files(uploaded_by)",
      "CREATE INDEX IF NOT EXISTS idx_history_user     ON history(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_history_time     ON history(user_id,viewed_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_favorites_user   ON favorites(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_favorites_file   ON favorites(file_id)",
      "CREATE INDEX IF NOT EXISTS idx_ratings_file     ON ratings(file_id)",
      "CREATE INDEX IF NOT EXISTS idx_ratings_avg      ON ratings(file_id,rating)",
      "CREATE INDEX IF NOT EXISTS idx_comments_file    ON comments(file_id)",
      "CREATE INDEX IF NOT EXISTS idx_user_points      ON user_points(total_points DESC)",
      "CREATE INDEX IF NOT EXISTS idx_users_active     ON users(last_active)",
      "CREATE INDEX IF NOT EXISTS idx_cats_subject     ON categories(subject_id,is_deleted)",
      "CREATE INDEX IF NOT EXISTS idx_subs_sem         ON subjects(semester_id,is_deleted)",
      "CREATE INDEX IF NOT EXISTS idx_sems_year        ON semesters(year_id,is_deleted)",
      "CREATE INDEX IF NOT EXISTS idx_years_spec       ON years(specialty_id,is_deleted)",
      "CREATE INDEX IF NOT EXISTS idx_bundle_files     ON bundle_files(bundle_id)",

      // ✅ جدد — تسرّع أكثر الـ queries استخداماً
      "CREATE INDEX IF NOT EXISTS idx_files_uploaded   ON files(uploaded_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_reports_status   ON reports(status,created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_files_search     ON files USING gin(to_tsvector('simple', title))",
      "CREATE INDEX IF NOT EXISTS idx_group_chats_spec ON group_chats(specialty_id)",
      "CREATE INDEX IF NOT EXISTS idx_users_banned     ON users(is_banned,joined_at DESC)",               // latest files
      // REMOVED duplicate: idx_users_banned simple (composite one above covers it)
      "CREATE INDEX IF NOT EXISTS idx_history_file     ON history(file_id)",                      // file stats
      "CREATE INDEX IF NOT EXISTS idx_comments_del     ON comments(file_id, is_deleted)",         // comments query
      "CREATE INDEX IF NOT EXISTS idx_ai_history_user  ON ai_history(user_id, created_at DESC)",  // AI chat history
      "CREATE INDEX IF NOT EXISTS idx_user_states_upd  ON user_states(updated_at)",               // cleanup
      "CREATE INDEX IF NOT EXISTS idx_gnl_chat         ON group_notify_log(chat_id)",             // group notify
      "CREATE INDEX IF NOT EXISTS idx_sched_sent       ON scheduled_messages(sent, send_at)",     // scheduler
      "CREATE INDEX IF NOT EXISTS idx_ads_deleted      ON ads(is_deleted,created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_channels_sort    ON channels(sort_order ASC,id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_downloads_user   ON downloads(user_id,created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_downloads_file   ON downloads(file_id)",               // bundle files

      // ✅ فهارس أداء إضافية — بروفايل المستخدم + نظام البنك
      "CREATE INDEX IF NOT EXISTS idx_comments_user    ON comments(user_id)",                // profile stats
      "CREATE INDEX IF NOT EXISTS idx_pro_bank_loans_user ON pro_bank_loans(user_id)",        // bank_pro loans
      "CREATE INDEX IF NOT EXISTS idx_pro_bank_inv_user   ON pro_bank_investments(user_id)",  // bank_pro investments
      "CREATE INDEX IF NOT EXISTS idx_bank_loans_user     ON bank_loans(user_id)",            // legacy bank
    ];
    for (const idx of IDX) {
      try { await pg.query(idx); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
    }
    

      logger.info('✅ Indexes جاهزة (' + IDX.length + ')');
  }

  // migration: created_at في users
  try { if(pg) await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // grp_approved و group_watching
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS grp_approved (
    chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, approved_by BIGINT,
    created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(chat_id,user_id))`); } catch(e) {}
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS group_watching (
    chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, admin_id BIGINT,
    created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(chat_id,user_id))`); } catch(e) {}

  // group_last_welcome (كان في group_pro.js اللي ما يُستدعى)
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS group_last_welcome (
    chat_id BIGINT PRIMARY KEY, msg_id BIGINT
  )`); } catch(err) { require('./logger').debug('[catch]', err.message); }

  // group_messages
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS group_messages (
    id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`); } catch(err) { require('./logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_group_messages_chat ON group_messages(chat_id)'); } catch(err) { require('./logger').debug('[catch]', err.message); }

  // إصلاح sequence جدول years (كان مكسور بسبب duplicate key)
  try { if(pg) await pg.query(`SELECT setval('years_id_seq', COALESCE((SELECT MAX(id) FROM years), 1), true)`); } catch(e) { require('./logger').debug('[years_seq]', e.message); }
  try { if(pg) await pg.query(`SELECT setval('specialties_id_seq', COALESCE((SELECT MAX(id) FROM specialties), 1), true)`); } catch(e) { require('./logger').debug('[specialties_seq]', e.message); }
  try { if(pg) await pg.query(`SELECT setval('semesters_id_seq', COALESCE((SELECT MAX(id) FROM semesters), 1), true)`); } catch(e) { require('./logger').debug('[semesters_seq]', e.message); }
  try { if(pg) await pg.query(`SELECT setval('subjects_id_seq', COALESCE((SELECT MAX(id) FROM subjects), 1), true)`); } catch(e) { require('./logger').debug('[subjects_seq]', e.message); }
  try { if(pg) await pg.query(`SELECT setval('categories_id_seq', COALESCE((SELECT MAX(id) FROM categories), 1), true)`); } catch(e) { require('./logger').debug('[categories_seq]', e.message); }
  try { if(pg) await pg.query(`SELECT setval('files_id_seq', COALESCE((SELECT MAX(id) FROM files), 1), true)`); } catch(e) { require('./logger').debug('[files_seq]', e.message); }

  // migration: specialty_id في users
  try { if(pg) await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty_id INTEGER'); } catch(err) { require('./logger').debug('[catch]', err.message); }

  // member_cards migrations
  try { if(pg) await pg.query('ALTER TABLE member_cards ADD COLUMN IF NOT EXISTS trigger_word TEXT'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE member_cards ADD COLUMN IF NOT EXISTS first_name TEXT'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE member_cards ADD COLUMN IF NOT EXISTS username TEXT'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE member_cards ADD COLUMN IF NOT EXISTS photo_file_id TEXT'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE member_cards ADD COLUMN IF NOT EXISTS bio TEXT'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE member_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // member_cards tables
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS member_cards (
    chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
    trigger_word TEXT, photo_file_id TEXT, bio TEXT,
    username TEXT, first_name TEXT, updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY(chat_id, user_id))`); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS member_card_triggers (
    chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, trigger_word TEXT NOT NULL,
    PRIMARY KEY(chat_id, trigger_word))`); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // Migration: history unique constraint
  try { if(pg) await pg.query('ALTER TABLE history ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('DELETE FROM history h1 USING history h2 WHERE h1.id > h2.id AND h1.user_id = h2.user_id AND h1.file_id = h2.file_id'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE history ADD CONSTRAINT IF NOT EXISTS hist_user_file_unique UNIQUE (user_id, file_id)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // Migration: history unique constraint
  try { if(pg) await pg.query('ALTER TABLE history ADD CONSTRAINT hist_user_file_unique UNIQUE (user_id, file_id)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // Migration: auto_replies table
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS auto_replies (
    id SERIAL PRIMARY KEY,
    trigger TEXT NOT NULL,
    response TEXT NOT NULL,
    match_type TEXT DEFAULT 'contains',
    is_active INTEGER DEFAULT 1,
    created_by BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_auto_replies_active ON auto_replies(is_active)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }


  // ── جداول الميزات الجديدة ──
  try { await pg.query(`CREATE TABLE IF NOT EXISTS afk_users(
    user_id BIGINT PRIMARY KEY, reason TEXT DEFAULT '',
    since TIMESTAMPTZ DEFAULT NOW(), is_afk SMALLINT DEFAULT 1
  )`); } catch(_) {}
  try { await pg.query(`CREATE TABLE IF NOT EXISTS couple_of_day(
    id SERIAL PRIMARY KEY, chat_id BIGINT, date TEXT,
    user1_id BIGINT, user2_id BIGINT, name1 TEXT, name2 TEXT,
    UNIQUE(chat_id, date)
  )`); } catch(_) {}
  try { await pg.query(`CREATE TABLE IF NOT EXISTS notes(
    id SERIAL PRIMARY KEY, chat_id BIGINT, name TEXT,
    content TEXT, file_id TEXT, note_type TEXT DEFAULT 'text',
    created_by BIGINT, UNIQUE(chat_id, name)
  )`); } catch(_) {}
  // migration: إصلاح جدول notes قديم بدون chat_id
  try { await pg.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS chat_id BIGINT'); } catch(_) {}
  try { await pg.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS name TEXT'); } catch(_) {}
  try { await pg.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS content TEXT'); } catch(_) {}
  try { await pg.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS file_id TEXT'); } catch(_) {}
  try { await pg.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS note_type TEXT DEFAULT \'text\''); } catch(_) {}
  try { await pg.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS created_by BIGINT'); } catch(_) {}
  try {
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'notes_chat_name_unique'
        ) THEN
          ALTER TABLE notes ADD CONSTRAINT notes_chat_name_unique UNIQUE(chat_id, name);
        END IF;
      END $$;
    `);
  } catch(e) { require('../utils/logger').debug('[notes constraint]', e.message); }
  try { await pg.query(`CREATE TABLE IF NOT EXISTS blacklist_words(
    id SERIAL PRIMARY KEY, chat_id BIGINT, word TEXT,
    action TEXT DEFAULT 'delete', added_by BIGINT,
    UNIQUE(chat_id, word)
  )`); } catch(_) {}
  try { await pg.query(`CREATE TABLE IF NOT EXISTS group_locks(
    chat_id BIGINT PRIMARY KEY,
    lock_sticker SMALLINT DEFAULT 0, lock_gif SMALLINT DEFAULT 0,
    lock_link SMALLINT DEFAULT 0, lock_forward SMALLINT DEFAULT 0,
    lock_photo SMALLINT DEFAULT 0, lock_video SMALLINT DEFAULT 0,
    lock_voice SMALLINT DEFAULT 0, lock_poll SMALLINT DEFAULT 0
  )`); } catch(_) {}

  

  try { await pg.query("ALTER TABLE million_sessions ADD COLUMN IF NOT EXISTS started_by BIGINT DEFAULT 0"); } catch(_) {}

    // Migration: توحيد أعمدة million_questions
  try {
    await pg.query("ALTER TABLE million_questions RENAME COLUMN question TO text").catch(()=>{});
  } catch(_) {}
  try {
    await pg.query("ALTER TABLE million_questions RENAME COLUMN correct_answer TO correct").catch(()=>{});
  } catch(_) {}
  try {
    await pg.query("ALTER TABLE million_questions ADD COLUMN IF NOT EXISTS resp_type TEXT DEFAULT 'text'").catch(()=>{});
  } catch(_) {}

    // ── Seed أسئلة المليون إذا DB فارغة ──
  try {
    const qCount = await pg.query('SELECT COUNT(*) as c FROM million_questions WHERE is_active=1');
    if (parseInt(qCount.rows[0].c) < 5) {
      const QS = [
        {q:'ما هي عاصمة الجزائر؟',a:'a',opts:['الجزائر','وهران','قسنطينة','عنابة'],d:'easy'},
        {q:'كم عدد اضلاع المثلث؟',a:'b',opts:['4','3','5','6'],d:'easy'},
        {q:'من اكتشف الجاذبية؟',a:'c',opts:['انشتاين','داروين','نيوتن','غاليليو'],d:'medium'},
        {q:'اكبر قارة في العالم؟',a:'a',opts:['اسيا','افريقيا','اوروبا','امريكا'],d:'easy'},
        {q:'كم تساوي 15x15؟',a:'c',opts:['200','215','225','250'],d:'medium'},
        {q:'متى قامت الثورة الجزائرية؟',a:'b',opts:['1952','1954','1956','1958'],d:'medium'},
        {q:'اسرع حيوان بري؟',a:'a',opts:['الفهد','الاسد','الغزال','الحصان'],d:'medium'},
        {q:'كم حاسة للانسان؟',a:'b',opts:['4','5','6','7'],d:'easy'},
        {q:'من كتب البؤساء؟',a:'d',opts:['ديكنز','بلزاك','تولستوي','فيكتور هوغو'],d:'medium'},
        {q:'الرمز الكيميائي للذهب؟',a:'c',opts:['Gl','Gd','Au','Go'],d:'medium'},
        {q:'اطول نهر في العالم؟',a:'a',opts:['النيل','الامازون','المسيسيبي','اليانغتسي'],d:'medium'},
        {q:'برج ايفل في اي بلد؟',a:'b',opts:['ايطاليا','فرنسا','اسبانيا','بلجيكا'],d:'easy'},
        {q:'عملة السعودية؟',a:'c',opts:['دينار','درهم','ريال','قرش'],d:'easy'},
        {q:'عدد لاعبي كرة القدم لكل فريق؟',a:'b',opts:['10','11','12','9'],d:'easy'},
        {q:'من اخترع الهاتف؟',a:'a',opts:['غراهام بيل','اديسون','تسلا','ماركوني'],d:'medium'},
        {q:'اقرب كوكب للشمس؟',a:'a',opts:['عطارد','الزهرة','الارض','المريخ'],d:'medium'},
        {q:'من بنى الاهرامات؟',a:'b',opts:['الرومان','المصريون القدامى','الاغريق','الفرس'],d:'easy'},
        {q:'كم ساعة في الاسبوع؟',a:'d',opts:['148','158','162','168'],d:'medium'},
        {q:'عدد ركائز الاسلام؟',a:'b',opts:['4','5','6','7'],d:'easy'},
        {q:'عاصمة اليابان؟',a:'c',opts:['اوساكا','كيوتو','طوكيو','ناغويا'],d:'easy'},
        {q:'من فاز بكاس العالم 2022؟',a:'b',opts:['فرنسا','الارجنتين','البرازيل','المغرب'],d:'medium'},
        {q:'اكبر مدينة في العالم سكانا؟',a:'a',opts:['طوكيو','شنغهاي','دلهي','بكين'],d:'medium'},
        {q:'كم عدد ابراج الفلك؟',a:'c',opts:['10','11','12','13'],d:'medium'},
        {q:'من رسم الموناليزا؟',a:'a',opts:['ليوناردو دافينشي','مايكل انجلو','رافاييل','بيكاسو'],d:'medium'},
        {q:'اعمق بحيرة في العالم؟',a:'b',opts:['بحيرة فيكتوريا','بايكال','تيتيكاكا','سوبيريور'],d:'hard'},
        {q:'عدد عظام الجسم البالغ؟',a:'c',opts:['196','200','206','210'],d:'hard'},
        {q:'اعلى قمة في العالم؟',a:'a',opts:['ايفرست','k2','كانشنجانغا','لوتسه'],d:'medium'},
        {q:'اول رائد فضاء في التاريخ؟',a:'b',opts:['نيل ارمسترونغ','يوري غاغارين','بوز الدرين','فالنتينا'],d:'medium'},
        {q:'عاصمة كندا؟',a:'c',opts:['تورنتو','مونتريال','اوتاوا','فانكوفر'],d:'medium'},
        {q:'اكبر محيط في العالم؟',a:'a',opts:['الهادي','الاطلسي','الهندي','المتجمد الشمالي'],d:'easy'},
        {q:'كم دقيقة في اليوم؟',a:'d',opts:['1200','1320','1400','1440'],d:'medium'},
        {q:'عدد الكروموسومات في الخلية البشرية؟',a:'b',opts:['23','46','48','22'],d:'hard'},
        {q:'اكثر معدن ثقلا في الطبيعة؟',a:'c',opts:['الرصاص','الذهب','الاوزميوم','البلاتين'],d:'hard'},
        {q:'الغاز الاكثر وفرة في الغلاف الجوي؟',a:'b',opts:['الاوكسجين','النيتروجين','ثاني اكسيد الكربون','الهيدروجين'],d:'hard'},
        {q:'من كتب الف ليلة وليلة؟',a:'d',opts:['ابن سينا','الجاحظ','ابن خلدون','مجهول'],d:'hard'},
      ];
      for (const q of QS) {
        await pg.query(
          'INSERT INTO million_questions(text,option_a,option_b,option_c,option_d,correct,difficulty) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [q.q, q.opts[0], q.opts[1], q.opts[2], q.opts[3], q.a, q.d]
        ).catch(()=>{});
      }
      console.log('[DB] ✅ أسئلة المليون أضيفت تلقائياً');
    }
  } catch(_) {}

  // Migration: auto_reactions
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS auto_reactions (
    id SERIAL PRIMARY KEY,
    trigger TEXT NOT NULL,
    emoji TEXT NOT NULL,
    match_type TEXT DEFAULT 'contains',
    is_active SMALLINT DEFAULT 1,
    created_by BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`); } catch(_) {}

  // Migration: resp_type و file_id لجدول auto_replies
  try { if(pg) await pg.query("ALTER TABLE auto_replies ADD COLUMN IF NOT EXISTS resp_type TEXT DEFAULT 'text'"); } catch(_) {}
  try { if(pg) await pg.query("ALTER TABLE auto_replies ADD COLUMN IF NOT EXISTS file_id TEXT"); } catch(_) {}
  // Migration: group_members is_bot + group_chats log_channel
  try { if(pg) await pg.query('ALTER TABLE group_members ADD COLUMN IF NOT EXISTS is_bot INTEGER DEFAULT 0'); } catch(_) {}
  try { if(pg) await pg.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS log_channel TEXT'); } catch(_) {}
  try { if(pg) await pg.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS added_by BIGINT'); } catch(_) {}

  // Migration: group_chats is_active column
  try { if(pg) await pg.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // Migration: group_bans + anti_spam columns
  try { if(pg) await pg.query(`CREATE TABLE IF NOT EXISTS group_bans (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, banned_by BIGINT, reason TEXT, banned_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(chat_id, user_id))`); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS anti_spam INTEGER DEFAULT 0'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS anti_link INTEGER DEFAULT 0'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS anti_flood INTEGER DEFAULT 0'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // Migration: used_count
  try { if(pg) await pg.query('ALTER TABLE million_questions ADD COLUMN IF NOT EXISTS used_count INTEGER DEFAULT 0'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_mq_used ON million_questions(used_count) WHERE is_active=1'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  // ── Migrations: pg_trgm + search indexes ──
  try { if(pg) await pg.query('CREATE EXTENSION IF NOT EXISTS pg_trgm'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query("CREATE INDEX IF NOT EXISTS idx_files_fts ON files USING GIN(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'')))"); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_files_title_trgm ON files USING GIN(title gin_trgm_ops)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_files_desc_trgm  ON files USING GIN(description gin_trgm_ops)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('CREATE INDEX IF NOT EXISTS idx_users_name_trgm  ON users USING GIN(first_name gin_trgm_ops)'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

// ── Migrations: جداول bundle_files.sort_order + bio ──
  try { if(pg) await pg.query('ALTER TABLE bundle_files ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT NULL'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }
  try { if(pg) await pg.query('ALTER TABLE comments ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0'); } catch(err) { require('../utils/logger').debug('[catch]', err.message); }

  logger.info('✅ Schema ready');
}

async function getSetting(k) {
  const r = await get('SELECT value FROM settings WHERE key=$1', [k]);
  return r ? r.value : null;
}

async function setSetting(k, v) {
  await run('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
}

function saveDB() {}

// ── Batch Download Counter ──────────────────────────────────────
const _dlBatch = new Map();

function batchDownload(fileId) {
  const id = parseInt(fileId);
  if (!id) return;
  _dlBatch.set(id, (_dlBatch.get(id) || 0) + 1);
}

async function _flushDlBatch() {
  if (!_dlBatch.size) return;
  const pg = getPg();
  if (!pg) return;
  const entries = [..._dlBatch];
  _dlBatch.clear();
  await Promise.all(
    entries.map(([fid, cnt]) =>
      pg.query('UPDATE files SET downloads = downloads + $1 WHERE id = $2', [cnt, fid]).catch(e => logger.error('[DL]', e.message))
    )
  );
}

setInterval(_flushDlBatch, 30000).unref(); // flush كل 30 ثانية


// ── Prepared Statements — تُعدَّل مرة واحدة لكل connection ──────
const PREPARED = {
  getFile:    { name: 'get_file',     text: 'SELECT * FROM files WHERE id=$1 AND is_deleted=0' },
  getUser:    { name: 'get_user',     text: 'SELECT * FROM users WHERE id=$1' },
  addHistory: { name: 'add_hist',     text: 'INSERT INTO history(user_id,file_id,viewed_at) VALUES($1,$2,NOW()) ON CONFLICT DO NOTHING' },
  getCats:    { name: 'get_cats',     text: 'SELECT * FROM categories WHERE subject_id=$1 AND is_deleted=0 ORDER BY name ASC' },
  getFav:     { name: 'get_fav',      text: 'SELECT 1 FROM favorites WHERE user_id=$1 AND file_id=$2' },
  getAdm:     { name: 'get_adm',      text: 'SELECT permissions FROM admins WHERE user_id=$1' },
  getBan:     { name: 'get_ban',      text: 'SELECT is_banned FROM users WHERE id=$1' },
};

async function queryP(name, values) {
  const pg = await getPg();
  if (!pg) return null;
  const stmt = PREPARED[name];
  if (!stmt) throw new Error('Unknown prepared statement: ' + name);
  const r = await pg.query({ name: stmt.name, text: stmt.text, values });
  return r.rows;
}

async function getP(name, values) {
  const rows = await queryP(name, values);
  return rows?.[0] || null;
}


// ══════════════════════════════════════════
// Group Management Pro — schema
// ══════════════════════════════════════════
async function migrateGroupPro() {
  if (!pg) return;
  const queries = [
    `CREATE TABLE IF NOT EXISTS grp_settings (
      chat_id BIGINT PRIMARY KEY,
      anti_spam BOOLEAN DEFAULT false,
      anti_link BOOLEAN DEFAULT false,
      anti_flood BOOLEAN DEFAULT false,
      anti_forward BOOLEAN DEFAULT false,
      anti_short_link BOOLEAN DEFAULT false,
      anti_invite BOOLEAN DEFAULT false,
      anti_new_account BOOLEAN DEFAULT false,
      anti_bot BOOLEAN DEFAULT false,
      anti_mention BOOLEAN DEFAULT false,
      anti_media BOOLEAN DEFAULT false,
      anti_file BOOLEAN DEFAULT false,
      anti_arabic_repeat BOOLEAN DEFAULT false,
      anti_edit BOOLEAN DEFAULT false,
      max_warns INTEGER DEFAULT 3,
      flood_limit INTEGER DEFAULT 5,
      flood_window INTEGER DEFAULT 5,
      max_msg_length INTEGER DEFAULT 4000,
      warn_action TEXT DEFAULT 'mute',
      escalation TEXT DEFAULT 'warn,mute10,mute60,ban',
      auto_reset_days INTEGER DEFAULT 30,
      updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE grp_settings ADD COLUMN IF NOT EXISTS anti_repeat BOOLEAN DEFAULT false`,
    `ALTER TABLE grp_settings ADD COLUMN IF NOT EXISTS repeat_limit INTEGER DEFAULT 3`,
    `ALTER TABLE grp_settings ADD COLUMN IF NOT EXISTS max_mentions INTEGER DEFAULT 5`,
    `ALTER TABLE grp_settings ADD COLUMN IF NOT EXISTS min_account_age_days INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS grp_logs (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      target_id BIGINT,
      by_id BIGINT,
      reason TEXT,
      extra TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_grp_logs_chat ON grp_logs(chat_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS grp_member_stats (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      msg_count INTEGER DEFAULT 0,
      warn_count INTEGER DEFAULT 0,
      mute_count INTEGER DEFAULT 0,
      ban_count INTEGER DEFAULT 0,
      violations INTEGER DEFAULT 0,
      joined_at TIMESTAMP DEFAULT NOW(),
      last_active TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id)
    )`,
    `ALTER TABLE grp_member_stats ADD COLUMN IF NOT EXISTS violations INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS grp_roles (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT DEFAULT '',
      assigned_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS grp_blacklist_words (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      word TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  ];
  for (const q of queries) {
    await pg.query(q).catch(e => {
      if (!e.message?.includes('already exists')) console.error('[GroupPro Migration]', e.message);
    });
  }
  console.log('✅ [GroupPro] Migration complete');
}

module.exports = {
  migrateGroupPro, batchDownload, queryP, getP, get, all, run, transaction, getPg, initSchema, getSetting, setSetting, saveDB };
// هذا السطر ما يضاف هنا — شغّل الكومند التالي مباشرة على DB

// ── Migration: جداول البنك ──
async function initBankTables() {
  const pg = getPg();
  if (!pg) return;
  try {
    await pg.query('CREATE TABLE IF NOT EXISTS bank_accounts(user_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, balance NUMERIC DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pg.query('CREATE TABLE IF NOT EXISTS bank_transactions(id SERIAL PRIMARY KEY, from_id BIGINT, to_id BIGINT, amount NUMERIC, type TEXT, note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pg.query('CREATE TABLE IF NOT EXISTS bank_loans(id SERIAL PRIMARY KEY, user_id BIGINT, amount NUMERIC, due_at TIMESTAMP, paid INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');

    await pg.query(`CREATE TABLE IF NOT EXISTS pro_bank_accounts (user_id BIGINT PRIMARY KEY, first_name TEXT DEFAULT '', username TEXT DEFAULT '', balance NUMERIC DEFAULT 0, card_type TEXT DEFAULT 'classic', account_type TEXT DEFAULT 'current', iban TEXT UNIQUE, pin TEXT DEFAULT NULL, is_frozen INTEGER DEFAULT 0, total_deposits NUMERIC DEFAULT 0, loans_count INTEGER DEFAULT 0, loans_paid INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pg.query(`CREATE TABLE IF NOT EXISTS pro_bank_transactions (id SERIAL PRIMARY KEY, from_id BIGINT, to_id BIGINT, amount NUMERIC NOT NULL, fee NUMERIC DEFAULT 0, type TEXT DEFAULT 'transfer', note TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pg.query('CREATE INDEX IF NOT EXISTS idx_pbt_from ON pro_bank_transactions(from_id)');
    await pg.query('CREATE INDEX IF NOT EXISTS idx_pbt_to ON pro_bank_transactions(to_id)');
    await pg.query(`CREATE TABLE IF NOT EXISTS pro_bank_loans (id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, amount NUMERIC NOT NULL, total_due NUMERIC NOT NULL, paid INTEGER DEFAULT 0, paid_at TIMESTAMP, due_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pg.query(`CREATE TABLE IF NOT EXISTS pro_bank_investments (id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, amount NUMERIC NOT NULL, daily_rate NUMERIC NOT NULL, tier TEXT DEFAULT 'أساسي', active INTEGER DEFAULT 1, profit_earned NUMERIC DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    console.log('[BankPro] ✅ Tables ready');
    console.log('[Bank] ✅ Tables ready');

    // ── Group Pro tables (احتياط مضمون التنفيذ) ──
    await pg.query(`CREATE TABLE IF NOT EXISTS grp_settings (
      chat_id BIGINT PRIMARY KEY,
      anti_spam BOOLEAN DEFAULT false, anti_link BOOLEAN DEFAULT false,
      anti_flood BOOLEAN DEFAULT false, anti_forward BOOLEAN DEFAULT false,
      anti_short_link BOOLEAN DEFAULT false, anti_invite BOOLEAN DEFAULT false,
      anti_new_account BOOLEAN DEFAULT false, anti_bot BOOLEAN DEFAULT false,
      anti_mention BOOLEAN DEFAULT false, anti_media BOOLEAN DEFAULT false,
      anti_file BOOLEAN DEFAULT false, anti_arabic_repeat BOOLEAN DEFAULT false,
      anti_edit BOOLEAN DEFAULT false, anti_repeat BOOLEAN DEFAULT false,
      max_warns INTEGER DEFAULT 3, flood_limit INTEGER DEFAULT 5,
      flood_window INTEGER DEFAULT 5, max_msg_length INTEGER DEFAULT 4000,
      repeat_limit INTEGER DEFAULT 3, max_mentions INTEGER DEFAULT 5,
      min_account_age_days INTEGER DEFAULT 0,
      warn_action TEXT DEFAULT 'mute', escalation TEXT DEFAULT 'warn,mute10,mute60,ban',
      auto_reset_days INTEGER DEFAULT 30, updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await pg.query(`CREATE TABLE IF NOT EXISTS grp_logs (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, action TEXT NOT NULL,
      target_id BIGINT, by_id BIGINT, reason TEXT, extra TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pg.query('CREATE INDEX IF NOT EXISTS idx_grp_logs_chat ON grp_logs(chat_id, created_at DESC)');
    await pg.query(`CREATE TABLE IF NOT EXISTS grp_member_stats (
      chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
      msg_count INTEGER DEFAULT 0, warn_count INTEGER DEFAULT 0,
      mute_count INTEGER DEFAULT 0, ban_count INTEGER DEFAULT 0,
      violations INTEGER DEFAULT 0,
      joined_at TIMESTAMP DEFAULT NOW(), last_active TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id)
    )`);
    await pg.query(`CREATE TABLE IF NOT EXISTS grp_roles (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
      role TEXT NOT NULL, permissions TEXT DEFAULT '', assigned_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(chat_id, user_id)
    )`);
    await pg.query(`CREATE TABLE IF NOT EXISTS grp_blacklist_words (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, word TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[GroupPro] ✅ Tables ready (fallback)');
  } catch(e) { console.error('[Bank]', e.message); }
}
module.exports.initBankTables = initBankTables;
