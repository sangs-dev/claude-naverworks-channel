/**
 * Standalone Naver Works Bot Server
 *
 * Receives webhook messages → calls `claude -p` for AI response → sends reply via Bot API.
 * No MCP dependency — runs independently.
 *
 * Usage: bun bot-server.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// ─── Config ───────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.claude', 'channels', 'naverworks')
const ENV_FILE = join(STATE_DIR, '.env')
const TOKEN_FILE = join(STATE_DIR, 'token.json')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const HISTORY_DIR = join(STATE_DIR, 'history')
const PORT = Number(process.env.NAVERWORKS_WEBHOOK_PORT ?? '48080')
const API_BASE = 'https://www.worksapis.com/v1.0'

for (const dir of [STATE_DIR, HISTORY_DIR]) {
  mkdirSync(dir, { recursive: true })
}

// ─── ENV ──────────────────────────────────────────────────────────

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

// ─── Token ────────────────────────────────────────────────────────

type TokenData = { access_token: string; refresh_token: string; expires_at: number }

let token: TokenData | null = existsSync(TOKEN_FILE)
  ? JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'))
  : null

async function getAccessToken(): Promise<string> {
  if (token && Date.now() < token.expires_at - 60_000) return token.access_token
  if (!token?.refresh_token) throw new Error('No token')

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
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2))
  return token.access_token
}

// ─── Bot API ──────────────────────────────────────────────────────

async function sendMessage(userId: string, text: string): Promise<void> {
  const at = await getAccessToken()
  const chunks = chunkText(text, 4000)
  for (const chunk of chunks) {
    const res = await fetch(`${API_BASE}/bots/${botId}/users/${userId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { type: 'text', text: chunk } }),
    })
    if (!res.ok) console.error('[bot] Send failed:', res.status, await res.text())
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break }
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt < limit * 0.3) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }
  return chunks
}

// ─── Access Control ───────────────────────────────────────────────

type Access = { dmPolicy: string; allowFrom: string[]; pending: Record<string, { code: string; ts: number; replies: number }> }

function readAccess(): Access {
  const defaults: Access = { dmPolicy: 'pairing', allowFrom: [], pending: {} }
  if (!existsSync(ACCESS_FILE)) return defaults
  try { return { ...defaults, ...JSON.parse(readFileSync(ACCESS_FILE, 'utf-8')) } } catch { return defaults }
}

function writeAccess(a: Access): void { writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2)) }

function gate(userId: string): 'deliver' | 'drop' | { pair: string } {
  const access = readAccess()
  if (access.dmPolicy === 'disabled') return 'drop'
  if (access.allowFrom.includes(userId)) return 'deliver'
  if (access.dmPolicy === 'allowlist') return 'drop'

  // pairing
  const existing = access.pending[userId]
  if (existing && Date.now() - existing.ts < 3600_000) {
    existing.replies++
    writeAccess(access)
    return { pair: existing.code }
  }
  const code = randomBytes(3).toString('hex')
  access.pending[userId] = { code, ts: Date.now(), replies: 0 }
  writeAccess(access)
  return { pair: code }
}

// ─── Conversation History ─────────────────────────────────────────

function getHistoryFile(userId: string): string {
  return join(HISTORY_DIR, `${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`)
}

function appendHistory(userId: string, role: 'user' | 'assistant', text: string): void {
  const entry = JSON.stringify({ role, content: text, ts: Date.now() })
  appendFileSync(getHistoryFile(userId), entry + '\n')
}

function getRecentHistory(userId: string, maxMessages = 20): Array<{ role: string; content: string }> {
  const file = getHistoryFile(userId)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
  const recent = lines.slice(-maxMessages)
  return recent.map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean) as Array<{ role: string; content: string }>
}

// ─── Claude AI Response ───────────────────────────────────────────

const processingUsers = new Set<string>()

async function getClaudeResponse(userId: string, userMessage: string): Promise<string> {
  // Build context from history
  const history = getRecentHistory(userId)
  const contextMessages = history.map(h => `${h.role === 'user' ? 'Human' : 'Assistant'}: ${h.content}`).join('\n')

  const systemPrompt = `You are Claude, an AI assistant chatting on Naver Works messenger.
Keep responses concise and conversational — this is a mobile chat context.
Respond in the same language as the user's message.
If the user writes in Korean, respond in Korean.`

  const fullPrompt = contextMessages
    ? `${systemPrompt}\n\nPrevious conversation:\n${contextMessages}\n\nHuman: ${userMessage}`
    : `${systemPrompt}\n\nHuman: ${userMessage}`

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', 'sonnet', fullPrompt], {
      env: { ...process.env, PATH: `${homedir()}/.bun/bin:/opt/homebrew/bin:${process.env.PATH}` },
      timeout: 60_000,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`claude exited ${code}: ${stderr}`))
      }
    })
    proc.on('error', reject)
  })
}

// ─── Webhook Handler ──────────────────────────────────────────────

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
    res.end(JSON.stringify({ status: 'ok', bot: botId, token: token ? 'valid' : 'missing' }))
    return
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      const body = await parseBody(req)
      const payload = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))

      if (payload.type === 'message') {
        const userId = payload.source?.userId
        const text = payload.content?.text ?? ''
        if (!userId) return

        console.log(`← [${userId}] ${text}`)

        const gateResult = gate(userId)
        if (gateResult === 'drop') return

        if (typeof gateResult === 'object' && 'pair' in gateResult) {
          await sendMessage(userId, `🔗 Pairing code: ${gateResult.pair}\nClaude Code에서 /naverworks:access pair ${gateResult.pair} 을 입력하세요.`)
          return
        }

        // Prevent duplicate processing
        if (processingUsers.has(userId)) {
          await sendMessage(userId, '⏳ 이전 메시지를 처리 중입니다. 잠시만 기다려주세요.')
          return
        }

        processingUsers.add(userId)
        appendHistory(userId, 'user', text)

        try {
          const response = await getClaudeResponse(userId, text)
          appendHistory(userId, 'assistant', response)
          await sendMessage(userId, response)
          console.log(`→ [${userId}] ${response.slice(0, 80)}...`)
        } catch (err) {
          console.error('[claude] Error:', err)
          await sendMessage(userId, '⚠️ 죄송합니다, 응답 생성 중 오류가 발생했습니다.')
        } finally {
          processingUsers.delete(userId)
        }
      }
    } catch (err) {
      console.error('[webhook] Error:', err)
      res.writeHead(400)
      res.end('Bad Request')
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, () => {
  console.log(`\n🤖 Claude Naver Works Bot Server`)
  console.log(`   Webhook: http://localhost:${PORT}/webhook`)
  console.log(`   Bot ID: ${botId}`)
  console.log(`   Token: ${token ? '✅' : '❌'}`)
  console.log(`   Model: sonnet (via claude -p)`)
  console.log(`\n   Ready for messages!\n`)
})
