'use strict';
// ══════════════════════════════════════════════════════════════
//  🐺 Loup-Garou (لعبة الذئب) — إعدادات مركزية
// ══════════════════════════════════════════════════════════════

module.exports = {
  // ── حدود اللاعبين ──
  MIN_PLAYERS: 6,
  MAX_PLAYERS: 15,

  // ── مؤقتات (بالمللي ثانية) ──
  TIMERS: {
    GUARDIAN:   45000,
    SEER:       45000,
    DETECTIVE:  45000,
    FOX:        45000,
    WOLVES:     60000,
    WITCH:      45000,
    HUNTER:     30000,
    DISCUSSION: 180000, // 3 دقائق
    DISCUSSION_WARN: 60000, // إشعار عند تبقي 60 ثانية
    VOTE:       90000,
    NIGHT_INTRO_DELAY: 4000,
    DAY_INTRO_DELAY:   4000,
    BETWEEN_ROUNDS:    6000,
    LOBBY_REMINDER:    60000,
  },

  // ── سجل الأحداث ──
  MAX_EVENT_LOG: 60,       // أحداث محفوظة بالذاكرة لكل لعبة
  EVENT_LOG_DISPLAY: 15,   // أحداث تُعرض عند الضغط على "📜 السجل"

  // ── الاقتصاد (مرتبط بالبنك) ──
  ECONOMY: {
    WIN_BASE:        200,   // مكافأة أساسية للفوز
    WIN_WOLF_BONUS:  100,   // إضافي إذا فاز كذئب
    SPECIAL_ROLE_BONUS: 50, // إضافي لأصحاب الأدوار الخاصة (عراف/ساحرة/حارس/صياد/محقق/ثعلب)
    PARTICIPATION:   20,    // مكافأة مشاركة لكل لاعب (فائز أو خاسر)
    ACHIEVEMENT_BONUS: 500, // مكافأة لكل إنجاز جديد
    RANK_UP_BONUS:   1000,  // مكافأة عند الترقي لرتبة أعلى
  },

  // ── الرتب الدائمة (حسب عدد الانتصارات الكلي) ──
  RANKS: [
    { key: 'legend_master', name: 'سيد لوب غارو', emoji: '👑', minWins: 120 },
    { key: 'legend',        name: 'أسطورة',        emoji: '💎', minWins: 60  },
    { key: 'expert',        name: 'خبير',          emoji: '🥇', minWins: 30  },
    { key: 'pro',           name: 'محترف',         emoji: '🥈', minWins: 10  },
    { key: 'beginner',      name: 'مبتدئ',         emoji: '🥉', minWins: 0   },
  ],

  // ── الإنجازات ──
  // كل إنجاز: شرط check(stats) -> bool ، يُتحقق منه بعد تحديث الإحصائيات
  ACHIEVEMENTS: [
    { key: 'first_win',     name: 'أول انتصار',    emoji: '🏆', check: s => s.wins >= 1 },
    { key: 'wins_10',       name: '10 انتصارات',   emoji: '🏆', check: s => s.wins >= 10 },
    { key: 'wins_100',      name: '100 انتصار',    emoji: '🏆', check: s => s.wins >= 100 },
    { key: 'pro_killer',    name: 'قاتل محترف',    emoji: '☠️', check: s => (s.sk_wins + s.vampire_wins) >= 5 },
    { key: 'best_seer',     name: 'أفضل عراف',     emoji: '🔮', check: s => s.seer_correct >= 20 },
    { key: 'wolf_master',   name: 'سيد الذئاب',    emoji: '🐺', check: s => s.wolf_wins >= 15 },
    { key: 'village_savior',name: 'منقذ القرية',   emoji: '🛡️', check: s => (s.witch_saves + s.guardian_saves) >= 15 },
  ],

  // ── حدود الأدوار الخاصة (للمكافآت الاقتصادية) ──
  SPECIAL_ROLES: ['seer', 'witch', 'guardian', 'hunter', 'detective', 'fox', 'mayor'],

  CALLBACK_PREFIX: 'ww',
};
