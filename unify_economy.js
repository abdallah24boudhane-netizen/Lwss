const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.cwd();

const patches = [
  // ═══ 1. Migration تلقائية جوا db.js ═══
  {
    file: 'database/db.js',
    desc: 'إضافة دالة توحيد الاقتصاد (Migration تلقائية آمنة مع تحقق رياضي)',
    old: `    console.log('[BankPro] ✅ Tables ready');
    console.log('[Bank] ✅ Tables ready');`,
    new: `    console.log('[BankPro] ✅ Tables ready');
    console.log('[Bank] ✅ Tables ready');

    await runEconomyMigration();`,
  },
  {
    file: 'database/db.js',
    desc: 'تعريف دالة runEconomyMigration + تصديرها',
    old: `async function initBankTables() {`,
    new: `async function runEconomyMigration() {
  if (!pg) return;
  try {
    const already = await getSetting('economy_migrated_v1');
    if (already) return;
    console.log('[EconomyMigration] 🔄 بدء توحيد الأنظمة البنكية (bank_accounts → pro_bank_accounts)...');

    await pg.query(\`CREATE TABLE IF NOT EXISTS legacy_bank_migration_map (
      old_user_id BIGINT PRIMARY KEY,
      migrated_amount NUMERIC NOT NULL,
      migrated_at TIMESTAMP DEFAULT NOW()
    )\`);

    const beforeOld = await pg.query('SELECT COALESCE(SUM(balance),0) as s FROM bank_accounts');
    const beforePro = await pg.query('SELECT COALESCE(SUM(balance),0) as s FROM pro_bank_accounts');
    const sumBefore = Number(beforeOld.rows[0].s) + Number(beforePro.rows[0].s);

    const client = await pg.connect();
    let migratedCount = 0;
    try {
      await client.query('BEGIN');
      const oldAccounts = await client.query('SELECT * FROM bank_accounts');
      for (const acc of oldAccounts.rows) {
        const bal = Number(acc.balance || 0);
        const existing = await client.query('SELECT balance FROM pro_bank_accounts WHERE user_id=$1', [acc.user_id]);
        if (existing.rows.length) {
          if (bal !== 0) {
            await client.query('UPDATE pro_bank_accounts SET balance = balance + $1 WHERE user_id=$2', [bal, acc.user_id]);
          }
        } else {
          const iban = 'TAL' + String(acc.user_id).padStart(10, '0') + Math.floor(Math.random() * 90 + 10);
          await client.query(
            \`INSERT INTO pro_bank_accounts(user_id, first_name, username, balance, card_type, account_type, iban)
             VALUES ($1,$2,$3,$4,'classic','current',$5)\`,
            [acc.user_id, acc.first_name || '', acc.username || '', bal, iban]
          );
        }
        await client.query(
          'INSERT INTO legacy_bank_migration_map(old_user_id, migrated_amount) VALUES($1,$2) ON CONFLICT(old_user_id) DO NOTHING',
          [acc.user_id, bal]
        );
        migratedCount++;
      }

      const oldTxs = await client.query('SELECT * FROM bank_transactions ORDER BY id');
      for (const tx of oldTxs.rows) {
        await client.query(
          \`INSERT INTO pro_bank_transactions(from_id, to_id, amount, fee, type, note, created_at)
           VALUES($1,$2,$3,0,$4,$5,$6)\`,
          [tx.from_id, tx.to_id, tx.amount, 'legacy_' + (tx.type || 'unknown'), tx.note || '', tx.created_at]
        );
      }

      await client.query('COMMIT');

      const afterPro = await pg.query('SELECT COALESCE(SUM(balance),0) as s FROM pro_bank_accounts');
      const sumAfter = Number(afterPro.rows[0].s);
      const diff = Math.abs(sumAfter - sumBefore);
      if (diff > 0.01) {
        console.error('[EconomyMigration] ⚠️ فرق فـ التحقق: ' + diff + ' — الترحيل ما تفعّلش، راجع legacy_bank_migration_map يدوياً.');
        return;
      }

      await setSetting('economy_migrated_v1', '1');
      console.log('[EconomyMigration] ✅ نجح — ' + migratedCount + ' حساب مدموج، ' + oldTxs.rows.length + ' معاملة مؤرشفة، المجموع متطابق (' + sumAfter + ' DA).');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[EconomyMigration] ❌ فشل، تم التراجع: ' + e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[EconomyMigration] ❌ خطأ عام: ' + e.message);
  }
}

async function initBankTables() {`,
  },
  {
    file: 'database/db.js',
    desc: 'تصدير runEconomyMigration',
    old: `module.exports.initBankTables = initBankTables;`,
    new: `module.exports.initBankTables = initBankTables;
module.exports.runEconomyMigration = runEconomyMigration;`,
  },

  // ═══ 2. handlers/bank.js → طبقة توافقية فوق bank_pro.js ═══
  {
    file: 'handlers/bank.js',
    desc: 'استبدال bank.js بالكامل — طبقة توافقية تفوّض كل شي لـ bank_pro.js',
    old: fs.readFileSync(path.join(ROOT, 'handlers/bank.js'), 'utf8'),
    new: `'use strict';
// ⚠️ طبقة توافقية فقط — كل العمليات الحقيقية تُنفَّذ عبر bank_pro.js (Taline Bank الموحّد)
// bank_accounts القديم ما عاد يُستعمل من هنا.
const bankPro = require('./bank_pro');

exports.createAccount = bankPro.openAccount;
exports.showBalance   = bankPro.showBalance;
exports.transfer      = bankPro.transfer;
exports.loan          = bankPro.requestLoan;
exports.addWinnings   = bankPro.addWinnings;
exports.showRip       = bankPro.showStatement;
exports.getAccount    = bankPro.getAccount;
exports.fmt           = bankPro.fmt;
`,
  },
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(path.dirname(ROOT), 'TALINE_BACKUP_economy_' + stamp);
fs.cpSync(ROOT, backupDir, { recursive: true, filter: (s) => !s.includes(path.sep+'node_modules') && !s.includes(path.sep+'.git') });
console.log('📦 نسخة احتياطية: ' + backupDir);

let applied = 0;
const touchedFiles = new Set();
for (const p of patches) {
  const fp = path.join(ROOT, p.file);
  const content = fs.readFileSync(fp, 'utf8');
  if (content.includes(p.new)) { console.log('⏭️  ' + p.desc + ' — مطبّق مسبقاً'); continue; }
  const count = content.split(p.old).length - 1;
  if (count !== 1) { console.log('⚠️  ' + p.desc + ' — الموضع غير موجود أو مكرر (' + count + '), يحتاج مراجعة يدوية'); continue; }
  fs.writeFileSync(fp, content.replace(p.old, () => p.new), 'utf8');
  console.log('✅ ' + p.desc);
  applied++;
  touchedFiles.add(p.file);
}

if (applied > 0) {
  for (const f of touchedFiles) {
    try { execSync('node --check "' + path.join(ROOT, f) + '"', { stdio: 'pipe' }); console.log('✅ ' + f + ' سليم نحوياً'); }
    catch (e) { console.log('❌ ' + f + ' خطأ نحوي! راجع النسخة الاحتياطية.'); console.log(e.stderr ? e.stderr.toString() : e.message); }
  }
  console.log('🎉 (' + applied + '/' + patches.length + ' تصليحات فالمرحلة 1)');
} else {
  console.log('❌ ما تطبق حتى تصليح.');
}
