'use strict';
/**
 * ════════════════════════════════════════════════════════════
 *  🔐 middlewares/rbac.js — Centralized RBAC (Role-Based Access Control)
 * ════════════════════════════════════════════════════════════
 *
 * هدف هذا الملف: نقطة واحدة موثوقة لفحص الصلاحيات، تُستخدم من:
 *   - Express API admin routes  (routes/api.js)          → requirePerm(perm)
 *   - Telegraf bot commands     (bot/commands.js)         → botRequirePerm(perm)
 *   - Telegraf bot callbacks    (bot/callbacks.js, handlers/manage.js) → checkPerm(ctx, perm)
 *
 * ⚠️ لا يُعرَّف نظام صلاحيات جديد هنا — هذا الملف طبقة رقيقة (thin wrapper)
 * فوق database/admins.js (ALL_PERMS + hasPerm) الموجود مسبقاً في المشروع،
 * حسب طلب "استخدم نظام الصلاحيات الموجود قدر الإمكان".
 *
 * قواعد التصميم (غير قابلة للكسر):
 *   1) Deny-by-default / Fail-closed: أي خطأ، استثناء، أو صلاحية غير معروفة → DENY.
 *   2) Owner دائماً لديه كل الصلاحيات (isOwner من auth.js — لا تغيير على هذا).
 *   3) صلاحية 'full' تُعطي كل شيء لأي أدمن يملكها فعلاً (سلوك موجود مسبقاً، محفوظ كما هو).
 *   4) لا صلاحية 'full' تلقائية عند الإضافة بدون تحديد — يجب أن تُمنح صراحة.
 *   5) أي permission string غير موجود ضمن ALL_PERMS → يُرفض فوراً (fail-closed)
 *      لمنع أخطاء الكتابة (typos) من فتح ثغرات صلاحيات بصمت.
 */

const { ALL_PERMS, hasPerm } = require('../database/admins');
const { isOwner } = require('./auth');
const logger = require('../utils/logger');

const VALID_PERMS = new Set(Object.keys(ALL_PERMS));

/**
 * تحقق أساسي من صلاحية واحدة لمستخدم معيّن.
 * fail-closed: أي خطأ أثناء الفحص = false (رفض)، وليس exception يفلت بصمت.
 */
async function checkPermission(uid, perm) {
  try {
    if (!uid) return false;

    // ✅ Owner دائماً مسموح — يطابق تصميم المشروع الحالي
    if (isOwner(uid)) return true;

    // ✅ fail-closed: صلاحية غير معرّفة في ALL_PERMS = رفض فوري (يمنع typos من فتح ثغرات)
    if (!VALID_PERMS.has(perm)) {
      logger.error(`[RBAC] Unknown permission requested: "${perm}" — denying by default (fail-closed).`);
      return false;
    }

    return await hasPerm(uid, perm);
  } catch (e) {
    logger.error('[RBAC] checkPermission error (fail-closed → deny):', e.message);
    return false; // ✅ أي استثناء = رفض، لا نمرر بصمت
  }
}

/**
 * تحقق سريع من ctx الخاص بالبوت (Telegraf) بدون استعلام إضافي إذا كان
 * middlewares/auth.js قد حمّل ctx.isOwner / ctx.adminPerms مسبقاً (fast path).
 * إن لم تكن محمّلة (نادراً)، يرجع لاستعلام DB مباشر كـ fallback آمن.
 */
async function checkPerm(ctx, perm) {
  try {
    const uid = ctx?.uid || ctx?.from?.id;
    if (!uid) return false;

    if (ctx.isOwner === true) return true;

    if (!VALID_PERMS.has(perm)) {
      logger.error(`[RBAC] Unknown permission requested from bot ctx: "${perm}" — denying.`);
      return false;
    }

    // Fast path: الصلاحيات محمّلة مسبقاً من middlewares/auth.js على كل تحديث
    if (Array.isArray(ctx.adminPerms)) {
      return ctx.adminPerms.includes('full') || ctx.adminPerms.includes(perm);
    }

    // Fallback نادر: لو لسبب ما ctx.adminPerms غير محمّلة، اسأل DB مباشرة (نفس المصدر الوحيد للحقيقة)
    return await checkPermission(uid, perm);
  } catch (e) {
    logger.error('[RBAC] checkPerm(ctx) error (fail-closed → deny):', e.message);
    return false;
  }
}

/**
 * Express middleware factory — يُستخدم في routes/api.js:
 *   router.post('/admin/ban/:id', auth, requirePerm('ban_users'), handler)
 *
 * يتوقع أن `auth` middleware (verifyWebApp) قد نفّذ قبله ووضع req.tgUser.
 */
function requirePerm(perm) {
  return async (req, res, next) => {
    try {
      const uid = parseInt(req.tgUser?.id);
      if (!uid) return res.status(401).json({ error: 'Unauthorized' });

      const allowed = await checkPermission(uid, perm);
      if (!allowed) {
        logger.warn(`[RBAC] DENY uid=${uid} perm="${perm}" path=${req.originalUrl}`);
        return res.status(403).json({ error: 'forbidden', required_permission: perm });
      }
      req.rbacPerm = perm; // للتوثيق/الـ logging اللاحق إن احتجنا
      next();
    } catch (e) {
      logger.error('[RBAC] requirePerm middleware error (fail-closed → 403):', e.message);
      return res.status(403).json({ error: 'forbidden' }); // fail-closed حتى عند خطأ غير متوقع
    }
  };
}

/**
 * Express middleware — Owner فقط (للعمليات شديدة الحساسية: إدارة الأدمنية أنفسهم).
 */
function requireOwner() {
  return (req, res, next) => {
    const uid = parseInt(req.tgUser?.id);
    if (!uid || !isOwner(uid)) {
      logger.warn(`[RBAC] DENY (owner-only) uid=${uid} path=${req.originalUrl}`);
      return res.status(403).json({ error: 'owner only' });
    }
    next();
  };
}

/**
 * Telegraf helper لأوامر البوت (bot/commands.js) — يرد تلقائياً برسالة رفض عند عدم وجود الصلاحية.
 * الاستخدام:
 *   bot.command('addfile', async ctx => {
 *     if (!(await botRequirePerm(ctx, 'upload'))) return;
 *     ...
 *   });
 * يرجع true إذا مسموح، false إذا رُفض (ويكون قد أرسل رسالة الرفض تلقائياً).
 */
async function botRequirePerm(ctx, perm, opts = {}) {
  const allowed = await checkPerm(ctx, perm);
  if (!allowed) {
    const msg = opts.silent ? null : (opts.message || '🚫 ليس لديك صلاحية لتنفيذ هذا الإجراء.');
    if (msg) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
      } else {
        await ctx.reply(msg).catch(() => {});
      }
    }
    logger.warn(`[RBAC] DENY (bot) uid=${ctx?.uid || ctx?.from?.id} perm="${perm}"`);
  }
  return allowed;
}

module.exports = {
  ALL_PERMS,
  VALID_PERMS,
  checkPermission, // (uid, perm) → Promise<boolean> — للاستخدام العام خارج Express/Telegraf
  checkPerm,       // (ctx, perm) → Promise<boolean> — لـ Telegraf ctx
  requirePerm,     // Express middleware factory
  requireOwner,    // Express middleware — owner only
  botRequirePerm,  // Telegraf helper مع رد رفض تلقائي
};
