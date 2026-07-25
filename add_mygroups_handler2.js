const fs = require('fs');
const { execSync } = require('child_process');

const old = "  if (data.startsWith('gp_poll_')) {\n    const chatId = data.replace('gp_poll_', '');\n    await require('../handlers/poll_system').startCreate(ctx, chatId);\n    return true;\n  }";
const add = "  if (data === 'gp_mylist') {\n    return showMyGroups(ctx);\n  }\n\n" + old;

const fp = 'handlers/group_panel.js';
const content = fs.readFileSync(fp, 'utf8');

if (content.includes("if (data === 'gp_mylist')")) {
  console.log('⏭️  مطبّق مسبقاً');
} else {
  const count = content.split(old).length - 1;
  if (count !== 1) {
    console.log('⚠️  الموضع غير فريد (' + count + ') — لا تعديل، راجعني');
  } else {
    fs.writeFileSync(fp, content.replace(old, () => add), 'utf8');
    console.log('✅ تمت الإضافة');
    execSync('node --check ' + fp);
    console.log('✅ سليم نحوياً');
  }
}
