# claude-channel-naverworks

Claude Code Channel plugin for **Naver Works (LINE WORKS)** messenger.

Chat with Claude from your Naver Works app — like Telegram, but for your company.

## Prerequisites

- Claude Code v2.1.80+
- Bun runtime
- LINE WORKS Developer Console admin access
- Caddy or reverse proxy for HTTPS (webhook)

## Quick Start

### 1. Set up Naver Works Bot

1. Go to [LINE WORKS Developer Console](https://developers.worksmobile.com)
2. Create a **Client App** → note Client ID & Secret
3. Set OAuth scope: `bot`
4. Register a **Bot** → note Bot ID & Bot Secret
5. Set bot callback URL to your HTTPS domain + `/webhook`

### 2. Configure credentials

Store in `~/.claude/channels/naverworks/.env`:

```env
NAVERWORKS_CLIENT_ID=your_client_id
NAVERWORKS_CLIENT_SECRET=your_client_secret
NAVERWORKS_BOT_ID=your_bot_id
NAVERWORKS_BOT_SECRET=your_bot_secret
NAVERWORKS_DOMAIN_ID=your_domain_id
```

### 3. Start the channel

```bash
bash scripts/start-channel.sh
```

Or for auto-start on boot (launchd):

```bash
bash scripts/start-channel-auto.sh
```

### 4. Pair your account

1. Send any message to the bot in Naver Works
2. You'll receive a pairing code
3. In Claude Code: `/naverworks:access pair <code>`
4. Lock down: `/naverworks:access policy allowlist`

## Architecture

```
Naver Works User ↔ LINE WORKS Bot API ↔ Webhook HTTP (localhost:48080) ↔ MCP stdio ↔ Claude Code Session
```

Messages are pushed directly into the running Claude session via MCP channel notifications — no subprocess spawning, ~2-3s response time.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NAVERWORKS_CLIENT_ID` | LINE WORKS Client App ID |
| `NAVERWORKS_CLIENT_SECRET` | Client Secret |
| `NAVERWORKS_BOT_ID` | Bot ID |
| `NAVERWORKS_BOT_SECRET` | Bot Secret (callback verification) |
| `NAVERWORKS_DOMAIN_ID` | Domain ID |
| `NAVERWORKS_WEBHOOK_PORT` | Webhook port (default: 48080) |
| `NAVERWORKS_STATE_DIR` | State directory (default: ~/.claude/channels/naverworks) |

## License

Apache-2.0
