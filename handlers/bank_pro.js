'use strict';
/**
 * ══════════════════════════════════════════════
 *   🏦  Taline Bank  —  نظام البنك الاحترافي
 *   handlers/bank_pro.js
 * ══════════════════════════════════════════════
 */
const { get, run, all, getPg } = require('../database/db');

// ────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────
const BANK_NAME = 'Taline Bank';
const CURRENCY  = 'DA';          // دينار جزائري

const CARD_TYPES = {
  classic:  { label: 'Classic',  emoji: '🪙', color: '⬜', daily_limit: 5_000,  fee_pct: 0.02, cashback: 0,    min_balance: 0      },
  silver:   { label: 'Silver',   emoji: '🥈', color: '🩶', daily_limit: 20_000, fee_pct: 0.015,cashback: 0,    min_balance: 5_000  },
  gold:     { label: 'Gold',     emoji: '🥇', color: '🟡', daily_limit: 80_000, fee_pct: 0.01, cashback: 0.01, min_balance: 25_000 },
  platinum: { label: 'Platinum', emoji: '💎', color: '🔷', daily_limit: 300_000,fee_pct: 0.005,cashback: 0.02, min_balance: 100_000},
  black:    { label: 'Black',    emoji: '🖤', color: '⬛', daily_limit: 999_999,fee_pct: 0,    cashback: 0.05, min_balance: 500_000},
};

const ACCOUNT_TYPES = {
  current:    { label: 'حساب جاري',       interest_daily: 0,      icon: '💳' },
  savings:    { label: 'حساب توفير',      interest_daily: 0.0003, icon: '🏦' },
  investment: { label: 'حساب استثماري',   interest_daily: 0.001,  icon: '📈' },
  business:   { label: 'حساب تجاري',      interest_daily: 0.0005, icon: '🏢' },
  vip:        { label: 'حساب VIP',        interest_daily: 0.0015, icon: '👑' },
};

const LOAN_RATES = { daily: 0.005, max_multiplier: 3 }; // فائدة 0.5% يومياً
const INVEST_TIERS = [
  { min: 1_000,   daily: 0.003, label: 'أساسي'  },
  { min: 10_000,  daily: 0.005, label: 'متوسط'  },
  { min: 50_000,  daily: 0.008, label: 'متقدم'  },
  { min: 200_000, daily: 0.012, label: 'ذهبي'   },
];

// ────────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('en') + ' ' + CURRENCY;
}

function genIBAN(userId) {
  const seed = String(userId).slice(-6).padStart(6, '0');
  return `DZ54-TLN-${seed.slice(0,4)}-${seed.slice(2)}`;
}

function creditScore(acc) {
  let score = 500;
  if (acc.balance > 10_000)   score += 50;
  if (acc.balance > 50_000)   score += 100;
  if (acc.balance > 200_000)  score += 150;
  if (acc.total_deposits > 0) score += 50;
  if (acc.loans_count === 0)  score += 50;
  if (acc.loans_paid > 0)     score += 30;
  return Math.min(850, score);
}

function getCardForBalance(balance) {
  if (balance >= 500_000) return 'black';
  if (balance >= 100_000) return 'platinum';
  if (balance >= 25_000)  return 'gold';
  if (balance >= 5_000)   return 'silver';
  return 'classic';
}

async function getAccount(userId) {
  return await get('SELECT * FROM pro_bank_accounts WHERE user_id=$1', [userId]);
}

async function ensureAccount(userId, firstName, username) {
  let acc = await getAccount(userId);
  if (!acc) {
    const iban = genIBAN(userId);
    await run(
      `INSERT INTO pro_bank_accounts
         (user_id, first_name, username, balance, card_type, account_type, iban, pin)
       VALUES ($1,$2,$3, 0, 'classic', 'current', $4, NULL)
       ON CONFLICT(user_id) DO NOTHING`,
      [userId, firstName || '', username || '', iban]
    );
    acc = await getAccount(userId);
  }
  // Auto-upgrade card based on balance
  const shouldCard = getCardForBalance(Number(acc.balance));
  if (shouldCard !== acc.card_type) {
    await run('UPDATE pro_bank_accounts SET card_type=$1 WHERE user_id=$2', [shouldCard, userId]);
    acc.card_type = shouldCard;
  }
  return acc;
}

