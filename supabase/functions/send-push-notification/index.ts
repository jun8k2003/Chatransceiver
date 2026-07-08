import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { create } from 'https://deno.land/x/djwt@v2.8/mod.ts'

// JSONキーを環境変数から取得
const serviceAccount = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') || '{}')

// PEMフォーマットの秘密鍵をWeb Crypto API用にインポートする関数
async function importPrivateKey(pem: string) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.substring(
    pem.indexOf(pemHeader) + pemHeader.length,
    pem.indexOf(pemFooter)
  ).replace(/\s/g, "");
  
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  
  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// OAuth2アクセストークンを取得する関数
async function getFirebaseAccessToken(): Promise<string> {
  const privateKey = await importPrivateKey(serviceAccount.private_key);
  
  const jwt = await create(
    { alg: "RS256", typ: "JWT" },
    {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    },
    privateKey
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  
  const data = await res.json();
  return data.access_token;
}

serve(async (req) => {
  const payload = await req.json()
  const record = payload.record // user_inboxes の挿入レコード
  
  if (payload.type !== 'INSERT') return new Response('OK')

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // 対象ユーザーのトークン、Discord Webhook、カスタムWebhook (DEC-033) を取得
  const [tokensResult, userResult, webhooksResult] = await Promise.all([
    supabaseAdmin.from('fcm_tokens').select('device_uuid, fcm_token').eq('user_id', record.user_id),
    supabaseAdmin.from('users').select('discord_webhook_url').eq('id', record.user_id).single(),
    supabaseAdmin.from('user_webhooks').select('url, method, body_template').eq('user_id', record.user_id).eq('enabled', true)
  ])

  const tokens = tokensResult.data || []
  const discordWebhookUrl = userResult.data?.discord_webhook_url
  const customWebhooks = webhooksResult.data || []

  if (tokens.length === 0 && (!discordWebhookUrl || discordWebhookUrl.trim() === '') && customWebhooks.length === 0) {
    return new Response('No notification targets')
  }

  // DBからメッセージ詳細、送信者情報、コミュニティ情報を取得
  const { data: msgData, error: msgError } = await supabaseAdmin
    .from('messages')
    .select('audio_url, text_content, users(name), chat_rooms(type, communities(slug, name))')
    .eq('id', record.message_id)
    .single()

  if (msgError || !msgData) {
    console.error('Failed to fetch message details:', msgError)
    return new Response('Message details not found', { status: 400 })
  }

  const senderName = (msgData.users as any)?.name || '不明なユーザー'
  const textContent = msgData.text_content || ''
  const audioUrl = msgData.audio_url || ''
  
  const chatRoom = msgData.chat_rooms as any
  const community = chatRoom?.communities as any
  const communitySlug = community?.slug || ''
  const communityName = community?.name || 'コミュニティ'

  // 通知用のデータ抽出
  const notificationTitle = `[新着メッセージ] ${senderName}`
  const notificationBody = audioUrl ? '🎤 音声メッセージ' : (textContent || '新しいメッセージが届きました')

  let accessToken = '';
  if (tokens.length > 0) {
    try {
      accessToken = await getFirebaseAccessToken()
    } catch (e) {
      console.error('Failed to get Firebase access token:', e)
    }
  }

  const sendPromises: Promise<any>[] = []

  if (accessToken && tokens.length > 0) {
    const fcmPromises = tokens.map(async (t) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token: t.fcm_token,
            // カスタムのクリックハンドラで利用するデータ
            data: {
              url: `/?c=${communitySlug}&m=${record.message_id || ''}`,
              communitySlug: communitySlug,
              messageId: record.message_id || '',
              communityName: communityName,
              senderName: senderName,
              messageType: audioUrl ? 'audio' : 'text',
              textContent: textContent
            }
          }
        })
      })

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        const errorCode = errorData.error?.details?.[0]?.errorCode
        // トークン無効時は削除
        if (errorCode === 'UNREGISTERED' || res.status === 404) {
          await supabaseAdmin.from('fcm_tokens').delete().eq('device_uuid', t.device_uuid)
        }
      }
    })
    sendPromises.push(...fcmPromises)
  }

  const fullUrl = `https://chatransceiver13162.web.app/?c=${communitySlug}&m=${record.message_id || ''}`
  const messageText = audioUrl ? '🎤 音声メッセージ' : textContent;

  // Discord Webhookの送信
  if (discordWebhookUrl && discordWebhookUrl.trim() !== '') {
    const discordPromise = fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `【新着】**${senderName}**さんからメッセージ:\n> ${messageText}\n\n👉 アプリで開く: ${fullUrl}`
      })
    }).then(res => {
      if (!res.ok) {
        console.error('Discord Webhook error:', res.status, res.statusText)
      }
    }).catch(e => {
      console.error('Failed to send Discord webhook:', e)
    })
    sendPromises.push(discordPromise)
  }

  // カスタムWebhookの送信 (DEC-033): 投げっぱなし (リトライ・ユーザー通知なし)
  if (customWebhooks.length > 0) {
    // 置換変数 (docs/custom_webhook_spec.md §3)
    const webhookVars: Record<string, string> = {
      message: messageText || '新しいメッセージが届きました',
      username: senderName,
      community: communityName,
      message_type: audioUrl ? 'audio' : 'text',
      url: fullUrl
    }

    // テンプレート置換: 未知の変数はそのまま残す
    const substituteVars = (template: string, escapeFn: (v: string) => string): string =>
      template.replace(/\{(\w+)\}/g, (match, key) =>
        key in webhookVars ? escapeFn(webhookVars[key]) : match)

    // Body内はJSON文字列として安全なようにエスケープ、URL内はパーセントエンコード
    const jsonEscape = (v: string): string => JSON.stringify(v).slice(1, -1)

    for (const w of customWebhooks) {
      try {
        const targetUrl = substituteVars(w.url || '', encodeURIComponent)
        if (!targetUrl.startsWith('https://')) continue

        const method = (w.method || 'POST').toUpperCase()
        const init: RequestInit = { method, signal: AbortSignal.timeout(5000) }
        if ((method === 'POST' || method === 'PUT') && w.body_template) {
          init.headers = { 'Content-Type': 'application/json' }
          init.body = substituteVars(w.body_template, jsonEscape)
        }

        sendPromises.push(
          fetch(targetUrl, init).then(res => {
            if (!res.ok) {
              console.error('Custom webhook error:', res.status, res.statusText)
            }
          }).catch(e => {
            console.error('Failed to send custom webhook:', e)
          })
        )
      } catch (e) {
        console.error('Failed to build custom webhook request:', e)
      }
    }
  }

  await Promise.allSettled(sendPromises)
  return new Response('Sent')
})