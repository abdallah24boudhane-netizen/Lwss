const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.cwd();

const patches = [
  {
    file: 'handlers/manage.js',
    desc: 'اختيار الإجابة الصحيحة → يفتح خطوة 7/7 (اختيار الصعوبة) بدل الحفظ المباشر',
    old: `  if (data.startsWith('mq_correct_')) {
    const correct = data.replace('mq_correct_', '');
    const { getStateAsync, getState, delState } = require('../utils/stateManager');
    const s = await (getStateAsync || getState)(uid).catch(()=>null);
    if (!s || s.type !== 'mq_wizard_correct') return ctx.answerCbQuery('❌ انتهت الجلسة').catch(()=>{});
    const insertRes = await run(
      'INSERT INTO million_questions(text,option_a,option_b,option_c,option_d,correct,difficulty,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,1)',
      [s.question, s.opt_a, s.opt_b, s.opt_c, s.opt_d, correct, 1]
    ).catch(e => { require('../utils/logger').error('[mq insert]', e.message); return null; });
    await delState(uid).catch(()=>{});
    const L = { a:'أ', b:'ب', c:'ج', d:'د' };
    return ctx.editMessageText(
      '✅ *تم حفظ السؤال!*\\n\\n❓ ' + s.question + '\\n🎯 الصحيحة: *' + L[correct] + ')*',
      { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'➕ إضافة آخر', callback_data:'mq_add' }, { text:'◀️ رجوع', callback_data:'mg_million_q' }]
      ]}}).catch(()=>ctx.reply('✅ تم الحفظ!').catch(()=>{}));
  }`,
    new: `  if (data.startsWith('mq_correct_')) {
    const correct = data.replace('mq_correct_', '');
    const { getStateAsync, getState, setState: ss } = require('../utils/stateManager');
    const s = await (getStateAsync || getState)(uid).catch(()=>null);
    if (!s || s.type !== 'mq_wizard_correct') return ctx.answerCbQuery('❌ انتهت الجلسة').catch(()=>{});
    await ss(uid, { ...s, type:'mq_wizard_difficulty', correct });
    await ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '📊 الخطوة 7/7 — شحال صعوبة هاذ السؤال؟\\n\\n_(يتحكم فمرحلة ظهوره فاللعبة: سهل فأول الجولة، صعب فآخرها)_',
      { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'🟢 سهل', callback_data:'mq_diff_easy' }, { text:'🟡 متوسط', callback_data:'mq_diff_medium' }, { text:'🔴 صعب', callback_data:'mq_diff_hard' }],
        [{ text:'❌ إلغاء', callback_data:'mg_million_q' }],
      ]}}).catch(()=>{});
  }

  if (data.startsWith('mq_diff_')) {
    const difficulty = data.replace('mq_diff_', '');
    const { getStateAsync, getState, delState } = require('../utils/stateManager');
    const s = await (getStateAsync || getState)(uid).catch(()=>null);
    if (!s || s.type !== 'mq_wizard_difficulty') return ctx.answerCbQuery('❌ انتهت الجلسة').catch(()=>{});
    await run(
      'INSERT INTO million_questions(text,option_a,option_b,option_c,option_d,correct,difficulty,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,1)',
      [s.question, s.opt_a, s.opt_b, s.opt_c, s.opt_d, s.correct, difficulty]
    ).catch(e => { require('../utils/logger').error('[mq insert]', e.message); return null; });
    await delState(uid).catch(()=>{});
    const L = { a:'أ', b:'ب', c:'ج', d:'د' };
    const D = { easy:'🟢 سهل', medium:'🟡 متوسط', hard:'🔴 صعب' };
    await ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '✅ *تم حفظ السؤال!*\\n\\n❓ ' + s.question + '\\n🎯 الصحيحة: *' + L[s.correct] + ')*\\n📊 الصعوبة: *' + (D[difficulty]||difficulty) + '*',
      { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'➕ إضافة آخر', callback_data:'mq_add' }, { text:'◀️ رجوع', callback_data:'mg_million_q' }]
      ]}}).catch(()=>ctx.reply('✅ تم الحفظ!').catch(()=>{}));
  }`,
  },
  {
    file: 'handlers/manage.js',
    desc: 'تحديث رقم الخطوة 6/6 → 6/7 فرسالة اختيار الإجابة الصحيحة',
    old: `'✅ د: ' + text + '\\n\\n🎯 الخطوة 6/6 — اختر الإجابة الصحيحة:',`,
    new: `'✅ د: ' + text + '\\n\\n🎯 الخطوة 6/7 — اختر الإجابة الصحيحة:',`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'استثناء mq_diff_ من شبكة أمان الحالة (نفس مشكلة mq_correct_)',
    old: `    const _wizardStepPrefixes = ['cg_hasans_', 'cg_showans_', 'mq_correct_'];`,
    new: `    const _wizardStepPrefixes = ['cg_hasans_', 'cg_showans_', 'mq_correct_', 'mq_diff_'];`,
  },
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(path.dirname(ROOT), 'TALINE_BACKUP_difficulty_' + stamp);
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
  console.log('🎉 (' + applied + '/' + patches.length + ' تصليحات)');
} else {
  console.log('❌ ما تطبق حتى تصليح.');
}