// Atomic transfer with fee & cashback
async function _atomicTransfer({ fromId, toId, amount, type, note }) {
  const pg     = getPg();
  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    const [lockA, lockB] = fromId < toId ? [fromId, toId] : [toId, fromId];
    await client.query(
      'SELECT balance FROM pro_bank_accounts WHERE user_id = ANY($1::bigint[]) FOR UPDATE',
      [[lockA, lockB]]
    );

    const { rows } = await client.query(
      'SELECT balance, card_type FROM pro_bank_accounts WHERE user_id=$1', [fromId]
    );
    if (!rows.length || Number(rows[0].balance) < amount) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient' };
    }

    const card    = CARD_TYPES[rows[0].card_type] || CARD_TYPES.classic;
    const fee     = Math.floor(amount * card.fee_pct);
    const cashb   = Math.floor(amount * card.cashback);
    const netSend = amount + fee;

    if (Number(rows[0].balance) < netSend) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient_with_fee', fee };
    }

    await client.query('UPDATE pro_bank_accounts SET balance = balance - $1 WHERE user_id=$2', [netSend, fromId]);
    await client.query('UPDATE pro_bank_accounts SET balance = balance + $1 + $2 WHERE user_id=$3', [amount, cashb, toId]);
    await client.query(
      'INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,$2,$3,$4,$5,$6)',
      [fromId, toId, amount, fee, type, note]
    );

    await client.query('COMMIT');
    return { ok: true, fee, cashback: cashb };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────
//  1. فتح حساب | بنك
// ────────────────────────────────────────────────
exports.openAccount = async (ctx) => {
  const uid  = ctx.from?.id;
  const existing = await getAccount(uid);
  if (existing) return exports.showWallet(ctx);

  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  const card = CARD_TYPES[acc.card_type];

  await ctx.reply(
    `🏦 *أهلاً بك في ${BANK_NAME}!*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ تم فتح حسابك البنكي بنجاح!\n\n` +
    `👤 الاسم: *${ctx.from?.first_name || 'العميل'}*\n` +
    `🆔 رقم العميل: \`${uid}\`\n` +
    `🏦 IBAN: \`${acc.iban}\`\n` +
    `💳 البطاقة: ${card.emoji} *${card.label}*\n` +
    `💰 الرصيد: *${fmt(0)}*\n\n` +
    `📋 الأوامر المتاحة:\n` +
    `• *محفظتي* — عرض حسابك\n` +
    `• *بطاقتي* — تفاصيل البطاقة\n` +
    `• *كشف* — آخر المعاملات\n` +
    `• *تحويل* — تحويل مبلغ\n` +
    `• *قرض* — طلب قرض\n` +
    `• *وديعة* — إيداع مبلغ\n` +
    `• *استثمار* — استثمار أموالك`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  2. محفظتي
// ────────────────────────────────────────────────
exports.showWallet = async (ctx) => {
  const uid = ctx.from?.id;
  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  const card = CARD_TYPES[acc.card_type];
  const acct = ACCOUNT_TYPES[acc.account_type] || ACCOUNT_TYPES.current;
  const score = creditScore(acc);
  const scoreBar = '█'.repeat(Math.floor(score/85)) + '░'.repeat(10 - Math.floor(score/85));

  // نمو اليوم
  const today = await get(
    `SELECT COALESCE(SUM(amount),0) as inc FROM pro_bank_transactions WHERE to_id=$1 AND created_at > NOW()-INTERVAL '24h'`,
    [uid]
  ).catch(() => ({ inc: 0 }));

  const loans = await get(
    'SELECT COALESCE(SUM(amount),0) as total FROM pro_bank_loans WHERE user_id=$1 AND paid=0',
    [uid]
  ).catch(() => ({ total: 0 }));

  let text =
    `${card.color} *${BANK_NAME}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 العميل: *${acc.first_name || ctx.from?.first_name}*\n` +
    `🆔 ID: \`${uid}\`\n` +
    `🏦 IBAN: \`${acc.iban}\`\n\n` +
    `💰 الرصيد: *${fmt(acc.balance)}*\n`;

  if (Number(today?.inc) > 0) text += `📈 دخل اليوم: +${fmt(today.inc)}\n`;
  if (Number(loans?.total) > 0) text += `🔴 ديون: ${fmt(loans.total)}\n`;

  text +=
    `\n💳 البطاقة: ${card.emoji} *${card.label}*\n` +
    `${acct.icon} الحساب: *${acct.label}*\n\n` +
    `📊 Credit Score:\n` +
    `\`${scoreBar}\` ${score}/850\n\n` +
    `🔒 الحالة: ${acc.is_frozen ? '🔴 مجمد' : '🟢 نشط'}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '💳 بطاقتي',    callback_data: 'bankpro:card'     },
        { text: '📋 كشف حساب',  callback_data: 'bankpro:statement'},
      ],
      [
        { text: '💸 تحويل',     callback_data: 'bankpro:transfer_help' },
        { text: '📈 استثمار',   callback_data: 'bankpro:invest_menu'   },
      ],
      [
        { text: '🏦 قرض',       callback_data: 'bankpro:loan_menu'  },
        { text: '⚙️ إعدادات',   callback_data: 'bankpro:settings'   },
      ],
    ],
  };

  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
    reply_to_message_id: ctx.message?.message_id,
  }).catch(() => {});
};

// ────────────────────────────────────────────────
//  حسابي — تفاصيل بدون أزرار
// ────────────────────────────────────────────────
exports.showWalletNoButtons = async (ctx) => {
  const uid = ctx.from?.id;
  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  const card = CARD_TYPES[acc.card_type];
  const acct = ACCOUNT_TYPES[acc.account_type] || ACCOUNT_TYPES.current;
  const score = creditScore(acc);
  const scoreBar = '█'.repeat(Math.floor(score/85)) + '░'.repeat(10 - Math.floor(score/85));

  const loans = await get(
    'SELECT COALESCE(SUM(amount),0) as total FROM pro_bank_loans WHERE user_id=$1 AND paid=0',
    [uid]
  ).catch(() => ({ total: 0 }));

  const text =
    `${card.color} *${BANK_NAME}*
` +
    `━━━━━━━━━━━━━━━━━━━━

` +
    `👤 العميل: *${acc.first_name || ctx.from?.first_name}*
` +
    `🆔 ID: \`${uid}\`
` +
    `🏦 IBAN: \`${acc.iban}\`

` +
    `💰 الرصيد: *${fmt(acc.balance)} DA*
` +
    (Number(loans?.total) > 0 ? `🔴 ديون: ${fmt(loans.total)} DA
` : '') +
    `
💳 البطاقة: ${card.emoji} *${card.label}*
` +
    `${acct.icon} الحساب: *${acct.label}*

` +
    `📊 Credit Score:
` +
    `\`${scoreBar}\` ${score}/850

` +
    `🔒 الحالة: ${acc.is_frozen ? '🔴 مجمد' : '🟢 نشط'}`;

  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_to_message_id: ctx.message?.message_id,
  }).catch(() => {});
};

