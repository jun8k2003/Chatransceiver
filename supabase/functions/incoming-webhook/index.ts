import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MAX_BODY_BYTES = 8192
const MAX_CONTENT_LENGTH = 500
const MAX_USERNAME_LENGTH = 30
// トークン形式: 英数字・ハイフン・アンダースコア 16〜64文字
const TOKEN_REGEX = /^[A-Za-z0-9_-]{16,64}$/

const jsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8'
}

function jsonResponse(body: Record<string, unknown>, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...(extraHeaders || {}) }
  })
}

/** NULLバイトおよび改行・タブ以外の制御文字を除去して前後空白をトリムする */
function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return ''
  // \x00-\x08, \x0B, \x0C, \x0E-\x1F, \x7F を除去
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
}

/** 8KB上限を守りながらリクエストボディをUTF-8文字列として読み取る */
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const contentLengthHeader = req.headers.get('content-length')
  if (contentLengthHeader) {
    const len = Number(contentLengthHeader)
    if (!Number.isNaN(len) && len > maxBytes) {
      return { ok: false }
    }
  }

  if (!req.body) {
    return { ok: true, text: '' }
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        return { ok: false }
      }
      chunks.push(value)
    }
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { ok: true, text: new TextDecoder('utf-8').decode(merged) }
}

/** ペイロードから本文と送信者名を抽出する（Discord / Slack / 内部形式互換） */
function extractPayloadFields(payload: Record<string, unknown>): { content: string; username: string | null } {
  // 1. content -> text -> message の優先順
  const rawCandidates = [payload.content, payload.text, payload.message]
  let content = ''
  for (const candidate of rawCandidates) {
    const cleaned = sanitizeText(candidate)
    if (cleaned) {
      content = cleaned
      break
    }
  }

  // 2. 本文が空なら Discord embeds[0] の title + description にフォールバック
  if (!content && Array.isArray(payload.embeds) && payload.embeds.length > 0) {
    const firstEmbed = payload.embeds[0]
    if (firstEmbed && typeof firstEmbed === 'object') {
      const embedObj = firstEmbed as Record<string, unknown>
      const title = sanitizeText(embedObj.title)
      const desc = sanitizeText(embedObj.description)
      content = [title, desc].filter(Boolean).join('\n')
    }
  }

  // 500文字超過時はエラーにせず先頭500文字＋…に切り詰める (docs/incoming_webhook_spec.md §3.2)
  const chars = Array.from(content)
  if (chars.length > MAX_CONTENT_LENGTH) {
    content = chars.slice(0, MAX_CONTENT_LENGTH).join('') + '…'
  }

  const rawUsername = sanitizeText(payload.username)
  const usernameChars = Array.from(rawUsername)
  const username = usernameChars.length > 0
    ? usernameChars.slice(0, MAX_USERNAME_LENGTH).join('')
    : null

  return { content, username }
}

serve(async (req) => {
  // 1. HTTPメソッド検証 (POSTのみ)
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' })
  }

  // 2. URLパス末尾から secret_token を抽出し形式チェック (DB接続前ガード)
  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const secretToken = segments[segments.length - 1] || ''
  if (!TOKEN_REGEX.test(secretToken) || secretToken === 'incoming-webhook') {
    return jsonResponse({ ok: false, error: 'webhook_not_found' }, 404)
  }

  // 3. ボディサイズ上限チェック (8KB) & JSONパース
  const bodyResult = await readBodyWithLimit(req, MAX_BODY_BYTES)
  if (!bodyResult.ok) {
    return jsonResponse({ ok: false, error: 'payload_too_large' }, 413)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyResult.text)
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_payload', message: 'Invalid JSON body' }, 400)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonResponse({ ok: false, error: 'invalid_payload', message: 'JSON body must be an object' }, 400)
  }

  const { content, username } = extractPayloadFields(parsed as Record<string, unknown>)
  if (!content) {
    return jsonResponse({ ok: false, error: 'invalid_payload', message: 'content or text is required' }, 400)
  }

  // 4. 1トランザクションRPCでトークン検証・レートリミット・メッセージ挿入を実行
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  const { data, error } = await supabaseAdmin.rpc('post_via_incoming_webhook', {
    p_secret_token: secretToken,
    p_content: content,
    p_username: username
  })

  if (error || !data) {
    console.error('post_via_incoming_webhook RPC failed:', error)
    return jsonResponse({ ok: false, error: 'internal_error' }, 500)
  }

  const status: number = typeof data.status === 'number' ? data.status : (data.ok ? 201 : 400)
  if (!data.ok) {
    const extraHeaders: Record<string, string> = {}
    if (status === 429 && data.retry_after) {
      extraHeaders['Retry-After'] = String(data.retry_after)
    }
    return jsonResponse({ ok: false, error: data.error || 'webhook_failed' }, status, extraHeaders)
  }

  return jsonResponse({ ok: true, message_id: data.message_id }, 201)
})
