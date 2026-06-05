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

  // 対象ユーザーのトークンを取得
  const { data: tokens } = await supabaseAdmin
    .from('fcm_tokens')
    .select('device_uuid, fcm_token')
    .eq('user_id', record.user_id)

  if (!tokens || tokens.length === 0) return new Response('No tokens')

  // 通知用のデータ抽出 (テキストはインボックスに保存されている text_content 等を利用)
  const notificationTitle = `[新着メッセージ] ${record.sender_name || '通知'}`
  const notificationBody = record.audio_url ? '🎤 音声メッセージ' : (record.text_content || '新しいメッセージが届きました')

  const accessToken = await getFirebaseAccessToken()

  const sendPromises = tokens.map(async (t) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token: t.fcm_token,
          // システム通知として表示させるための data ペイロード
          data: {
            communitySlug: record.community_slug || '',
            messageId: record.message_id || '',
            communityName: 'コミュニティ',
            senderName: record.sender_name || '通知',
            messageType: record.audio_url ? 'audio' : 'text',
            textContent: notificationBody
          }
        }
      })
    })

    if (!res.ok) {
      const errorData = await res.json()
      const errorCode = errorData.error?.details?.[0]?.errorCode
      // トークン無効時は削除
      if (errorCode === 'UNREGISTERED' || res.status === 404) {
        await supabaseAdmin.from('fcm_tokens').delete().eq('device_uuid', t.device_uuid)
      }
    }
  })

  await Promise.all(sendPromises)
  return new Response('Sent')
})