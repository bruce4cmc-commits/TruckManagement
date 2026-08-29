import { supabase } from '../config/supabase.js'

/**
 * Create a new Trip plan
 */
export async function createTrip({ planDate, planDeparture, truckId, driverId, planType = 'NORMAL', forceSave = false }) {
  const { data, error } = await supabase.rpc('create_trip', {
    p_plan_date: planDate,
    p_plan_departure: planDeparture,
    p_truck_id: truckId,
    p_driver_id: driverId || null,
    p_plan_type: planType,
    p_force_save: forceSave
  })

  if (error) throw new Error(`建立 Trip 失敗: ${error.message}`)
  return data
}

/**
 * Update an existing Trip
 */
export async function updateTrip({ tripId, planDeparture, truckId, driverId, forceSave = false }) {
  const { data, error } = await supabase.rpc('update_trip', {
    p_trip_id: tripId,
    p_plan_departure: planDeparture || null,
    p_truck_id: truckId || null,
    p_driver_id: driverId || null,
    p_force_save: forceSave
  })

  if (error) throw new Error(`修改 Trip 失敗: ${error.message}`)
  return data
}

/**
 * Add Extra Trip (ADDED)
 */
export async function addExtraTrip({ planDate, planDeparture, truckId, driverId, addReason, forceSave = false }) {
  const { data, error } = await supabase.rpc('add_extra_trip', {
    p_plan_date: planDate,
    p_plan_departure: planDeparture,
    p_truck_id: truckId,
    p_driver_id: driverId || null,
    p_add_reason: addReason,
    p_force_save: forceSave
  })

  if (error) throw new Error(`追加 Trip 失敗: ${error.message}`)
  return data
}

/**
 * Cancel an unstarted Trip
 */
export async function cancelTrip({ tripId, cancelReason }) {
  const { data, error } = await supabase.rpc('cancel_trip', {
    p_trip_id: tripId,
    p_cancel_reason: cancelReason
  })

  if (error) throw new Error(`取消 Trip 失敗: ${error.message}`)
  return data
}

/**
 * Copy Previous Week's Plan to Target Week
 */
export async function copyWeek({ sourceWeekStart, targetWeekStart }) {
  const { data, error } = await supabase.rpc('copy_week', {
    p_source_week_start: sourceWeekStart,
    p_target_week_start: targetWeekStart
  })

  if (error) throw new Error(`複製週計畫失敗: ${error.message}`)
  return data
}

/**
 * Auto Assign Trucks Interleaving
 */
export async function autoAssignTrucks({ planDate }) {
  const { data, error } = await supabase.rpc('auto_assign_trucks', {
    p_plan_date: planDate
  })

  if (error) throw new Error(`自動排車失敗: ${error.message}`)
  return data
}

/**
 * Manual Add Event (補正漏掃)
 */
export async function manualAddTripEvent({ tripId, eventCode, eventTime }) {
  const { data, error } = await supabase.rpc('manual_add_trip_event', {
    p_trip_id: tripId,
    p_event_code: eventCode,
    p_event_time: eventTime
  })

  if (error) throw new Error(`人工補正失敗: ${error.message}`)
  return data
}

/**
 * Correct Existing Event Time (更正 Event)
 */
export async function correctTripEvent({ originalEventId, newEventTime }) {
  const { data, error } = await supabase.rpc('correct_trip_event', {
    p_original_event_id: originalEventId,
    p_new_event_time: newEventTime
  })

  if (error) throw new Error(`更正 Event 失敗: ${error.message}`)
  return data
}

/**
 * Query Unified Effective Events View for a Trip
 */
export async function getEffectiveTripEvents(tripId) {
  let query = supabase.from('effective_trip_events').select('*')
  if (tripId) {
    query = query.eq('trip_id', tripId)
  }
  const { data, error } = await query
  if (error) throw new Error(`無法讀取 Effective Events: ${error.message}`)
  return data
}

/**
 * Fetch Today's Vehicle Status for Logistics Dashboard UI
 */
export async function getLogisticsTodayStatus() {
  const { data: trucks, error: tErr } = await supabase.from('truck_master').select('*').order('sort_order')
  if (tErr) throw tErr

  const { data: statuses, error: sErr } = await supabase.from('trip_status').select('*')
  if (sErr) throw sErr

  const { data: plans, error: pErr } = await supabase.from('trip_plan').select('*').eq('plan_date', new Date().toISOString().split('T')[0]).order('trip_no')
  if (pErr) throw pErr

  return { trucks, statuses, plans }
}

/**
 * Fetch Weekly Trip Plan (Monday to Saturday)
 */
export async function getWeeklyTripPlan(weekStartDate) {
  const endDate = new Date(new Date(weekStartDate).getTime() + 5 * 86400000).toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('trip_plan')
    .select('*')
    .gte('plan_date', weekStartDate)
    .lte('plan_date', endDate)
    .order('plan_date', { ascending: true })
    .order('trip_no', { ascending: true })

  if (error) throw error
  return data
}
