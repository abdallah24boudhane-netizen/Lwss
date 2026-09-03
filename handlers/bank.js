'use strict';
// ⚠️ طبقة توافقية فقط — كل العمليات الحقيقية تُنفَّذ عبر bank_pro.js (Taline Bank الموحّد)
// bank_accounts القديم ما عاد يُستعمل من هنا.
const bankPro = require('./bank_pro');

exports.createAccount = bankPro.openAccount;
exports.showBalance   = bankPro.showBalance;
exports.transfer      = bankPro.transfer;
exports.loan          = bankPro.requestLoan;
exports.addWinnings   = bankPro.addWinnings;
exports.showRip       = bankPro.showStatement;
exports.getAccount    = bankPro.getAccount;
exports.fmt           = bankPro.fmt;
