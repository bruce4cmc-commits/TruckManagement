import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

const supabase = createClient(supabaseUrl, supabaseKey)

async function testAnonAccess() {
  const tables = [
    'truck_master',
    'driver_master',
    'user_master',
    'trip_plan',
    'trip_event',
    'trip_status',
    'exception_log',
    'system_config',
    'dashboard_data'
  ]

  console.log('=== ANON ACCESS TEST ===')
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('*')
    if (error) {
      console.log(`[BLOCKED/ERROR] ${table}:`, error.message, `(${error.code})`)
    } else {
      console.log(`[ALLOWED] ${table}:`, data.length, 'rows')
    }
  }
}

testAnonAccess()
