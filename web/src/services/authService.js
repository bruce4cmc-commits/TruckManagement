import { supabase } from '../config/supabase.js'

let currentUserProfile = null
let currentSession = null

/**
 * Maps Driver ID or Truck ID to internal Auth Email format
 * Example: D001 -> d001@truckmgmt.com
 */
export function getDriverInternalEmail(driverIdOrTruckId) {
  const cleanId = String(driverIdOrTruckId).trim().toLowerCase()
  return `${cleanId}@truckmgmt.com`
}

/**
 * Maps Management Login Name to internal Auth Email format
 * Example: logistics01 -> logistics01@truckmgmt.com
 */
export function getManagementInternalEmail(loginName) {
  const cleanName = String(loginName).trim().toLowerCase()
  if (cleanName.includes('@')) {
    return cleanName
  }
  return `${cleanName}@truckmgmt.com`
}

/**
 * Get current Auth Session
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) {
    console.error('Failed to fetch Auth Session:', error.message)
    return null
  }
  currentSession = data.session
  return currentSession
}

/**
 * Fetch detailed user profile according to auth.uid()
 * Checks user_master first (LOGISTICS/SUPERVISOR/ADMIN), then driver_master (DRIVER)
 */
export async function getCurrentUserProfile() {
  const session = await getSession()
  if (!session || !session.user) {
    currentUserProfile = null
    return null
  }

  const authUserId = session.user.id

  // 1. Check user_master (Management users)
  const { data: userData, error: userErr } = await supabase
    .from('user_master')
    .select('user_id, user_name, login_name, role, active, auth_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle()

  if (userErr) {
    console.error('user_master profile query failed:', userErr.message)
    throw userErr
  }

  if (userData) {
    currentUserProfile = {
      type: 'MANAGEMENT',
      id: userData.user_id,
      name: userData.user_name,
      loginName: userData.login_name,
      role: userData.role, // LOGISTICS, SUPERVISOR, ADMIN
      active: userData.active,
      authUserId: userData.auth_user_id,
      rawUser: session.user
    }
    return currentUserProfile
  }

  // 2. Check driver_master (Driver users)
  const { data: driverData, error: driverErr } = await supabase
    .from('driver_master')
    .select('driver_id, driver_name, default_truck_id, active, auth_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle()

  if (driverErr) {
    console.error('driver_master profile query failed:', driverErr.message)
    throw driverErr
  }

  if (driverData) {
    currentUserProfile = {
      type: 'DRIVER',
      id: driverData.driver_id,
      name: driverData.driver_name,
      defaultTruckId: driverData.default_truck_id,
      role: 'DRIVER',
      active: driverData.active,
      authUserId: driverData.auth_user_id,
      rawUser: session.user
    }
    return currentUserProfile
  }

  // Auth user exists in auth.users, but not yet linked in master tables
  currentUserProfile = {
    type: 'UNLINKED',
    id: null,
    name: session.user.email,
    role: 'UNKNOWN',
    authUserId,
    rawUser: session.user
  }

  return currentUserProfile
}

/**
 * Driver Login (Truck No / Driver ID + Password)
 * UI receives Truck No / Truck ID, maps internally to email, signs in via Supabase Auth
 */
export async function loginDriver(driverId, password) {
  const internalEmail = getDriverInternalEmail(driverId)

  console.log('[DEBUG DRIVER LOGIN] selected truck value:', driverId)
  console.log('[DEBUG DRIVER LOGIN] mapped email:', internalEmail)

  const { data, error } = await supabase.auth.signInWithPassword({
    email: internalEmail,
    password
  })

  if (error) {
    console.log('[DEBUG DRIVER LOGIN] Supabase Auth 是否成功: false')
    console.log('[DEBUG DRIVER LOGIN] error.message:', error.message)
    throw new Error(`司機登入失敗：${error.message === 'Invalid login credentials' ? '車號或密碼錯誤' : error.message}`)
  }

  console.log('[DEBUG DRIVER LOGIN] Supabase Auth 是否成功: true')
  console.log('[DEBUG DRIVER LOGIN] session.user.id:', data.session.user.id)

  currentSession = data.session
  const profile = await getCurrentUserProfile()
  console.log('[DEBUG DRIVER LOGIN] driver profile lookup 結果:', {
    type: profile ? profile.type : null,
    id: profile ? profile.id : null,
    name: profile ? profile.name : null,
    role: profile ? profile.role : null,
    defaultTruckId: profile ? profile.defaultTruckId : null,
    authUserId: profile ? profile.authUserId : null
  })

  return { session: data.session, profile }
}

/**
 * Management Login (Login Name + Password)
 */
export async function loginManagement(loginName, password) {
  const internalEmail = getManagementInternalEmail(loginName)

  const { data, error } = await supabase.auth.signInWithPassword({
    email: internalEmail,
    password
  })

  if (error) {
    throw new Error(`管理端登入失敗：${error.message === 'Invalid login credentials' ? '帳號或密碼錯誤' : error.message}`)
  }

  currentSession = data.session
  const profile = await getCurrentUserProfile()
  return { session: data.session, profile }
}

/**
 * Logout user
 */
export async function logout() {
  const { error } = await supabase.auth.signOut()
  if (error) {
    throw error
  }
  currentUserProfile = null
  currentSession = null
}

/**
 * Listen to Auth State Changes
 */
export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(async (event, session) => {
    currentSession = session
    if (session) {
      await getCurrentUserProfile()
    } else {
      currentUserProfile = null
    }
    if (callback) {
      callback(event, session, currentUserProfile)
    }
  })
}

/**
 * Placeholder for Admin Password Reset
 * Spec requirement: UI placeholder only, actual implementation deferred to Supabase Edge Function
 */
export async function resetUserPasswordByAdmin(targetUserId, newPassword) {
  throw new Error('本功能在現階段僅保留介面設計，後續將透過 Supabase Edge Function 實作（避免在前端暴露 Secret Key）。')
}
