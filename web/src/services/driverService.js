import { supabase } from '../config/supabase.js'

/**
 * Fetch Driver Home Data via get_driver_home RPC
 */
export async function getDriverHome() {
  const { data, error } = await supabase.rpc('get_driver_home')

  if (error) {
    console.error('get_driver_home RPC failed:', error.message)
    throw new Error(`無法載入司機首頁資料: ${error.message}`)
  }

  if (!data || !data.success) {
    throw new Error(data ? data.message : '取得司機首頁資料失敗')
  }

  return data.data
}

/**
 * Fetch Today's Tasks
 */
export async function getTodayTasks() {
  const homeData = await getDriverHome()
  return homeData.todayTasks || []
}
