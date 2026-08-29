import { supabase } from '../config/supabase.js'

/**
 * Fetch Aggregated Dashboard KPI
 */
export async function getDashboardKpi(periodType = 'DAY', referenceDate = new Date().toISOString().split('T')[0]) {
  const { data, error } = await supabase.rpc('get_dashboard_kpi', {
    p_period_type: periodType,
    p_reference_date: referenceDate
  })

  if (error) throw new Error(`讀取 KPI 失敗: ${error.message}`)
  return data
}

/**
 * Fetch KPI Trip Details
 */
export async function getKpiTripDetails(periodType = 'DAY', referenceDate = new Date().toISOString().split('T')[0]) {
  const { data, error } = await supabase.rpc('get_kpi_trip_details', {
    p_period_type: periodType,
    p_reference_date: referenceDate
  })

  if (error) throw new Error(`讀取 KPI 車趟明細失敗: ${error.message}`)
  return data
}
