'use strict';
/**
 * ════════════════════════════════════════════
 *  💾 utils/backup_full.js — نسخ احتياطي واستعادة شاملة
 *  يشمل كل جداول البوت: مستخدمين، بنك، ألعاب، حماية، محتوى، إلخ
 * ════════════════════════════════════════════
 */
const { all, run, getPg } = require('../database/db');

// كل الجداول المعروفة في المشروع، مرتّبة حسب الأولوية
// (سنستعيد بترتيب عكسي احتياطياً: المرجعيات أولاً ثم التفصيليات)
const ALL_TABLES = [
  // ── محتوى أكاديمي ──
  'specialties','years','semesters','subjects','categories',
  'files','bundles','bundle_files',
  // ── مستخدمون ──
  'users','user_specialties','user_states','user_points','user_xp',
  'admins',
  // ── تفاعلات ──
  'downloads','favorites','history','ratings','comments','comment_likes',
  'reports','notes',
  // ── بنك (قديم وجديد) ──
  'bank_accounts','bank_transactions','bank_loans',
  'pro_bank_accounts','pro_bank_transactions','pro_bank_loans','pro_bank_investments',
  // ── ألعاب ──
  'million_questions','million_games','million_answers','million_scores','million_stats',
  'guess_games','couple_of_day','poll_options','poll_votes','polls',
  // ── قروبات - حماية وإدارة ──
  'group_chats','group_bans','group_warns','group_members','group_messages',
  'group_locks','group_filters','group_notes','group_reports','group_schedules',
  'group_tempbans','group_verify','group_violations','group_watching','group_welcome',
  'group_protection','group_notify_log','group_bot_msgs','group_last_welcome',
  'grp_settings','grp_logs','grp_member_stats','grp_roles',
  'grp_blacklist','grp_blacklist_words','grp_approved','grp_gbans',
  'global_bans',
  // ── ردود وأتمتة ──
  'auto_replies','auto_reactions','blacklist_words','member_cards','member_card_triggers',
  // ── رسائل وإشعارات ──
  'message_templates','scheduled_messages','ads','channels','required_channels',
  // ── دول/عوالم (لعبة أخرى محتملة) ──
  'nations','nation_alliances','nation_army','nation_citizens','nation_companies',
  'nation_elections','nation_events','nation_ministers','nation_projects',
  'nation_seasons','nation_tech','nation_wars','world_lands',
  // ── متفرقات ──
  'afk_users','ai_history','logs','settings','cache_store',
];

/**
 * يُصدّر كل الجداول لكائن JSON واحد. أي جدول غير موجود فعلياً
 * أو يفشل الاستعلام عليه يُسجَّل كمصفوفة فارغة بدل إيقاف العملية.
 */
async function exportAll() {
  const backup = {
    exported_at: new Date().toISOString(),
    version: 2,
    tables: {},
    errors: [],
  };

  for (const t of ALL_TABLES) {
    try {
      backup.tables[t] = await all('SELECT * FROM ' + t);
    } catch (e) {
      backup.tables[t] = [];
      backup.errors.push(t + ': ' + e.message);
    }
  }

  return backup;
}

/**
 * يستعيد كل الجداول من كائن backup. لكل جدول:
 * - يحذف البيانات القديمة (TRUNCATE ... CASCADE) إن وُجد جدول فعلي
 * - يُدرج البيانات الجديدة صفاً بصف (لتفادي فشل استعلام واحد ضخم)
 * لا يوقف العملية عند فشل جدول واحد — يسجّل الخطأ ويكمل.
 */
async function restoreAll(backup, options = {}) {
  const pg = getPg();
  if (!pg) throw new Error('لا يوجد اتصال بقاعدة البيانات');

  const result = { restored: {}, errors: [], skipped: [] };
  const tables = backup?.tables || {};
  const tableNames = Object.keys(tables);

  if (!tableNames.length) {
    throw new Error('ملف النسخة الاحتياطية فارغ أو تالف');
  }

  for (const t of tableNames) {
    const rows = tables[t];
    if (!Array.isArray(rows)) { result.skipped.push(t); continue; }
    if (!rows.length) { result.restored[t] = 0; continue; }

    try {
      // تحقق أن الجدول موجود فعلاً قبل أي عملية
      await pg.query('SELECT 1 FROM ' + t + ' LIMIT 1').catch(() => {
        throw new Error('الجدول غير موجود في القاعدة الحالية');
      });

      if (options.wipe !== false) {
        await pg.query('TRUNCATE TABLE "' + t + '" CASCADE').catch(async () => {
          // TRUNCATE قد يفشل بسبب صلاحيات أو قيود؛ جرّب DELETE كخيار احتياطي
          await pg.query('DELETE FROM "' + t + '"').catch(() => {});
        });
      }

      const columns = Object.keys(rows[0]);
      const colList = columns.map(c => '"' + c + '"').join(',');

      let inserted = 0;
      // إدراج على دفعات من 200 صف لتفادي استعلامات ضخمة جداً
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values = [];
        const placeholders = chunk.map((row, ri) => {
          const rowPh = columns.map((c, ci) => {
            values.push(row[c] === undefined ? null : row[c]);
            return '$' + (ri * columns.length + ci + 1);
          });
          return '(' + rowPh.join(',') + ')';
        }).join(',');

        const sql = 'INSERT INTO "' + t + '"(' + colList + ') VALUES ' + placeholders +
                    ' ON CONFLICT DO NOTHING';
        await pg.query(sql, values);
        inserted += chunk.length;
      }

      result.restored[t] = inserted;
    } catch (e) {
      result.errors.push(t + ': ' + e.message);
    }
  }

  return result;
}

module.exports = { exportAll, restoreAll, ALL_TABLES };