// ────────────────────────────────────────────────
//  فلوسي — رصيد فقط
// ────────────────────────────────────────────────
exports.showBalance = async (ctx) => {
  const uid = ctx.from?.id;
  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  return ctx.reply(
    `💰 رصيدك: *${fmt(acc.balance)} DA*`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  3. بطاقتي
// ────────────────────────────────────────────────
exports.showCard = async (ctx) => {
  const uid = ctx.from?.id;
  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  const card = CARD_TYPES[acc.card_type];

  // حساب المصروف اليومي
  const spent = await get(
    `SELECT COALESCE(SUM(amount+fee),0) as s FROM pro_bank_transactions WHERE from_id=$1 AND created_at > NOW()-INTERVAL '24h'`,
    [uid]
  ).catch(() => ({ s: 0 }));

  const usedPct  = Math.min(100, Math.floor((Number(spent?.s) / card.daily_limit) * 100));
  const usedBar  = '█'.repeat(Math.floor(usedPct/10)) + '░'.repeat(10 - Math.floor(usedPct/10));

  // تنسيق رقم البطاقة المخفي
  const cardNum  = `•••• •••• •••• ${String(uid).slice(-4)}`;
  const expiry   = (() => {
    const d = new Date(acc.created_at);
    d.setFullYear(d.getFullYear() + 4);
    return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear()).slice(-2)}`;
  })();

  // البطاقات المتاحة للترقية
  const nextCards = Object.entries(CARD_TYPES).filter(([k]) => {
    const types = ['classic','silver','gold','platinum','black'];
    return types.indexOf(k) > types.indexOf(acc.card_type);
  });

  let text =
    `${card.color} *${card.emoji} بطاقة ${card.label}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔢 \`${cardNum}\`\n` +
    `📅 الصلاحية: ${expiry}\n` +
    `👤 ${acc.first_name || ctx.from?.first_name}\n\n` +
    `💸 رسوم التحويل: ${(card.fee_pct * 100).toFixed(1)}%\n`;

  if (card.cashback > 0)
    text += `🎁 كاش باك: ${(card.cashback * 100).toFixed(0)}%\n`;

  text +=
    `📊 الحد اليومي: ${fmt(card.daily_limit)}\n` +
    `📉 المستخدم اليوم: \`${usedBar}\` ${usedPct}%\n`;

  if (nextCards.length > 0) {
    const [nextKey, nextCard] = nextCards[0];
    text += `\n⬆️ *ترقية للـ ${nextCard.emoji} ${nextCard.label}*\nيلزمك رصيد: ${fmt(nextCard.min_balance)}`;
  }

  if (acc.is_frozen)
    text += `\n\n🔴 *البطاقة مجمدة*`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: acc.is_frozen ? '🟢 فك التجميد' : '🔴 تجميد البطاقة', callback_data: 'bankpro:toggle_freeze' },
        { text: '🔑 تغيير PIN', callback_data: 'bankpro:set_pin' },
      ],
      [{ text: '🏦 العودة للمحفظة', callback_data: 'bankpro:wallet' }],
    ],
  };

  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
    reply_to_message_id: ctx.message?.message_id,
  }).catch(() => {});
};

