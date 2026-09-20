module.exports = {
  apps: [
    {
      name: 'study-bot',
      script: 'index.js',
      instances: 1,
      exec_mode: 'cluster',
      max_memory_restart: '380M',
      node_args: '--max-old-space-size=380 --optimize-for-size --expose-gc',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      listen_timeout: 8000,
      exp_backoff_restart_delay: 3000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true
    },
    {
      // 🤖 UserBot (Telethon/Python) — Phase 1: heartbeat فقط.
      // معزول تماماً عن study-bot: كراش هنا لا يوقف البوت العادي، وله autorestart خاص به.
      name: 'userbot',
      script: 'main.py',
      interpreter: 'python3',
      cwd: './userbot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      max_restarts: 20,
      restart_delay: 5000,
      exp_backoff_restart_delay: 3000,
      out_file: './logs/userbot-out.log',
      error_file: './logs/userbot-err.log',
      merge_logs: true
    }
  ]
};
