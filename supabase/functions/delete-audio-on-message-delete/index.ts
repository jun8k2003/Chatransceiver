import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const payload = await req.json()
    
    // We only care about DELETE events
    if (payload.type !== 'DELETE') {
      return new Response('OK', { status: 200 })
    }

    const oldRecord = payload.old_record
    if (!oldRecord || !oldRecord.audio_url) {
      return new Response('No audio URL to delete', { status: 200 })
    }

    const audioUrl: string = oldRecord.audio_url

    // Extract path from public URL
    // e.g. https://xxxx.supabase.co/storage/v1/object/public/voice-messages/123/456.webm -> 123/456.webm
    // NOTE: バケット名はアップロード側 (src/services/supabase.ts の `voice-messages`) と必ず一致させること。
    const bucketName = 'voice-messages'
    const marker = `/public/${bucketName}/`
    const pathIndex = audioUrl.indexOf(marker)
    
    if (pathIndex === -1) {
      console.warn(`Could not parse audio path from URL: ${audioUrl}`)
      return new Response('Invalid audio URL format', { status: 200 })
    }

    const filePath = audioUrl.substring(pathIndex + marker.length)
    if (!filePath) {
      return new Response('Empty file path', { status: 200 })
    }

    // Initialize Supabase Admin Client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log(`Deleting file from Storage: ${filePath}`)

    const { data, error } = await supabaseAdmin.storage
      .from(bucketName)
      .remove([filePath])

    if (error) {
      console.error('Failed to delete file from Storage:', error)
      return new Response('Failed to delete file', { status: 500 })
    }

    console.log(`Successfully deleted file: ${filePath}`)
    return new Response('File deleted successfully', { status: 200 })
  } catch (err) {
    console.error('Error processing request:', err)
    return new Response('Internal Server Error', { status: 500 })
  }
})