// ────────────────────────────────────────────────
//  4. كشف الحساب
// ────────────────────────────────────────────────
exports.showStatement = async (ctx) => {
  const uid = ctx.from?.id;
  const acc = await getAccount(uid);
  if (!acc) return _noAccount(ctx);

  const txs = await all(
    `SELECT t.*, 
      (SELECT first_name FROM pro_bank_accounts WHERE user_id=t.from_id LIMIT 1) as from_name,
      (SELECT first_name FROM pro_bank_accounts WHERE user_id=t.to_id   LIMIT 1) as to_name
     FROM pro_bank_transactions t
     WHERE t.to_id=$1 OR t.from_id=$1
     ORDER BY t.created_at DESC LIMIT 10`,
    [uid]
  ).catch(() => []);

  let text = `📋 *كشف حساب — ${BANK_NAME}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (!txs.length) {
    text += '_(لا توجد معاملات بعد)_';
  } else {
    txs.forEach(t => {
      const isIn   = t.to_id == uid;
      const sign   = isIn ? '🟢 +' : '🔴 -';
      const who    = isIn ? (t.from_name || 'النظام') : (t.to_name || 'النظام');
      const typeAr = { transfer: 'تحويل', win: 'جائزة', loan: 'قرض', invest: 'استثمار', deposit: 'إيداع', salary: 'راتب' }[t.type] || t.type;
      const date   = new Date(t.created_at).toLocaleDateString('ar-DZ', { month:'short', day:'numeric' });
      text += `${sign}${fmt(t.amount)} ${typeAr}\n`;
      text += `   👤 ${who}  📅 ${date}\n`;
      if (t.fee > 0) text += `   💸 رسوم: ${fmt(t.fee)}\n`;
      text += '\n';
    });
  }

  text += `\n💰 *الرصيد الحالي: ${fmt(acc.balance)}*`;

  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🏦 المحفظة', callback_data: 'bankpro:wallet' }]] },
    reply_to_message_id: ctx.message?.message_id,
  }).catch(() => {});
};

// ────────────────────────────────────────────────
//  5. تحويل | تحويل [مبلغ] (رد على رسالة)
// ────────────────────────────────────────────────
exports.transfer = async (ctx) => {
  const uid     = ctx.from?.id;
  const replyTo = ctx.message?.reply_to_message;
  const txt     = ctx.message?.text || '';

  if (!replyTo || replyTo.from?.id === uid) {
    return ctx.reply(
      '💸 *كيف تحول؟*\n\n' +
      'رد على رسالة المستخدم واكتب:\n`تحويل 5000`\n\n' +
      '• يُطبَّق رسم حسب نوع بطاقتك\n' +
      '• بطاقة Gold وأعلى تحصل على كاش باك',
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
    ).catch(() => {});
  }

  const toId  = replyTo.from?.id;
  const match = txt.match(/تحويل\s+(\d+(?:\.\d+)?)/);
  if (!match) return ctx.reply('❌ صيغة خاطئة. مثال: `تحويل 5000`',
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  const amount = parseFloat(match[1]);
  if (amount < 100) return ctx.reply('❌ الحد الأدنى للتحويل 100 ' + CURRENCY,
    { reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  const fromAcc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  if (fromAcc.is_frozen)
    return ctx.reply('🔴 بطاقتك مجمدة! اكتب *بطاقتي* لفكّ التجميد.',
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  const card = CARD_TYPES[fromAcc.card_type];
  // فحص الحد اليومي
  const dailySpent = await get(
    `SELECT COALESCE(SUM(amount+fee),0) as s FROM pro_bank_transactions WHERE from_id=$1 AND created_at > NOW()-INTERVAL '24h'`,
    [uid]
  ).catch(() => ({ s: 0 }));

  if (Number(dailySpent?.s) + amount > card.daily_limit) {
    return ctx.reply(
      `❌ تجاوزت الحد اليومي للبطاقة ${card.emoji} *${card.label}*\n` +
      `الحد: ${fmt(card.daily_limit)} | المستخدم: ${fmt(dailySpent?.s)}`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
    ).catch(() => {});
  }

  await ensureAccount(toId, replyTo.from?.first_name, replyTo.from?.username);

  const result = await _atomicTransfer({
    fromId: uid, toId, amount, type: 'transfer',
    note: `تحويل من ${ctx.from?.first_name || uid}`,
  }).catch(e => ({ ok: false, reason: e.message }));

  if (!result.ok) {
    const msg = result.reason === 'insufficient' || result.reason === 'insufficient_with_fee'
      ? `❌ رصيدك غير كافٍ${result.fee ? ` (+ رسوم ${fmt(result.fee)})` : ''}`
      : '❌ فشل التحويل، حاول مجدداً.';
    return ctx.reply(msg, { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});
  }

  const [fromNew, toNew] = await Promise.all([getAccount(uid), getAccount(toId)]);

  // إشعار المستلم
  ctx.telegram.sendMessage(toId,
    `💸 *وصلتك حوالة!*\n\n` +
    `👤 من: *${ctx.from?.first_name || 'مجهول'}*\n` +
    `💰 المبلغ: *${fmt(amount)}*\n` +
    (result.cashback > 0 ? `🎁 كاش باك: +${fmt(result.cashback)}\n` : '') +
    `💳 رصيدك: *${fmt(toNew?.balance ?? 0)}*`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  return ctx.reply(
    `✅ *تم التحويل بنجاح!*\n\n` +
    `💸 المبلغ: *${fmt(amount)}*\n` +
    `💸 الرسوم: ${fmt(result.fee)}\n` +
    (result.cashback > 0 ? `🎁 كاش باك للمستلم: ${fmt(result.cashback)}\n` : '') +
    `👤 إلى: *${replyTo.from?.first_name || toId}*\n` +
    `💳 رصيدك المتبقي: *${fmt(fromNew?.balance ?? 0)}*`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  6. قرض
// ────────────────────────────────────────────────
exports.requestLoan = async (ctx) => {
  const uid  = ctx.from?.id;
  const txt  = ctx.message?.text || '';
  const match = txt.match(/قرض\s+(\d+(?:\.\d+)?)/);

  if (!match) {
    const acc = await getAccount(uid);
    const maxLoan = acc ? Math.floor(Number(acc.balance) * LOAN_RATES.max_multiplier) : 0;
    return ctx.reply(
      `🏦 *نظام القروض — ${BANK_NAME}*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📝 الصيغة: \`قرض [مبلغ]\`\n` +
      `مثال: \`قرض 10000\`\n\n` +
      `📊 الحد الأقصى المتاح: *${fmt(maxLoan)}*\n` +
      `💸 فائدة: ${(LOAN_RATES.daily * 100).toFixed(1)}% يومياً\n` +
      `📅 مدة السداد: 30 يوم\n\n` +
      `⚠️ عدم السداد يخفض الـ Credit Score`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
    ).catch(() => {});
  }

  const amount = parseFloat(match[1]);
  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);

  // فحص قرض سابق غير مسدد
  const existingLoan = await get(
    'SELECT COUNT(*) as c FROM pro_bank_loans WHERE user_id=$1 AND paid=0', [uid]
  ).catch(() => ({ c: 0 }));
  if (Number(existingLoan?.c) > 0) {
    return ctx.reply('❌ لديك قرض غير مسدد! أسدد قرضك أولاً.\n\nاكتب: *ديوني* لعرض القرض الحالي.',
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});
  }

  const maxLoan = Math.floor(Number(acc.balance) * LOAN_RATES.max_multiplier);
  if (amount < 500) return ctx.reply('❌ الحد الأدنى للقرض 500 ' + CURRENCY,
    { reply_to_message_id: ctx.message?.message_id }).catch(() => {});
  if (amount > maxLoan) return ctx.reply(
    `❌ الحد الأقصى للقرض هو *${fmt(maxLoan)}*\n(3× رصيدك الحالي)`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  const totalDue = Math.ceil(amount * (1 + LOAN_RATES.daily * 30));
  const dueDate  = new Date(Date.now() + 30 * 86400_000);

  await run('UPDATE pro_bank_accounts SET balance = balance + $1 WHERE user_id=$2', [amount, uid]);
  await run(
    'INSERT INTO pro_bank_loans(user_id, amount, total_due, due_at) VALUES($1,$2,$3,$4)',
    [uid, amount, totalDue, dueDate]
  );
  await run(
    `INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,$2,$3,0,'loan','قرض من ${BANK_NAME}')`,
    [uid, uid, amount]
  );

  const newAcc = await getAccount(uid);
  return ctx.reply(
    `✅ *تمت الموافقة على القرض!*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 مبلغ القرض: *${fmt(amount)}*\n` +
    `💸 إجمالي السداد: *${fmt(totalDue)}*\n` +
    `📅 تاريخ الاستحقاق: ${dueDate.toLocaleDateString('ar-DZ')}\n` +
    `💳 رصيدك الآن: *${fmt(newAcc?.balance ?? 0)}*\n\n` +
    `💡 لسداد القرض اكتب: *سداد*`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  7. ديوني
// ────────────────────────────────────────────────
exports.showLoans = async (ctx) => {
  const uid = ctx.from?.id;
  const loans = await all(
    'SELECT * FROM pro_bank_loans WHERE user_id=$1 AND paid=0 ORDER BY created_at DESC',
    [uid]
  ).catch(() => []);

  if (!loans.length) return ctx.reply('✅ لا توجد قروض مستحقة!',
    { reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  let text = `💳 *قروضك الحالية — ${BANK_NAME}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  loans.forEach((l, i) => {
    const due    = new Date(l.due_at);
    const daysLeft = Math.ceil((due - Date.now()) / 86400_000);
    const status  = daysLeft > 0 ? `⏳ ${daysLeft} يوم متبقي` : `🔴 متأخر ${Math.abs(daysLeft)} يوم`;
    text += `${i+1}. ${fmt(l.total_due)} — ${status}\n`;
  });

  const totalDue = loans.reduce((s, l) => s + Number(l.total_due), 0);
  text += `\n💸 إجمالي الديون: *${fmt(totalDue)}*\n\nاكتب *سداد* لتسديد القرض.`;

  return ctx.reply(text, { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});
};

// ────────────────────────────────────────────────
//  8. سداد القرض
// ────────────────────────────────────────────────
exports.repayLoan = async (ctx) => {
  const uid  = ctx.from?.id;
  const acc  = await getAccount(uid);
  if (!acc) return _noAccount(ctx);

  const loan = await get(
    'SELECT * FROM pro_bank_loans WHERE user_id=$1 AND paid=0 ORDER BY created_at ASC LIMIT 1', [uid]
  ).catch(() => null);

  if (!loan) return ctx.reply('✅ ليس لديك قروض! أنت خالٍ من الديون.',
    { reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  const due = Number(loan.total_due);
  if (Number(acc.balance) < due) {
    return ctx.reply(
      `❌ رصيدك غير كافٍ للسداد!\n\n💸 المطلوب: *${fmt(due)}*\n💳 رصيدك: *${fmt(acc.balance)}*\n\nالفرق: ${fmt(due - Number(acc.balance))}`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
    ).catch(() => {});
  }

  await run('UPDATE pro_bank_accounts SET balance = balance - $1 WHERE user_id=$2', [due, uid]);
  await run('UPDATE pro_bank_loans SET paid=1, paid_at=NOW() WHERE id=$1', [loan.id]);
  await run(
    `INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,$2,$3,0,'repay','سداد قرض')`,
    [uid, uid, due]
  );

  const newAcc = await getAccount(uid);
  return ctx.reply(
    `✅ *تم سداد القرض بالكامل!*\n\n💸 المبلغ المسدد: *${fmt(due)}*\n💳 رصيدك المتبقي: *${fmt(newAcc?.balance ?? 0)}*\n\n🏅 Credit Score تحسّن!`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  9. استثمار
// ────────────────────────────────────────────────
exports.invest = async (ctx) => {
  const uid   = ctx.from?.id;
  const txt   = ctx.message?.text || '';
  const match = txt.match(/استثمار\s+(\d+(?:\.\d+)?)/);

  if (!match) {
    let text = `📈 *الاستثمار — ${BANK_NAME}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    INVEST_TIERS.forEach(t => {
      text += `${t.label}: من ${fmt(t.min)} → فائدة ${(t.daily*100).toFixed(1)}%/يوم\n`;
    });
    text += `\nالصيغة: \`استثمار [مبلغ]\``;

    // عرض الاستثمارات الحالية
    const active = await all(
      'SELECT * FROM pro_bank_investments WHERE user_id=$1 AND active=1', [uid]
    ).catch(() => []);
    if (active.length) {
      text += '\n\n📊 *استثماراتك الحالية:*\n';
      active.forEach(inv => {
        const days = Math.floor((Date.now() - new Date(inv.created_at)) / 86400_000);
        const earned = Math.floor(Number(inv.amount) * inv.daily_rate * days);
        text += `• ${fmt(inv.amount)} — ${days} أيام — ربح: +${fmt(earned)}\n`;
      });
      text += '\nاكتب *سحب استثمار* لسحب أرباحك.';
    }

    return ctx.reply(text, { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});
  }

  const amount = parseFloat(match[1]);
  const acc = await ensureAccount(uid, ctx.from?.first_name, ctx.from?.username);
  if (Number(acc.balance) < amount)
    return ctx.reply('❌ رصيدك غير كافٍ!', { reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  const tier = [...INVEST_TIERS].reverse().find(t => amount >= t.min);
  if (!tier)
    return ctx.reply(`❌ الحد الأدنى للاستثمار ${fmt(INVEST_TIERS[0].min)}`,
      { reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  await run('UPDATE pro_bank_accounts SET balance = balance - $1 WHERE user_id=$2', [amount, uid]);
  await run(
    'INSERT INTO pro_bank_investments(user_id, amount, daily_rate, tier) VALUES($1,$2,$3,$4)',
    [uid, amount, tier.daily, tier.label]
  );

  return ctx.reply(
    `✅ *تم الاستثمار بنجاح!*\n\n` +
    `💰 المبلغ: *${fmt(amount)}*\n` +
    `📊 المستوى: *${tier.label}*\n` +
    `📈 فائدة يومية: *${(tier.daily*100).toFixed(1)}%*\n` +
    `💡 ربح يومي تقريبي: *${fmt(Math.floor(amount * tier.daily))}*\n\n` +
    `اكتب *سحب استثمار* لسحب أرباحك في أي وقت.`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  10. سحب استثمار
// ────────────────────────────────────────────────
exports.withdrawInvest = async (ctx) => {
  const uid = ctx.from?.id;
  const investments = await all(
    'SELECT * FROM pro_bank_investments WHERE user_id=$1 AND active=1', [uid]
  ).catch(() => []);

  if (!investments.length)
    return ctx.reply('❌ لا توجد استثمارات نشطة!', { reply_to_message_id: ctx.message?.message_id }).catch(() => {});

  let totalPrincipal = 0, totalProfit = 0;
  for (const inv of investments) {
    const days   = Math.max(1, Math.floor((Date.now() - new Date(inv.created_at)) / 86400_000));
    const profit = Math.floor(Number(inv.amount) * inv.daily_rate * days);
    totalPrincipal += Number(inv.amount);
    totalProfit    += profit;
    await run('UPDATE pro_bank_investments SET active=0, profit_earned=$1 WHERE id=$2', [profit, inv.id]);
  }

  const total = totalPrincipal + totalProfit;
  await run('UPDATE pro_bank_accounts SET balance = balance + $1 WHERE user_id=$2', [total, uid]);
  await run(
    `INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,$2,$3,0,'invest','أرباح استثمار')`,
    [uid, uid, totalProfit]
  );

  const newAcc = await getAccount(uid);
  return ctx.reply(
    `✅ *تم سحب الاستثمار!*\n\n` +
    `💰 الأصل: *${fmt(totalPrincipal)}*\n` +
    `📈 الأرباح: *+${fmt(totalProfit)}*\n` +
    `━━━━━━━━━━━━\n` +
    `💎 الإجمالي: *${fmt(total)}*\n\n` +
    `💳 رصيدك الآن: *${fmt(newAcc?.balance ?? 0)}*`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }
  ).catch(() => {});
};

// ────────────────────────────────────────────────
//  11. ترتيب الأثرياء
// ────────────────────────────────────────────────
exports.richList = async (ctx) => {
  const top = await all(
    'SELECT first_name, username, balance, card_type FROM pro_bank_accounts ORDER BY balance DESC LIMIT 10'
  ).catch(() => []);

  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let text = `🏆 *أثرياء ${BANK_NAME}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  top.forEach((u, i) => {
    const card = CARD_TYPES[u.card_type] || CARD_TYPES.classic;
    text += `${medals[i]} *${u.first_name || 'مجهول'}* ${card.emoji}\n   ${fmt(u.balance)}\n`;
  });

  return ctx.reply(text, { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});
};

// ────────────────────────────────────────────────
//  12. تجميد / فك تجميد (callback)
// ────────────────────────────────────────────────
exports.toggleFreeze = async (ctx) => {
  const uid = ctx.from?.id;
  const acc = await getAccount(uid);
  if (!acc) return ctx.answerCbQuery('❌ لا يوجد حساب!').catch(() => {});

  const newState = acc.is_frozen ? 0 : 1;
  await run('UPDATE pro_bank_accounts SET is_frozen=$1 WHERE user_id=$2', [newState, uid]);

  await ctx.answerCbQuery(newState ? '🔴 تم تجميد البطاقة' : '🟢 تم فك التجميد').catch(() => {});
  return exports.showCard(ctx);
};

// ────────────────────────────────────────────────
//  CALLBACK ROUTER
// ────────────────────────────────────────────────
exports.handleCallback = async (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  if (!data.startsWith('bankpro:')) return;

  const action = data.split(':')[1];
  await ctx.answerCbQuery().catch(() => {});

  switch (action) {
    case 'wallet':      return exports.showWallet(ctx);
    case 'card':        return exports.showCard(ctx);
    case 'statement':   return exports.showStatement(ctx);
    case 'toggle_freeze': return exports.toggleFreeze(ctx);
    case 'transfer_help':
      return ctx.reply('💸 رد على رسالة المستخدم واكتب:\n`تحويل 5000`',
        { parse_mode: 'Markdown' }).catch(() => {});
    case 'invest_menu': return exports.invest(ctx);
    case 'loan_menu':   return exports.requestLoan(ctx);
    case 'settings':
      return ctx.reply('⚙️ *إعدادات البنك*\n\nاكتب *تجميد بطاقتي* لتجميد حسابك.',
        { parse_mode: 'Markdown' }).catch(() => {});
    default: break;
  }
};

// ────────────────────────────────────────────────
//  HELPER: لا يوجد حساب
// ────────────────────────────────────────────────
function _noAccount(ctx) {
  return ctx.reply('❌ لا يوجد حساب بنكي! اكتب *بنك* لفتح حساب.',
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id }).catch(() => {});
}

// export helper for games
exports.addWinnings = async (userId, firstName, username, amount, note) => {
  try {
    await ensureAccount(userId, firstName, username);
    await run('UPDATE pro_bank_accounts SET balance = balance + $1 WHERE user_id=$2', [amount, userId]);
    await run(
      `INSERT INTO pro_bank_transactions(from_id,to_id,amount,fee,type,note) VALUES($1,$2,$3,0,'win',$4)`,
      [userId, userId, amount, note || 'جائزة لعبة']
    );
    return true;
  } catch(e) { return false; }
};
exports.getAccount    = getAccount;
exports.ensureAccount  = ensureAccount;
exports.fmt            = fmt;
