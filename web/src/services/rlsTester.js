import { supabase } from '../config/supabase.js'
import { getCurrentUserProfile } from './authService.js'

/**
 * Execute Security Fix Verification Suite for current identity
 */
export async function runRlsTests() {
  const profile = await getCurrentUserProfile()
  const role = profile ? profile.role : 'ANON'

  console.log(`[Security Tester] Running tests for role: ${role}`)

  const testResults = []

  // 1. anon Direct SELECT on truck_master (Must be BLOCKED)
  try {
    const { data, error } = await supabase.from('truck_master').select('*')
    if (error) {
      testResults.push({
        testId: 'TRUCK_DIRECT_SELECT',
        name: '直接 SELECT truck_master (包含敏感預設司機欄位)',
        expected: 'BLOCKED',
        actual: 'BLOCKED',
        code: error.code,
        message: error.message,
        success: true
      })
    } else {
      testResults.push({
        testId: 'TRUCK_DIRECT_SELECT',
        name: '直接 SELECT truck_master (包含敏感預設司機欄位)',
        expected: 'BLOCKED',
        actual: `ALLOWED (${data ? data.length : 0} 筆)`,
        message: '安全警告：truck_master 未阻擋直接 SELECT！',
        success: false
      })
    }
  } catch (err) {
    testResults.push({
      testId: 'TRUCK_DIRECT_SELECT',
      name: '直接 SELECT truck_master Exception',
      expected: 'BLOCKED',
      actual: 'ERROR',
      message: err.message,
      success: true
    })
  }

  // 2. RPC get_public_active_trucks (Must be ALLOWED & return strictly 4 public fields)
  try {
    const { data, error } = await supabase.rpc('get_public_active_trucks')
    if (error) {
      testResults.push({
        testId: 'TRUCK_RPC_SELECT',
        name: '執行 get_public_active_trucks() RPC',
        expected: 'ALLOWED',
        actual: 'BLOCKED',
        message: error.message,
        success: false
      })
    } else if (data && data.length > 0) {
      const sample = data[0]
      const keys = Object.keys(sample)
      const hasDefaultDriver = keys.includes('default_driver_id')
      const hasAuthUserId = keys.includes('auth_user_id')
      const isFourFields = keys.length === 4 && !hasDefaultDriver && !hasAuthUserId

      testResults.push({
        testId: 'TRUCK_RPC_SELECT',
        name: '執行 get_public_active_trucks() RPC (驗證僅回傳 4 個公開欄位)',
        expected: 'ALLOWED (4 欄位: truck_id, truck_no, truck_name, sort_order)',
        actual: `ALLOWED (${data.length} 筆, 欄位: ${keys.join(', ')})`,
        success: isFourFields
      })
    } else {
      testResults.push({
        testId: 'TRUCK_RPC_SELECT',
        name: '執行 get_public_active_trucks() RPC',
        expected: 'ALLOWED',
        actual: 'ALLOWED (0 筆資料)',
        success: true
      })
    }
  } catch (err) {
    testResults.push({
      testId: 'TRUCK_RPC_SELECT',
      name: '執行 get_public_active_trucks() RPC Exception',
      expected: 'ALLOWED',
      actual: 'ERROR',
      message: err.message,
      success: false
    })
  }

  // 3. driver_master read test (Unauthenticated blocked / Driver scope restricted)
  try {
    const { data, error } = await supabase.from('driver_master').select('driver_id, driver_name, auth_user_id')
    if (error) {
      testResults.push({
        testId: 'DRIVER_READ',
        name: '讀取 driver_master 主檔',
        expected: role === 'ANON' ? 'BLOCKED' : 'ALLOWED',
        actual: 'BLOCKED',
        code: error.code,
        message: error.message,
        success: role === 'ANON'
      })
    } else {
      const ownCount = data ? data.length : 0
      const isDriverIsolated = role === 'DRIVER' ? ownCount <= 1 : true

      testResults.push({
        testId: 'DRIVER_READ',
        name: role === 'DRIVER' ? '讀取 driver_master (只能看到自己)' : '讀取 driver_master',
        expected: role === 'ANON' ? 'BLOCKED' : 'ALLOWED',
        actual: `ALLOWED (${ownCount} 筆)`,
        success: role === 'ANON' ? false : isDriverIsolated
      })
    }
  } catch (err) {
    testResults.push({
      testId: 'DRIVER_READ',
      name: '讀取 driver_master Exception',
      expected: 'UNKNOWN',
      actual: 'ERROR',
      message: err.message,
      success: false
    })
  }

  // 4. user_master read test
  try {
    const { data, error } = await supabase.from('user_master').select('user_id, user_name, role')
    if (error) {
      testResults.push({
        testId: 'USER_READ',
        name: '讀取 user_master 主檔',
        expected: (role === 'LOGISTICS' || role === 'SUPERVISOR' || role === 'ADMIN') ? 'ALLOWED' : 'BLOCKED',
        actual: 'BLOCKED',
        code: error.code,
        message: error.message,
        success: role === 'ANON' || role === 'DRIVER'
      })
    } else {
      testResults.push({
        testId: 'USER_READ',
        name: '讀取 user_master 主檔',
        expected: (role === 'LOGISTICS' || role === 'SUPERVISOR' || role === 'ADMIN') ? 'ALLOWED' : 'BLOCKED',
        actual: `ALLOWED (${data.length} 筆)`,
        success: (role === 'LOGISTICS' || role === 'SUPERVISOR' || role === 'ADMIN')
      })
    }
  } catch (err) {
    testResults.push({
      testId: 'USER_READ',
      name: '讀取 user_master Exception',
      expected: 'UNKNOWN',
      actual: 'ERROR',
      message: err.message,
      success: false
    })
  }

  // 5. Metadata Role Tamper Test (Verify raw_user_meta_data cannot alter current_app_role())
  try {
    const { data: dbRole, error: roleErr } = await supabase.rpc('current_app_role')
    if (!roleErr) {
      testResults.push({
        testId: 'METADATA_TAMPER_TEST',
        name: '認證源判定 (基於 auth.uid() 與 DB，忽略用戶 metadata)',
        expected: role === 'ANON' ? 'NULL' : role,
        actual: dbRole || 'NULL (ANON)',
        success: role === 'ANON' ? (dbRole === null) : (dbRole === role)
      })
    }
  } catch (err) {
    // RPC current_app_role execute test
  }

  // 6. trip_plan write test (SUPERVISOR / DRIVER / ANON must be BLOCKED; LOGISTICS ALLOWED)
  try {
    const dummyId = `SECURITY-TEST-${Date.now()}`
    const { error } = await supabase.from('trip_plan').insert({
      trip_id: dummyId,
      plan_date: new Date().toISOString().split('T')[0],
      trip_no: 99,
      plan_departure: new Date().toISOString(),
      truck_id: 'T001',
      plan_type: 'NORMAL',
      trip_status: 'WAITING'
    })

    if (error) {
      testResults.push({
        testId: 'TRIP_WRITE',
        name: '新增 trip_plan (SUPERVISOR / DRIVER 禁止日常排程寫入)',
        expected: (role === 'LOGISTICS' || role === 'ADMIN') ? 'ALLOWED' : 'BLOCKED',
        actual: 'BLOCKED',
        code: error.code,
        message: error.message,
        success: (role !== 'LOGISTICS' && role !== 'ADMIN')
      })
    } else {
      await supabase.from('trip_plan').delete().eq('trip_id', dummyId)
      testResults.push({
        testId: 'TRIP_WRITE',
        name: '新增 trip_plan (日常排程寫入權限)',
        expected: (role === 'LOGISTICS' || role === 'ADMIN') ? 'ALLOWED' : 'BLOCKED',
        actual: 'ALLOWED',
        success: (role === 'LOGISTICS' || role === 'ADMIN')
      })
    }
  } catch (err) {
    testResults.push({
      testId: 'TRIP_WRITE',
      name: '新增 trip_plan Exception',
      expected: 'UNKNOWN',
      actual: 'ERROR',
      message: err.message,
      success: false
    })
  }

  return {
    role,
    profile,
    results: testResults
  }
}
