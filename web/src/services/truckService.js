import { supabase } from '../config/supabase.js'

/**
 * Fetch all active trucks for public login dropdown via get_public_active_trucks RPC.
 * Returns strictly 4 public fields: truck_id, truck_no, truck_name, sort_order.
 * Excludes sensitive management fields like default_driver_id.
 */
export async function getActiveTrucks() {
  const { data, error } = await supabase.rpc('get_public_active_trucks')

  if (error) {
    console.warn('get_public_active_trucks RPC call failed:', error.message)
    throw new Error(`無法載入車輛選單 (${error.message})。請確認是否已在 Supabase 執行 sql/05_Supabase_Security_Fix_V1.2.sql。`)
  }

  return data
}

/**
 * Basic Supabase Connection & Schema Health Check
 */
export async function testSupabaseConnection() {
  const startTime = Date.now()
  try {
    const trucks = await getActiveTrucks()
    const latencyMs = Date.now() - startTime
    return {
      success: true,
      latencyMs,
      count: trucks ? trucks.length : 0,
      data: trucks
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || JSON.stringify(err),
      details: err
    }
  }
}