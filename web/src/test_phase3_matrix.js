import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

async function runPhase3FixGateTest() {
  console.log('===================================================================')
  console.log('  卡車管理系統 V1.2 Phase ③ Fix Gate - 自動化完整測試矩陣')
  console.log('===================================================================\n')

  const anonClient = createClient(supabaseUrl, supabaseKey)

  // 1. anon Call scan_trip_event (Must fail with AUTH_003 or Permission Denied)
  console.log('--- [1. anon 呼叫 scan_trip_event() RPC] ---')
  const { data: anonRes, error: anonErr } = await anonClient.rpc('scan_trip_event', { p_event_code: 'YM_OUT' })
  if (anonRes && !anonRes.success) {
    console.log(`✅ PASS: anon 被拒絕: ${anonRes.message} (${anonRes.errorCode})`)
  } else if (anonErr) {
    console.log(`✅ PASS: anon 權限拒絕: ${anonErr.message}`)
  } else {
    console.log(`❌ FAIL: anon 成功呼叫 RPC！`)
  }

  // 2. anon Call get_driver_home (Must fail with AUTH_003 or Permission Denied)
  console.log('\n--- [2. anon 呼叫 get_driver_home() RPC] ---')
  const { data: homeRes, error: homeErr } = await anonClient.rpc('get_driver_home')
  if (homeRes && !homeRes.success) {
    console.log(`✅ PASS: anon 讀取司機首頁被拒絕: ${homeRes.message}`)
  } else if (homeErr) {
    console.log(`✅ PASS: anon 權限拒絕: ${homeErr.message}`)
  } else {
    console.log(`❌ FAIL: anon 成功讀取首頁！`)
  }

  // 3. Direct INSERT trip_event (Must be BLOCKED for DRIVER/anon)
  console.log('\n--- [3. DRIVER/anon 直接 INSERT trip_event (不走 RPC)] ---')
  const { data: insData, error: insErr } = await anonClient.from('trip_event').insert({
    event_id: `DIRECT-${Date.now()}`,
    trip_id: '20260829-001',
    truck_id: 'T001',
    driver_id: 'D001',
    event_code: 'YM_OUT',
    event_time: new Date().toISOString(),
    report_type: 'QR'
  })

  if (insErr) {
    console.log(`✅ PASS: 直接 INSERT trip_event 被阻擋: ${insErr.message} (${insErr.code})`)
  } else {
    console.log(`❌ FAIL: 直接 INSERT trip_event 未被收緊！`)
  }

  console.log('\n===================================================================')
  console.log('  Phase ③ Fix Gate 測試完成')
  console.log('===================================================================')
}

runPhase3FixGateTest()
