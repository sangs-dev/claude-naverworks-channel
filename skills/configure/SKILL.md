---
name: configure
description: Configure Naver Works channel credentials (Client ID, Secret, Bot ID, Bot Secret, Domain ID)
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
- `/naverworks:configure <client_id> <client_secret> <bot_id> <bot_secret> <domain_id>` — set credentials

## State Location

`~/.claude/channels/naverworks/.env`

## Implementation

### If no arguments: Show Status

1. Read `~/.claude/channels/naverworks/.env`
2. For each key (`NAVERWORKS_CLIENT_ID`, `NAVERWORKS_CLIENT_SECRET`, `NAVERWORKS_BOT_ID`, `NAVERWORKS_BOT_SECRET`, `NAVERWORKS_DOMAIN_ID`):
   - Show `✅ set` or `❌ missing`
3. Show webhook URL info: `http://localhost:48080/webhook`

### If arguments provided: Configure

1. Create `~/.claude/channels/naverworks/` if it doesn't exist
2. Write `.env` file with the provided values:
   ```
   NAVERWORKS_CLIENT_ID=<value>
   NAVERWORKS_CLIENT_SECRET=<value>
   NAVERWORKS_BOT_ID=<value>
   NAVERWORKS_BOT_SECRET=<value>
   NAVERWORKS_DOMAIN_ID=<value>
   ```
3. `chmod 600 ~/.claude/channels/naverworks/.env`
4. Show success message

### Security Reminders

After configuration:
- Remind: "Never share your client secret or bot secret"
- Remind: "The .env file is chmod 600 (owner-only readable)"
- Remind: "Restart the channel session to pick up the new config"

### Naver Works Setup Guide

If the user hasn't set up a bot yet, guide them:

1. Go to LINE WORKS Developer Console: https://developers.worksmobile.com
2. Sign in with admin account
3. Go to **API** → **Client App** → **Add**
4. Create an app, note down **Client ID** and **Client Secret**
5. Set OAuth scope to include `bot`
6. Set Redirect URI to your domain + `/callback`
7. Go to **Bot** → **Bot registration**
8. Create a bot, note the **Bot ID** and **Bot Secret**
9. Set the callback URL to your HTTPS domain + `/webhook`
10. Complete OAuth flow: visit `/oauth/start` on your webhook server
