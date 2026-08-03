import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 月あたりの無料枠を守るための上限 (docs/stt_transcription_spec.md §4.1)
const MONTHLY_REQUEST_LIMIT = 200

serve(async (req) => {
  const payload = await req.json()

  if (payload.type !== 'INSERT') return new Response('OK')

  const record = payload.record // messages の挿入レコード
  if (!record?.audio_url || !record?.needs_transcription) {
    return new Response('Not a transcription target')
  }

  // APIキー未設定は「機能が未有効化」の通常状態として扱う (docs/stt_transcription_spec.md §4.0)
  // エラーログを出さず、needs_transcription も変更せずに正常終了する。
  const apiKey = Deno.env.get('GOOGLE_STT_API_KEY')
  if (!apiKey) {
    return new Response('OK')
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // 月間リクエスト数の判定 (追記ログ方式・厳密なアトミック制御はしない) (§4.1)
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const { count, error: countError } = await supabaseAdmin
    .from('stt_usage_log')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', monthStart.toISOString())

  if (countError) {
    console.error('Failed to count stt_usage_log:', countError)
    return new Response('Failed to check usage', { status: 500 })
  }

  if ((count ?? 0) >= MONTHLY_REQUEST_LIMIT) {
    // 上限到達: エラー・警告・通知は行わず、静かにスキップする。needs_transcription は true のまま残す。
    return new Response('Monthly limit reached')
  }

  try {
    // 音声ファイルを取得
    const audioRes = await fetch(record.audio_url)
    if (!audioRes.ok) {
      console.error('Failed to fetch audio file:', record.audio_url, audioRes.status)
      await supabaseAdmin.from('messages').update({ needs_transcription: false }).eq('id', record.id).eq('is_revoked', false)
      return new Response('Failed to fetch audio', { status: 200 })
    }
    const audioBuffer = await audioRes.arrayBuffer()
    const audioBase64 = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)))

    // リクエスト送信直前に利用ログを記録 (成否に関わらず「呼び出した事実」を記録する) (§4.1)
    const { error: logError } = await supabaseAdmin.from('stt_usage_log').insert({})
    if (logError) {
      console.error('Failed to insert stt_usage_log:', logError)
    }

    // Google Speech-to-Text 同期 recognize (音声は最長15秒のため同期APIで完結する) (§4.2)
    const sttRes = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000,
          languageCode: 'ja-JP'
        },
        audio: { content: audioBase64 }
      })
    })

    if (!sttRes.ok) {
      let errBody = ''
      try {
        errBody = await sttRes.text()
      } catch { /* ignore */ }
      console.error('Google Speech-to-Text request failed:', sttRes.status, errBody)
      // 失敗時はリトライしない。二度と対象にならないよう needs_transcription を false にする (§4.5)
      await supabaseAdmin.from('messages').update({ needs_transcription: false }).eq('id', record.id).eq('is_revoked', false)
      return new Response('STT request failed', { status: 200 })
    }

    const sttData = await sttRes.json()
    const transcript: string = sttData.results?.[0]?.alternatives?.[0]?.transcript?.trim() || ''

    // 取り消し (revoke) とのレース対策として is_revoked = false を必ずガードする (§4.4)
    if (transcript) {
      const { error: updateError } = await supabaseAdmin
        .from('messages')
        .update({ text_content: transcript, needs_transcription: false })
        .eq('id', record.id)
        .eq('is_revoked', false)

      if (updateError) {
        console.error('Failed to update message with transcript:', updateError)
      }
    } else {
      // 無音・認識不能: プレースホルダー文言は維持し、対象からのみ外す
      await supabaseAdmin.from('messages').update({ needs_transcription: false }).eq('id', record.id).eq('is_revoked', false)
    }

    return new Response('Transcribed')
  } catch (e) {
    console.error('Unexpected error during transcription:', e)
    try {
      await supabaseAdmin.from('messages').update({ needs_transcription: false }).eq('id', record.id).eq('is_revoked', false)
    } catch (cleanupError) {
      console.error('Failed to clear needs_transcription after error:', cleanupError)
    }
    return new Response('Internal error', { status: 200 })
  }
})
