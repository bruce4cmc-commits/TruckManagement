import './style.css'
import { supabase } from './config/supabase.js'
import { getActiveTrucks } from './services/truckService.js'
import {
  loginDriver,
  loginManagement,
  logout,
  getCurrentUserProfile,
  onAuthStateChange
} from './services/authService.js'
import { getDriverHome } from './services/driverService.js'
import { scanEvent, confirmOutOfSequenceEvent, EVENT_CODES } from './services/eventService.js'
import {
  createTrip,
  updateTrip,
  addExtraTrip,
  cancelTrip,
  copyWeek,
  autoAssignTrucks,
  manualAddTripEvent,
  correctTripEvent,
  getLogisticsTodayStatus,
  getWeeklyTripPlan,
  getEffectiveTripEvents
} from './services/logisticsService.js'
import { getDashboardKpi, getKpiTripDetails } from './services/kpiService.js'

const app = document.querySelector('#app')

// Base App Shell
app.innerHTML = `
  <div class="container">
    <header class="header">
      <div class="badge-phase">卡車管理系統 V1.2 - 上線整合驗證版</div>
      <h1>楊梅廠－新竹廠卡車循環運輸管理系統 V1.2</h1>
      <p class="subtitle">Supabase Realtime 訂閱、相機 QR Code 掃描、離線隊列與全功能整合</p>
    </header>

    <main class="main-content">
      <!-- Session Banner -->
      <section class="card shadow" id="identity-section">
        <div class="card-header">
          <h2>系統登入身分與權限</h2>
          <div id="session-actions"></div>
        </div>
        <div id="identity-display" class="identity-box">
          <div class="spinner"></div>
          <span>載入 Session 中...</span>
        </div>
      </section>

      <!-- SUPERVISOR DASHBOARD UI -->
      <section class="card shadow" id="supervisor-dashboard-section" style="display: none;">
        <div class="dashboard-header">
          <h2>主管端 KPI 監控看板 (Supervisor Dashboard) <span id="realtime-status-badge" class="badge badge-role-driver">🟢 Realtime 訂閱中</span></h2>
          <div class="period-selector">
            <button class="btn btn-outline period-btn active" data-period="DAY">今日</button>
            <button class="btn btn-outline period-btn" data-period="WEEK">本週</button>
            <button class="btn btn-outline period-btn" data-period="MONTH">本月</button>
          </div>
        </div>

        <div id="kpi-cards-container" class="kpi-grid"><div class="spinner"></div><span>計算 KPI 中...</span></div>

        <div class="dashboard-section margin-top">
          <h3>車輛即時車況與 7 節點橫式流程進度</h3>
          <div id="workflow-progress-container" class="workflow-container"><div class="spinner"></div><span>載入流程進度中...</span></div>
        </div>

        <div class="dashboard-section margin-top">
          <h3>車趟排程計畫與執行實績 (Read-Only)</h3>
          <div id="kpi-table-container"></div>
        </div>

        <div class="dashboard-section margin-top">
          <h3>管理趨勢圖與統計分析</h3>
          <div class="charts-grid">
            <div class="chart-card"><h4>1. Cycle Time 趨勢與標準區間 (分鐘)</h4><div class="chart-body" id="chart-cycle-time"></div></div>
            <div class="chart-card"><h4>2. 趟次達成率 (%)</h4><div class="chart-body" id="chart-achievement"></div></div>
            <div class="chart-card"><h4>3. 楊梅出發準時率 (%)</h4><div class="chart-body" id="chart-departure"></div></div>
            <div class="chart-card"><h4>4. 異常車趟統計</h4><div class="chart-body" id="chart-exception"></div></div>
          </div>
        </div>
      </section>

      <!-- DRIVER HOME UI -->
      <section class="card shadow" id="driver-home-section" style="display: none;">
        <div id="driver-home-content"></div>
      </section>

      <!-- LOGISTICS MANAGEMENT UI -->
      <section class="card shadow" id="logistics-home-section" style="display: none;">
        <div class="tab-buttons">
          <button class="tab-btn active" data-tab="logistics-today">今日車況監控</button>
          <button class="tab-btn" data-tab="logistics-weekly">週間車趟計畫管理</button>
        </div>
        <div id="logistics-today-tab" class="tab-content active"><div id="logistics-today-content"></div></div>
        <div id="logistics-weekly-tab" class="tab-content">
          <div class="logistics-toolbar">
            <button id="btn-open-create-trip" class="btn btn-primary">＋新增 Trip</button>
            <button id="btn-open-add-extra" class="btn btn-outline">＋臨時追加 Trip</button>
            <button id="btn-auto-assign" class="btn btn-secondary">自動排車 (交錯排程)</button>
            <button id="btn-copy-week" class="btn btn-outline">複製上週計畫</button>
          </div>
          <div id="weekly-plan-content"></div>
        </div>
      </section>

      <!-- LOGIN FORMS -->
      <section class="card shadow" id="login-section">
        <div class="tab-buttons">
          <button class="tab-btn active" data-tab="driver-login">司機端登入 (車號 + 密碼)</button>
          <button class="tab-btn" data-tab="mgmt-login">物流管理 / 主管登入</button>
        </div>
        <form id="driver-login-form" class="tab-content active">
          <div class="form-group"><label for="driver-truck-select">選擇車號</label><select id="driver-truck-select" class="form-control" required></select></div>
          <div class="form-group"><label for="driver-password">密碼</label><input type="password" id="driver-password" class="form-control" placeholder="請輸入密碼" required /></div>
          <button type="submit" class="btn btn-primary btn-block">司機登入</button>
        </form>
        <form id="mgmt-login-form" class="tab-content">
          <div class="form-group"><label for="mgmt-login-name">帳號</label><input type="text" id="mgmt-login-name" class="form-control" placeholder="例: supervisor01 或 logistics01" required /></div>
          <div class="form-group"><label for="mgmt-password">密碼</label><input type="password" id="mgmt-password" class="form-control" placeholder="請輸入密碼" required /></div>
          <button type="submit" class="btn btn-primary btn-block">管理端登入</button>
        </form>
      </section>

      <!-- RLS & Security Tester Runner -->
      <section class="card shadow">
        <div class="card-header">
          <h2>PostgreSQL RLS & RPC 安全性測試</h2>
          <button id="run-rls-btn" class="btn btn-secondary">執行安全性矩陣測試</button>
        </div>
        <div id="rls-matrix-container"><p class="placeholder-text">點擊執行檢測。</p></div>
      </section>
    </main>

    <!-- QR SCANNER MODAL (Camera + Fallback Buttons) -->
    <div id="qr-modal" class="modal-backdrop">
      <div class="modal-content">
        <div class="modal-header">
          <h3>掃描作業節點 QR Code</h3>
          <button id="close-qr-modal" class="modal-close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <div class="qr-camera-prototype">
            <video id="qr-video" style="width: 100%; border-radius: 8px;" autoplay playsinline></video>
            <div id="camera-status-text" class="placeholder-text margin-top">點擊「啟動手機鏡頭」開啟相機掃碼</div>
          </div>
          <button id="btn-start-camera" class="btn btn-secondary btn-block margin-top">啟動手機鏡頭 (Camera API)</button>
          
          <div class="form-group margin-top">
            <label for="manual-qr-input">模擬 / 手動輸入 QR 字串:</label>
            <div class="input-group">
              <input type="text" id="manual-qr-input" class="form-control" placeholder="例: YM_OUT" />
              <button id="scan-manual-btn" class="btn btn-primary">確認掃碼</button>
            </div>
          </div>

          <div class="qr-nodes-grid margin-top">
            <button class="qr-node-btn" data-code="YM_OUT">1. 楊梅出廠 (YM_OUT)</button>
            <button class="qr-node-btn" data-code="HC_IN">2. 新竹入廠 (HC_IN)</button>
            <button class="qr-node-btn" data-code="HC_WH">3. 新竹庫房 (HC_WH)</button>
            <button class="qr-node-btn" data-code="HC_OUT">4. 新竹出廠 (HC_OUT)</button>
            <button class="qr-node-btn" data-code="YM_IN">5. 楊梅入廠 (YM_IN)</button>
            <button class="qr-node-btn" data-code="YM_ENGINE">6. 楊梅卸引擎 (YM_ENGINE)</button>
            <button class="qr-node-btn" data-code="YM_CAB">7. 楊梅裝車頭 (YM_CAB)</button>
          </div>
          <div id="qr-scan-msg" class="msg-box margin-top"></div>
        </div>
      </div>
    </div>

    <!-- OUT OF SEQUENCE CONFIRMATION MODAL -->
    <div id="confirm-modal" class="modal-backdrop">
      <div class="modal-content warning-modal">
        <div class="modal-header">
          <h3>⚠ 作業提醒（掃錯 QR Code）</h3>
        </div>
        <div class="modal-body text-center">
          <p class="warning-text">掃描節點與系統預期不一致！</p>
          <div class="expected-vs-actual">
            <div class="compare-box"><span class="label">預期</span><strong id="expected-node-text" class="value text-success">-</strong></div>
            <div class="compare-arrow">➔</div>
            <div class="compare-box"><span class="label">實際</span><strong id="actual-node-text" class="value text-warning">-</strong></div>
          </div>
          <div class="modal-actions margin-top">
            <button id="cancel-out-seq-btn" class="btn btn-secondary">返回重新掃描</button>
            <button id="force-confirm-seq-btn" class="btn btn-primary">確認本次回報</button>
          </div>
        </div>
      </div>
    </div>

    <footer class="footer">
      <p>楊梅廠－新竹廠卡車循環運輸管理系統 V1.2 &copy; 2026</p>
    </footer>
  </div>
`

