import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'

async function runSecurityFixMatrixTest() {
  console.log('===================================================================')
  console.log('  卡車管理系統 V1.2 第②階段 Security Fix - 自動化安全性測試矩陣')
  console.log('===================================================================\n')

  const anonClient = createClient(supabaseUrl, supabaseKey)

  // 1. Direct SELECT on truck_master (Must be BLOCKED)
  console.log('--- [1. Direct SELECT on truck_master] ---')
  const { data: tmData, error: tmErr } = await anonClient.from('truck_master').select('*')
  if (tmErr) {
    console.log('✅ PASS: anon 直接 SELECT truck_master 被阻擋:', tmErr.message, `(${tmErr.code})`)
  } else {
    console.log('❌ FAIL: anon 直接 SELECT truck_master 未被阻擋！筆數:', tmData.length)
  }

  // 2. RPC get_public_active_trucks (Must be ALLOWED & Return 4 fields)
  console.log('\n--- [2. Execute get_public_active_trucks() RPC] ---')
  const { data: rpcData, error: rpcErr } = await anonClient.rpc('get_public_active_trucks')
  if (rpcErr) {
    console.log('❌ FAIL: get_public_active_trucks() RPC 執行失敗:', rpcErr.message)
  } else {
    console.log(`✅ PASS: RPC 執行成功，取得 ${rpcData.length} 筆車輛`)
    if (rpcData.length > 0) {
      const fields = Object.keys(rpcData[0])
      console.log('   暴露欄位:', fields.join(', '))
      const hasDefaultDriver = fields.includes('default_driver_id')
      if (!hasDefaultDriver && fields.length === 4) {
        console.log('✅ PASS: 欄位嚴格限制為 4 個公開欄位 (不含 default_driver_id)')
      } else {
        console.log('❌ FAIL: RPC 暴露了敏感欄位！')
      }
    }
  }

  // 3. Unauthenticated access to driver_master (Must be BLOCKED)
  console.log('\n--- [3. Unauthenticated access to driver_master] ---')
  const { data: dmData, error: dmErr } = await anonClient.from('driver_master').select('*')
  if (dmErr) {
    console.log('✅ PASS: 未登入存取 driver_master 被阻擋:', dmErr.message, `(${dmErr.code})`)
  } else {
    console.log('❌ FAIL: 未登入允許讀取 driver_master！')
  }

  // 4. Unauthenticated access to user_master (Must be BLOCKED)
  console.log('\n--- [4. Unauthenticated access to user_master] ---')
  const { data: umData, error: umErr } = await anonClient.from('user_master').select('*')
  if (umErr) {
    console.log('✅ PASS: 未登入存取 user_master 被阻擋:', umErr.message, `(${umErr.code})`)
  } else {
    console.log('❌ FAIL: 未登入允許讀取 user_master！')
  }

  // 5. Unauthenticated access to trip_plan (Must be BLOCKED)
  console.log('\n--- [5. Unauthenticated access to trip_plan] ---')
  const { data: tpData, error: tpErr } = await anonClient.from('trip_plan').select('*')
  if (tpErr) {
    console.log('✅ PASS: 未登入存取 trip_plan 被阻擋:', tpErr.message, `(${tpErr.code})`)
  } else {
    console.log('❌ FAIL: 未登入允許讀取 trip_plan！')
  }

  console.log('\n===================================================================')
  console.log('  安全性矩陣測試結束')
  console.log('===================================================================')
}

runSecurityFixMatrixTest()
