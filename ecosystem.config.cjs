'use strict';

const common = {
  cwd: __dirname,
  interpreter: '/bin/bash',
  autorestart: true,
  restart_delay: 5000,
  min_uptime: '30s',
  kill_timeout: 15000,
  time: true,
  env: {
    NODE_ENV: 'production',
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'personalize-session-access',
      script: 'scripts/watch-session-access.sh',
      max_restarts: 20,
      max_memory_restart: '200M',
    },
    {
      ...common,
      name: 'personalize-wppconnect',
      script: 'scripts/start-vps-whatsapp.sh',
      max_restarts: 10,
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '1200M',
    },
  ],
};
