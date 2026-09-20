// Helper to format ISO timestamptz with +08:00
function formatISO(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00+08:00`
}

function addMinutesToISO(isoStr, mins) {
  const dt = new Date(isoStr)
  dt.setMinutes(dt.getMinutes() + mins)
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(dt)
  const h = String(dt.getHours()).padStart(2, '0')
  const m = String(dt.getMinutes()).padStart(2, '0')
  return `${ymd}T${h}:${m}:00+08:00`
}

function getDates() {
  const dates = []
  let curr = new Date('2026-08-01T00:00:00+08:00')
  const end = new Date('2026-09-18T00:00:00+08:00')

  while (curr <= end) {
    const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(curr)
    const dayOfWeek = curr.getDay() // 0 = Sun
    dates.push({ ymd, isSunday: dayOfWeek === 0, dayOfWeek })
    curr.setDate(curr.getDate() + 1)
  }
  return dates
}

const dates = getDates()
const departureSlotTimes = [
  '07:00', '08:00', '09:00', '10:00', '11:00',
  '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'
]

export const tripPlans = []
export const tripEvents = []
export const exceptionLogs = []

let globalTripCounter = 0
let globalEventCounter = 0
let globalExceptionCounter = 0

dates.forEach((d) => {
  if (d.isSunday) return // Skip Sundays

  const dayNum = parseInt(d.ymd.split('-')[2], 10)
  const dailyTripCount = 8 + (dayNum % 3) // 8, 9, or 10

  for (let i = 1; i <= dailyTripCount; i++) {
    globalTripCounter++
    const tripNo = i
    const tripId = `KPI202608-${d.ymd.replace(/-/g, '')}-${String(tripNo).padStart(3, '0')}`
    
    const isT001 = tripNo % 2 === 1
    const truckId = isT001 ? 'T001' : 'T002'
    const driverId = isT001 ? 'D001' : 'D002'

    const slotTime = departureSlotTimes[(tripNo - 1) % departureSlotTimes.length]
    const planDeparture = formatISO(d.ymd, slotTime)

    let planType = 'NORMAL'
    let tripStatus = 'COMPLETE'
    let addReason = null
    let cancelReason = null

    // Deterministic CANCELLED Trips
    if (tripNo === 8 && [5, 12, 19, 26].includes(dayNum) && d.ymd.startsWith('2026-08')) {
      tripStatus = 'CANCELLED'
      cancelReason = '客戶臨時取消車趟'
    } else if (tripNo === 8 && [2, 9, 16].includes(dayNum) && d.ymd.startsWith('2026-09')) {
      tripStatus = 'CANCELLED'
      cancelReason = '系統測試定保取消'
    }

    // Deterministic ADDED Trips
    if (tripStatus !== 'CANCELLED' && tripNo === dailyTripCount && (d.dayOfWeek === 5 || d.dayOfWeek === 6)) {
      planType = 'ADDED'
      addReason = '17:00 臨時追加車趟'
    }

    tripPlans.push({
      trip_id: tripId,
      plan_date: d.ymd,
      trip_no: tripNo,
      plan_departure: planDeparture,
      truck_id: truckId,
      driver_id: driverId,
      plan_type: planType,
      trip_status: tripStatus,
      add_reason: addReason,
      cancel_reason: cancelReason,
      created_by: 'U001',
      created_at: planDeparture
    })

    if (tripStatus === 'CANCELLED') continue

    let depOffsetMin = 0
    let hcInDelay = 0
    let hcWhDelay = 0
    let hcOutDelay = 0
    let ymInDelay = 0
    let ymEngineDelay = 0
    let ymCabDelay = 0

    let isCorrectionCase = false
    let origDepOffsetMin = 0

    // Late Departures (~15% of trips)
    if (tripNo === 3 && (d.dayOfWeek === 1 || d.dayOfWeek === 3 || d.dayOfWeek === 5)) {
      depOffsetMin = 25 + (dayNum % 3) * 10
    }

    // Full Cycle Overtime (>140 min)
    if (tripNo === 5 && (d.dayOfWeek === 2 || d.dayOfWeek === 4)) {
      depOffsetMin += 30
    }

    // Correction Cases (9 trips)
    if (tripNo === 2 && (d.dayOfWeek === 3 || d.dayOfWeek === 6)) {
      isCorrectionCase = true
      origDepOffsetMin = 35
      depOffsetMin = 5
    }

    // Node Timeouts (+15 min standard + 20 min delay)
    if (tripNo === 4 && d.dayOfWeek === 1) hcInDelay = 20
    if (tripNo === 4 && d.dayOfWeek === 2) hcWhDelay = 20
    if (tripNo === 4 && d.dayOfWeek === 3) hcOutDelay = 20
    if (tripNo === 4 && d.dayOfWeek === 4) ymInDelay = 20
    if (tripNo === 4 && d.dayOfWeek === 5) ymCabDelay = 20

    const ymOutTime = addMinutesToISO(planDeparture, isCorrectionCase ? origDepOffsetMin : depOffsetMin)
    const hcInTime  = addMinutesToISO(ymOutTime, 30 + hcInDelay)
    const hcWhTime  = addMinutesToISO(hcInTime, 15 + hcWhDelay)
    const hcOutTime = addMinutesToISO(hcWhTime, 15 + hcOutDelay)
    const ymInTime  = addMinutesToISO(hcOutTime, 30 + ymInDelay)
    const ymEngTime = addMinutesToISO(ymInTime, 10 + ymEngineDelay)
    const ymCabTime = addMinutesToISO(ymEngTime, 10 + ymCabDelay)

    const eventList = [
      { code: 'YM_OUT', time: ymOutTime },
      { code: 'HC_IN', time: hcInTime },
      { code: 'HC_WH', time: hcWhTime },
      { code: 'HC_OUT', time: hcOutTime },
      { code: 'YM_IN', time: ymInTime },
      { code: 'YM_ENGINE', time: ymEngTime },
      { code: 'YM_CAB', time: ymCabTime }
    ]

    const baseEventIds = {}
    eventList.forEach(ev => {
      globalEventCounter++
      const eventId = `EV-KPI202608-${d.ymd.replace(/-/g, '')}-${String(tripNo).padStart(3, '0')}-${ev.code}`
      baseEventIds[ev.code] = eventId

      tripEvents.push({
        event_id: eventId,
        trip_id: tripId,
        truck_id: truckId,
        driver_id: driverId,
        event_code: ev.code,
        event_time: ev.time,
        scan_time: ev.time,
        report_type: 'QR',
        is_manual_correction: false,
        original_event_id: null,
        offline_flag: false,
        uploaded_at: ev.time,
        valid_flag: true,
        created_by: driverId
      })
    })

    if (isCorrectionCase) {
      globalEventCounter++
      const origEventId = baseEventIds['YM_OUT']
      const corrEventId = `EV-KPI202608-${d.ymd.replace(/-/g, '')}-${String(tripNo).padStart(3, '0')}-YMOUT-CORR`
      const correctedTime = addMinutesToISO(planDeparture, depOffsetMin)

      tripEvents.push({
        event_id: corrEventId,
        trip_id: tripId,
        truck_id: truckId,
        driver_id: driverId,
        event_code: 'YM_OUT',
        event_time: correctedTime,
        scan_time: correctedTime,
        report_type: 'MANUAL',
        is_manual_correction: true,
        original_event_id: origEventId,
        offline_flag: false,
        uploaded_at: addMinutesToISO(correctedTime, 1),
        valid_flag: true,
        created_by: 'U001'
      })
    }

    if (tripNo === 6) {
      let exType = null
      let exRemark = ''
      if (d.ymd === '2026-08-03' || d.ymd === '2026-08-17' || d.ymd === '2026-09-01') {
        exType = 'TRAFFIC_JAM'
        exRemark = '國道一號竹北段嚴重塞車'
      } else if (d.ymd === '2026-08-07' || d.ymd === '2026-08-21' || d.ymd === '2026-09-04') {
        exType = 'ACCIDENT'
        exRemark = '新竹廠區周邊事故塞車'
      } else if (d.ymd === '2026-08-11' || d.ymd === '2026-08-25' || d.ymd === '2026-09-08') {
        exType = 'TRUCK_FAILURE'
        exRemark = '車頭氣煞風管微漏氣檢修'
      } else if (d.ymd === '2026-08-14' || d.ymd === '2026-08-28' || d.ymd === '2026-09-11') {
        exType = 'OTHER'
        exRemark = '楊梅廠區門口交管等候'
      }

      if (exType) {
        globalExceptionCounter++
        exceptionLogs.push({
          exception_id: `EX-KPI202608-${d.ymd.replace(/-/g, '')}-${String(tripNo).padStart(3, '0')}`,
          trip_id: tripId,
          truck_id: truckId,
          driver_id: driverId,
          exception_type: exType,
          event_code: 'HC_IN',
          start_time: hcInTime,
          end_time: hcWhTime,
          duration_minutes: 20,
          status: 'CLOSED',
          remark: exRemark,
          reported_by: driverId,
          created_at: hcInTime
        })
      }
    }
  }
})
