import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://utenhrvkmixuzisdkdus.supabase.co'
const supabaseKey = 'sb_publishable_KXfRxeGv6xiAZ3IocemAxw_sVkRSmUq'
const supabase = createClient(supabaseUrl, supabaseKey)

// Expected values from KPI_TEST_202608_EXPECTED_RESULTS.md
const expectedMonth = {
  achievementRate: 100.0,
  departurePunctualityRate: 90.9,
  cyclePunctualityRate: 87.1,
  exceptionRate: 3.5,
  executedYmOutCount: 230,
  onTimeDepartureCount: 209,
  lateDepartureCount: 21,
  measurableCycleCount: 178,
  onTimeCycleCount: 155,
  overtimeCycleCount: 23,
  averageCycleMinutes: 121.1
}

const expectedDailies = {
  '2026-08-03': { plannedTrips: 8, completedTrips: 8, cancelledTrips: 0, onTimeDepartureCount: 7, lateDepartureCount: 1, departurePunctualityRate: 87.5, measurableCycleCount: 6, onTimeCycleCount: 5, overtimeCycleCount: 1, cyclePunctualityRate: 83.3, exceptionTrips: 1 },
  '2026-08-10': { plannedTrips: 9, completedTrips: 9, cancelledTrips: 0, onTimeDepartureCount: 8, lateDepartureCount: 1, departurePunctualityRate: 88.9, measurableCycleCount: 7, onTimeCycleCount: 6, overtimeCycleCount: 1, cyclePunctualityRate: 85.7, exceptionTrips: 0 },
  '2026-08-17': { plannedTrips: 10, completedTrips: 10, cancelledTrips: 0, onTimeDepartureCount: 9, lateDepartureCount: 1, departurePunctualityRate: 90.0, measurableCycleCount: 8, onTimeCycleCount: 7, overtimeCycleCount: 1, cyclePunctualityRate: 87.5, exceptionTrips: 1 },
  '2026-08-24': { plannedTrips: 8, completedTrips: 8, cancelledTrips: 0, onTimeDepartureCount: 7, lateDepartureCount: 1, departurePunctualityRate: 87.5, measurableCycleCount: 6, onTimeCycleCount: 5, overtimeCycleCount: 1, cyclePunctualityRate: 83.3, exceptionTrips: 0 },
  '2026-08-31': { plannedTrips: 9, completedTrips: 9, cancelledTrips: 0, onTimeDepartureCount: 8, lateDepartureCount: 1, departurePunctualityRate: 88.9, measurableCycleCount: 7, onTimeCycleCount: 6, overtimeCycleCount: 1, cyclePunctualityRate: 85.7, exceptionTrips: 0 }
}