let currentProfile = null
let currentPeriod = 'DAY'
let pendingOutOfSeqCode = null
let mediaStream = null

// Realtime Subscription Setup
function setupRealtimeSubscription() {
  const badge = document.querySelector('#realtime-status-badge')
  const channel = supabase.channel('realtime_trip_status')

  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_status' }, () => {
      if (badge) badge.textContent = '🟢 Realtime 數據即時同步中'
      renderSupervisorDashboard()
      renderLogisticsToday()
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (badge) badge.textContent = '🟢 Realtime 訂閱中'
      } else {
        if (badge) badge.textContent = '🟡 Polling 模式 (Fallback 30s)'
      }
    })

  // 30 Seconds Polling Fallback
  setInterval(() => {
    if (currentProfile && currentProfile.role !== 'DRIVER') {
      renderSupervisorDashboard()
    }
  }, 30000)
}

// Render App
async function renderApp() {
  const identityDisplay = document.querySelector('#identity-display')
  const sessionActions = document.querySelector('#session-actions')
  const loginSection = document.querySelector('#login-section')
  const driverHomeSection = document.querySelector('#driver-home-section')
  const logisticsHomeSection = document.querySelector('#logistics-home-section')
  const supervisorDashboardSection = document.querySelector('#supervisor-dashboard-section')

  currentProfile = await getCurrentUserProfile()

  if (currentProfile) {
    loginSection.style.display = 'none'

    identityDisplay.innerHTML = `
      <div class="user-card">
        <span class="user-name">${currentProfile.name || currentProfile.loginName || currentProfile.id}</span>
        <span class="badge badge-role-${currentProfile.role.toLowerCase()}">${currentProfile.role}</span>
      </div>
    `
    sessionActions.innerHTML = `<button id="logout-btn" class="btn btn-danger">登出 Session</button>`
    document.querySelector('#logout-btn').addEventListener('click', async () => { await logout(); renderApp(); })

    if (currentProfile.role === 'DRIVER') {
      driverHomeSection.style.display = 'block'
      logisticsHomeSection.style.display = 'none'
      supervisorDashboardSection.style.display = 'none'
      renderDriverHome()
    } else if (currentProfile.role === 'SUPERVISOR') {
      driverHomeSection.style.display = 'none'
      logisticsHomeSection.style.display = 'none'
      supervisorDashboardSection.style.display = 'block'
      renderSupervisorDashboard()
    } else { // LOGISTICS / ADMIN
      driverHomeSection.style.display = 'none'
      logisticsHomeSection.style.display = 'block'
      supervisorDashboardSection.style.display = 'block'
      renderSupervisorDashboard()
      renderLogisticsToday()
      renderWeeklyPlan()
    }
  } else {
    loginSection.style.display = 'block'
    driverHomeSection.style.display = 'none'
    logisticsHomeSection.style.display = 'none'
    supervisorDashboardSection.style.display = 'none'
    identityDisplay.innerHTML = `<div class="status-box info">目前為未登入狀態 (anon)</div>`
    sessionActions.innerHTML = ''
  }
}

