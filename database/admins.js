'use strict';
const { all, get, run } = require('./db');
const { isOwner } = require('../middlewares/auth');
const { cacheGet, cacheSet, cacheClear } = require('../utils/cache');

// ── الصلاحيات المتاحة ────────────────────────────
const ALL_PERMS = {
  'upload':       '📤 رفع ملفات',
  'delete':       '🗑 حذف ملفات',
  'add_content':  '📁 إدارة المحتوى',
  'view_users':   '👥 عرض المستخدمين',
  'ban_users':    '🚫 حظر مستخدمين',
  'broadcast':    '📢 إرسال بث',
  'manage_groups':'👥 إدارة القروبات',
  'full':         '👑 صلاحيات كاملة',
};

/**
 * ✅ RBAC hardening: ينظّف/يتحقق من صحة سلسلة الصلاحيات قبل حفظها.
 * أي قيمة غير معرّفة ضمن ALL_PERMS تُرفض بصمت (fail-closed) بدل أن تُحفظ
 * كصلاحية "شبح" غير معروفة يمكن أن تُفسَّر لاحقاً بشكل غير متوقع.
 * لا تسمح بإدخال 'full' ضمنياً — 'full' يجب أن يُطلب صراحة.
 */
const sanitizePerms = (permsInput) => {
  if (!permsInput) return '';
  const arr = String(permsInput).split(',').map(p => p.trim()).filter(Boolean);
  const valid = arr.filter(p => Object.prototype.hasOwnProperty.call(ALL_PERMS, p));
  return [...new Set(valid)].join(',');
};

const getAll = () => all(
  'SELECT a.*,u.first_name,u.username FROM admins a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.user_id'
);

const setSpecialty = (uid, spId) => {
  cacheClear('sp_' + uid);
  return run('UPDATE admins SET specialty_id=$1 WHERE user_id=$2', [spId, uid]);
};

const getAdminSpecialty = async uid => {
  const c = cacheGet('sp_' + uid);
  if (c !== null) return c;
  const r = (await get('SELECT specialty_id FROM admins WHERE user_id=$1', [uid]))?.specialty_id || 0;
  cacheSet('sp_' + uid, r, 300000);
  return r;
};

// ✅ RBAC: الافتراضي محدود عمداً (مبدأ أقل صلاحية ممكنة) وليس 'full'،
// وأي قيمة تُمرَّر تُنظَّف عبر sanitizePerms قبل الحفظ (fail-closed ضد typos/قيم غير معروفة).
const add = (uid, by, perms = 'upload,add_content') => {
  cacheClear('ia_' + uid); cacheClear('admp_' + uid);
  const clean = sanitizePerms(perms) || 'upload,add_content'; // لا نحفظ أبداً سلسلة فارغة بصمت
  return run(
    'INSERT INTO admins(user_id,added_by,permissions) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET permissions=$3',
    [uid, by, clean]
  );
};

const remove = uid => {
  cacheClear('ia_' + uid); cacheClear('admp_' + uid); cacheClear('sp_' + uid);
  return run('DELETE FROM admins WHERE user_id=$1', [uid]);
};

const isAdmin = async uid => {
  const c = cacheGet('ia_' + uid);
  if (c !== null) return c;
  const r = !!(await get('SELECT 1 FROM admins WHERE user_id=$1', [uid]));
  cacheSet('ia_' + uid, r, 300000);
  return r;
};

const getPerms = async uid => {
  const c = cacheGet('admp_' + uid);
  if (c !== null) return c;
  const r = await get('SELECT permissions FROM admins WHERE user_id=$1', [uid]);
  const val = r ? r.permissions.split(',').map(p => p.trim()).filter(Boolean) : [];
  cacheSet('admp_' + uid, val, 300000);
  return val;
};

const updatePerms = (uid, perms) => {
  cacheClear('admp_' + uid);
  const clean = sanitizePerms(perms); // فارغ = يزيل كل الصلاحيات (fail-closed) بدل حفظ قيمة غير موثوقة
  return run('UPDATE admins SET permissions=$1 WHERE user_id=$2', [clean, uid]);
};

const clearCache = uid => {
  cacheClear('ia_' + uid); cacheClear('admp_' + uid); cacheClear('sp_' + uid);
};

const hasPerm = async (uid, perm) => {
  if (isOwner(uid)) return true;
  const p = await getPerms(uid);
  return p.includes('full') || p.includes(perm);
};

const getAdminInfo = async uid => {
  const [adminStatus, perms] = await Promise.all([isAdmin(uid), getPerms(uid)]);
  return { isAdmin: adminStatus, perms };
};

module.exports = { ALL_PERMS, getAll, add, remove, isAdmin, getPerms, updatePerms, hasPerm, setSpecialty, getAdminSpecialty, clearCache, getAdminInfo, sanitizePerms };
