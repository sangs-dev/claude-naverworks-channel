/**
 * Standalone test of the webhook server + bot API.
 * No MCP, just HTTP webhook → console log → reply via Bot API.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'naverworks')
const ENV_FILE = join(STATE_DIR, '.env')
const TOKEN_FILE = join(STATE_DIR, 'token.json')
const API_BASE = 'https://www.worksapis.com/v1.0'
const PORT = 48080

// Load env
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (!existsSync(ENV_FILE)) return env
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    env[t.slice(0, eq).trim()] = val
  }
  return env
}

const fe = loadEnv()
const botId = fe.NAVERWORKS_BOT_ID ?? ''
const clientId = fe.NAVERWORKS_CLIENT_ID ?? ''
const clientSecret = fe.NAVERWORKS_CLIENT_SECRET ?? ''

type TokenData = { access_token: string; refresh_token: string; expires_at: number }

function loadToken(): TokenData | null {
  if (!existsSync(TOKEN_FILE)) return null
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) } catch { return null }
}

function saveToken(data: TokenData): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2))
}

let token = loadToken()

async function getAccessToken(): Promise<string> {
  if (token && Date.now() < token.expires_at - 60_000) return token.access_token

  if (!token?.refresh_token) throw new Error('No token. Run oauth-setup.ts first.')

  // Refresh
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: token.refresh_token,
  })
  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`Refresh failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  saveToken(token)
  return token.access_token
}

async function sendMessage(userId: string, text: string): Promise<void> {
  const at = await getAccessToken()
  const res = await fetch(`${API_BASE}/bots/${botId}/users/${userId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { type: 'text', text } }),
  })
  if (!res.ok) {
    console.error('Send failed:', res.status, await res.text())
  } else {
    console.log(`→ Sent to ${userId}: ${text.slice(0, 80)}`)
  }
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      const body = await parseBody(req)
      console.log('← Webhook:', body)
      const payload = JSON.parse(body)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))

      // Echo test: reply with received message
      if (payload.type === 'message') {
        const userId = payload.source?.userId
        const text = payload.content?.text ?? '(non-text message)'
        if (userId) {
          await sendMessage(userId, `Echo: ${text}`)
        }
      }
    } catch (err) {
      console.error('Webhook error:', err)
      res.writeHead(400)
      res.end('Bad Request')
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, () => {
  console.log(`🚀 Test server running on http://localhost:${PORT}`)
  console.log(`   Webhook: http://localhost:${PORT}/webhook`)
  console.log(`   Bot ID: ${botId}`)
  console.log(`   Token: ${token ? 'loaded' : 'missing'}`)
  console.log('\n   Send a message to the bot in Naver Works to test!\n')
})
