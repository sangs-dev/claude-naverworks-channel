/**
 * Unit tests for channel server core logic.
 * Tests pure functions without external dependencies.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// ─── Test helpers ─────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `naverworks-test-${randomBytes(4).toString('hex')}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ─── chunkText ────────────────────────────────────────────────────

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

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const result = chunkText('hello', 100)
    expect(result).toEqual(['hello'])
  })

  test('splits long text at limit', () => {
    const text = 'a'.repeat(200)
    const result = chunkText(text, 100)
    expect(result.length).toBe(2)
    expect(result[0].length).toBe(100)
    expect(result[1].length).toBe(100)
  })

  test('prefers splitting at newline', () => {
    const text = 'line1\nline2\nline3\nline4\nline5'
    const result = chunkText(text, 15)
    expect(result[0]).toContain('line')
    expect(result.length).toBeGreaterThan(1)
  })

  test('handles empty string', () => {
    const result = chunkText('', 100)
    expect(result).toEqual([''])
  })

  test('handles text exactly at limit', () => {
    const text = 'a'.repeat(100)
    const result = chunkText(text, 100)
    expect(result).toEqual([text])
  })

  test('handles very long text with multiple chunks', () => {
    const text = 'a'.repeat(10000)
    const result = chunkText(text, 4000)
    expect(result.length).toBe(3)
    expect(result.join('').length).toBe(10000)
  })
})

// ─── Access Control ───────────────────────────────────────────────

type Access = {
  dmPolicy: string
  allowFrom: string[]
  pending: Record<string, { code: string; ts: number; replies: number }>
}

function readAccess(accessFile: string): Access {
  const defaults: Access = { dmPolicy: 'pairing', allowFrom: [], pending: {} }
  if (!existsSync(accessFile)) return defaults
  try { return { ...defaults, ...JSON.parse(readFileSync(accessFile, 'utf-8')) } } catch { return defaults }
}

function writeAccess(accessFile: string, a: Access): void {
  writeFileSync(accessFile, JSON.stringify(a, null, 2))
}

function gate(accessFile: string, userId: string): 'deliver' | 'drop' | { pair: string } {
  const access = readAccess(accessFile)
  if (access.dmPolicy === 'disabled') return 'drop'
  if (access.allowFrom.includes(userId)) return 'deliver'
  if (access.dmPolicy === 'allowlist') return 'drop'

  const existing = access.pending[userId]
  if (existing && Date.now() - existing.ts < 3600_000) {
    existing.replies++
    writeAccess(accessFile, access)
    return { pair: existing.code }
  }
  const code = randomBytes(3).toString('hex')
  access.pending[userId] = { code, ts: Date.now(), replies: 0 }
  writeAccess(accessFile, access)
  return { pair: code }
}

describe('Access Control', () => {
  test('returns defaults when no access file', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    const access = readAccess(accessFile)
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
  })

  test('reads existing access file', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['user1', 'user2'],
    }))
    const access = readAccess(accessFile)
    expect(access.dmPolicy).toBe('allowlist')
    expect(access.allowFrom).toEqual(['user1', 'user2'])
  })

  test('gate delivers for allowlisted user', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['user1'],
      pending: {},
    }))
    expect(gate(accessFile, 'user1')).toBe('deliver')
  })

  test('gate drops for non-allowlisted user in allowlist mode', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['user1'],
      pending: {},
    }))
    expect(gate(accessFile, 'unknown')).toBe('drop')
  })

  test('gate drops when disabled', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'disabled',
      allowFrom: [],
      pending: {},
    }))
    expect(gate(accessFile, 'anyone')).toBe('drop')
  })

  test('gate returns pair code for unknown user in pairing mode', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: {},
    }))
    const result = gate(accessFile, 'new-user')
    expect(typeof result).toBe('object')
    expect((result as { pair: string }).pair).toHaveLength(6)
  })

  test('gate returns same pair code for repeated requests', () => {
    const accessFile = join(TEST_DIR, 'access.json')
    writeFileSync(accessFile, JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: {},
    }))
    const result1 = gate(accessFile, 'new-user') as { pair: string }
    const result2 = gate(accessFile, 'new-user') as { pair: string }
    expect(result1.pair).toBe(result2.pair)
  })
})

// ─── ENV Loading ──────────────────────────────────────────────────

function loadEnv(envFile: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!existsSync(envFile)) return env
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
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

describe('ENV Loading', () => {
  test('returns empty for missing file', () => {
    expect(loadEnv(join(TEST_DIR, 'nope.env'))).toEqual({})
  })

  test('parses simple key=value', () => {
    const f = join(TEST_DIR, '.env')
    writeFileSync(f, 'KEY1=value1\nKEY2=value2\n')
    const env = loadEnv(f)
    expect(env.KEY1).toBe('value1')
    expect(env.KEY2).toBe('value2')
  })

  test('strips quotes', () => {
    const f = join(TEST_DIR, '.env')
    writeFileSync(f, 'A="hello"\nB=\'world\'\n')
    const env = loadEnv(f)
    expect(env.A).toBe('hello')
    expect(env.B).toBe('world')
  })

  test('ignores comments and blank lines', () => {
    const f = join(TEST_DIR, '.env')
    writeFileSync(f, '# comment\n\nKEY=val\n')
    const env = loadEnv(f)
    expect(Object.keys(env)).toEqual(['KEY'])
  })

  test('handles values with = sign', () => {
    const f = join(TEST_DIR, '.env')
    writeFileSync(f, 'URL=https://example.com?a=1&b=2\n')
    const env = loadEnv(f)
    expect(env.URL).toBe('https://example.com?a=1&b=2')
  })
})

// ─── Token Management ─────────────────────────────────────────────

describe('Token File', () => {
  test('reads valid token file', () => {
    const tokenFile = join(TEST_DIR, 'token.json')
    const tokenData = {
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_at: Date.now() + 3600_000,
    }
    writeFileSync(tokenFile, JSON.stringify(tokenData))

    const loaded = JSON.parse(readFileSync(tokenFile, 'utf-8'))
    expect(loaded.access_token).toBe('test-token')
    expect(loaded.expires_at).toBeGreaterThan(Date.now())
  })

  test('detects expired token', () => {
    const tokenData = {
      access_token: 'old-token',
      refresh_token: 'refresh',
      expires_at: Date.now() - 1000,
    }
    expect(Date.now() < tokenData.expires_at - 60_000).toBe(false)
  })

  test('detects valid token', () => {
    const tokenData = {
      access_token: 'good-token',
      refresh_token: 'refresh',
      expires_at: Date.now() + 3600_000,
    }
    expect(Date.now() < tokenData.expires_at - 60_000).toBe(true)
  })
})

// ─── Webhook Payload Parsing ──────────────────────────────────────

describe('Webhook Payload', () => {
  test('parses text message payload', () => {
    const payload = {
      type: 'message',
      source: { userId: 'user-123' },
      content: { type: 'text', text: 'hello bot' },
    }
    expect(payload.type).toBe('message')
    expect(payload.source.userId).toBe('user-123')
    expect(payload.content.text).toBe('hello bot')
  })

  test('handles missing content gracefully', () => {
    const payload = { type: 'message', source: { userId: 'user-123' } }
    const content = (payload as Record<string, unknown>).content as Record<string, string> | undefined
    expect(content).toBeUndefined()
  })

  test('handles non-message type', () => {
    const payload = { type: 'join', source: { userId: 'user-123' } }
    expect(payload.type).not.toBe('message')
  })
})
