module.exports = {
  apps: [
    {
      name: 'naverworks-bot',
      script: 'bot-server.ts',
      interpreter: process.env.HOME + '/.bun/bin/bun',
      cwd: __dirname,
      env: {
        PATH: process.env.HOME + '/.bun/bin:/opt/homebrew/bin:' + process.env.PATH,
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
}
