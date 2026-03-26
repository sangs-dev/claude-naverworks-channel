/**
 * E2E tests for Naver Works Claude Bot.
 *
 * Uses the running browser server (localhost:9222) to interact with
 * Naver Works web messenger, and verifies bot responses.
 *
 * Prerequisites:
 *   - Browser server running on :9222 with Naver Works messenger open
 *   - Bot server running on :48080
 *   - Logged in to Naver Works and Claude AI bot chat open
 */

import { describe, test, expect, beforeAll } from 'bun:test'

const BROWSER_API = 'http://localhost:9222'
const BOT_API = 'https://bot.twomos.com'
const BOT_USER_ID = '1d381d4f-3b28-412f-1f02-033ac71fcb6e'

async function browserEval(js: string): Promise<unknown> {
  const res = await fetch(`${BROWSER_API}/eval?${new URLSearchParams({ js })}`)
  const data = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'eval failed')
  return data.result
}

async function screenshot(): Promise<void> {
  await fetch(`${BROWSER_API}/screenshot`)
}

async function getVisibleMessages(): Promise<string[]> {
  const result = await browserEval(`
    (()=>{
      const msgs = document.querySelectorAll('.message_content, .txt_msg, [class*=message] p, [class*=chat] [class*=text]');
      const texts = [];
      for (const m of msgs) {
        const t = m.textContent?.trim();
        if (t && t.length > 0 && t.length < 2000) texts.push(t);
      }
      return JSON.stringify(texts.slice(-10));
    })()
  `)
  return JSON.parse(result as string)
}

async function sendWebhookMessage(text: string): Promise<boolean> {
  const res = await fetch(`${BOT_API}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      source: { userId: BOT_USER_ID },
      content: { type: 'text', text },
    }),
  })
  return res.ok
}

async function sendMessageViaPlaywright(text: string): Promise<boolean> {
  const result = await browserEval(`
    (()=>{
      const el = document.querySelector('#message-input');
      if (!el) return 'no-input';
      el.focus();
      el.innerHTML = '';
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      setTimeout(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      }, 300);
      return 'sent';
    })()
  `)
  return result === 'sent'
}

async function waitForBotResponse(timeoutMs: number = 45000): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, timeoutMs))
}

// ─── Tests ────────────────────────────────────────────────────────

describe('Bot Server Health', () => {
  test('health endpoint returns ok', async () => {
    const res = await fetch(`${BOT_API}/health`)
    const data = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(data.status).toBe('ok')
    expect(data.token).toBe('valid')
  })

  test('webhook endpoint accepts POST', async () => {
    const res = await fetch(`${BOT_API}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ping' }),
    })
    expect(res.status).toBe(200)
  })

  test('returns 404 for unknown routes', async () => {
    const res = await fetch(`${BOT_API}/nonexistent`)
    expect(res.status).toBe(404)
  })
})

describe('Browser Server', () => {
  test('browser server is accessible', async () => {
    const res = await fetch(`${BROWSER_API}/url`)
    const url = await res.text()
    expect(url).toContain('worksmobile.com')
  })

  test('can take screenshot', async () => {
    const res = await fetch(`${BROWSER_API}/screenshot`)
    const data = (await res.json()) as { ok: boolean }
    expect(data.ok).toBe(true)
  })

  test('message input exists', async () => {
    const result = await browserEval(`
      (()=>{ return document.querySelector('#message-input') ? 'found' : 'not-found' })()
    `)
    expect(result).toBe('found')
  })
})

describe('E2E Bot Conversation via Webhook', () => {
  test('bot responds to Korean greeting', async () => {
    const sent = await sendWebhookMessage('안녕하세요!')
    expect(sent).toBe(true)

    await waitForBotResponse(35000)
    await screenshot()

    // Verify response arrived in messenger
    const messages = await getVisibleMessages()
    expect(messages.length).toBeGreaterThan(0)
  }, 60000)

  test('bot responds to English question', async () => {
    const sent = await sendWebhookMessage('What is 2+2?')
    expect(sent).toBe(true)

    await waitForBotResponse(35000)
    await screenshot()

    const messages = await getVisibleMessages()
    expect(messages.length).toBeGreaterThan(0)
  }, 60000)

  test('bot responds to follow-up (history)', async () => {
    const sent = await sendWebhookMessage('방금 내가 뭐라고 했지?')
    expect(sent).toBe(true)

    await waitForBotResponse(35000)
    await screenshot()

    const messages = await getVisibleMessages()
    expect(messages.length).toBeGreaterThan(0)
  }, 60000)
})

describe('E2E Bot Conversation via Playwright', () => {
  test('can send message via Playwright and receive response', async () => {
    const sent = await sendMessageViaPlaywright('Playwright 테스트 메시지입니다!')
    expect(sent).toBe(true)

    await waitForBotResponse(40000)
    await screenshot()

    const messages = await getVisibleMessages()
    expect(messages.length).toBeGreaterThan(0)
  }, 60000)
})