// Render Supervisor Dashboard
async function renderSupervisorDashboard() {
  const kpiContainer = document.querySelector('#kpi-cards-container')
  const workflowContainer = document.querySelector('#workflow-progress-container')
  const tableContainer = document.querySelector('#kpi-table-container')

  try {
    const kpiRes = await getDashboardKpi(currentPeriod)
    const kpi = kpiRes.data

    kpiContainer.innerHTML = `
      <div class="kpi-card"><span class="kpi-label">計畫 Trip 數</span><strong class="kpi-val">${kpi.plannedTrips}</strong><span class="kpi-sub">最終排程 (不含取消)</span></div>
      <div class="kpi-card"><span class="kpi-label">完成 Trip 數</span><strong class="kpi-val text-success">${kpi.completedTrips}</strong><span class="kpi-sub">7節點完成至 YM_CAB</span></div>
      <div class="kpi-card"><span class="kpi-label">Trip 達成率</span><strong class="kpi-val text-success">${kpi.achievementRate}%</strong><span class="kpi-sub">完成 / 計畫</span></div>
      <div class="kpi-card"><span class="kpi-label">楊梅出發準時率</span><strong class="kpi-val text-info">${kpi.departurePunctualityRate}%</strong><span class="kpi-sub">±20分鐘視為準時</span></div>
      <div class="kpi-card"><span class="kpi-label">平均 Cycle Time</span><strong class="kpi-val">${kpi.averageCycleMinutes !== null ? `${kpi.averageCycleMinutes} 分` : 'N/A'}</strong><span class="kpi-sub">標準 120 分鐘</span></div>
      <div class="kpi-card"><span class="kpi-label">Cycle 準時率</span><strong class="kpi-val text-info">${kpi.cyclePunctualityRate}%</strong><span class="kpi-sub">≤140分鐘視為準時</span></div>
      <div class="kpi-card"><span class="kpi-label">異常 Trip / 異常率</span><strong class="kpi-val text-warning">${kpi.exceptionTrips} / ${kpi.exceptionRate}%</strong><span class="kpi-sub">不含 QR 漏掃</span></div>
      <div class="kpi-card"><span class="kpi-label">追加 Trip 數</span><strong class="kpi-val">${kpi.addedTrips}</strong><span class="kpi-sub">ADDED 類型</span></div>
      <div class="kpi-card"><span class="kpi-label">取消 Trip 數</span><strong class="kpi-val text-muted">${kpi.cancelledTrips}</strong><span class="kpi-sub">CANCELLED 歷史保留</span></div>
    `

    const { trucks, statuses } = await getLogisticsTodayStatus()
    const effectiveEvents = await getEffectiveTripEvents()

    const workflowHtml = (trucks || []).map(t => {
      const status = (statuses || []).find(s => s.truck_id === t.truck_id) || {}
      const tEvents = (effectiveEvents || []).filter(e => e.truck_id === t.truck_id)
      const nodes = ['YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB']

      const nodeStepsHtml = nodes.map(code => {
        const evt = tEvents.find(e => e.event_code === code)
        let stateClass = 'node-pending'
        let icon = '○'
        if (evt) { stateClass = 'node-completed'; icon = '●'; }
        else if (code === status.next_event_code) { stateClass = 'node-current'; icon = '◉'; }

        const timeStr = evt ? new Date(evt.effective_event_time).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}) : '--:--'
        return `
          <div class="workflow-step ${stateClass}">
            <span class="step-icon">${icon}</span>
            <span class="step-code">${code}</span>
            <span class="step-time">${timeStr}</span>
          </div>
        `
      }).join('<span class="workflow-line"></span>')

      return `
        <div class="workflow-card">
          <div class="wf-truck-header">
            <strong>${t.truck_no} (${t.truck_name || t.truck_id})</strong>
            <span class="badge-tag">${status.current_status || 'WAITING'}</span>
          </div>
          <div class="workflow-steps">${nodeStepsHtml}</div>
        </div>
      `
    }).join('')

    workflowContainer.innerHTML = workflowHtml || '<p>目前無車輛流程</p>'

    const detailsRes = await getKpiTripDetails(currentPeriod)
    const details = detailsRes.data || []

    const tableRows = details.map(d => `
      <tr>
        <td><code>${d.planDate}</code></td>
        <td>第 ${d.tripNo} 趟 (<code>${d.tripId}</code>)</td>
        <td>${d.truckId}</td>
        <td>${new Date(d.planDeparture).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'})}</td>
        <td>${d.actualYmOut ? new Date(d.actualYmOut).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}) : '-'}</td>
        <td>${d.departureDifferenceMinutes !== null ? `${d.departureDifferenceMinutes > 0 ? '+' : ''}${d.departureDifferenceMinutes} 分` : '-'}</td>
        <td><span class="badge ${d.departureOnTime ? 'badge-role-driver' : 'badge-fail'}">${d.departureOnTime ? '準時' : '未準時'}</span></td>
        <td><span class="badge ${d.operationalComplete ? 'badge-role-driver' : 'badge-role-default'}">${d.status}</span></td>
      </tr>
    `).join('')

    tableContainer.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr><th>日期</th><th>趟次/ID</th><th>車輛</th><th>計畫出發</th><th>實際出發</th><th>時間差</th><th>判定</th><th>狀態</th></tr></thead>
          <tbody>${tableRows || '<tr><td colspan="8">無車趟明細</td></tr>'}</tbody>
        </table>
      </div>
    `
    renderCharts(kpi)
  } catch (err) {
    kpiContainer.innerHTML = `<div class="status-box error">❌ 讀取 KPI 失敗: ${err.message}</div>`
  }
}

function renderCharts(kpi) {
  document.querySelector('#chart-cycle-time').innerHTML = `
    <div class="bar-chart-mock">
      <div class="bar-item"><span class="bar-label">平均 Cycle</span><div class="bar-fill" style="width: ${Math.min(100, (kpi.averageCycleMinutes || 120) / 1.5)}%;"></div><span>${kpi.averageCycleMinutes || 120} 分</span></div>
      <div class="bar-item"><span class="bar-label">標準 Cycle</span><div class="bar-fill standard" style="width: 80%;"></div><span>120 分</span></div>
    </div>
  `
  document.querySelector('#chart-achievement').innerHTML = `
    <div class="bar-chart-mock">
      <div class="bar-item"><span class="bar-label">計畫 Trip</span><div class="bar-fill" style="width: 100%;"></div><span>${kpi.plannedTrips} 趟</span></div>
      <div class="bar-item"><span class="bar-label">完成 Trip</span><div class="bar-fill success" style="width: ${kpi.achievementRate}%;"></div><span>${kpi.completedTrips} 趟</span></div>
    </div>
  `
  document.querySelector('#chart-departure').innerHTML = `
    <div class="bar-chart-mock">
      <div class="bar-item"><span class="bar-label">出發準時率</span><div class="bar-fill info" style="width: ${kpi.departurePunctualityRate}%;"></div><span>${kpi.departurePunctualityRate}%</span></div>
    </div>
  `
  document.querySelector('#chart-exception').innerHTML = `
    <div class="bar-chart-mock">
      <div class="bar-item"><span class="bar-label">異常趟數</span><div class="bar-fill warning" style="width: ${Math.min(100, kpi.exceptionRate * 3)}%;"></div><span>${kpi.exceptionTrips} 趟</span></div>
    </div>
  `
}

// Logistics Today UI Render
async function renderLogisticsToday() {
  const container = document.querySelector('#logistics-today-content')
  if (!container) return
  try {
    const { trucks, statuses } = await getLogisticsTodayStatus()
    const cardsHtml = (trucks || []).map(t => {
      const s = (statuses || []).find(st => st.truck_id === t.truck_id) || {}
      return `
        <div class="truck-card">
          <div class="truck-card-header"><h4>${t.truck_no}</h4><span class="status-pill status-green">${s.current_status || 'WAITING'}</span></div>
          <div class="truck-card-body"><p>最後回報: ${s.last_event_code || '-'}</p><p>下一節點: <code>${s.next_event_code || 'YM_OUT'}</code></p></div>
        </div>
      `
    }).join('')
    container.innerHTML = `<div class="trucks-grid">${cardsHtml}</div>`
  } catch (err) {
    container.innerHTML = `<div class="status-box error">❌ 載入失敗: ${err.message}</div>`
  }
}

async function renderWeeklyPlan() {
  const container = document.querySelector('#weekly-plan-content')
  if (!container) return
  try {
    const plans = await getWeeklyTripPlan(new Date().toISOString().split('T')[0])
    container.innerHTML = `<p class="placeholder-text">本週計畫共 ${(plans || []).length} 趟車次</p>`
  } catch (err) {
    container.innerHTML = `<div class="status-box error">❌ 載入失敗: ${err.message}</div>`
  }
}

// Driver Home UI Render
async function renderDriverHome() {
  const container = document.querySelector('#driver-home-content')
  try {
    const homeData = await getDriverHome()
    const nextNodeInfo = EVENT_CODES[homeData.nextEventCode] ? EVENT_CODES[homeData.nextEventCode].name : homeData.nextEventCode

    container.innerHTML = `
      <div class="driver-card-header">
        <div class="driver-info"><h2>${homeData.truckNo}｜${homeData.driverName}</h2></div>
        <div class="status-pill status-green">🟢 ${homeData.currentStatus}</div>
      </div>
      <div class="driver-status-body">
        <div class="next-node-box">下一預期作業節點：<strong>${nextNodeInfo}</strong></div>
        <div class="driver-actions"><button id="open-qr-scan-btn" class="btn btn-primary btn-lg">掃描 QR Code</button></div>
      </div>
    `
    document.querySelector('#open-qr-scan-btn').addEventListener('click', () => { document.querySelector('#qr-modal').classList.add('active'); })
  } catch (err) {
    container.innerHTML = `<div class="status-box error">❌ 載入失敗: ${err.message}</div>`
  }
}

// Camera QR Code Scanner Handler
document.querySelector('#btn-start-camera').addEventListener('click', async () => {
  const video = document.querySelector('#qr-video')
  const statusText = document.querySelector('#camera-status-text')

  statusText.textContent = '請求開啟相機權限中...'
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.srcObject = mediaStream
    statusText.textContent = '🟢 相機鏡頭已開啟，請對準作業節點 QR Code'
  } catch (err) {
    statusText.textContent = `❌ 相機開啟失敗 (Camera Permission Denied): ${err.message}`
  }
})

document.querySelector('#close-qr-modal').addEventListener('click', () => {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }
  document.querySelector('#qr-modal').classList.remove('active')
})

// QR Code Scanning Trigger Logic
async function handleScanCode(eventCode, forceAccept = false) {
  const msgBox = document.querySelector('#qr-scan-msg')
  
  // Security payload check: Only 7 valid node codes allowed
  if (!EVENT_CODES[eventCode]) {
    msgBox.className = 'msg-box error'
    msgBox.textContent = '❌ 無效的 QR Code (拒絕執行非 7 合法節點之 URL/Script Payload)'
    return
  }

  msgBox.className = 'msg-box loading'
  msgBox.textContent = `處理中 (${eventCode})...`

  try {
    let res = forceAccept ? await confirmOutOfSequenceEvent(eventCode) : await scanEvent(eventCode)

    if (res.success) {
      msgBox.className = 'msg-box success'
      msgBox.textContent = res.alreadyProcessed ? `ℹ 事件先前已成功處理過 (${eventCode})` : `✅ 回報成功！節點：${eventCode}`
      setTimeout(() => {
        document.querySelector('#qr-modal').classList.remove('active')
        msgBox.style.display = 'none'
        renderApp()
      }, 1000)
    } else if (res.requiresConfirm) {
      document.querySelector('#qr-modal').classList.remove('active')
      pendingOutOfSeqCode = eventCode
      document.querySelector('#expected-node-text').textContent = EVENT_CODES[res.data.expected] ? EVENT_CODES[res.data.expected].name : res.data.expected
      document.querySelector('#actual-node-text').textContent = EVENT_CODES[res.data.actual] ? EVENT_CODES[res.data.actual].name : res.data.actual
      document.querySelector('#confirm-modal').classList.add('active')
    } else {
      msgBox.className = 'msg-box error'
      msgBox.textContent = `❌ [${res.errorCode || 'ERROR'}] ${res.message}`
    }
  } catch (err) {
    msgBox.className = 'msg-box error'
    msgBox.textContent = `❌ 錯誤: ${err.message}`
  }
}

document.querySelectorAll('.qr-node-btn').forEach(btn => {
  btn.addEventListener('click', (e) => { handleScanCode(e.target.getAttribute('data-code')) })
})

document.querySelector('#scan-manual-btn').addEventListener('click', () => {
  const val = document.querySelector('#manual-qr-input').value.trim()
  if (val) handleScanCode(val)
})

document.querySelector('#force-confirm-seq-btn').addEventListener('click', () => {
  document.querySelector('#confirm-modal').classList.remove('active')
  if (pendingOutOfSeqCode) handleScanCode(pendingOutOfSeqCode, true)
})

document.querySelector('#cancel-out-seq-btn').addEventListener('click', () => {
  document.querySelector('#confirm-modal').classList.remove('active')
  document.querySelector('#qr-modal').classList.add('active')
})

// Options & Truck Select Helper
async function loadTruckOptions() {
  const selectEl = document.querySelector('#driver-truck-select')
  try {
    const trucks = await getActiveTrucks()
    selectEl.innerHTML = (trucks || []).map(t => `<option value="${t.truck_id}">${t.truck_no} (${t.truck_name || t.truck_id})</option>`).join('')
  } catch (err) {
    selectEl.innerHTML = `<option value="">載入車輛失敗</option>`
  }
}

// Initializations
loadTruckOptions()
setupRealtimeSubscription()
renderApp()