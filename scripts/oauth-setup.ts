/**
 * OAuth setup helper — runs the token exchange flow independently.
 *
 * Usage:
 *   bun scripts/oauth-setup.ts           # Opens auth URL, waits for code
 *   bun scripts/oauth-setup.ts <code>    # Exchange code directly
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:http'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'naverworks')
const ENV_FILE = join(STATE_DIR, '.env')
const TOKEN_FILE = join(STATE_DIR, 'token.json')

mkdirSync(STATE_DIR, { recursive: true })

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    env[t.slice(0, eq).trim()] = val
  }
  return env
}

const fe = loadEnv()
const clientId = process.env.NAVERWORKS_CLIENT_ID ?? fe.NAVERWORKS_CLIENT_ID ?? ''
const clientSecret = process.env.NAVERWORKS_CLIENT_SECRET ?? fe.NAVERWORKS_CLIENT_SECRET ?? ''
const redirectUri = process.env.NAVERWORKS_REDIRECT_URI ?? 'http://localhost:38080/callback'

if (!clientId || !clientSecret) {
  console.error('Missing NAVERWORKS_CLIENT_ID or NAVERWORKS_CLIENT_SECRET in', ENV_FILE)
  process.exit(1)
}

async function exchangeCode(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  })

  console.log('Exchanging code for token...')
  console.log('redirect_uri:', redirectUri)

  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`Token exchange failed (${res.status}):`, text)
    process.exit(1)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    token_type: string
    scope: string
  }

  const tokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }

  writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2))
  chmodSync(TOKEN_FILE, 0o600)

  console.log('✅ Token saved to', TOKEN_FILE)
  console.log('   access_token:', data.access_token.slice(0, 20) + '...')
  console.log('   expires_in:', data.expires_in, 'seconds')
  console.log('   scope:', data.scope)
}

const codeArg = process.argv[2]

if (codeArg) {
  // Direct code exchange
  await exchangeCode(codeArg)
  process.exit(0)
}

// Start a local callback server and open auth URL
const PORT = 38080
const authUrl = `https://auth.worksmobile.com/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=bot&response_type=code&state=setup`

console.log('\n🔗 Open this URL in your browser to authorize:\n')
console.log(authUrl)
console.log('\nWaiting for callback on http://localhost:' + PORT + '/callback ...\n')

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>❌ No code received</h1>')
      return
    }

    try {
      await exchangeCode(code)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>✅ 인증 완료!</h1><p>이 창을 닫아도 됩니다.</p>')
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>❌ Token exchange failed</h1>')
    }

    setTimeout(() => process.exit(0), 1000)
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, () => {
  console.log(`Callback server listening on port ${PORT}`)
})
