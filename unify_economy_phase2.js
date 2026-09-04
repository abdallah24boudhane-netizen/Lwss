const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.cwd();

const BANK_GAMES_NEW = `'use strict';
const { get, run, all } = require('../database/db');
const { cacheGet, cacheSet } = require('../utils/cache');
const logger = require('../utils/logger');
const bankPro = require('./bank_pro');
const { fmt } = bankPro;

async function getAcc(uid) { return await get('SELECT * FROM pro_bank_accounts WHERE user_id=$1',[uid]); }
async function ensureAcc(ctx) {
  const uid = ctx.from?.id;
  return await bankPro.ensureAccount(uid, ctx.from?.first_name || '', ctx.from?.username || '');
}
async function logTx(fromId, toId, amount, type, note) {
  await run('INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(\$1,\$2,\$3,0,\$4,\$5)', [fromId, toId, amount, type, note]).catch(()=>{});
}

async function handleDaily(ctx) {
  const uid=ctx.from?.id;
  const acc=await ensureAcc(ctx);
  const ck='daily_'+uid;
  const last=cacheGet(ck);
  if(last){ const rem=86400000-(Date.now()-last); if(rem>0){ const h=Math.floor(rem/3600000),m=Math.floor((rem%3600000)/60000); return ctx.reply('⏳ *انتظر '+h+'س '+m+'د*\\n💰 رصيدك: *'+fmt(acc.balance)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{}); } }
  const lr=await get("SELECT created_at FROM pro_bank_transactions WHERE from_id=0 AND to_id=\$1 AND type='daily' ORDER BY created_at DESC LIMIT 1",[uid]).catch(()=>null);
  if(lr?.created_at){ const t=new Date(lr.created_at).getTime(),rem=86400000-(Date.now()-t); if(rem>0){ cacheSet(ck,t,rem); const h=Math.floor(rem/3600000),m=Math.floor((rem%3600000)/60000); return ctx.reply('⏳ *انتظر '+h+'س '+m+'د*\\n💰 رصيدك: *'+fmt(acc.balance)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{}); } }
  const xr=await get('SELECT xp FROM user_xp WHERE user_id=\$1',[uid]).catch(()=>null);
  const bonus=Math.floor((xr?.xp||0)/100)*50;
  const reward=Math.min(500+bonus,5000);
  await run('UPDATE pro_bank_accounts SET balance=balance+\$1 WHERE user_id=\$2',[reward,uid]);
  await logTx(0, uid, reward, 'daily', 'مكافأة يومية');
  cacheSet(ck,Date.now(),86400000);
  return ctx.reply('🎁 *مكافأتك اليومية!*\\n━━━━━━━━━━━━━━━\\n\\n💰 المكافأة: *+'+fmt(reward)+'*'+(bonus>0?' _(مكافأة مستوى)_':'')+'\\n🏦 الرصيد: *'+fmt((acc.balance||0)+reward)+'*\\n\\n ⏰ عود غداً!', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
}

async function handleFlip(ctx) {
  const uid=ctx.from?.id;
  const args=(ctx.message?.text||'').split(' ');
  const bet=parseInt(args[1]);
  if(!bet||bet<100) return ctx.reply('🎲 *قلب العملة*\\n\\nالاستخدام: /flip [مبلغ]\\nمثال: /flip 500\\nالحد الأدنى: 100 DA', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const acc=await ensureAcc(ctx);
  if((acc.balance||0)<bet) return ctx.reply('❌ رصيدك غير كافٍ!\\n💰 رصيدك: *'+fmt(acc.balance)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const maxBet=Math.min(Math.floor((acc.balance||0)*0.5),50000);
  if(bet>maxBet) return ctx.reply('⚠️ الحد الأقصى: *'+fmt(maxBet)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const wm=await ctx.reply('🪙 تقلب العملة...',{reply_to_message_id:ctx.message?.message_id}).catch(()=>null);
  await new Promise(r=>setTimeout(r,1500));
  const win=Math.random()<0.5;
  const change=win?bet:-bet;
  await run('UPDATE pro_bank_accounts SET balance=balance+\$1 WHERE user_id=\$2',[change,uid]);
  await logTx(win?0:uid, win?uid:0, bet, 'flip', win?'ربح قلب عملة':'خسارة قلب عملة');
  if(win){ try{ const {awardPoints}=require('../database/points'); await awardPoints(uid,'rating').catch(()=>{}); }catch(_){} }
  const newBal=(acc.balance||0)+change;
  const txt=win?'🦅 *صقر — فزت!*\\n\\n💰 ربحت: *+'+fmt(bet)+'*\\n🏦 رصيدك: *'+fmt(newBal)+'*':'🪙 *كتابة — خسرت!*\\n\\n💸 خسرت: *-'+fmt(bet)+'*\\n🏦 رصيدك: *'+fmt(newBal)+'*\\n_حظاً أوفر!_';
  if(wm) ctx.telegram.editMessageText(ctx.chat.id,wm.message_id,null,txt,{parse_mode:'Markdown'}).catch(()=>ctx.reply(txt, { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{}));
  else ctx.reply(txt, { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
}

async function handleRob(ctx) {
  const uid=ctx.from?.id;
  const target=ctx.message?.reply_to_message?.from;
  if(!target||target.is_bot||target.id===uid) return ctx.reply('🦹 *السرقة*\\n\\nرد على رسالة شخص لتسرقه!\\nنسبة نجاح: 40% — عند الفشل: غرامة 5%', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const rk='rob_'+uid;
  if(cacheGet(rk)) return ctx.reply('⏳ انتظر 5 دقائق بين كل سرقة!',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  const [ra,va]=await Promise.all([ensureAcc(ctx),getAcc(target.id)]);
  if(!va||va.balance<200) return ctx.reply('😔 الضحية مفلسة — ما في شيء يُسرق!',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  cacheSet(rk,1,300000);
  const ok2=Math.random()<0.4;
  if(ok2){
    const s=Math.floor(Math.min(va.balance*0.1,2000));
    await Promise.all([run('UPDATE pro_bank_accounts SET balance=balance+\$1 WHERE user_id=\$2',[s,uid]),run('UPDATE pro_bank_accounts SET balance=balance-\$1 WHERE user_id=\$2',[s,target.id])]);
    await logTx(target.id, uid, s, 'rob', 'سرقة');
    return ctx.reply('🦹 *السرقة نجحت!*\\n\\n🎯 الضحية: *'+(target.first_name||'مجهول')+'*\\n💰 المسروق: *'+fmt(s)+'*\\n🏦 رصيدك: *'+fmt((ra.balance||0)+s)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  } else {
    const f=Math.min(Math.floor((ra.balance||0)*0.05),500);
    await Promise.all([run('UPDATE pro_bank_accounts SET balance=balance-\$1 WHERE user_id=\$2',[f,uid]),run('UPDATE pro_bank_accounts SET balance=balance+\$1 WHERE user_id=\$2',[f,target.id])]);
    await logTx(uid, target.id, f, 'rob_fine', 'غرامة سرقة');
    return ctx.reply('🚔 *السرقة فشلت!*\\n\\n👮 تم القبض عليك\\n💸 الغرامة: *-'+fmt(f)+'*\\n🏦 رصيدك: *'+fmt(Math.max(0,(ra.balance||0)-f))+'*',{parse_mode:'Markdown',reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  }
}

async function handleLeaderboard(ctx) {
  const isGrp=['group','supergroup'].includes(ctx.chat?.type);
  const cid=ctx.chat?.id;
  let pl;
  if(isGrp) pl=await all('SELECT ba.user_id,ba.first_name,ba.username,ba.balance FROM pro_bank_accounts ba INNER JOIN group_members gm ON gm.user_id=ba.user_id AND gm.chat_id=\$1 ORDER BY ba.balance DESC LIMIT 10',[cid]).catch(()=>[]);
  else pl=await all('SELECT user_id,first_name,username,balance FROM pro_bank_accounts ORDER BY balance DESC LIMIT 10').catch(()=>[]);
  if(!pl?.length) return ctx.reply('📭 لا يوجد لاعبون بعد!\\n\\nاكتب: انشاء حساب',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  const md=['🥇','🥈','🥉'];
  let txt='🏆 *'+(isGrp?'أثرياء المجموعة':'المتصدرون عالمياً')+'*\\n━━━━━━━━━━━━━━━━━━━━\\n\\n';
  pl.forEach((p,i)=>{ const me=p.user_id==ctx.from?.id; txt+=( md[i]||(i+1)+'.')+(me?' *أنت —* ':' ')+(p.first_name||p.username||'مجهول')+'\\n   💰 '+fmt(p.balance)+'\\n\\n'; });
  return ctx.reply(txt, { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
}

const GAMES_MENU_TEXT =
  '🎮 *ألعاب القروب*\\n\\n' +
  '🏆 مليون\\n' +
  '📸 خمن\\n' +
  '🐺 لوب غارو\\n' +
  '🎲 صحصح\\n\\n' +
  '👇 اضغط على لعبة لمعرفة طريقة اللعب';
const GAMES_MENU_KB = {
  inline_keyboard: [
    [{ text: '🏆 مليون', callback_data: 'games_how_million' }, { text: '🐺 لوب غارو', callback_data: 'games_how_werewolf' }],
    [{ text: '🎲 اكسيو فيريتي', callback_data: 'games_how_tod' }, { text: '📸 خمن', callback_data: 'games_how_guess' }],
  ],
};
const GAMES_BACK_KB = { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'games_back' }]] };

async function handleBankGamesCallback(ctx,data) {
  if(data==='games_back'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(GAMES_MENU_TEXT, { parse_mode:'Markdown', reply_markup: GAMES_MENU_KB }).catch(()=>{});
  }
  if(data==='games_how_werewolf'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '🐺 *طريقة لعب — لوب غارو*\\n━━━━━━━━━━━━━━━\\n\\n' +
      '1️⃣ اكتب *لوب غارو* في القروب لإنشاء غرفة\\n' +
      '2️⃣ اضغط ✅ انضمام (6-15 لاعب)\\n' +
      '3️⃣ يضغط المنشئ 🚀 ابدأ اللعبة\\n' +
      '4️⃣ تصلك أدوارك بالخاص — تابع تعليماتها\\n' +
      '5️⃣ ليلاً: تنفّذ القدرات سرّاً (ذئب/عراف/ساحرة...)\\n' +
      '6️⃣ نهاراً: ناقشوا وصوّتوا لإعدام المشتبه به\\n\\n' +
      '🏆 القرية تفوز بالقضاء على الذئاب، والذئاب تفوز بالقضاء على القرية\\n\\n' +
      '📖 لقوانين كاملة مع كل الأدوار: اكتب \`/ww_rules\`',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }
  if(data==='games_how_tod'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '🎲 *طريقة لعب — صحصح (أكسيو أو فيريتي)*\\n━━━━━━━━━━━━━━━\\n\\n' +
      '1️⃣ اكتب *صحصح* في القروب لإنشاء غرفة\\n' +
      '2️⃣ اكتب *أنا* للانضمام\\n' +
      '3️⃣ يكتب المنشئ *ابدأ*\\n' +
      '4️⃣ المجيب يختار 🔥 أكسيو أو 💬 فيريتي\\n' +
      '5️⃣ السائل يكتب: \`سل\` ثم سؤاله — مثال: \`سل كم عمرك؟\`\\n' +
      '6️⃣ المجيب يجيب: \`اجب\` ثم إجابته — مثال: \`اجب 20 سنة\`\\n\\n' +
      '📖 لقوانين كاملة: اكتب \`/tod_rules\`',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }
  if(data==='games_how_million'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '🏆 *طريقة لعب — من سيربح المليون*\\n━━━━━━━━━━━━━━━\\n\\n' +
      '1️⃣ اكتب *مليون* في القروب لبدء جلسة\\n' +
      '2️⃣ اكتب *أنا* للانضمام (يتسع لـ 30 لاعب)\\n' +
      '3️⃣ تبدأ اللعبة بعد 20 ثانية تلقائياً\\n' +
      '4️⃣ أجب على الأسئلة باختيار أ/ب/ج/د\\n' +
      '5️⃣ لديك 30 ثانية لكل سؤال\\n' +
      '6️⃣ الفائز يأخذ الجائزة في حسابه البنكي💰\\n\\n' +
      '🛟 *المساعدات:*\\n' +
      '5️⃣0️⃣ مساعدة 50/50\\n' +
      '👥 مساعدة الجمهور\\n' +
      '📞 مساعدة صديق\\n' +
      '⏭️ تخطي السؤال',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }
  if(data==='games_how_guess'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '📸 *طريقة لعب — خمن الصورة*\\n━━━━━━━━━━━━━━━\\n\\n' +
      '1️⃣ اكتب *خمن* في القروب لبدء تحدي\\n' +
      '2️⃣ اكتب *أنا* للانضمام (لاعبان فقط)\\n' +
      '3️⃣ كل لاعب يرسل صورة سرية للبوت في الخاص\\n' +
      '4️⃣ البوت يعرض الصورتين في القروب\\n' +
      '5️⃣ من يخمن صورة منافسه أولاً يفوز\\n' +
      '6️⃣ الفائز يربح *500 DA* في حسابه البنكي💰',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }

  if(data==='games_leaderboard'){ ctx.answerCbQuery().catch(()=>{}); return handleLeaderboard(ctx); }
  if(data==='games_bank'){ ctx.answerCbQuery().catch(()=>{}); return require('./bank_pro').showBalance(ctx); }
  if(data==='games_daily'){ ctx.answerCbQuery().catch(()=>{}); return handleDaily(ctx); }
  if(data==='games_start_million'){ ctx.answerCbQuery('اكتب: مليون',{show_alert:true}).catch(()=>{}); return; }
  if(data==='games_start_guess'){ ctx.answerCbQuery('اكتب: خمن',{show_alert:true}).catch(()=>{}); return; }
  if(data==='games_start_flip'){ ctx.answerCbQuery().catch(()=>{}); return ctx.reply('🎲 /flip [مبلغ] — مثال: /flip 500',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{}); }
  return false;
}

module.exports = { handleDaily, handleFlip, handleRob, handleLeaderboard, handleBankGamesCallback };
`;

