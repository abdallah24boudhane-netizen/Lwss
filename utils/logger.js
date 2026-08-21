'use strict';
const fs   = require('fs');
const path = require('path');

const LOG_DIR    = path.join(__dirname, '..', 'logs');
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_SERVICE_NAME;
const ERR_LOG  = path.join(LOG_DIR, 'app.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_KEEP = 3;

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch(err) { require('./logger').debug('[catch]', err.message); }

let buf = '', flushTimer = null;

function ts() { return new Date().toISOString().replace('T', ' ').substring(0, 19); }

function _rotate() {
  try {
    if (fs.statSync(ERR_LOG).size < MAX_SIZE) return;
    for (let i = MAX_KEEP; i >= 1; i--) {
      const src  = i === 1 ? ERR_LOG : `${ERR_LOG}.${i - 1}`;
      const dest = `${ERR_LOG}.${i}`;
      try { fs.renameSync(src, dest); } catch(err) { require('./logger').debug('[catch]', err.message); }
    }
  } catch(err) { require('./logger').debug('[catch]', err.message); }
}

function _flush() {
  if (!buf) return;
  // ⚡ PERF FIX: على Railway ما كنا نكتب على ملف (وهذا صحيح ومقصود)، بس buf كانت
  // تبقى تتراكم للأبد لأن الدالة كانت ترجع *قبل* تصفيرها = تسرب ذاكرة طول عمر البروسيس.
  // console.log/warn/error (اللي Railway فعلياً يقرأ منها اللوغز) ما تأثرت ولا تتأثر هنا إطلاقاً.
  if (IS_RAILWAY) { buf = ''; return; }
  _rotate();
  const d = buf; buf = '';
  fs.appendFile(ERR_LOG, d, () => {});
}

function _write(level, args) {
  buf += `[${ts()}] [${level}] ${
    args.map(a => typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)).join(' ')
  }\n`;
  if (buf.length > 8192) { _flush(); return; }
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; _flush(); }, 2000);
    if (flushTimer.unref) flushTimer.unref();
  }
}

const logger = {
  info:  (...a) => { console.log('[INFO]',  ...a); _write('INFO',  a); },
  warn:  (...a) => { console.warn('[WARN]',  ...a); _write('WARN',  a); },
  error: (...a) => { console.error('[ERROR]', ...a); _write('ERROR', a); },
  debug: (...a) => { if (process.env.DEBUG) { console.debug('[DEBUG]', ...a); _write('DEBUG', a); } },
};

process.on('exit', _flush);
process.on('uncaughtException', err => {
  logger.error('[UNCAUGHT]', err.message, err.stack);
  _flush();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[UNHANDLED]', String(reason));
});

module.exports = logger;
