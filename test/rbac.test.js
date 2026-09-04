'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  🧪 test/rbac.test.js — RBAC scenario tests
 * ════════════════════════════════════════════════════════════
 *
 * يشغّل الكود الحقيقي المشحون فعلاً في:
 *   - database/admins.js   (hasPerm, sanitizePerms, add, updatePerms, getPerms, isAdmin)
 *   - middlewares/rbac.js  (checkPermission, checkPerm, requirePerm, requireOwner, botRequirePerm)
 *
 * وليس إعادة كتابة للمنطق. الاستبدال الوحيد هو طبقة قاعدة البيانات (database/db.js)
 * و middlewares/auth.js — يُستبدلان بـ stub بسيط في الذاكرة، لأن هذه البيئة الحالية
 * لا تملك pg/express مثبّتة (لا يوجد اتصال شبكة لتشغيل npm install).
 *
 * التشغيل: node test/rbac.test.js
 * على جهازك (بعد npm install) يمكنك أيضاً حذف هذا الـ stub لاحقاً وتشغيله ضد DB حقيقية
 * تجريبية إذا رغبت باختبار تكاملي كامل — لكن هذا الملف كافٍ للتحقق من منطق RBAC نفسه.
 */

const path = require('path');
const Module = require('module');

process.env.OWNER_ID = '111'; // 👑 مالك وهمي للاختبار

// ─── In-memory fake admins table ─────────────────────────────
const admins = {
  // 222: أدمن بصلاحية واحدة فقط
  222: { permissions: 'upload' },
  // 333: غير موجود إطلاقاً بجدول admins (يُختبر لاحقاً كمستخدم عادي)
  // 444: أدمن أُضيف لكن صلاحياته فارغة (يُختبر fail-closed)
  444: { permissions: '' },
};

function fakeGet(sql, params) {
  const uid = params && params[0];
  if (sql.includes('SELECT permissions FROM admins')) {
    const row = admins[uid];
    return Promise.resolve(row ? { permissions: row.permissions } : undefined);
  }
  if (sql.includes('SELECT 1 FROM admins')) {
    return Promise.resolve(admins[uid] ? { 1: 1 } : undefined);
  }
  if (sql.includes('SELECT specialty_id FROM admins')) {
    return Promise.resolve(admins[uid] ? { specialty_id: admins[uid].specialty_id || 0 } : undefined);
  }
  return Promise.resolve(undefined);
}

function fakeAll() { return Promise.resolve([]); }

function fakeRun(sql, params) {
  if (sql.includes('INSERT INTO admins')) {
    const [uid, , perms] = params;
    admins[uid] = { permissions: perms };
  } else if (sql.includes('UPDATE admins SET permissions')) {
    const [perms, uid] = params;
    admins[uid] = admins[uid] || {};
    admins[uid].permissions = perms;
  } else if (sql.includes('DELETE FROM admins')) {
    delete admins[params[0]];
  }
  return Promise.resolve({ rowCount: 1 });
}

// ─── حقن الـ stubs في require.cache قبل تحميل الكود الحقيقي ───
function injectStub(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  const m = new Module(resolved, null);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolved] = m;
}

const root = path.join(__dirname, '..');
injectStub(path.join(root, 'database/db.js'), { get: fakeGet, all: fakeAll, run: fakeRun });
injectStub(path.join(root, 'middlewares/auth.js'), {
  isOwner: uid => parseInt(uid) === parseInt(process.env.OWNER_ID), // مطابق حرفياً لمنطق auth.js الحقيقي
});

// ─── الآن حمّل الكود الحقيقي ────────────────────────────────
const adminsDb = require('../database/admins');
const rbac = require('../middlewares/rbac');

