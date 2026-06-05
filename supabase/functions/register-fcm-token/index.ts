import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  
  try {
    const { action, device_uuid, fcm_token } = await req.json()

    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

    if (action === 'register') {
      const { error } = await supabase
        .from('fcm_tokens')
        .upsert({ 
          device_uuid, 
          user_id: user.id, 
          fcm_token,
          updated_at: new Date().toISOString()
        })
      if (error) throw error;
    } else if (action === 'unregister') {
      const { error } = await supabase
        .from('fcm_tokens')
        .delete()
        .eq('device_uuid', device_uuid)
        .eq('user_id', user.id)
      if (error) throw error;
    }

    return new Response(JSON.stringify({ success: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})