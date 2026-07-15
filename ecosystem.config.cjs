'use strict';

module.exports = {
  apps: [
    {
      name: 'personalize-wppconnect',
      cwd: __dirname,
      script: 'scripts/start-vps-whatsapp.sh',
      interpreter: '/bin/bash',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      kill_timeout: 15000,
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '1200M',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
