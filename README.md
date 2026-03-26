# claude-channel-naverworks

Claude Code Channel plugin for **Naver Works (LINE WORKS)** messenger.

Chat with Claude from your Naver Works app — like Telegram, but for your company.

## Prerequisites

- Claude Code v2.1.80+
- Bun runtime
- LINE WORKS Developer Console admin access
- ngrok or Cloudflare Tunnel (for webhook)

## Quick Start

### 1. Install the plugin

```bash
# From local directory
claude --channels ./projects/claude-naverworks-channel
```

### 2. Set up Naver Works Bot

1. Go to [LINE WORKS Developer Console](https://developers.worksmobile.com)
2. Create a **Client App** → note Client ID & Secret
3. Set OAuth scope: `bot`
4. Register a **Bot** → note Bot ID
5. Create a **Service Account** → download Private Key
6. Set bot callback URL to your webhook (see step 3)

### 3. Start ngrok tunnel

```bash
ngrok http 48080
```

Set the ngrok HTTPS URL + `/webhook` as your bot's callback URL in Developer Console.

### 4. Configure credentials

```
/naverworks:configure
```

### 5. Pair your account

1. Send any message to the bot in Naver Works
2. You'll receive a pairing code
3. In Claude Code: `/naverworks:access pair <code>`
4. Lock down: `/naverworks:access policy allowlist`

## Architecture

```
Naver Works User ↔ LINE WORKS Bot API ↔ Webhook HTTP Server (localhost:48080) ↔ MCP stdio ↔ Claude Code
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NAVERWORKS_CLIENT_ID` | LINE WORKS Client App ID |
| `NAVERWORKS_CLIENT_SECRET` | Client Secret |
| `NAVERWORKS_SERVICE_ACCOUNT` | Service Account ID |
| `NAVERWORKS_PRIVATE_KEY` | RSA Private Key (PEM) |
| `NAVERWORKS_BOT_ID` | Bot ID |
| `NAVERWORKS_WEBHOOK_PORT` | Webhook port (default: 48080) |
| `NAVERWORKS_STATE_DIR` | State directory (default: ~/.claude/channels/naverworks) |

## License

Apache-2.0