// ─── Mini test runner ───────────────────────────────────────
let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✅ ' + name);
  } catch (e) {
    fail++;
    console.log('  ❌ ' + name + '\n     → ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

// ─── سيناريوهات فارغة ────────────────────────────────────────
function fakeExpressReqRes(uid) {
  const state = { statusCode: null, body: null, called: false };
  const req = { tgUser: uid != null ? { id: uid } : undefined };
  const res = {
    status(c) { state.statusCode = c; return this; },
    json(b) { state.body = b; return this; },
  };
  const next = () => { state.called = true; };
  return { req, res, next, state };
}

function fakeBotCtx(uid, isOwner, adminPerms) {
  let repliedWith = null, cbAnswered = null;
  return {
    uid, from: { id: uid }, isOwner,
    adminPerms,
    reply: async (msg) => { repliedWith = msg; },
    answerCbQuery: async (msg) => { cbAnswered = msg; },
    get lastReply() { return repliedWith; },
    get lastCbAnswer() { return cbAnswered; },
  };
}

(async () => {
  console.log('\n🧪 RBAC scenario tests\n───────────────────────');

  console.log('\n[1] Owner — يجب أن يملك كل الصلاحيات دائماً:');
  await t('Owner(111) لديه view_users', async () => assertEq(await rbac.checkPermission(111, 'view_users'), true));
  await t('Owner(111) لديه ban_users', async () => assertEq(await rbac.checkPermission(111, 'ban_users'), true));
  await t('Owner(111) لديه broadcast رغم عدم وجوده أصلاً بجدول admins', async () => assertEq(await rbac.checkPermission(111, 'broadcast'), true));

  console.log('\n[2] Admin بصلاحية واحدة (uid=222, perms="upload"):');
  await t('222 يملك upload', async () => assertEq(await rbac.checkPermission(222, 'upload'), true));
  await t('222 لا يملك broadcast', async () => assertEq(await rbac.checkPermission(222, 'broadcast'), false));
  await t('222 لا يملك delete', async () => assertEq(await rbac.checkPermission(222, 'delete'), false));
  await t('222 لا يملك ban_users', async () => assertEq(await rbac.checkPermission(222, 'ban_users'), false));

  console.log('\n[3] Admin بدون صلاحية أصلاً (uid=444, perms=""):');
  await t('444 لا يملك أي شيء (fail-closed على قيمة فارغة)', async () => assertEq(await rbac.checkPermission(444, 'upload'), false));

  console.log('\n[4] مستخدم عادي غير موجود بجدول admins (uid=333):');
  await t('333 لا يملك upload', async () => assertEq(await rbac.checkPermission(333, 'upload'), false));
  await t('333 لا يملك أي صلاحية حتى المنخفضة الخطورة', async () => assertEq(await rbac.checkPermission(333, 'view_users'), false));

  console.log('\n[5] محاولة وصول مباشر لـ API بدون صلاحية (Express middleware requirePerm):');
  await t('222 (upload فقط) يُرفض من requirePerm("ban_users") بـ 403', async () => {
    const { req, res, next, state } = fakeExpressReqRes(222);
    await rbac.requirePerm('ban_users')(req, res, next);
    assertEq(state.statusCode, 403);
    assertEq(state.called, false);
    assert(state.body && state.body.error === 'forbidden', 'expected forbidden error body');
  });
  await t('222 (upload فقط) يُسمح له من requirePerm("upload")', async () => {
    const { req, res, next, state } = fakeExpressReqRes(222);
    await rbac.requirePerm('upload')(req, res, next);
    assertEq(state.called, true);
    assertEq(state.statusCode, null);
  });
  await t('333 (مستخدم عادي) يُرفض من requirePerm حتى لأخف صلاحية', async () => {
    const { req, res, next, state } = fakeExpressReqRes(333);
    await rbac.requirePerm('view_users')(req, res, next);
    assertEq(state.statusCode, 403);
  });
  await t('111 (Owner) يُسمح له دائماً من requireOwner()', async () => {
    const { req, res, next, state } = fakeExpressReqRes(111);
    await rbac.requireOwner()(req, res, next);
    assertEq(state.called, true);
    assertEq(state.statusCode, null);
  });
  await t('222 (أدمن غير مالك) يُرفض من requireOwner()', async () => {
    const { req, res, next, state } = fakeExpressReqRes(222);
    await rbac.requireOwner()(req, res, next);
    assertEq(state.statusCode, 403);
    assertEq(state.called, false);
  });
  await t('طلب بدون tgUser إطلاقاً (غير مُصادَق) يُرفض بـ 401 من requirePerm', async () => {
    const { req, res, next, state } = fakeExpressReqRes(null);
    await rbac.requirePerm('upload')(req, res, next);
    assertEq(state.statusCode, 401);
    assertEq(state.called, false);
  });

  console.log('\n[6] fail-closed ضد صلاحيات غير معرّفة (typo/اختراع):');
  await t('صلاحية غير موجودة أصلاً في ALL_PERMS تُرفض حتى للأدمن', async () => {
    assertEq(await rbac.checkPermission(222, 'super_admin_mode'), false);
  });
  await t('نفس الشيء حتى لو "خزّنّا" هذه القيمة الوهمية في عمود permissions', async () => {
    admins[222].permissions = 'upload,super_admin_mode';
    assertEq(await rbac.checkPermission(222, 'super_admin_mode'), false); // fail-closed: القيمة غير معروفة أصلاً
    admins[222].permissions = 'upload'; // استرجاع الحالة
  });

  console.log('\n[7] sanitizePerms() — لا صلاحيات وهمية تُحفظ أبداً:');
  await t('يبقي القيم الصحيحة فقط ويحذف الوهمية', () => {
    assertEq(adminsDb.sanitizePerms('full, made_up_perm ,upload,,upload'), 'full,upload');
  });
  await t('قيمة فارغة تماماً ترجع فارغة (وليس "full")', () => {
    assertEq(adminsDb.sanitizePerms(''), '');
  });
  await t('قيمة كلها وهمية ترجع فارغة', () => {
    assertEq(adminsDb.sanitizePerms('xx,yy,zz'), '');
  });

  console.log('\n[8] add() — لا "full" تلقائي أبداً عند عدم التحديد الصريح:');
  await t('add(uid, by) بدون perms يعطي الافتراضي المحدود، ليس full', async () => {
    await adminsDb.add(999, 111); // بدون تمرير perms إطلاقاً
    assertEq(admins[999].permissions, 'upload,add_content');
    assert(!admins[999].permissions.includes('full'), 'يجب ألا تحتوي full تلقائياً');
  });
  await t('add(uid, by, "evil,made_up") تُنظَّف لصلاحيات آمنة بدل قبول قيم وهمية', async () => {
    await adminsDb.add(998, 111, 'evil,made_up');
    assertEq(admins[998].permissions, 'upload,add_content'); // fallback الآمن لأن كل القيم كانت وهمية
  });
  await t('add(uid, by, "delete,manage_groups") تحفظ فقط ما طُلب صراحة وهو صالح', async () => {
    await adminsDb.add(997, 111, 'delete,manage_groups');
    assertEq(admins[997].permissions, 'delete,manage_groups');
  });

  console.log('\n[9] Telegram bot ctx (botRequirePerm) — نفس الاختبارات لكن على واجهة البوت:');
  await t('Owner ctx: مسموح دائماً بدون رسالة رفض', async () => {
    const ctx = fakeBotCtx(111, true, ['full']); // owner-ish ctx
    const ok = await rbac.botRequirePerm(ctx, 'broadcast');
    assertEq(ok, true);
    assertEq(ctx.lastReply, null);
  });
  await t('Admin ctx بصلاحية واحدة محمّلة مسبقاً (fast path ctx.adminPerms): مسموح لصلاحيته فقط', async () => {
    const ctx = fakeBotCtx(222, false, ['upload']);
    assertEq(await rbac.botRequirePerm(ctx, 'upload'), true);
  });
  await t('Admin ctx بصلاحية واحدة: يُرفض لصلاحية أخرى + يرسل رسالة رفض', async () => {
    const ctx = fakeBotCtx(222, false, ['upload']);
    const ok = await rbac.botRequirePerm(ctx, 'delete');
    assertEq(ok, false);
    assert(ctx.lastReply && ctx.lastReply.includes('صلاحية'), 'يجب إرسال رسالة رفض للمستخدم');
  });
  await t('مستخدم عادي (isAdmin=false, adminPerms=[]) يُرفض من أي صلاحية', async () => {
    const ctx = fakeBotCtx(333, false, []);
    assertEq(await rbac.botRequirePerm(ctx, 'view_users'), false);
  });

  console.log('\n───────────────────────');
  console.log(`النتيجة: ${pass} ناجح، ${fail} فاشل، من أصل ${pass + fail}`);
  if (fail > 0) { console.log('🔴 توجد اختبارات فاشلة — راجع الأعلى.'); process.exit(1); }
  console.log('🟢 كل الاختبارات ناجحة.');
  process.exit(0);
})();
