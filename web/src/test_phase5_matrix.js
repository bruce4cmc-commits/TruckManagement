import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

async function runPhase5MatrixTests() {
  console.log('===================================================================')
  console.log('  卡車管理系統 V1.2 Phase ⑤ - KPI Engine & Supervisor 完整測試矩陣')
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

  // 1. anon Call get_dashboard_kpi (Must be BLOCKED / AUTH_003)
  const { data: kAnonData, error: kAnonErr } = await anonClient.rpc('get_dashboard_kpi', { p_period_type: 'DAY' })
  logResult('P5-01', 'anon 呼叫 get_dashboard_kpi() RPC', '拒絕執行 (AUTH_003)', kAnonData ? kAnonData.message : (kAnonErr ? kAnonErr.message : 'BLOCKED'), kAnonData ? !kAnonData.success : !!kAnonErr)

  // 2. anon Call get_kpi_trip_details (Must be BLOCKED / AUTH_003)
  const { data: dAnonData, error: dAnonErr } = await anonClient.rpc('get_kpi_trip_details', { p_period_type: 'DAY' })
  logResult('P5-02', 'anon 呼叫 get_kpi_trip_details() RPC', '拒絕執行 (AUTH_003)', dAnonData ? dAnonData.message : (dAnonErr ? dAnonErr.message : 'BLOCKED'), dAnonData ? !dAnonData.success : !!dAnonErr)

  // 3. Direct INSERT trip_event (Must be BLOCKED)
  const { error: insErr } = await anonClient.from('trip_event').insert({ event_id: `P5-${Date.now()}`, trip_id: '20260901-001', truck_id: 'T001', event_code: 'YM_OUT', event_time: new Date().toISOString(), report_type: 'QR' })
  logResult('P5-03', '直接 INSERT trip_event (Event Ledger Lockdown)', 'permission denied (42501)', insErr ? insErr.message : 'ALLOWED', !!insErr)

  // 4. anon Call create_trip (Must be BLOCKED)
  const { data: cAnonData, error: cAnonErr } = await anonClient.rpc('create_trip', { p_plan_date: '2026-09-01', p_plan_departure: '2026-09-01T09:00:00+08:00', p_truck_id: 'T001' })
  logResult('P5-04', 'anon / SUPERVISOR 寫入 create_trip() RPC', '拒絕執行 (AUTH_003/AUTH_005)', cAnonData ? cAnonData.message : (cAnonErr ? cAnonErr.message : 'BLOCKED'), cAnonData ? !cAnonData.success : !!cAnonErr)

  console.log('===================================================================')
  console.log(`  Phase ⑤ 全矩陣測試完畢，總計 ${testMatrix.length} 項測試驗證`)
  console.log('===================================================================')
}

runPhase5MatrixTests()