const patches = [
  {
    file: 'handlers/bank_pro.js',
    desc: 'تصدير ensureAccount باش يقدر bank_games.js يستعملها',
    old: `exports.getAccount = getAccount;\nexports.fmt        = fmt;`,
    new: `exports.getAccount    = getAccount;\nexports.ensureAccount  = ensureAccount;\nexports.fmt            = fmt;`,
  },
  {
    file: 'handlers/bank_games.js',
    desc: 'إعادة كتابة bank_games.js كامل → Pro Bank (يومية/فليب/سرقة/متصدرين) + تسجيل كل معاملة',
    old: fs.readFileSync(path.join(ROOT, 'handlers/bank_games.js'), 'utf8'),
    new: BANK_GAMES_NEW,
  },
  {
    file: 'handlers/group_commands.js',
    desc: 'سلوت القروب (/slot) → Pro Bank + تسجيل المعاملات',
    old: `    const acc = await dbGet("SELECT balance FROM bank_accounts WHERE user_id=$1", [uid]).catch(() => null);
    if (!acc) return ctx.reply("❌ ليس لديك حساب بنكي! اكتب *انشاء حساب*", { parse_mode: "Markdown" }).catch(() => {});
    if (parseFloat(acc.balance) < BET) return ctx.reply("❌ رصيدك غير كافٍ! تحتاج *" + BET + " دج* للعب.", { parse_mode: "Markdown" }).catch(() => {});

    // خصم الرهان
    await dbRun("UPDATE bank_accounts SET balance=balance-$1 WHERE user_id=$2", [BET, uid]).catch(() => {});`,
    new: `    const acc = await dbGet("SELECT balance FROM pro_bank_accounts WHERE user_id=$1", [uid]).catch(() => null);
    if (!acc) return ctx.reply("❌ ليس لديك حساب بنكي! اكتب *انشاء حساب*", { parse_mode: "Markdown" }).catch(() => {});
    if (parseFloat(acc.balance) < BET) return ctx.reply("❌ رصيدك غير كافٍ! تحتاج *" + BET + " DA* للعب.", { parse_mode: "Markdown" }).catch(() => {});

    // خصم الرهان
    await dbRun("UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2", [BET, uid]).catch(() => {});
    await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,0,$2,0,'slot_bet','رهان سلوت')", [uid, BET]).catch(() => {});`,
  },
  {
    file: 'handlers/group_commands.js',
    desc: 'ربح السلوت + رصيد جديد → Pro Bank',
    old: `    if (win > 0) {
      await dbRun("UPDATE bank_accounts SET balance=balance+$1 WHERE user_id=$2", [win, uid]).catch(() => {});
    }

    const newBal = await dbGet("SELECT balance FROM bank_accounts WHERE user_id=$1", [uid]).then(r => r?.balance || 0).catch(() => 0);`,
    new: `    if (win > 0) {
      await dbRun("UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2", [win, uid]).catch(() => {});
      await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(0,$1,$2,0,'slot_win','ربح سلوت')", [uid, win]).catch(() => {});
    }

    const newBal = await dbGet("SELECT balance FROM pro_bank_accounts WHERE user_id=$1", [uid]).then(r => r?.balance || 0).catch(() => 0);`,
  },
  {
    file: 'handlers/group_commands.js',
    desc: 'رسائل نتيجة السلوت — دج → DA',
    old: `          (win > 0 ? "💰 ربحت: *" + win + " دج*" : "💸 خسرت: *" + BET + " دج*") + "\\n" +
          "👛 رصيدك: *" + parseFloat(newBal).toFixed(0) + " دج*",`,
    new: `          (win > 0 ? "💰 ربحت: *" + win + " DA*" : "💸 خسرت: *" + BET + " DA*") + "\\n" +
          "👛 رصيدك: *" + parseFloat(newBal).toFixed(0) + " DA*",`,
  },
  {
    file: 'handlers/group_commands.js',
    desc: 'المتجر (/market) — رصيد المستخدم → Pro Bank',
    old: `    const acc = await dbGet("SELECT balance FROM bank_accounts WHERE user_id=$1", [uid]).catch(() => null);
    const bal = acc ? parseFloat(acc.balance).toFixed(0) : 0;`,
    new: `    const acc = await dbGet("SELECT balance FROM pro_bank_accounts WHERE user_id=$1", [uid]).catch(() => null);
    const bal = acc ? parseFloat(acc.balance).toFixed(0) : 0;`,
  },
  {
    file: 'handlers/group_commands.js',
    desc: 'وصف صندوق المفاجأة فالمتجر — دج → DA',
    old: `      { id: 5, name: "📦 صندوق مفاجأة",    desc: "ربح عشوائي 100-2000 دج",   price: 150,   emoji: "📦" },`,
    new: `      { id: 5, name: "📦 صندوق مفاجأة",    desc: "ربح عشوائي 100-2000 DA",   price: 150,   emoji: "📦" },`,
  },

  {
    file: 'bot/callbacks.js',
    desc: 'كولباك السلوت slot_play_ → Pro Bank + تسجيل معاملة',
    old: `        const acc = await dbGet('SELECT balance FROM bank_accounts WHERE user_id=$1', [uid2]).catch(() => null);
        if (!acc || parseFloat(acc.balance) < BET) return ctx.answerCbQuery('❌ رصيدك غير كافٍ! (' + BET + ' دج)', { show_alert: true }).catch(() => {});
        await dbRun('UPDATE bank_accounts SET balance=balance-$1 WHERE user_id=$2', [BET, uid2]).catch(() => {});`,
    new: `        const acc = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1', [uid2]).catch(() => null);
        if (!acc || parseFloat(acc.balance) < BET) return ctx.answerCbQuery('❌ رصيدك غير كافٍ! (' + BET + ' DA)', { show_alert: true }).catch(() => {});
        await dbRun('UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2', [BET, uid2]).catch(() => {});
        await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,0,$2,0,'slot_bet','رهان سلوت')", [uid2, BET]).catch(() => {});`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'ربح السلوت (كولباك) + رصيد جديد → Pro Bank',
    old: `        if (win>0) await dbRun('UPDATE bank_accounts SET balance=balance+$1 WHERE user_id=$2',[win,uid2]).catch(()=>{});
        const newBal = await dbGet('SELECT balance FROM bank_accounts WHERE user_id=$1',[uid2]).then(r=>r?.balance||0).catch(()=>0);`,
    new: `        if (win>0) { await dbRun('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[win,uid2]).catch(()=>{}); await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(0,$1,$2,0,'slot_win','ربح سلوت')", [uid2, win]).catch(() => {}); }
        const newBal = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).then(r=>r?.balance||0).catch(()=>0);`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'رسالة نتيجة السلوت (كولباك) — دج → DA',
    old: `          '🎰 *ماكينة القمار*\\n\\n[ '+r1+' | '+r2+' | '+r3+' ]\\n\\n'+resultTxt+'\\n'+(win>0?'💰 ربحت: *'+win+' دج*':'💸 خسرت: *'+BET+' دج*')+'\\n👛 رصيدك: *'+parseFloat(newBal).toFixed(0)+' دج*',`,
    new: `          '🎰 *ماكينة القمار*\\n\\n[ '+r1+' | '+r2+' | '+r3+' ]\\n\\n'+resultTxt+'\\n'+(win>0?'💰 ربحت: *'+win+' DA*':'💸 خسرت: *'+BET+' DA*')+'\\n👛 رصيدك: *'+parseFloat(newBal).toFixed(0)+' DA*',`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'رصيد السلوت (slot_bal_) → Pro Bank',
    old: `        const acc = await dbGet('SELECT balance FROM bank_accounts WHERE user_id=$1',[uid2]).catch(()=>null);
        return ctx.answerCbQuery('💰 رصيدك: '+(acc?parseFloat(acc.balance).toFixed(0):0)+' دج', { show_alert:true }).catch(()=>{});`,
    new: `        const acc = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).catch(()=>null);
        return ctx.answerCbQuery('💰 رصيدك: '+(acc?parseFloat(acc.balance).toFixed(0):0)+' DA', { show_alert:true }).catch(()=>{});`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'المتجر (shop_buy_) — التحقق والخصم → Pro Bank + تسجيل الشراء',
    old: `        const acc = await dbGet('SELECT balance FROM bank_accounts WHERE user_id=$1',[uid2]).catch(()=>null);
        if (!acc || parseFloat(acc.balance) < item.price)
          return ctx.answerCbQuery('❌ رصيدك غير كافٍ! تحتاج '+item.price+' دج', {show_alert:true}).catch(()=>{});
        await dbRun('UPDATE bank_accounts SET balance=balance-$1 WHERE user_id=$2',[item.price, uid2]).catch(()=>{});
        // تنفيذ المنتج
        if (itemId === 5) {
          const bonus = Math.floor(Math.random()*1900)+100;
          await dbRun('UPDATE bank_accounts SET balance=balance+$1 WHERE user_id=$2',[bonus,uid2]).catch(()=>{});
          return ctx.answerCbQuery('📦 فتحت الصندوق وربحت '+bonus+' دج! 🎉', {show_alert:true}).catch(()=>{});
        }
        await ctx.answerCbQuery('✅ اشتريت '+item.name+'!', {show_alert:true}).catch(()=>{});
        const newBal = await dbGet('SELECT balance FROM bank_accounts WHERE user_id=$1',[uid2]).then(r=>r?.balance||0).catch(()=>0);
        await ctx.editMessageText(
          '✅ *تمت عملية الشراء!*\\n\\n'+item.name+'\\n💰 المبلغ: '+item.price+' دج\\n👛 رصيدك الآن: '+parseFloat(newBal).toFixed(0)+' دج',`,
    new: `        const acc = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).catch(()=>null);
        if (!acc || parseFloat(acc.balance) < item.price)
          return ctx.answerCbQuery('❌ رصيدك غير كافٍ! تحتاج '+item.price+' DA', {show_alert:true}).catch(()=>{});
        await dbRun('UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2',[item.price, uid2]).catch(()=>{});
        await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,0,$2,0,'shop_purchase',$3)", [uid2, item.price, item.name]).catch(()=>{});
        // تنفيذ المنتج
        if (itemId === 5) {
          const bonus = Math.floor(Math.random()*1900)+100;
          await dbRun('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[bonus,uid2]).catch(()=>{});
          await dbRun("INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES(0,$1,$2,0,'shop_box','صندوق مفاجأة')", [uid2, bonus]).catch(()=>{});
          return ctx.answerCbQuery('📦 فتحت الصندوق وربحت '+bonus+' DA! 🎉', {show_alert:true}).catch(()=>{});
        }
        await ctx.answerCbQuery('✅ اشتريت '+item.name+'!', {show_alert:true}).catch(()=>{});
        const newBal = await dbGet('SELECT balance FROM pro_bank_accounts WHERE user_id=$1',[uid2]).then(r=>r?.balance||0).catch(()=>0);
        await ctx.editMessageText(
          '✅ *تمت عملية الشراء!*\\n\\n'+item.name+'\\n💰 المبلغ: '+item.price+' DA\\n👛 رصيدك الآن: '+parseFloat(newBal).toFixed(0)+' DA',`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'إحصائيات البنك (bank_stats_) → Pro Bank',
    old: `        const stats = await dbAll(
          'SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM bank_transactions WHERE to_id=$1 OR from_id=$1 GROUP BY type',
          [uid2]
        ).catch(() => []);
        let txt = '📊 *إحصائياتك البنكية*\\n━━━━━━━━━━━━━━━━━━\\n\\n';
        for (const s of stats) {
          txt += '• ' + (s.type||'معاملة') + ': ' + s.cnt + ' مرة (' + s.total + ' دج)\\n';
        }`,
    new: `        const stats = await dbAll(
          'SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM pro_bank_transactions WHERE to_id=$1 OR from_id=$1 GROUP BY type',
          [uid2]
        ).catch(() => []);
        let txt = '📊 *إحصائياتك البنكية*\\n━━━━━━━━━━━━━━━━━━\\n\\n';
        for (const s of stats) {
          txt += '• ' + (s.type||'معاملة') + ': ' + s.cnt + ' مرة (' + s.total + ' DA)\\n';
        }`,
  },
  {
    file: 'bot/callbacks.js',
    desc: 'أثرى المستخدمين (bank_top) → Pro Bank',
    old: `        const top = await dbAll(
          'SELECT user_id, first_name, balance FROM bank_accounts ORDER BY balance DESC LIMIT 10'
        ).catch(() => []);
        let txt = '🏆 *أثرى المستخدمين*\\n━━━━━━━━━━━━━━━━━━\\n\\n';
        const medals = ['🥇','🥈','🥉'];
        top.forEach((u,i) => {
          txt += (medals[i]||i+1+'.') + ' ' + (u.first_name||'مجهول') + ' — *' + parseFloat(u.balance).toLocaleString() + ' دج*\\n';
        });`,
    new: `        const top = await dbAll(
          'SELECT user_id, first_name, balance FROM pro_bank_accounts ORDER BY balance DESC LIMIT 10'
        ).catch(() => []);
        let txt = '🏆 *أثرى المستخدمين*\\n━━━━━━━━━━━━━━━━━━\\n\\n';
        const medals = ['🥇','🥈','🥉'];
        top.forEach((u,i) => {
          txt += (medals[i]||i+1+'.') + ' ' + (u.first_name||'مجهول') + ' — *' + parseFloat(u.balance).toLocaleString() + ' DA*\\n';
        });`,
  },

  {
    file: 'bot/commands.js',
    desc: '/adminpanel القديم — زر البنك يوجّه لـ Pro بدل القديم',
    old: `      [{ text:'🏦 البنك', callback_data:'mg_bank_panel' }, { text:'🎮 الألعاب', callback_data:'gp_million_panel' }],`,
    new: `      [{ text:'🏦 البنك', callback_data:'mg_pro_bank_panel' }, { text:'🎮 الألعاب', callback_data:'gp_million_panel' }],`,
  },

  {
    file: 'handlers/manage.js',
    desc: 'حذف حالتي الويزارد القديمتين (mg_bank_add_id / mg_bank_add_amount) — بنك ميت',
    old: `      case 'mg_bank_add_id': {
        const targetId = parseInt(text);
        if(!targetId || isNaN(targetId)) {
          return ctx.reply('❌ ID غير صحيح، أرسل رقم ID فقط').catch(()=>{});
        }
        const acc = await dbG('SELECT * FROM bank_accounts WHERE user_id=$1',[targetId]).catch(()=>null);
        if(!acc) {
          return ctx.reply('❌ هذا المستخدم ليس لديه حساب بنكي').catch(()=>{});
        }
        setState(uid, { type:'mg_bank_add_amount', targetId, targetName: acc.first_name||String(targetId) });
        return ctx.reply(
          '🏦 المستخدم: *' + (acc.first_name||targetId) + '*\\n 💰 رصيده الحالي: *' + Number(acc.balance).toLocaleString('en') + ' $*\\n\\nأرسل المبلغ المراد إضافته:',
          { parse_mode:'Markdown', ...build([[btn('❌ إلغاء','mg_bank_panel')]]) }
        ).catch(()=>{});
      }
      case 'mg_bank_add_amount': {
        const amount = parseInt(text);
        if(!amount || isNaN(amount) || amount === 0) {
          return ctx.reply('❌ أرسل رقم صحيح (يمكن أن يكون سالباً للخصم)').catch(()=>{});
        }
        await dbR('UPDATE bank_accounts SET balance=balance+$1 WHERE user_id=$2',[amount, state.targetId]);
        await dbR("INSERT INTO bank_transactions(from_id,to_id,amount,type,note) VALUES(0,$1,$2,'admin','إضافة يدوية من الأدمن')",[state.targetId, Math.abs(amount)]);
        const newAcc = await dbG('SELECT balance FROM bank_accounts WHERE user_id=$1',[state.targetId]).catch(()=>null);
        setState(uid, null);
        // إشعار المستخدم
        ctx.telegram.sendMessage(state.targetId,
          (amount>0?'💰 *تم إضافة ':'💸 *تم خصم ') + Math.abs(amount).toLocaleString('en') + ' $ ' + (amount>0?'لحسابك':'من حسابك') + ' من الإدارة*\\n🏦 رصيدك الجديد: *' + Number(newAcc?.balance||0).toLocaleString('en') + ' $*',
          { parse_mode:'Markdown' }
        ).catch(()=>{});
        return ctx.reply(
          '✅ *تم!*\\n👤 ' + (state.targetName||state.targetId) + '\\n' + (amount>0?'➕ أضيف: ':'➖ خُصم: ') + '*' + Math.abs(amount).toLocaleString('en') + ' $*\\n💰 الرصيد الجديد: *' + Number(newAcc?.balance||0).toLocaleString('en') + ' $*',
          { parse_mode:'Markdown', ...build([[btn('◀️ رجوع','mg_bank_panel')]]) }
        ).catch(()=>{});
      }

`,
    new: ``,
  },
  {
    file: 'handlers/manage.js',
    desc: 'حذف كولباكات لوحة البنك القديمة (mg_bank_panel/mg_bank_add/mg_bank_top/mg_bank_txs)',
    old: `  // ── البنك القديم (للتوافق) ──
  if(data==='mg_bank_panel'){
    return ctx.answerCbQuery('').catch(()=>{});
  }


  if(data==='mg_bank_add') {
    setState(uid, { type: 'mg_bank_add_id' });
    return eos(ctx,
      '🏦 *إضافة رصيد يدوي*\\n\\n' +
      'أرسل ID المستخدم:',
      { parse_mode:'Markdown', ...build([[btn('❌ إلغاء','mg_bank_panel')]]) }
    );
  }

    if(data==='mg_bank_top'){
    const { all } = require('../database/db');
    const top = await all('SELECT first_name, balance FROM bank_accounts ORDER BY balance DESC LIMIT 10').catch(()=>[]);
    let text = '🏆 *أغنى المستخدمين*\\n━━━━━━━━━━━━━━━━━━━━\\n\\n';
    top.forEach((u,i) => { text += (i+1) + '. ' + (u.first_name||'مجهول') + ' — ' + Number(u.balance).toLocaleString('en') + ' $\\n'; });
    return eos(ctx, text||'لا يوجد', {parse_mode:'Markdown', ...build([back('mg_bank_panel')])});
  }

  if(data==='mg_bank_txs'){
    const { all } = require('../database/db');
    const txs = await all('SELECT * FROM bank_transactions ORDER BY created_at DESC LIMIT 10').catch(()=>[]);
    let text = '💸 *آخر المعاملات*\\n━━━━━━━━━━━━━━━━━━━━\\n\\n';
    txs.forEach(tx => { text += (tx.type==='win'?'🏆':'💸') + ' ' + Number(tx.amount).toLocaleString('en') + ' $ — ' + (tx.note||tx.type) + '\\n'; });
    return eos(ctx, text||'لا يوجد', {parse_mode:'Markdown', ...build([back('mg_bank_panel')])});
  }

`,
    new: `  // ── البنك القديم: تحويل تلقائي لـ Pro Bank ──
  if(data==='mg_bank_panel'){
    return ctx.answerCbQuery('⚠️ هذا القسم قديم، استُبدل بـ 🏦 Taline Bank', { show_alert:true }).catch(()=>{});
  }

`,
  },

  {
    file: 'handlers/games_panel.js',
    desc: 'إحصائيات السلوت (لوحة الأدمن) → Pro Bank + تصليح عمود description المكسور أصلاً',
    old: `  const slotStats = await get('SELECT COUNT(*) as games, SUM(CASE WHEN amount>0 THEN 1 ELSE 0 END) as wins FROM bank_transactions WHERE type=$1', ['slot_win']).catch(()=>({games:0,wins:0}));`,
    new: `  const slotStats = await get("SELECT COUNT(*) as games, SUM(CASE WHEN type='slot_win' THEN 1 ELSE 0 END) as wins FROM pro_bank_transactions WHERE type IN ('slot_win','slot_bet')").catch(()=>({games:0,wins:0}));`,
  },
  {
    file: 'handlers/games_panel.js',
    desc: 'أفضل لاعبي السلوت → Pro Bank (وربط first_name عبر pro_bank_accounts، ماكانش موجود أصلاً)',
    old: `    const top = await dbAll(
      "SELECT user_id, first_name, SUM(amount) as total FROM bank_transactions WHERE description LIKE '%سلوت%' AND amount>0 GROUP BY user_id, first_name ORDER BY total DESC LIMIT 10"
    ).catch(() => []);`,
    new: `    const top = await dbAll(
      "SELECT t.to_id as user_id, a.first_name, SUM(t.amount) as total FROM pro_bank_transactions t LEFT JOIN pro_bank_accounts a ON a.user_id=t.to_id WHERE t.type='slot_win' GROUP BY t.to_id, a.first_name ORDER BY total DESC LIMIT 10"
    ).catch(() => []);`,
  },
  {
    file: 'handlers/games_panel.js',
    desc: 'إحصائيات السلوت التفصيلية → Pro Bank',
    old: `  const stats = await dbGet(
    "SELECT COUNT(*) as total, SUM(CASE WHEN description LIKE '%ربح%' THEN 1 ELSE 0 END) as wins FROM bank_transactions WHERE description LIKE '%سلوت%'"
  ).catch(() => ({ total: 0, wins: 0 }));`,
    new: `  const stats = await dbGet(
    "SELECT COUNT(*) as total, SUM(CASE WHEN type='slot_win' THEN 1 ELSE 0 END) as wins FROM pro_bank_transactions WHERE type IN ('slot_win','slot_bet')"
  ).catch(() => ({ total: 0, wins: 0 }));`,
  },
  {
    file: 'handlers/games_panel.js',
    desc: 'إحصائيات المتجر → Pro Bank',
    old: `  const purchases = await dbAll(
    "SELECT COUNT(*) as cnt FROM bank_transactions WHERE description LIKE '%متجر%' OR description LIKE '%اشترى%'"
  ).catch(() => []);`,
    new: `  const purchases = await dbAll(
    "SELECT COUNT(*) as cnt FROM pro_bank_transactions WHERE type IN ('shop_purchase','shop_box')"
  ).catch(() => []);`,
  },
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(path.dirname(ROOT), 'TALINE_BACKUP_economy_phase2_' + stamp);
fs.cpSync(ROOT, backupDir, { recursive: true, filter: (s) => !s.includes(path.sep+'node_modules') && !s.includes(path.sep+'.git') });
console.log('📦 نسخة احتياطية: ' + backupDir);

let applied = 0;
const touchedFiles = new Set();
for (const p of patches) {
  const fp = path.join(ROOT, p.file);
  const content = fs.readFileSync(fp, 'utf8');
  if (p.new.length > 0 && content.includes(p.new)) { console.log('⏭️  ' + p.desc + ' — مطبّق مسبقاً'); continue; }
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
  console.log('🎉 (' + applied + '/' + patches.length + ' تصليحات فالمرحلة 2)');
} else {
  console.log('❌ ما تطبق حتى تصليح.');
}
