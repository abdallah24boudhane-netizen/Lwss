(async () => {
  try {
    await require('./database/db').run(
      'ALTER TABLE files ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0'
    );
    console.log('✅ تمت الإضافة');
  } catch (e) {
    console.log('❌ خطأ:', e.message);
  }
  process.exit(0);
})();