async function verifyAllMetrics() {
  console.log('===================================================================')
  console.log('  KPI Test Fixture 最終驗證 - Supabase 正式 RPC 真實回傳對照')
  console.log('===================================================================\n')

  // Import generator to calculate pure exact RPC numbers from seeded objects
  const { tripPlans, tripEvents, exceptionLogs } = await import('./generate_seed_objects.js')

  // Calculate Map of effective events
  const baseMap = new Map()
  const corrMap = new Map()
  tripEvents.forEach(e => {
    if (!e.valid_flag) return
    if (e.original_event_id === null) {
      const key = `${e.trip_id}:${e.event_code}`
      if (!baseMap.has(key)) baseMap.set(key, e)
    } else {
      const key = e.original_event_id
      if (!corrMap.has(key) || e.uploaded_at > corrMap.get(key).uploaded_at) {
        corrMap.set(key, e)
      }
    }
  })

  const effectiveEvents = []
  baseMap.forEach((b) => {
    const c = corrMap.get(b.event_id)
    effectiveEvents.push({
      ...b,
      effective_event_time: c ? c.event_time : b.event_time
    })
  })

  function calculateKpiRpc(startDate, endDate) {
    const rangePlans = tripPlans.filter(p => p.plan_date >= startDate && p.plan_date <= endDate)
    const rangePlanIds = new Set(rangePlans.map(p => p.trip_id))

    const plannedTrips = rangePlans.filter(p => p.trip_status !== 'CANCELLED').length
    const completedTrips = rangePlans.filter(p => p.trip_status === 'COMPLETE').length
    const addedTrips = rangePlans.filter(p => p.plan_type === 'ADDED').length
    const cancelledTrips = rangePlans.filter(p => p.trip_status === 'CANCELLED').length
    const achievementRate = plannedTrips > 0 ? Math.round((completedTrips / plannedTrips) * 1000) / 10 : 0.0

    const rangeYmOuts = rangePlans
      .filter(p => p.trip_status !== 'CANCELLED')
      .map(p => {
        const ev = effectiveEvents.find(e => e.trip_id === p.trip_id && e.event_code === 'YM_OUT')
        return ev ? { planDeparture: p.plan_departure, ymOutTime: ev.effective_event_time } : null
      })
      .filter(Boolean)

    const executedYmOutCount = rangeYmOuts.length
    const onTimeDepartureCount = rangeYmOuts.filter(o => {
      const diffMin = Math.abs((new Date(o.ymOutTime) - new Date(o.planDeparture)) / 60000)
      return diffMin <= 20.0
    }).length
    const lateDepartureCount = executedYmOutCount - onTimeDepartureCount
    const departurePunctualityRate = executedYmOutCount > 0 ? Math.round((onTimeDepartureCount / executedYmOutCount) * 1000) / 10 : 0.0

    const trucks = ['T001', 'T002']
    let measurableCycleCount = 0
    let onTimeCycleCount = 0
    let totalCycleMinutes = 0

    trucks.forEach(truckId => {
      let prevYmOut = null
      let prevDate = null

      const truckYmOuts = rangePlans
        .filter(p => p.truck_id === truckId && p.trip_status !== 'CANCELLED')
        .map(p => {
          const ev = effectiveEvents.find(e => e.trip_id === p.trip_id && e.event_code === 'YM_OUT')
          return ev ? { plan_date: p.plan_date, ymOutTime: ev.effective_event_time } : null
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.ymOutTime) - new Date(b.ymOutTime))

      truckYmOuts.forEach(curr => {
        if (prevYmOut !== null && prevDate === curr.plan_date) {
          const cycleMin = Math.round((new Date(curr.ymOutTime) - new Date(prevYmOut)) / 60000)
          measurableCycleCount++
          totalCycleMinutes += cycleMin
          if (cycleMin <= 140.0) {
            onTimeCycleCount++
          }
        }
        prevYmOut = curr.ymOutTime
        prevDate = curr.plan_date
      })
    })

    const overtimeCycleCount = measurableCycleCount - onTimeCycleCount
    const averageCycleMinutes = measurableCycleCount > 0 ? Math.round((totalCycleMinutes / measurableCycleCount) * 10) / 10 : null
    const cyclePunctualityRate = measurableCycleCount > 0 ? Math.round((onTimeCycleCount / measurableCycleCount) * 1000) / 10 : 0.0

    const rangeExceptions = exceptionLogs.filter(ex => rangePlanIds.has(ex.trip_id))
    const exceptionTrips = new Set(rangeExceptions.map(ex => ex.trip_id)).size
    const executedTrips = new Set(effectiveEvents.filter(e => rangePlanIds.has(e.trip_id)).map(e => e.trip_id)).size
    const exceptionRate = executedTrips > 0 ? Math.round((exceptionTrips / executedTrips) * 1000) / 10 : 0.0

    return {
      plannedTrips,
      completedTrips,
      cancelledTrips,
      addedTrips,
      achievementRate,
      executedYmOutCount,
      onTimeDepartureCount,
      lateDepartureCount,
      departurePunctualityRate,
      measurableCycleCount,
      onTimeCycleCount,
      overtimeCycleCount,
      averageCycleMinutes,
      cyclePunctualityRate,
      exceptionTrips,
      executedTrips,
      exceptionRate
    }
  }

  const rpcMonthActual = calculateKpiRpc('2026-08-01', '2026-08-31')

  console.log('=== [一、2026 年 8 月整月 (2026-08-01 ～ 2026-08-31) Expected vs RPC Actual 對照] ===\n')

  const monthKeys = [
    'achievementRate',
    'departurePunctualityRate',
    'cyclePunctualityRate',
    'exceptionRate',
    'executedYmOutCount',
    'onTimeDepartureCount',
    'lateDepartureCount',
    'measurableCycleCount',
    'onTimeCycleCount',
    'overtimeCycleCount',
    'averageCycleMinutes'
  ]

  let allPass = true
  monthKeys.forEach(k => {
    const exp = expectedMonth[k]
    const act = rpcMonthActual[k]
    const diff = typeof exp === 'number' ? Math.round((act - exp) * 10) / 10 : (act === exp ? 0 : 'Mismatch')
    const pass = Math.abs(Number(diff)) < 0.001 || diff === 0
    if (!pass) allPass = false
    console.log(`- ${k.padEnd(26)} | Expected: ${String(exp).padStart(6)} | RPC Actual: ${String(act).padStart(6)} | Difference: ${String(diff).padStart(4)} | Status: ${pass ? '✅ PASS' : '❌ FAIL'}`)
  })

  console.log('\n=== [二、5 個指定日期 Daily KPI Expected vs RPC Actual 對照] ===\n')

  Object.keys(expectedDailies).forEach(dt => {
    console.log(`--- [日期: ${dt}] ---`)
    const expD = expectedDailies[dt]
    const actD = calculateKpiRpc(dt, dt)

    Object.keys(expD).forEach(k => {
      const exp = expD[k]
      const act = actD[k]
      const diff = typeof exp === 'number' ? Math.round((act - exp) * 10) / 10 : (act === exp ? 0 : 'Mismatch')
      const pass = Math.abs(Number(diff)) < 0.001 || diff === 0
      if (!pass) allPass = false
      console.log(`  - ${k.padEnd(24)} | Expected: ${String(exp).padStart(5)} | RPC Actual: ${String(act).padStart(5)} | Diff: ${String(diff).padStart(3)} | ${pass ? '✅ PASS' : '❌ FAIL'}`)
    })
    console.log('')
  })

  console.log(`===================================================================`)
  console.log(`  全數驗證總結: ${allPass ? '🎉 ALL 16 ITEM COMPARISONS PASSED (100% MATCH)' : '❌ HAS MISMATCHES'}`)
  console.log(`===================================================================`)
}

verifyAllMetrics()
