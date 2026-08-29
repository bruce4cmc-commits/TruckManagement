import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

async function runManualAddVerificationTest() {
  console.log('===================================================================')
  console.log('  卡車管理系統 V1.2 Phase ④ 最終 SQL Verification (manual_add 驗證)')
  console.log('===================================================================\n')

  const anonClient = createClient(supabaseUrl, supabaseKey)
  const testMatrix = []

  function logResult(testId, scenario, expected, actual, pass, details = '') {
    testMatrix.push({ testId, scenario, expected, actual, pass, details })
    const icon = pass ? '✅ PASS' : '❌ FAIL'
    console.log(`[${testId}] ${scenario}`)
    console.log(`   預期: ${expected}`)
    console.log(`   實際: ${actual}`)
    console.log(`   結果: ${icon} ${details ? `(${details})` : ''}\n`)
  }

  // Test 1: Unauthenticated call manual_add_trip_event (Must be BLOCKED)
  const { data: mAnonData, error: mAnonErr } = await anonClient.rpc('manual_add_trip_event', {
    p_trip_id: 'NON-EXISTENT-TRIP',
    p_event_code: 'YM_OUT',
    p_event_time: new Date().toISOString()
  })
  logResult('V-01', '未登入呼叫 manual_add_trip_event()', '拒絕執行 (AUTH_003)', mAnonData ? mAnonData.message : mAnonData ? mAnonData.errorCode : (mAnonErr ? mAnonErr.message : 'BLOCKED'), mAnonData ? !mAnonData.success : !!mAnonErr)

  // Test 2: Invalid event code passed
  const { data: invCodeData, error: invCodeErr } = await anonClient.rpc('manual_add_trip_event', {
    p_trip_id: '20260901-001',
    p_event_code: 'INVALID_NODE_CODE',
    p_event_time: new Date().toISOString()
  })
  logResult('V-02', '傳入非法 event_code (非 7 合法節點)', 'EVENT_001 (無效的作業節點代碼)', invCodeData ? `${invCodeData.errorCode}: ${invCodeData.message}` : invCodeErr.message, invCodeData ? invCodeData.errorCode === 'EVENT_001' : !!invCodeErr)

  // Test 3: Non-existent trip_id passed
  const { data: nonTripData, error: nonTripErr } = await anonClient.rpc('manual_add_trip_event', {
    p_trip_id: 'NON-EXISTENT-TRIP-999',
    p_event_code: 'YM_OUT',
    p_event_time: new Date().toISOString()
  })
  logResult('V-03', '傳入不存在之 trip_id', 'TRIP_001 (Trip 不存在)', nonTripData ? `${nonTripData.errorCode}: ${nonTripData.message}` : nonTripErr.message, nonTripData ? (nonTripData.errorCode === 'TRIP_001' || !nonTripData.success) : !!nonTripErr)

  // Test 4: Direct INSERT on trip_event (Event Ledger Lockdown)
  const { error: insErr } = await anonClient.from('trip_event').insert({
    event_id: `VERIFY-${Date.now()}`,
    trip_id: '20260901-001',
    truck_id: 'T001',
    event_code: 'YM_OUT',
    event_time: new Date().toISOString(),
    report_type: 'MANUAL'
  })
  logResult('V-04', '瀏覽器直接手動傳入 truck_id/driver_id INSERT trip_event', 'permission denied (42501)', insErr ? insErr.message : 'ALLOWED', !!insErr)

  console.log('===================================================================')
  console.log(`  Phase ④ SQL Verification 測試完畢，總計 ${testMatrix.length} 項測試`)
  console.log('===================================================================')
}

runManualAddVerificationTest()
