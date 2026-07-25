const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.cwd();

const patches = [
  {
    file: 'handlers/start.js',
    desc: 'إضافة زر "👥 قروباتي" بقائمة /start للمشرفين والمالك',
    old: "  if (ctx.isOwner) rows.push([btn('🔧 لوحة الإدارة', 'mg_menu')]);\n  else if (ctx.isAdmin) rows.push([btn('🛡️ لوحة الإدارة', 'mg_menu')]);",
    new: "  if (ctx.isOwner) rows.push([btn('🔧 لوحة الإدارة', 'mg_menu')]);\n  else if (ctx.isAdmin) rows.push([btn('🛡️ لوحة الإدارة', 'mg_menu')]);\n  if (ctx.isOwner || ctx.isAdmin) rows.push([btn('👥 قروباتي', 'gp_mylist')]);",
  },
  {
    file: 'handlers/group_panel.js',
    desc: 'إضافة معالج الزر gp_mylist (يستدعي showMyGroups الموجودة أصلاً)',
    old: "  if (data.startsWith('gp_poll_')) {\n    const chatId = data.replace('gp_poll_', '');\n    await require('../handlers/poll_system').startCreate(ctx, chatId);\n    return true;\n  }\n\n  if (data.startsWith('gp_msgone_')) {",
    new: "  if (data === 'gp_mylist') {\n    return showMyGroups(ctx);\n  }\n\n  if (data.startsWith('gp_poll_')) {\n    const chatId = data.replace('gp_poll_', '');\n    await require('../handlers/poll_system').startCreate(ctx, chatId);\n    return true;\n  }\n\n  if (data.startsWith('gp_msgone_')) {",
  },
];

let backupDir = null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
backupDir = path.join(path.dirname(ROOT), 'TALINE_BACKUP_قروباتي_' + stamp);
fs.cpSync(ROOT, backupDir, { recursive: true, filter: (s) => !s.includes(path.sep+'node_modules') && !s.includes(path.sep+'.git') });
console.log('📦 نسخة احتياطية: ' + backupDir);

let applied = 0;
for (const p of patches) {
  const fp = path.join(ROOT, p.file);
  const content = fs.readFileSync(fp, 'utf8');
  if (content.includes(p.new)) { console.log('⏭️  ' + p.desc + ' — مطبّق مسبقاً'); continue; }
  const count = content.split(p.old).length - 1;
  if (count !== 1) { console.log('⚠️  ' + p.desc + ' — الموضع غير موجود أو مكرر (' + count + '), يحتاج مراجعة يدوية'); continue; }
  fs.writeFileSync(fp, content.replace(p.old, () => p.new), 'utf8');
  console.log('✅ ' + p.desc);
  applied++;
}

if (applied > 0) {
  for (const f of ['handlers/start.js', 'handlers/group_panel.js']) {
    try { execSync('node --check "' + path.join(ROOT, f) + '"', { stdio: 'pipe' }); console.log('✅ ' + f + ' سليم نحوياً'); }
    catch (e) { console.log('❌ ' + f + ' خطأ نحوي! راجع النسخة الاحتياطية.'); }
  }
  console.log('🎉 أعد تشغيل البوت الآن.');
}
