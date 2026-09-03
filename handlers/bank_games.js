'use strict';
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
  await run('INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,$2,$3,0,$4,$5)', [fromId, toId, amount, type, note]).catch(()=>{});
}

async function handleDaily(ctx) {
  const uid=ctx.from?.id;
  const acc=await ensureAcc(ctx);
  const ck='daily_'+uid;
  const last=cacheGet(ck);
  if(last){ const rem=86400000-(Date.now()-last); if(rem>0){ const h=Math.floor(rem/3600000),m=Math.floor((rem%3600000)/60000); return ctx.reply('⏳ *انتظر '+h+'س '+m+'د*\n💰 رصيدك: *'+fmt(acc.balance)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{}); } }
  const lr=await get("SELECT created_at FROM pro_bank_transactions WHERE from_id=0 AND to_id=$1 AND type='daily' ORDER BY created_at DESC LIMIT 1",[uid]).catch(()=>null);
  if(lr?.created_at){ const t=new Date(lr.created_at).getTime(),rem=86400000-(Date.now()-t); if(rem>0){ cacheSet(ck,t,rem); const h=Math.floor(rem/3600000),m=Math.floor((rem%3600000)/60000); return ctx.reply('⏳ *انتظر '+h+'س '+m+'د*\n💰 رصيدك: *'+fmt(acc.balance)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{}); } }
  const xr=await get('SELECT xp FROM user_xp WHERE user_id=$1',[uid]).catch(()=>null);
  const bonus=Math.floor((xr?.xp||0)/100)*50;
  const reward=Math.min(500+bonus,5000);
  await run('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[reward,uid]);
  await logTx(0, uid, reward, 'daily', 'مكافأة يومية');
  cacheSet(ck,Date.now(),86400000);
  return ctx.reply('🎁 *مكافأتك اليومية!*\n━━━━━━━━━━━━━━━\n\n💰 المكافأة: *+'+fmt(reward)+'*'+(bonus>0?' _(مكافأة مستوى)_':'')+'\n🏦 الرصيد: *'+fmt((acc.balance||0)+reward)+'*\n\n ⏰ عود غداً!', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
}

async function handleFlip(ctx) {
  const uid=ctx.from?.id;
  const args=(ctx.message?.text||'').split(' ');
  const bet=parseInt(args[1]);
  if(!bet||bet<100) return ctx.reply('🎲 *قلب العملة*\n\nالاستخدام: /flip [مبلغ]\nمثال: /flip 500\nالحد الأدنى: 100 DA', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const acc=await ensureAcc(ctx);
  if((acc.balance||0)<bet) return ctx.reply('❌ رصيدك غير كافٍ!\n💰 رصيدك: *'+fmt(acc.balance)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const maxBet=Math.min(Math.floor((acc.balance||0)*0.5),50000);
  if(bet>maxBet) return ctx.reply('⚠️ الحد الأقصى: *'+fmt(maxBet)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const wm=await ctx.reply('🪙 تقلب العملة...',{reply_to_message_id:ctx.message?.message_id}).catch(()=>null);
  await new Promise(r=>setTimeout(r,1500));
  const win=Math.random()<0.5;
  const change=win?bet:-bet;
  await run('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[change,uid]);
  await logTx(win?0:uid, win?uid:0, bet, 'flip', win?'ربح قلب عملة':'خسارة قلب عملة');
  if(win){ try{ const {awardPoints}=require('../database/points'); await awardPoints(uid,'rating').catch(()=>{}); }catch(_){} }
  const newBal=(acc.balance||0)+change;
  const txt=win?'🦅 *صقر — فزت!*\n\n💰 ربحت: *+'+fmt(bet)+'*\n🏦 رصيدك: *'+fmt(newBal)+'*':'🪙 *كتابة — خسرت!*\n\n💸 خسرت: *-'+fmt(bet)+'*\n🏦 رصيدك: *'+fmt(newBal)+'*\n_حظاً أوفر!_';
  if(wm) ctx.telegram.editMessageText(ctx.chat.id,wm.message_id,null,txt,{parse_mode:'Markdown'}).catch(()=>ctx.reply(txt, { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{}));
  else ctx.reply(txt, { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
}

async function handleRob(ctx) {
  const uid=ctx.from?.id;
  const target=ctx.message?.reply_to_message?.from;
  if(!target||target.is_bot||target.id===uid) return ctx.reply('🦹 *السرقة*\n\nرد على رسالة شخص لتسرقه!\nنسبة نجاح: 40% — عند الفشل: غرامة 5%', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  const rk='rob_'+uid;
  if(cacheGet(rk)) return ctx.reply('⏳ انتظر 5 دقائق بين كل سرقة!',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  const [ra,va]=await Promise.all([ensureAcc(ctx),getAcc(target.id)]);
  if(!va||va.balance<200) return ctx.reply('😔 الضحية مفلسة — ما في شيء يُسرق!',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  cacheSet(rk,1,300000);
  const ok2=Math.random()<0.4;
  if(ok2){
    const s=Math.floor(Math.min(va.balance*0.1,2000));
    await Promise.all([run('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[s,uid]),run('UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2',[s,target.id])]);
    await logTx(target.id, uid, s, 'rob', 'سرقة');
    return ctx.reply('🦹 *السرقة نجحت!*\n\n🎯 الضحية: *'+(target.first_name||'مجهول')+'*\n💰 المسروق: *'+fmt(s)+'*\n🏦 رصيدك: *'+fmt((ra.balance||0)+s)+'*', { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
  } else {
    const f=Math.min(Math.floor((ra.balance||0)*0.05),500);
    await Promise.all([run('UPDATE pro_bank_accounts SET balance=balance-$1 WHERE user_id=$2',[f,uid]),run('UPDATE pro_bank_accounts SET balance=balance+$1 WHERE user_id=$2',[f,target.id])]);
    await logTx(uid, target.id, f, 'rob_fine', 'غرامة سرقة');
    return ctx.reply('🚔 *السرقة فشلت!*\n\n👮 تم القبض عليك\n💸 الغرامة: *-'+fmt(f)+'*\n🏦 رصيدك: *'+fmt(Math.max(0,(ra.balance||0)-f))+'*',{parse_mode:'Markdown',reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  }
}

async function handleLeaderboard(ctx) {
  const isGrp=['group','supergroup'].includes(ctx.chat?.type);
  const cid=ctx.chat?.id;
  let pl;
  if(isGrp) pl=await all('SELECT ba.user_id,ba.first_name,ba.username,ba.balance FROM pro_bank_accounts ba INNER JOIN group_members gm ON gm.user_id=ba.user_id AND gm.chat_id=$1 ORDER BY ba.balance DESC LIMIT 10',[cid]).catch(()=>[]);
  else pl=await all('SELECT user_id,first_name,username,balance FROM pro_bank_accounts ORDER BY balance DESC LIMIT 10').catch(()=>[]);
  if(!pl?.length) return ctx.reply('📭 لا يوجد لاعبون بعد!\n\nاكتب: انشاء حساب',{reply_to_message_id:ctx.message?.message_id}).catch(()=>{});
  const md=['🥇','🥈','🥉'];
  let txt='🏆 *'+(isGrp?'أثرياء المجموعة':'المتصدرون عالمياً')+'*\n━━━━━━━━━━━━━━━━━━━━\n\n';
  pl.forEach((p,i)=>{ const me=p.user_id==ctx.from?.id; txt+=( md[i]||(i+1)+'.')+(me?' *أنت —* ':' ')+(p.first_name||p.username||'مجهول')+'\n   💰 '+fmt(p.balance)+'\n\n'; });
  return ctx.reply(txt, { reply_to_message_id: ctx.message?.message_id, parse_mode:'Markdown'}).catch(()=>{});
}

const GAMES_MENU_TEXT =
  '🎮 *ألعاب القروب*\n\n' +
  '🏆 مليون\n' +
  '📸 خمن\n' +
  '🐺 لوب غارو\n' +
  '🎲 صحصح\n\n' +
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
      '🐺 *طريقة لعب — لوب غارو*\n━━━━━━━━━━━━━━━\n\n' +
      '1️⃣ اكتب *لوب غارو* في القروب لإنشاء غرفة\n' +
      '2️⃣ اضغط ✅ انضمام (6-15 لاعب)\n' +
      '3️⃣ يضغط المنشئ 🚀 ابدأ اللعبة\n' +
      '4️⃣ تصلك أدوارك بالخاص — تابع تعليماتها\n' +
      '5️⃣ ليلاً: تنفّذ القدرات سرّاً (ذئب/عراف/ساحرة...)\n' +
      '6️⃣ نهاراً: ناقشوا وصوّتوا لإعدام المشتبه به\n\n' +
      '🏆 القرية تفوز بالقضاء على الذئاب، والذئاب تفوز بالقضاء على القرية\n\n' +
      '📖 لقوانين كاملة مع كل الأدوار: اكتب `/ww_rules`',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }
  if(data==='games_how_tod'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '🎲 *طريقة لعب — صحصح (أكسيو أو فيريتي)*\n━━━━━━━━━━━━━━━\n\n' +
      '1️⃣ اكتب *صحصح* في القروب لإنشاء غرفة\n' +
      '2️⃣ اكتب *أنا* للانضمام\n' +
      '3️⃣ يكتب المنشئ *ابدأ*\n' +
      '4️⃣ المجيب يختار 🔥 أكسيو أو 💬 فيريتي\n' +
      '5️⃣ السائل يكتب: `سل` ثم سؤاله — مثال: `سل كم عمرك؟`\n' +
      '6️⃣ المجيب يجيب: `اجب` ثم إجابته — مثال: `اجب 20 سنة`\n\n' +
      '📖 لقوانين كاملة: اكتب `/tod_rules`',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }
  if(data==='games_how_million'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '🏆 *طريقة لعب — من سيربح المليون*\n━━━━━━━━━━━━━━━\n\n' +
      '1️⃣ اكتب *مليون* في القروب لبدء جلسة\n' +
      '2️⃣ اكتب *أنا* للانضمام (يتسع لـ 30 لاعب)\n' +
      '3️⃣ تبدأ اللعبة بعد 20 ثانية تلقائياً\n' +
      '4️⃣ أجب على الأسئلة باختيار أ/ب/ج/د\n' +
      '5️⃣ لديك 30 ثانية لكل سؤال\n' +
      '6️⃣ الفائز يأخذ الجائزة في حسابه البنكي💰\n\n' +
      '🛟 *المساعدات:*\n' +
      '5️⃣0️⃣ مساعدة 50/50\n' +
      '👥 مساعدة الجمهور\n' +
      '📞 مساعدة صديق\n' +
      '⏭️ تخطي السؤال',
      { parse_mode:'Markdown', reply_markup: GAMES_BACK_KB }
    ).catch(()=>{});
  }
  if(data==='games_how_guess'){
    ctx.answerCbQuery().catch(()=>{});
    return ctx.editMessageText(
      '📸 *طريقة لعب — خمن الصورة*\n━━━━━━━━━━━━━━━\n\n' +
      '1️⃣ اكتب *خمن* في القروب لبدء تحدي\n' +
      '2️⃣ اكتب *أنا* للانضمام (لاعبان فقط)\n' +
      '3️⃣ كل لاعب يرسل صورة سرية للبوت في الخاص\n' +
      '4️⃣ البوت يعرض الصورتين في القروب\n' +
      '5️⃣ من يخمن صورة منافسه أولاً يفوز\n' +
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
