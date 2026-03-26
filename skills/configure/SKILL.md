---
name: configure
description: Configure Naver Works channel credentials (Client ID, Secret, Service Account, Private Key, Bot ID)
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /naverworks:configure

Set up or check Naver Works channel credentials.

## Usage

- `/naverworks:configure` — show current status
- `/naverworks:configure <client_id> <client_secret> <service_account> <bot_id>` — set credentials

## State Location

`~/.claude/channels/naverworks/.env`

## Implementation

### If no arguments: Show Status

1. Read `~/.claude/channels/naverworks/.env`
2. For each key (`NAVERWORKS_CLIENT_ID`, `NAVERWORKS_CLIENT_SECRET`, `NAVERWORKS_SERVICE_ACCOUNT`, `NAVERWORKS_PRIVATE_KEY`, `NAVERWORKS_BOT_ID`):
   - Show `✅ set` or `❌ missing`
3. Show webhook URL info: `http://localhost:48080/webhook`

### If arguments provided: Configure

1. Create `~/.claude/channels/naverworks/` if it doesn't exist
2. Write `.env` file with the provided values:
   ```
   NAVERWORKS_CLIENT_ID=<value>
   NAVERWORKS_CLIENT_SECRET=<value>
   NAVERWORKS_SERVICE_ACCOUNT=<value>
   NAVERWORKS_BOT_ID=<value>
   NAVERWORKS_PRIVATE_KEY="<pasted key>"
   ```
3. `chmod 600 ~/.claude/channels/naverworks/.env`
4. Show success message

### Private Key Handling

The private key is multi-line (RSA PEM format). When the user provides it:
1. Ask user to paste the full private key (including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`)
2. Store it in `.env` with escaped newlines or as a separate `.pem` file
3. If stored separately: `NAVERWORKS_PRIVATE_KEY_FILE=~/.claude/channels/naverworks/private.pem`

### Security Reminders

After configuration:
- Remind: "Never share your private key or client secret"
- Remind: "The .env file is chmod 600 (owner-only readable)"
- Remind: "Restart Claude Code to pick up the new config"

### Naver Works Setup Guide

If the user hasn't set up a bot yet, guide them:

1. Go to LINE WORKS Developer Console: https://developers.worksmobile.com
2. Sign in with admin account
3. Go to **API** → **Client App** → **Add**
4. Create an app, note down **Client ID** and **Client Secret**
5. Set OAuth scope to include `bot`
6. Go to **Bot** → **Bot registration**
7. Create a bot, note the **Bot ID**
8. Set the callback URL to your webhook URL (e.g., `https://your-ngrok-url.ngrok.io/webhook`)
9. Under **Service Account**, create one and download the **Private Key**
