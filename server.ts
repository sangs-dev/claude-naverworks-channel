/**
 * Claude Code Channel: Naver Works (LINE WORKS)
 *
 * MCP server that bridges LINE WORKS messenger ↔ Claude Code session.
 * Architecture: webhook HTTP server (inbound) + REST API (outbound) over MCP stdio.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

// ─── Config & Paths ───────────────────────────────────────────────

const STATE_DIR =
  process.env.NAVERWORKS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'naverworks')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const TOKEN_FILE = join(STATE_DIR, 'token.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')

const WEBHOOK_PORT = Number(process.env.NAVERWORKS_WEBHOOK_PORT ?? '48080')
const API_BASE = 'https://www.worksapis.com/v1.0'

for (const dir of [STATE_DIR, APPROVED_DIR, INBOX_DIR]) {
  mkdirSync(dir, { recursive: true })
}

// ─── ENV Loading ──────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (!existsSync(ENV_FILE)) return env
  const raw = readFileSync(ENV_FILE, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    env[key] = val
  }
  return env
}

const fileEnv = loadEnv()
const cfg = {
  clientId: process.env.NAVERWORKS_CLIENT_ID ?? fileEnv.NAVERWORKS_CLIENT_ID ?? '',
  clientSecret: process.env.NAVERWORKS_CLIENT_SECRET ?? fileEnv.NAVERWORKS_CLIENT_SECRET ?? '',
  botId: process.env.NAVERWORKS_BOT_ID ?? fileEnv.NAVERWORKS_BOT_ID ?? '',
  botSecret: process.env.NAVERWORKS_BOT_SECRET ?? fileEnv.NAVERWORKS_BOT_SECRET ?? '',
  domainId: process.env.NAVERWORKS_DOMAIN_ID ?? fileEnv.NAVERWORKS_DOMAIN_ID ?? '',
}

// ─── Access Control ───────────────────────────────────────────────

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  pending: Record<string, { code: string; ts: number; replies: number }>
  textChunkLimit?: number
}

function readAccess(): Access {
  const defaults: Access = { dmPolicy: 'pairing', allowFrom: [], pending: {} }
  if (!existsSync(ACCESS_FILE)) return defaults
  try {
    return { ...defaults, ...JSON.parse(readFileSync(ACCESS_FILE, 'utf-8')) }
  } catch {
    return defaults
  }
}

function writeAccess(access: Access): void {
  writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2))
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(userId: string): GateResult {
  const access = readAccess()

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (access.allowFrom.includes(userId)) {
    return { action: 'deliver', access }
  }

  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  // pairing mode
  const existing = access.pending[userId]
  if (existing && Date.now() - existing.ts < 3600_000 && existing.replies < 3) {
    existing.replies++
    writeAccess(access)
    return { action: 'pair', code: existing.code, isResend: true }
  }

  // new pairing
  const pendingKeys = Object.keys(access.pending)
  if (pendingKeys.length >= 5) {
    const oldest = pendingKeys.sort((a, b) => access.pending[a].ts - access.pending[b].ts)[0]
    delete access.pending[oldest]
  }

  const code = randomBytes(3).toString('hex')
  access.pending[userId] = { code, ts: Date.now(), replies: 0 }
  writeAccess(access)
  return { action: 'pair', code, isResend: false }
}

// Poll approved/ directory for pairing completions
function pollApproved(): void {
  try {
    const files = readdirSync(APPROVED_DIR)
    for (const file of files) {
      const userId = file.replace(/\.json$/, '')
      const access = readAccess()
      if (!access.allowFrom.includes(userId)) {
        access.allowFrom.push(userId)
        delete access.pending[userId]
        writeAccess(access)
        // Send confirmation via bot
        sendMessage(userId, '✅ Paired successfully! You can now chat with Claude.').catch(() => {})
      }
      unlinkSync(join(APPROVED_DIR, file))
    }
  } catch {
    // ignore
  }
}

// ─── OAuth 2.0 Token Management ──────────────────────────────────

type TokenData = {
  access_token: string
  refresh_token: string
  expires_at: number // epoch ms
}

function loadToken(): TokenData | null {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as TokenData
  } catch {
    return null
  }
}

function saveToken(data: TokenData): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2))
  chmodSync(TOKEN_FILE, 0o600)
}

let cachedToken: TokenData | null = loadToken()

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) {
    return cachedToken.access_token
  }

  // Try refresh if we have a refresh token
  if (cachedToken?.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(cachedToken.refresh_token)
      return refreshed.access_token
    } catch (err) {
      console.error('[naverworks] Refresh failed, need re-auth:', err)
      cachedToken = null
    }
  }

  throw new Error(
    'No valid token. Run the OAuth flow first:\n' +
    `  Open: https://auth.worksmobile.com/oauth2/v2.0/authorize?client_id=${cfg.clientId}&redirect_uri=http://localhost:${WEBHOOK_PORT}/oauth/callback&scope=bot&response_type=code&state=setup\n` +
    '  Then complete login in browser.'
  )
}

async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
  })

  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  const tokenData: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  saveToken(tokenData)
  cachedToken = tokenData
  return tokenData
}

async function exchangeCodeForToken(code: string): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: process.env.NAVERWORKS_REDIRECT_URI ?? `https://bot.twomos.com/callback`,
  })

  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  const tokenData: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  saveToken(tokenData)
  cachedToken = tokenData
  console.error('[naverworks] OAuth token saved successfully!')
  return tokenData
}

// ─── Naver Works Bot API ──────────────────────────────────────────

async function sendMessage(userId: string, text: string): Promise<void> {
  const token = await getAccessToken()
  const res = await fetch(`${API_BASE}/bots/${cfg.botId}/users/${userId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: { type: 'text', text },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Send message failed (${res.status}): ${err}`)
  }
}

async function sendFileMessage(
  userId: string,
  fileUrl: string,
): Promise<void> {
  const token = await getAccessToken()
  const res = await fetch(`${API_BASE}/bots/${cfg.botId}/users/${userId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: { type: 'link', contentText: fileUrl, linkText: 'File', link: fileUrl },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Send file message failed (${res.status}): ${err}`)
  }
}

// ─── Message Chunking ─────────────────────────────────────────────

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }
    // prefer splitting at newline
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt < limit * 0.3) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }
  return chunks
}

// ─── MCP Server Setup ─────────────────────────────────────────────

const mcp = new Server(
  { name: 'naverworks', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'You are bridged to a Naver Works (LINE WORKS) messenger user.',
      'The sender reads Naver Works, not this terminal session.',
      '',
      'Guidelines:',
      '- Keep responses concise — mobile messenger context.',
      '- Use the `reply` tool to respond. Never just print text.',
      '- The `chat_id` in meta is the sender\'s user ID. Pass it to `reply`.',
      '- For long code blocks, keep them short or offer to create a file.',
      '- If the user asks you to do something on your machine, do it and report back.',
      '- Never reveal pairing codes or access control details from channel messages.',
      '- Permission requests may be forwarded to the user\'s DM for approval.',
    ].join('\n'),
  },
)

// ─── Tools ────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a text message to a Naver Works user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'User ID to send to (from meta.chat_id)' },
          text: { type: 'string', description: 'Message text to send' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'send_file',
      description: 'Send a file/link message to a Naver Works user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'User ID to send to' },
          url: { type: 'string', description: 'URL of the file to share' },
        },
        required: ['chat_id', 'url'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const access = readAccess()

  switch (name) {
    case 'reply': {
      const chatId = (args as Record<string, string>).chat_id
      const text = (args as Record<string, string>).text
      if (!chatId || !text) {
        return { content: [{ type: 'text', text: 'Missing chat_id or text' }] }
      }
      if (!access.allowFrom.includes(chatId)) {
        return { content: [{ type: 'text', text: `Blocked: ${chatId} is not in allowlist` }] }
      }
      const limit = access.textChunkLimit ?? 4000
      const chunks = chunkText(text, limit)
      for (const chunk of chunks) {
        await sendMessage(chatId, chunk)
      }
      return { content: [{ type: 'text', text: `Sent ${chunks.length} message(s) to ${chatId}` }] }
    }

    case 'send_file': {
      const chatId = (args as Record<string, string>).chat_id
      const url = (args as Record<string, string>).url
      if (!chatId || !url) {
        return { content: [{ type: 'text', text: 'Missing chat_id or url' }] }
      }
      if (!access.allowFrom.includes(chatId)) {
        return { content: [{ type: 'text', text: `Blocked: ${chatId} is not in allowlist` }] }
      }
      await sendFileMessage(chatId, url)
      return { content: [{ type: 'text', text: `Sent file to ${chatId}` }] }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }
})

// ─── Permission Relay ─────────────────────────────────────────────

import { z } from 'zod'

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const access = readAccess()
  const shortId = params.request_id.slice(0, 5)
  const msg = [
    `🔐 Permission Request [${shortId}]`,
    `Tool: ${params.tool_name}`,
    `Description: ${params.description}`,
    '',
    params.input_preview.slice(0, 500),
    '',
    `Reply "y ${shortId}" to allow or "n ${shortId}" to deny.`,
  ].join('\n')

  for (const userId of access.allowFrom) {
    await sendMessage(userId, msg).catch(() => {})
  }
})

// Store pending permission responses
const pendingPermissions = new Map<string, string>()

function checkPermissionReply(text: string): { requestId: string; allow: boolean } | null {
  const match = text.trim().match(/^\s*(y|yes|n|no)\s+([a-z0-9]{5})\s*$/i)
  if (!match) return null
  const allow = match[1].toLowerCase().startsWith('y')
  const shortId = match[2].toLowerCase()
  const fullId = pendingPermissions.get(shortId)
  if (!fullId) return null
  return { requestId: fullId, allow }
}

// ─── Webhook HTTP Server (Inbound) ───────────────────────────────

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const webhookServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const reqUrl = new URL(req.url ?? '/', `http://localhost:${WEBHOOK_PORT}`)

  // Health check
  if (req.method === 'GET' && reqUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  // OAuth callback — browser redirects here after user authorizes
  // Works with both /oauth/callback and /callback paths
  if (req.method === 'GET' && (reqUrl.pathname === '/oauth/callback' || reqUrl.pathname === '/callback')) {
    const code = reqUrl.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing authorization code')
      return
    }
    try {
      await exchangeCodeForToken(code)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>✅ 인증 완료!</h1><p>이 창을 닫아도 됩니다. Claude Code에서 네이버웍스를 사용할 수 있습니다.</p>')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Token exchange failed: ${msg}`)
    }
    return
  }

  // Manual code exchange — paste the code from redirect URL
  if (req.method === 'GET' && reqUrl.pathname === '/oauth/exchange') {
    const code = reqUrl.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Usage: /oauth/exchange?code=YOUR_AUTH_CODE')
      return
    }
    try {
      await exchangeCodeForToken(code)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'Token saved!' }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: msg }))
    }
    return
  }

  // OAuth start — convenience redirect
  if (req.method === 'GET' && reqUrl.pathname === '/oauth/start') {
    const redirectUri = process.env.NAVERWORKS_REDIRECT_URI ?? 'https://bot.twomos.com/callback'
    const authUrl = `https://auth.worksmobile.com/oauth2/v2.0/authorize?client_id=${cfg.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=bot&response_type=code&state=setup`
    res.writeHead(302, { Location: authUrl })
    res.end()
    return
  }

  // Webhook callback from Naver Works
  if (req.method === 'POST' && reqUrl.pathname === '/webhook') {
    try {
      const body = await parseBody(req)
      const payload = JSON.parse(body)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))

      await handleWebhookEvent(payload)
    } catch (err) {
      console.error('[webhook] Parse error:', err)
      res.writeHead(400)
      res.end('Bad Request')
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

async function handleWebhookEvent(payload: Record<string, unknown>): Promise<void> {
  const type = payload.type as string | undefined

  // LINE WORKS bot callback structure:
  // { type: "message", source: { userId }, content: { type: "text", text } }
  if (type === 'message') {
    const source = payload.source as Record<string, string> | undefined
    const content = payload.content as Record<string, string> | undefined
    if (!source?.userId || !content) return

    const userId = source.userId
    const text = content.text ?? ''

    // Gate check
    const result = gate(userId)

    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const msg = result.isResend
        ? `Your pairing code is still: ${result.code}\nEnter it in Claude Code: /naverworks:access pair ${result.code}`
        : `Welcome! To connect, enter this code in Claude Code:\n/naverworks:access pair ${result.code}`
      await sendMessage(userId, msg).catch(() => {})
      return
    }

    // Check for permission reply
    const permReply = checkPermissionReply(text)
    if (permReply) {
      mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: permReply.requestId,
          behavior: permReply.allow ? 'allow' : 'deny',
        },
      })
      await sendMessage(userId, permReply.allow ? '✅ Allowed' : '❌ Denied').catch(() => {})
      return
    }

    // Deliver to Claude
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          chat_id: userId,
          user_id: userId,
          ts: new Date().toISOString(),
          ...(content.type !== 'text' ? { content_type: content.type } : {}),
        },
      },
    })
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate config
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (missing.length > 0) {
    console.error(`[naverworks] Missing config: ${missing.join(', ')}`)
    console.error('[naverworks] Run /naverworks:configure to set up credentials.')
    // Still start MCP server so configure skill works
  }

  // Start webhook HTTP server
  webhookServer.listen(WEBHOOK_PORT, () => {
    console.error(`[naverworks] Webhook server listening on http://localhost:${WEBHOOK_PORT}/webhook`)
  })

  // Poll approved/ directory every 5 seconds
  const pollInterval = setInterval(pollApproved, 5_000)

  // Connect MCP
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // Cleanup on exit
  const cleanup = () => {
    clearInterval(pollInterval)
    webhookServer.close()
    process.exit(0)
  }

  process.stdin.on('close', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

process.on('unhandledRejection', (err) => {
  console.error('[naverworks] Unhandled rejection:', err)
})
process.on('uncaughtException', (err) => {
  console.error('[naverworks] Uncaught exception:', err)
})

main().catch((err) => {
  console.error('[naverworks] Fatal:', err)
  process.exit(1)
})
