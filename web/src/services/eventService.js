import { supabase } from '../config/supabase.js'

const OFFLINE_STORAGE_KEY = 'truck_mgmt_offline_events_v12'

/**
 * Seven Legal Event Codes mapping
 */
export const EVENT_CODES = {
  YM_OUT: { code: 'YM_OUT', name: '楊梅出廠', next: 'HC_IN' },
  HC_IN: { code: 'HC_IN', name: '新竹入廠', next: 'HC_WH' },
  HC_WH: { code: 'HC_WH', name: '新竹車頭庫房', next: 'HC_OUT' },
  HC_OUT: { code: 'HC_OUT', name: '新竹出廠', next: 'YM_IN' },
  YM_IN: { code: 'YM_IN', name: '楊梅入廠', next: 'YM_ENGINE' },
  YM_ENGINE: { code: 'YM_ENGINE', name: '楊梅卸引擎', next: 'YM_CAB' },
  YM_CAB: { code: 'YM_CAB', name: '楊梅裝車頭', next: 'YM_OUT' }
}

/**
 * Standardized Error Codes Map
 */
export const ERROR_CODES = {
  AUTH_003: '未登入或 Session 已失效',
  AUTH_004: '當前使用者非有效司機身分',
  TRIP_001: '找不到目前 Trip (尚未建立今日車趟計畫)',
  EVENT_001: '無效的 QR Code 作業節點代碼',
  EVENT_002: '重複掃描：100分鐘內已記錄相同節點',
  EVENT_003: '掃描節點與預期不一致',
  EVENT_004: 'Event 紀錄不存在',
  EVENT_005: '該節點已有有效紀錄 (如需修正時間請使用 Event 更正功能)'
}

/**
 * Scan QR Code Event via scan_trip_event RPC (with client_event_id idempotency)
 */
export async function scanEvent(
  eventCode,
  scanTime = new Date().toISOString(),
  offlineFlag = false,
  clientEventId = crypto.randomUUID()
) {
  // Validate if eventCode is valid
  if (!EVENT_CODES[eventCode]) {
    return {
      success: false,
      errorCode: 'EVENT_001',
      message: ERROR_CODES.EVENT_001
    }
  }

  // Check network connectivity for offline mode
  if (!navigator.onLine || offlineFlag) {
    saveOfflineEvent({ eventCode, scanTime, offlineFlag: true, clientEventId })
    return {
      success: true,
      offline: true,
      clientEventId,
      message: '已暫存於離線隊列，待連線恢復後自動補傳',
      data: { eventCode, eventTime: scanTime, offlineFlag: true, clientEventId }
    }
  }

  const { data, error } = await supabase.rpc('scan_trip_event', {
    p_event_code: eventCode,
    p_scan_time: scanTime,
    p_offline_flag: false,
    p_force_accept: false,
    p_client_event_id: clientEventId
  })

  if (error) {
    throw new Error(`RPC 執行失敗: ${error.message}`)
  }

  return data
}

/**
 * Force Confirm Out-Of-Sequence Event (p_force_accept = true)
 */
export async function confirmOutOfSequenceEvent(
  eventCode,
  scanTime = new Date().toISOString(),
  offlineFlag = false,
  clientEventId = crypto.randomUUID()
) {
  const { data, error } = await supabase.rpc('scan_trip_event', {
    p_event_code: eventCode,
    p_scan_time: scanTime,
    p_offline_flag: offlineFlag,
    p_force_accept: true,
    p_client_event_id: clientEventId
  })

  if (error) {
    throw new Error(`RPC 執行失敗: ${error.message}`)
  }

  return data
}

/**
 * Offline Storage Helpers (localStorage / IndexedDB interface)
 */
export function getOfflineQueue() {
  try {
    const raw = localStorage.getItem(OFFLINE_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch (err) {
    console.error('Failed to read offline queue:', err)
    return []
  }
}

export function saveOfflineEvent(eventObj) {
  const queue = getOfflineQueue()
  // Ensure same clientEventId is preserved across retries
  if (!eventObj.clientEventId) {
    eventObj.clientEventId = crypto.randomUUID()
  }
  queue.push({
    ...eventObj,
    createdAt: new Date().toISOString()
  })
  localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(queue))
}

export async function syncOfflineEvents() {
  const queue = getOfflineQueue()
  if (queue.length === 0) return { synced: 0, failed: 0, remainingCount: 0 }

  let synced = 0
  let failed = 0
  const remaining = []

  for (const item of queue) {
    try {
      const res = await confirmOutOfSequenceEvent(
        item.eventCode,
        item.scanTime,
        true,
        item.clientEventId
      )

      if (res && (res.success || res.alreadyProcessed)) {
        synced++
      } else {
        failed++
        remaining.push(item)
      }
    } catch (err) {
      failed++
      remaining.push(item)
    }
  }

  localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(remaining))
  return { synced, failed, remainingCount: remaining.length }
}
