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
  correctTripEvent,
  batchCreateTrips,
  getLogisticsTrucks,
  getLogisticsDrivers,
  getLogisticsTodayStatus,
  getWeeklyTripPlan,
  getEffectiveTripEvents,
  getTripExecutionByRange
} from './services/logisticsService.js'
import { getDashboardKpi, getKpiTripDetails } from './services/kpiService.js'

// Centralized UI Label Mappings (Traditional Chinese display labels for UI only)
export const SHORT_EVENT_LABELS = {
  YM_OUT: '楊梅出廠',
  HC_IN: '新竹入廠',
  HC_WH: '新竹庫房',
  HC_OUT: '新竹出廠',
  YM_IN: '楊梅入廠',
  YM_ENGINE: '楊梅卸引擎',
  YM_CAB: '楊梅裝車頭'
}

export const STATUS_LABELS = {
  DAY_START_READY: '準備楊梅廠出廠',
  DAY_END: '當日作業結束',
  NO_TRIP: '今日無排程',
  WAITING: '待出發',
  YM_TO_HC: '前往新竹',
  HC_INTERNAL: '新竹廠內作業',
  HC_LOADING: '新竹卸車頭／裝引擎',
  HC_TO_YM: '前往楊梅',
  YM_INTERNAL: '楊梅廠內作業',
  YM_UNLOADING: '楊梅卸引擎',
  READY: '準備下一趟',
  IN_PROGRESS: '執行中',
  COMPLETE: '已完成',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  OVERTIME: '超時未回報'
}

export const TRIP_TYPE_LABELS = {
  NORMAL: '一般排程',
  ADDED: '臨時追加'
}

/**
 * Helper to format date/time into 24-hour time HH:mm format (e.g., "19:00", "07:30")
 */
export function formatTime24(dateVal) {
  if (!dateVal) return '-'
  if (typeof dateVal === 'string') {
    const timeMatch = dateVal.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
    if (timeMatch) {
      const hh = String(timeMatch[1]).padStart(2, '0')
      const mm = String(timeMatch[2]).padStart(2, '0')
      return `${hh}:${mm}`
    }
  }
  const d = new Date(dateVal)
  if (isNaN(d.getTime())) return '-'
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Date Normalization Helper for Excel imports
 * Converts SheetJS dates (serial number, Date object, or string 'YYYY/M/D') to 'YYYY-MM-DD'
 */
export function normalizeExcelDate(val, XLSX) {
  if (val === null || val === undefined || val === '') return null

  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null
    const yyyy = val.getFullYear()
    const mm = String(val.getMonth() + 1).padStart(2, '0')
    const dd = String(val.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  if (typeof val === 'number') {
    const parsedDate = XLSX && XLSX.SSF ? XLSX.SSF.parse_date_code(val) : null
    if (parsedDate && parsedDate.y && parsedDate.m && parsedDate.d) {
      const yyyy = parsedDate.y
      const mm = String(parsedDate.m).padStart(2, '0')
      const dd = String(parsedDate.d).padStart(2, '0')
      return `${yyyy}-${mm}-${dd}`
    }
  }

  const str = String(val).trim()
  if (!str) return null

  const m = str.match(/^(\d{4})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])$/)
  if (m) {
    const yyyy = m[1]
    const mm = String(m[2]).padStart(2, '0')
    const dd = String(m[3]).padStart(2, '0')
    const dt = new Date(`${yyyy}-${mm}-${dd}`)
    if (!isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === `${yyyy}-${mm}-${dd}`) {
      return `${yyyy}-${mm}-${dd}`
    }
  }

  return null
}

/**
 * Time Normalization Helper for Excel imports
 * Converts SheetJS times (fraction number 0.2916, string '7:00 AM', '07:00:00', '19:00') to 'HH:mm'
 */
export function normalizeExcelTime(val) {
  if (val === null || val === undefined || val === '') return null

  if (typeof val === 'number') {
    const timeFraction = val % 1
    const totalSeconds = Math.round(timeFraction * 86400)
    const hours = Math.floor(totalSeconds / 3600) % 24
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  const str = String(val).trim()
  if (!str) return null

  const ampmMatch = str.match(/^(0?[1-9]|1[0-2]):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM|上午|下午)$/i)
  if (ampmMatch) {
    let hh = parseInt(ampmMatch[1], 10)
    const mm = String(ampmMatch[2]).padStart(2, '0')
    const period = ampmMatch[3].toUpperCase()
    if ((period === 'PM' || period === '下午') && hh < 12) hh += 12
    if ((period === 'AM' || period === '上午') && hh === 12) hh = 0
    return `${String(hh).padStart(2, '0')}:${mm}`
  }

  const match24 = str.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/)
  if (match24) {
    const hh = String(match24[1]).padStart(2, '0')
    const mm = String(match24[2]).padStart(2, '0')
    return `${hh}:${mm}`
  }

  return null
}

const app = document.querySelector('#app')

// Base Shell Structure (Role-based views are dynamically unmounted and mounted into #role-view-container)
app.innerHTML = `
  <div class="container">
    <header class="header">
      <div class="badge-phase">卡車管理系統 V1.2 - 正式營運版</div>
      <h1>楊梅廠－新竹廠卡車循環運輸管理系統 V1.2</h1>
      <p class="subtitle">Supabase Realtime 訂閱、動態 Role-Based 模組化隔離與全功能整合</p>
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

      <!-- Dynamic Role-Based View Container (Driver, Logistics, or Supervisor UI mounted here) -->
      <div id="role-view-container"></div>

      <!-- LOGIN FORMS (Unauthenticated only, dual-column layout without tab switch buttons) -->
      <section class="card shadow" id="login-section">
        <div class="login-grid">
          <!-- 1. 司機端登入區 -->
          <div class="login-block">
            <h3>🚛 司機端登入</h3>
            <form id="driver-login-form">
              <div class="form-group margin-top">
                <label for="driver-truck-select">選擇車號</label>
                <select id="driver-truck-select" class="form-control" required></select>
              </div>
              <div class="form-group margin-top">
                <label for="driver-password">密碼</label>
                <input type="password" id="driver-password" class="form-control" placeholder="請輸入密碼" required />
              </div>
              <button type="submit" class="btn btn-primary btn-block margin-top">司機登入</button>
            </form>
          </div>

          <!-- 2. 物流 / 主管登入區 -->
          <div class="login-block">
            <h3>🏢 物流管理 / 主管登入</h3>
            <form id="mgmt-login-form">
              <div class="form-group margin-top">
                <label for="mgmt-login-name">帳號</label>
                <input type="text" id="mgmt-login-name" class="form-control" placeholder="例: supervisor01 或 logistics01" required />
              </div>
              <div class="form-group margin-top">
                <label for="mgmt-password">密碼</label>
                <input type="password" id="mgmt-password" class="form-control" placeholder="請輸入密碼" required />
              </div>
              <button type="submit" class="btn btn-primary btn-block margin-top">管理端登入</button>
            </form>
          </div>
        </div>
      </section>
    </main>

    <!-- Dynamic Container for Driver QR Scanner Modals (Mounted ONLY for DRIVER role) -->
    <div id="qr-modals-container"></div>

    <footer class="footer">
      <p>楊梅廠－新竹廠卡車循環運輸管理系統 V1.2 &copy; 2026</p>
    </footer>
  </div>
`

let currentProfile = null
let currentPeriod = 'DAY'
let pendingOutOfSeqCode = null
let mediaStream = null

// Realtime Subscription Setup (Separated per role, zero KPI requests for Logistics)
function setupRealtimeSubscription() {
  const channel = supabase.channel('realtime_trip_status')

  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_status' }, () => {
      const badge = document.querySelector('#realtime-status-badge')
      if (badge) badge.textContent = '🟢 Realtime 數據即時同步中'
      
      if (currentProfile) {
        if (currentProfile.role === 'SUPERVISOR') {
          renderSupervisorDashboard()
        } else if (currentProfile.role === 'LOGISTICS' || currentProfile.role === 'ADMIN') {
          renderLogisticsToday()
        }
      }
    })
    .subscribe((status) => {
      const badge = document.querySelector('#realtime-status-badge')
      if (badge) {
        if (status === 'SUBSCRIBED') {
          badge.textContent = '🟢 Realtime 訂閱中'
        } else {
          badge.textContent = '🟡 Polling 模式 (Fallback 30s)'
        }
      }
    })

  // 30 Seconds Polling Fallback
  setInterval(() => {
    if (currentProfile) {
      if (currentProfile.role === 'SUPERVISOR') {
        renderSupervisorDashboard()
      } else if (currentProfile.role === 'LOGISTICS' || currentProfile.role === 'ADMIN') {
        renderLogisticsToday()
      }
    }
  }, 30000)
}

// Render App (Strict Role-based route branching & DOM unmounting)
async function renderApp() {
  const identityDisplay = document.querySelector('#identity-display')
  const sessionActions = document.querySelector('#session-actions')
  const loginSection = document.querySelector('#login-section')
  const roleViewContainer = document.querySelector('#role-view-container')

  currentProfile = await getCurrentUserProfile()

  console.log('[DEBUG UI LOGIN] renderApp fetched profile:', currentProfile)

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
      console.log('[DEBUG UI LOGIN] selected route: DRIVER UI')
      closeAndRemoveQrModals()
      renderQrModals() // Mount #qr-modal and #confirm-modal into DOM ONLY for DRIVER
      
      // Mount DRIVER view into DOM (Unmount Supervisor Dashboard & Logistics Management completely)
      roleViewContainer.innerHTML = `
        <section class="card shadow" id="driver-home-section">
          <div id="driver-home-content"></div>
        </section>
      `
      await renderDriverHome()
    } else if (currentProfile.role === 'SUPERVISOR') {
      console.log('[DEBUG UI LOGIN] selected route: SUPERVISOR UI')
      closeAndRemoveQrModals() // Unmount QR Modals & camera
      
      // Mount SUPERVISOR Dashboard into DOM (Unmount Logistics Management & Driver Home completely)
      roleViewContainer.innerHTML = `
        <section class="card shadow" id="supervisor-dashboard-section">
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
      `
      setupSupervisorPeriodButtons()
      await renderSupervisorDashboard()
    } else { // LOGISTICS / ADMIN
      console.log('[DEBUG UI LOGIN] selected route: LOGISTICS UI')
      closeAndRemoveQrModals() // Unmount QR Modals & camera
      
      // Mount LOGISTICS Operational View (5 Collapsible Sections) into DOM
      roleViewContainer.innerHTML = `
        <section class="card shadow" id="logistics-home-section">
          <!-- 1. 7 節點橫式流程進度監控 -->
          <div class="collapsible-card" id="section-progress" data-section="progress">
            <button type="button" class="section-toggle" data-target="progress">
              <span>7 節點橫式流程進度監控</span>
              <span class="toggle-icon">▲</span>
            </button>
            <div class="section-body">
              <div id="logistics-7node-progress"></div>
            </div>
          </div>

          <!-- 2. 車輛即時車況 -->
          <div class="collapsible-card" id="section-realtime" data-section="realtime">
            <button type="button" class="section-toggle" data-target="realtime">
              <span>車輛即時車況</span>
              <span class="toggle-icon">▼</span>
            </button>
            <div class="section-body">
              <div id="logistics-realtime-status"></div>
            </div>
          </div>

          <!-- 3. 車趟排程計畫與執行實績 -->
          <div class="collapsible-card" id="section-execution" data-section="execution">
            <button type="button" class="section-toggle" data-target="execution">
              <span>車趟排程計畫與執行實績</span>
              <span class="toggle-icon">▲</span>
            </button>
            <div class="section-body">
              <div class="period-filter-group">
                <button type="button" class="period-filter-btn" data-period="today">當日計畫</button>
                <button type="button" class="period-filter-btn" data-period="thisWeek">當週計畫</button>
                <button type="button" class="period-filter-btn" data-period="nextWeek">次週計畫</button>
                <span id="execution-period-range" class="period-range-display">顯示期間：-</span>
              </div>
              <div id="logistics-trip-execution-table"></div>
            </div>
          </div>

          <!-- 4. 新增 Trip 計畫 -->
          <div class="collapsible-card" id="section-create-trip" data-section="createTrip">
            <button type="button" class="section-toggle" data-target="createTrip">
              <span>新增 Trip 計畫</span>
              <span class="toggle-icon">▼</span>
            </button>
            <div class="section-body">
              <div class="tab-container margin-bottom" style="margin-bottom: 1rem;">
                <div class="tab-buttons" style="display: flex; gap: 0.5rem; border-bottom: 2px solid var(--card-border); padding-bottom: 0.5rem;">
                  <button type="button" class="btn btn-secondary active" id="btn-tab-single-trip" style="padding: 0.4rem 1rem;">單筆新增</button>
                  <button type="button" class="btn btn-secondary" id="btn-tab-excel-trip" style="padding: 0.4rem 1rem;">📊 Excel 批次匯入 V1.0</button>
                </div>
              </div>

              <!-- A. 單筆新增區塊 -->
              <div id="subpanel-single-trip">
                <form id="trip-form">
                  <div class="form-group">
                    <label for="create-trip-date">計畫日期</label>
                    <input type="date" id="create-trip-date" class="form-control" required />
                  </div>
                  <div class="form-group margin-top">
                    <label for="create-trip-departure">計畫發車時間 (YM_OUT)</label>
                    <input type="time" id="create-trip-departure" class="form-control" required />
                  </div>
                  <div class="form-group margin-top">
                    <label for="create-trip-truck">指派車輛</label>
                    <select id="create-trip-truck" class="form-control" required></select>
                  </div>
                  <div class="form-group margin-top">
                    <label for="create-trip-driver">指派司機 (可空值，將自動代入車輛預設司機)</label>
                    <select id="create-trip-driver" class="form-control">
                      <option value="">-- 未指定司機 (將自動套用車輛預設司機) --</option>
                      <option value="D001">司機01 (D001)</option>
                      <option value="D002">司機02 (D002)</option>
                    </select>
                  </div>
                  <div class="form-group margin-top">
                    <label><input type="checkbox" id="create-trip-forcesave" /> 強制儲存 (忽略衝突檢查)</label>
                  </div>
                  <div class="form-actions margin-top">
                    <button type="submit" class="btn btn-primary">確認建立</button>
                  </div>
                </form>
              </div>

              <!-- B. Excel 批次匯入區塊 -->
              <div id="subpanel-excel-trip" hidden>
                <div class="excel-import-box" style="background: rgba(15, 23, 42, 0.4); border: 1px dashed var(--card-border); border-radius: 8px; padding: 1rem;">
                  <h4 style="margin-top:0;">📊 Excel 批次匯入 Trip 計畫 V1.0</h4>
                  <p class="text-muted" style="font-size: 0.85rem; line-height: 1.4;">
                    請下載範本檔填寫「計畫日期 (YYYY-MM-DD)、計畫發車時間 (24hr HH:mm)、車號、司機 (選填)、備註 (選填)」，選擇檔案後點擊「解析並預覽」。
                  </p>

                  <div class="excel-actions-grid" style="display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 0.75rem;">
                    <a href="/template/Trip計畫批次匯入範本.xlsx" download="Trip計畫批次匯入範本.xlsx" id="btn-download-excel-template" class="btn btn-secondary">
                      📥 下載 Excel 範本
                    </a>
                    <input type="file" id="excel-file-input" accept=".xlsx, .xls" class="form-control" style="max-width: 280px;" />
                    <button type="button" id="btn-parse-excel" class="btn btn-primary">🔍 解析並預覽</button>
                  </div>

                  <div id="excel-preview-container" class="margin-top" style="display: none; margin-top: 1rem;"></div>
                  <div id="excel-batch-msg" class="msg-box margin-top" style="display: none; margin-top: 1rem;"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 5. 臨時追加 Trip (ADDED) -->
          <div class="collapsible-card" id="section-add-extra" data-section="addExtra">
            <button type="button" class="section-toggle" data-target="addExtra">
              <span>臨時追加 Trip</span>
              <span class="toggle-icon">▼</span>
            </button>
            <div class="section-body">
              <form id="add-extra-form">
                <div class="form-group">
                  <label for="add-extra-date">計畫日期</label>
                  <input type="date" id="add-extra-date" class="form-control" required />
                </div>
                <div class="form-group margin-top">
                  <label for="add-extra-departure">計畫發車時間 (YM_OUT)</label>
                  <input type="time" id="add-extra-departure" class="form-control" required />
                </div>
                <div class="form-group margin-top">
                  <label for="add-extra-truck">指派車輛</label>
                  <select id="add-extra-truck" class="form-control" required></select>
                </div>
                <div class="form-group margin-top">
                  <label for="add-extra-driver">指派司機 (可空值，將自動代入車輛預設司機)</label>
                  <select id="add-extra-driver" class="form-control">
                    <option value="">-- 未指定司機 (將自動套用車輛預設司機) --</option>
                    <option value="D001">司機01 (D001)</option>
                    <option value="D002">司機02 (D002)</option>
                  </select>
                </div>
                <div class="form-group margin-top">
                  <label for="add-extra-reason">追加原因類別</label>
                  <select id="add-extra-reason" class="form-control" required>
                    <option value="EXTRA_PARTS">加送海採件 / 零配件 (EXTRA_PARTS)</option>
                    <option value="STOCK_INCREASE">庫存 / 產能需求增加 (STOCK_INCREASE)</option>
                    <option value="TRUCK_ADJUST">車輛臨時調度 (TRUCK_ADJUST)</option>
                    <option value="OTHER">其他原因 (OTHER)</option>
                  </select>
                </div>
                <div class="form-actions margin-top">
                  <button type="submit" class="btn btn-primary">確認追加</button>
                </div>
              </form>
            </div>
          </div>
        </section>
      `
      await bindLogisticsHandlers()
      await renderLogisticsToday()
    }
  } else {
    closeAndRemoveQrModals()
    roleViewContainer.innerHTML = ''
    loginSection.style.display = 'block'
    identityDisplay.innerHTML = `<div class="status-box info">目前為未登入狀態 (anon)</div>`
    sessionActions.innerHTML = ''
  }
}

function setupSupervisorPeriodButtons() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.onclick = (e) => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'))
      e.target.classList.add('active')
      currentPeriod = e.target.getAttribute('data-period')
      renderSupervisorDashboard()
    }
  })
}


async function bindLogisticsHandlers() {
  // 1. Initialize Collapsible Sections & localStorage states
  const SECTION_DEFAULTS = {
    progress: true,
    realtime: false,
    execution: true,
    createTrip: false,
    addExtra: false
  }

  Object.keys(SECTION_DEFAULTS).forEach(key => {
    const card = document.querySelector(`[data-section="${key}"]`)
    if (!card) return
    const toggleBtn = card.querySelector('.section-toggle')
    const body = card.querySelector('.section-body')
    const icon = card.querySelector('.toggle-icon')
    if (!toggleBtn || !body || !icon) return

    const storageKey = `logistics.section.${key}`
    const storedVal = localStorage.getItem(storageKey)
    let isExpanded = storedVal !== null ? storedVal === 'true' : SECTION_DEFAULTS[key]

    const updateUI = (expanded) => {
      body.hidden = !expanded
      icon.textContent = expanded ? '▲' : '▼'
      if (expanded) {
        card.classList.remove('collapsed')
      } else {
        card.classList.add('collapsed')
      }
    }

    updateUI(isExpanded)

    toggleBtn.onclick = () => {
      isExpanded = !isExpanded
      localStorage.setItem(storageKey, String(isExpanded))
      updateUI(isExpanded)
    }
  })

  // 2. Load truck options into create-trip-truck and add-extra-truck & fetch default_driver_id
  let logisticsTrucks = []
  let logisticsDrivers = []
  try {
    logisticsTrucks = await getLogisticsTrucks()
  } catch (err) {
    console.warn('[DEBUG LOGISTICS] failed to fetch logistics trucks:', err.message)
    logisticsTrucks = await getActiveTrucks()
  }

  try {
    logisticsDrivers = await getLogisticsDrivers()
  } catch (err) {
    console.warn('[DEBUG LOGISTICS] failed to fetch logistics drivers:', err.message)
  }

  const truckOpts = (logisticsTrucks || []).map(t => {
    const displayName = t.truck_name || t.truck_no || t.truck_id
    return `<option value="${t.truck_id}">${displayName}</option>`
  }).join('')

  const driverOpts = `
    <option value="">-- 未指定司機 (將自動套用車輛預設司機) --</option>
    ${(logisticsDrivers || []).map(d => `<option value="${d.driver_id}">${d.driver_name || d.driver_id}</option>`).join('')}
  `

  const createTruckSel = document.querySelector('#create-trip-truck')
  const createDriverSel = document.querySelector('#create-trip-driver')
  const addExtraTruckSel = document.querySelector('#add-extra-truck')
  const addExtraDriverSel = document.querySelector('#add-extra-driver')

  if (createTruckSel) createTruckSel.innerHTML = truckOpts
  if (addExtraTruckSel) addExtraTruckSel.innerHTML = truckOpts

  if (createDriverSel) createDriverSel.innerHTML = driverOpts
  if (addExtraDriverSel) addExtraDriverSel.innerHTML = driverOpts

  // Helper: Auto-select default_driver_id if driver selection is empty ("未指定司機")
  const handleTruckSelectChange = (truckSelEl, driverSelEl) => {
    if (!truckSelEl || !driverSelEl) return
    const selectedTruckId = truckSelEl.value
    const selectedTruck = (logisticsTrucks || []).find(t => t.truck_id === selectedTruckId)
    if (!driverSelEl.value && selectedTruck?.default_driver_id) {
      driverSelEl.value = selectedTruck.default_driver_id
    }
  }

  if (createTruckSel && createDriverSel) {
    createTruckSel.onchange = () => handleTruckSelectChange(createTruckSel, createDriverSel)
    handleTruckSelectChange(createTruckSel, createDriverSel)
  }
  if (addExtraTruckSel && addExtraDriverSel) {
    addExtraTruckSel.onchange = () => handleTruckSelectChange(addExtraTruckSel, addExtraDriverSel)
    handleTruckSelectChange(addExtraTruckSel, addExtraDriverSel)
  }

  // 3. Set default date to today & departure time to current time
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const createDateInput = document.querySelector('#create-trip-date')
  const createDepInput = document.querySelector('#create-trip-departure')
  const addExtraDateInput = document.querySelector('#add-extra-date')
  const addExtraDepInput = document.querySelector('#add-extra-departure')

  if (createDateInput) createDateInput.value = todayStr
  if (createDepInput) createDepInput.value = timeStr
  if (addExtraDateInput) addExtraDateInput.value = todayStr
  if (addExtraDepInput) addExtraDepInput.value = timeStr

  // 4. Submit Create Trip Form (#trip-form)
  const tripForm = document.querySelector('#trip-form')
  if (tripForm) {
    tripForm.onsubmit = async (e) => {
      e.preventDefault()
      if (!currentProfile || (currentProfile.role !== 'LOGISTICS' && currentProfile.role !== 'ADMIN')) return

      const planDate = document.querySelector('#create-trip-date').value
      const depTime = document.querySelector('#create-trip-departure').value
      const truckId = document.querySelector('#create-trip-truck').value
      let driverId = document.querySelector('#create-trip-driver').value
      const forceSave = document.querySelector('#create-trip-forcesave').checked

      // Fallback auto-assign default driver if driverId is empty ("未指定司機")
      if (!driverId) {
        const selectedTruck = (logisticsTrucks || []).find(t => t.truck_id === truckId)
        driverId = selectedTruck?.default_driver_id || selectedTruck?.defaultDriverId || ''
      }

      const planDeparture = `${planDate}T${depTime}:00+08:00`

      console.log('[DEBUG LOGISTICS] create trip submit', {
        planDate,
        planDeparture,
        truckId,
        driverId,
        forceSave
      })

      try {
        const res = await createTrip({
          planDate,
          planDeparture,
          truckId,
          driverId,
          planType: 'NORMAL',
          forceSave
        })
        console.log('[DEBUG LOGISTICS] create trip success:', res)
        alert('✅ 成功建立 Trip 計畫！')
        await renderLogisticsToday()
      } catch (err) {
        console.error('[DEBUG LOGISTICS] create trip failed:', err.message)
        alert(`❌ 建立 Trip 失敗: ${err.message}`)
      }
    }
  }

  // 5. Submit Add Extra Trip Form (#add-extra-form)
  const addExtraForm = document.querySelector('#add-extra-form')
  if (addExtraForm) {
    addExtraForm.onsubmit = async (e) => {
      e.preventDefault()
      if (!currentProfile || (currentProfile.role !== 'LOGISTICS' && currentProfile.role !== 'ADMIN')) return

      const planDate = document.querySelector('#add-extra-date').value
      const depTime = document.querySelector('#add-extra-departure').value
      const truckId = document.querySelector('#add-extra-truck').value
      const driverIdSel = document.querySelector('#add-extra-driver')
      let driverId = driverIdSel ? driverIdSel.value : null
      const addReason = document.querySelector('#add-extra-reason').value

      // Fallback auto-assign default driver if driverId is empty ("未指定司機")
      if (!driverId) {
        const selectedTruck = (logisticsTrucks || []).find(t => t.truck_id === truckId)
        driverId = selectedTruck?.default_driver_id || selectedTruck?.defaultDriverId || null
      }

      const planDeparture = `${planDate}T${depTime}:00+08:00`

      console.log('[DEBUG LOGISTICS] add extra trip submit', {
        planDate,
        planDeparture,
        truckId,
        driverId,
        addReason
      })

      try {
        const res = await addExtraTrip({
          planDate,
          planDeparture,
          truckId,
          driverId,
          addReason,
          forceSave: true
        })
        console.log('[DEBUG LOGISTICS] add extra trip success:', res)
        alert('✅ 成功追加 Trip！')
        await renderLogisticsToday()
      } catch (err) {
        console.error('[DEBUG LOGISTICS] add extra trip failed:', err.message)
        alert(`❌ 追加 Trip 失敗: ${err.message}`)
      }
    }
  }

  // 6. Excel Batch Import V1.0 Handlers (#subpanel-excel-trip)
  const btnSingleTab = document.querySelector('#btn-tab-single-trip')
  const btnExcelTab = document.querySelector('#btn-tab-excel-trip')
  const subpanelSingle = document.querySelector('#subpanel-single-trip')
  const subpanelExcel = document.querySelector('#subpanel-excel-trip')

  if (btnSingleTab && btnExcelTab && subpanelSingle && subpanelExcel) {
    btnSingleTab.onclick = () => {
      btnSingleTab.classList.add('active')
      btnExcelTab.classList.remove('active')
      subpanelSingle.hidden = false
      subpanelExcel.hidden = true
    }
    btnExcelTab.onclick = () => {
      btnExcelTab.classList.add('active')
      btnSingleTab.classList.remove('active')
      subpanelSingle.hidden = true
      subpanelExcel.hidden = false
    }
  }

  const btnParseExcel = document.querySelector('#btn-parse-excel')
  const fileInput = document.querySelector('#excel-file-input')
  const previewContainer = document.querySelector('#excel-preview-container')
  const batchMsgBox = document.querySelector('#excel-batch-msg')

  if (btnParseExcel && fileInput) {
    let parsedValidPayload = []

    btnParseExcel.onclick = async () => {
      if (batchMsgBox) {
        batchMsgBox.style.display = 'none'
        batchMsgBox.className = 'msg-box margin-top'
      }

      if (!fileInput.files || fileInput.files.length === 0) {
        alert('請先選擇要匯入的 Excel 檔案 (.xlsx / .xls)')
        return
      }

      const file = fileInput.files[0]
      try {
        // Dynamic import SheetJS only on demand when user parses Excel file
        const XLSX = await import('xlsx')
        const arrayBuffer = await file.arrayBuffer()
        const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })
        const sheetName = workbook.SheetNames.includes('Trip計畫') ? 'Trip計畫' : workbook.SheetNames[0]
        const worksheet = workbook.Sheets[sheetName]

        if (!worksheet) {
          throw new Error('Excel 檔案內找不到有效的工作表 (Sheet)')
        }

        const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '' })
        if (!rawRows || rawRows.length === 0) {
          throw new Error('Excel 檔案內容為空！')
        }

        // 1. 標題列 Header Validation
        const headerRow = (rawRows[0] || []).map(cell => String(cell).trim())
        const reqHeaders = ['計畫日期', '計畫發車時間', '車號']
        const missingReq = reqHeaders.filter(h => !headerRow.includes(h))

        if (missingReq.length > 0) {
          throw new Error(`Excel 欄位格式錯誤：缺少必要標題欄位 (${missingReq.join('、')})。官方標準 5 欄標題為：計畫日期, 計畫發車時間, 車號, 司機, 備註`)
        }

        const idxDate = headerRow.indexOf('計畫日期')
        const idxTime = headerRow.indexOf('計畫發車時間')
        const idxTruck = headerRow.indexOf('車號')
        const idxDriver = headerRow.indexOf('司機')
        const idxRemark = headerRow.indexOf('備註')

        // Fetch master data for validation
        const trucksMaster = await getLogisticsTrucks()
        const driversMaster = await getLogisticsDrivers()

        const dataRows = rawRows.slice(1)
        if (dataRows.length === 0) {
          throw new Error('Excel 只有 Header 標題列，沒有任何數據資料列！')
        }

        const parsedResults = []
        const seenExcelKeys = new Set()
        parsedValidPayload = []

        let excelRowNumber = 1 // 1-based index (Header is row 1, data starts row 2)

        dataRows.forEach((row) => {
          excelRowNumber++

          // Skip completely blank rows
          const isAllBlank = row.every(cell => cell === null || cell === undefined || String(cell).trim() === '')
          if (isAllBlank) return

          const rawDate = row[idxDate]
          const rawTime = row[idxTime]
          const rawTruck = String(row[idxTruck] || '').trim()
          const rawDriver = idxDriver >= 0 ? String(row[idxDriver] || '').trim() : ''
          const rawRemark = idxRemark >= 0 ? String(row[idxRemark] || '').trim() : ''

          let errorMsg = null
          let normDate = null
          let normTime = null
          let matchedTruck = null
          let matchedDriverId = null
          let matchedDriverName = '-'

          // A. 日期驗證
          if (!rawDate && rawDate !== 0) {
            errorMsg = '計畫日期不可空白'
          } else {
            normDate = normalizeExcelDate(rawDate, XLSX)
            if (!normDate) {
              errorMsg = `計畫日期「${rawDate}」格式錯誤 (必須為 YYYY-MM-DD)`
            }
          }

          // B. 時間驗證
          if (!errorMsg) {
            if (!rawTime && rawTime !== 0) {
              errorMsg = '計畫發車時間不可空白'
            } else {
              normTime = normalizeExcelTime(rawTime)
              if (!normTime) {
                errorMsg = `計畫發車時間「${rawTime}」格式錯誤 (必須為 24hr HH:mm 00:00~23:59)`
              }
            }
          }

          // C. 車號驗證
          if (!errorMsg) {
            if (!rawTruck) {
              errorMsg = '車號不可空白'
            } else {
              matchedTruck = trucksMaster.find(t => t.truck_no === rawTruck || t.truck_id === rawTruck)
              if (!matchedTruck) {
                errorMsg = `車號「${rawTruck}」不存在`
              } else if (matchedTruck.active === false) {
                errorMsg = `車輛「${rawTruck}」非啟用狀態 (Active)`
              }
            }
          }

          // D. 司機驗證 (與同名司機歧義 AMBIGUOUS 檢查)
          if (!errorMsg) {
            if (rawDriver) {
              const driverMatches = driversMaster.filter(d => (d.driver_name === rawDriver || d.driver_id === rawDriver) && d.active === true)
              if (driverMatches.length === 0) {
                errorMsg = `司機「${rawDriver}」不存在或非啟用狀態`
              } else if (driverMatches.length > 1) {
                errorMsg = `DRIVER_AMBIGUOUS: 同名司機「${rawDriver}」存在多筆有效紀錄，請改填司機 ID`
              } else {
                matchedDriverId = driverMatches[0].driver_id
                matchedDriverName = driverMatches[0].driver_name
              }
            } else {
              // 司機空白 ➔ 使用車輛預設司機 default_driver_id
              if (matchedTruck && matchedTruck.default_driver_id) {
                matchedDriverId = matchedTruck.default_driver_id
                const defDriver = driversMaster.find(d => d.driver_id === matchedDriverId)
                matchedDriverName = defDriver ? `${defDriver.driver_name} (預設)` : matchedDriverId
              } else {
                errorMsg = `車輛「${rawTruck}」未設定預設司機，且司機欄位為空`
              }
            }
          }

          // E. Excel 內部重複驗證 (planDate + truckId + planDeparture)
          if (!errorMsg) {
            const dupKey = `${normDate}_${matchedTruck.truck_id}_${normTime}`
            if (seenExcelKeys.has(dupKey)) {
              errorMsg = `Excel 內出現重複發車時間 (日期: ${normDate}, 車號: ${rawTruck}, 發車時間: ${normTime})`
            } else {
              seenExcelKeys.add(dupKey)
            }
          }

          if (!errorMsg) {
            const departureIso = `${normDate}T${normTime}:00+08:00`
            parsedValidPayload.push({
              planDate: normDate,
              planDeparture: departureIso,
              truckId: matchedTruck.truck_id,
              driverId: matchedDriverId,
              remark: rawRemark
            })
            parsedResults.push({
              rowNo: excelRowNumber,
              date: normDate,
              time: normTime,
              truck: rawTruck,
              driver: matchedDriverName,
              remark: rawRemark,
              isValid: true,
              msg: '✅ 可建立'
            })
          } else {
            parsedResults.push({
              rowNo: excelRowNumber,
              date: normDate || rawDate || '-',
              time: normTime || rawTime || '-',
              truck: rawTruck || '-',
              driver: rawDriver || '-',
              remark: rawRemark || '-',
              isValid: false,
              msg: `❌ ${errorMsg}`
            })
          }
        })

        const totalParsed = parsedResults.length
        const validCount = parsedResults.filter(r => r.isValid).length
        const errorCount = parsedResults.filter(r => !r.isValid).length

        // Render Preview UI Table
        let tableRowsHtml = parsedResults.map(r => `
          <tr style="${r.isValid ? '' : 'background: rgba(239, 68, 68, 0.15);'}">
            <td>第 ${r.rowNo} 列</td>
            <td><code>${r.date}</code></td>
            <td><code>${r.time}</code></td>
            <td>${r.truck}</td>
            <td>${r.driver}</td>
            <td>${r.remark || '-'}</td>
            <td style="${r.isValid ? 'color: var(--success); font-weight: bold;' : 'color: var(--danger); font-weight: bold;'}">${r.msg}</td>
          </tr>
        `).join('')

        previewContainer.style.display = 'block'
        previewContainer.innerHTML = `
          <div class="preview-header margin-bottom" style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.7); padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 0.75rem;">
            <div>
              <strong>Excel 數據：${totalParsed} 筆</strong> ｜ 
              <span style="color: var(--success); font-weight: bold;">可建立：${validCount} 筆</span> ｜ 
              <span style="color: ${errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: bold;">錯誤：${errorCount} 筆</span>
            </div>
          </div>

          <div class="table-responsive" style="max-height: 350px; overflow-y: auto; border: 1px solid var(--card-border); border-radius: 6px;">
            <table class="table" style="width: 100%; font-size: 0.85rem;">
              <thead>
                <tr style="position: sticky; top: 0; background: #1e293b; z-index: 10;">
                  <th>Excel 列號</th>
                  <th>計畫日期</th>
                  <th>計畫發車時間</th>
                  <th>車號</th>
                  <th>司機</th>
                  <th>備註</th>
                  <th>驗證結果</th>
                </tr>
              </thead>
              <tbody>
                ${tableRowsHtml || '<tr><td colspan="7">無有效數據資料</td></tr>'}
              </tbody>
            </table>
          </div>

          <div class="margin-top" style="margin-top: 1rem; text-align: right;">
            <button type="button" id="btn-confirm-batch-create" class="btn btn-primary btn-lg" ${errorCount > 0 || validCount === 0 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
              ${errorCount > 0 ? `🔒 請先修正 Excel 中 ${errorCount} 筆錯誤後重新上傳` : (validCount === 0 ? '無可建立之資料' : `🚀 確認批次建立 ${validCount} 筆 Trip`)}
            </button>
          </div>
        `

        // Confirm Batch Create Event Handler
        const btnConfirmBatch = document.querySelector('#btn-confirm-batch-create')
        if (btnConfirmBatch && errorCount === 0 && validCount > 0) {
          btnConfirmBatch.onclick = async () => {
            btnConfirmBatch.disabled = true
            btnConfirmBatch.textContent = '處理中，請稍候...'

            try {
              const res = await batchCreateTrips(parsedValidPayload)
              if (res && res.success === true) {
                batchMsgBox.style.display = 'block'
                batchMsgBox.className = 'msg-box success'
                batchMsgBox.innerHTML = `✅ <strong>批次建立完成！</strong>成功建立 <strong>${res.createdCount}</strong> 筆 Trip`

                // Clear File Input & Preview Table
                fileInput.value = ''
                previewContainer.style.display = 'none'

                // Re-query official DB RPCs & update Logistics View
                await renderLogisticsToday()
              } else {
                throw new Error(res.message || '批次建立失敗')
              }
            } catch (err) {
              batchMsgBox.style.display = 'block'
              batchMsgBox.className = 'msg-box error'
              batchMsgBox.innerHTML = `❌ <strong>批次建立失敗 (RPC Rollback)：</strong> ${err.message}`
              btnConfirmBatch.disabled = false
              btnConfirmBatch.textContent = `🚀 確認批次建立 ${validCount} 筆 Trip`
            }
          }
        }

      } catch (err) {
        if (batchMsgBox) {
          batchMsgBox.style.display = 'block'
          batchMsgBox.className = 'msg-box error'
          batchMsgBox.innerHTML = `❌ ${err.message}`
        }
        previewContainer.style.display = 'none'
      }
    }
  }

  // 7. Setup LOGISTICS Execution Table Period Filter Buttons
  document.querySelectorAll('.period-filter-btn').forEach(btn => {
    btn.onclick = (e) => {
      const targetPeriod = e.target.getAttribute('data-period')
      if (targetPeriod === logisticsExecutionPeriod) return // Skip redundant query
      renderLogisticsExecutionTable(targetPeriod)
    }
  })
}

async function handleCancelTrip(tripId) {
  if (!currentProfile || !['LOGISTICS', 'ADMIN'].includes(currentProfile.role)) return
  const cancelReason = prompt('請選擇或輸入取消原因代碼 (STOCK_DECREASE / TRUCK_FAILURE / OTHER)', 'STOCK_DECREASE')
  if (!cancelReason) return
  try {
    const res = await cancelTrip({ tripId, cancelReason })
    console.log('[DEBUG LOGISTICS] cancel trip success:', res)
    alert(`✅ 成功取消 Trip (${tripId})`)
    await renderLogisticsToday()
  } catch (err) {
    console.error('[DEBUG LOGISTICS] cancel trip failed:', err.message)
    alert(`❌ 取消 Trip 失敗: ${err.message}`)
  }
}

/**
 * Role-Based Conditional Render for QR Modals (DRIVER only)
 */
function renderQrModals() {
  const container = document.querySelector('#qr-modals-container')
  if (!container) return

  container.innerHTML = `
    <!-- QR SCANNER MODAL -->
    <div id="qr-modal" class="modal-backdrop">
      <div class="modal-content">
        <div class="modal-header">
          <h3>掃描作業節點 QR Code</h3>
          <button id="close-qr-modal" class="modal-close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <!-- ① 作業提醒（掃錯 QR Code） (置頂最前) -->
          <div class="qr-warning-section msg-box info margin-bottom" style="margin-bottom: 1.25rem;">
            <h4 style="margin: 0 0 0.5rem 0; color: var(--info); font-size: 0.95rem;">⚠️ 作業提醒（掃錯 QR Code）：</h4>
            <p style="margin: 0; font-size: 0.85rem; line-height: 1.4;">
              若掃描之作業節點與系統預期不符，系統將彈出警告提示。您可以選擇「返回重新掃描」或在確認無誤後點擊「確認本次回報」強制儲存。
            </p>
          </div>

          <!-- ② 掃描作業節點 QR Code (僅保留相機預覽與啟動按鈕) -->
          <div class="camera-scan-section">
            <h4 style="margin: 0 0 0.75rem 0; font-size: 0.95rem;">掃描作業節點 QR Code</h4>
            <div class="qr-camera-prototype">
              <video id="qr-video" style="width: 100%; border-radius: 8px;" autoplay playsinline></video>
              <div id="camera-status-text" class="placeholder-text margin-top">點擊「啟動手機鏡頭」開啟相機掃碼</div>
            </div>
            <button id="btn-start-camera" class="btn btn-secondary btn-block margin-top">啟動手機鏡頭 (Camera API)</button>
            <div id="qr-scan-msg" class="msg-box margin-top"></div>
          </div>

          <!-- ③ 模擬 / 手動輸入 QR 字串 (Collapsible Card，7個按鈕與輸入框皆在收合區內) -->
          <div class="collapsible-card margin-top" id="manual-qr-card" style="border: 1px solid var(--card-border); border-radius: 8px; overflow: hidden;">
            <div class="card-header section-toggle" id="toggle-manual-qr" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 0.65rem 0.85rem; background: rgba(30, 41, 59, 0.6);">
              <strong style="font-size: 0.9rem;">模擬 / 手動輸入 QR 字串</strong>
              <span class="toggle-icon" id="manual-qr-icon" style="font-size: 0.85rem; color: var(--primary);">▶ 展開</span>
            </div>
            <div class="section-body" id="manual-qr-body" hidden style="padding: 0.85rem;">
              <div class="qr-nodes-grid" style="margin-bottom: 1rem;">
                <button class="qr-node-btn" data-code="YM_OUT">1. 楊梅出廠 (YM_OUT)</button>
                <button class="qr-node-btn" data-code="HC_IN">2. 新竹入廠 (HC_IN)</button>
                <button class="qr-node-btn" data-code="HC_WH">3. 新竹庫房 (HC_WH)</button>
                <button class="qr-node-btn" data-code="HC_OUT">4. 新竹出廠 (HC_OUT)</button>
                <button class="qr-node-btn" data-code="YM_IN">5. 楊梅入廠 (YM_IN)</button>
                <button class="qr-node-btn" data-code="YM_ENGINE">6. 楊梅卸引擎 (YM_ENGINE)</button>
                <button class="qr-node-btn" data-code="YM_CAB">7. 楊梅裝車頭 (YM_CAB)</button>
              </div>
              <div class="form-group margin-top">
                <label for="manual-qr-input">輸入 QR 字串:</label>
                <div class="input-group">
                  <input type="text" id="manual-qr-input" class="form-control" placeholder="例: YM_OUT" />
                  <button id="scan-manual-btn" class="btn btn-primary">送出</button>
                </div>
              </div>
            </div>
          </div>
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
  `

  // Manual QR Collapsible Section Handler
  const STORAGE_KEY_MANUAL_QR = 'driver.section.manualQr'
  const isManualQrExpanded = localStorage.getItem(STORAGE_KEY_MANUAL_QR) === 'true'
  const manualQrBody = document.querySelector('#manual-qr-body')
  const manualQrIcon = document.querySelector('#manual-qr-icon')
  const toggleManualQrBtn = document.querySelector('#toggle-manual-qr')

  if (manualQrBody && manualQrIcon) {
    if (isManualQrExpanded) {
      manualQrBody.hidden = false
      manualQrIcon.textContent = '▼ 收合'
    } else {
      manualQrBody.hidden = true
      manualQrIcon.textContent = '▶ 展開'
    }

    if (toggleManualQrBtn) {
      toggleManualQrBtn.addEventListener('click', () => {
        const currentlyHidden = manualQrBody.hidden
        manualQrBody.hidden = !currentlyHidden
        const newExpanded = !manualQrBody.hidden
        manualQrIcon.textContent = newExpanded ? '▼ 收合' : '▶ 展開'
        localStorage.setItem(STORAGE_KEY_MANUAL_QR, newExpanded)
      })
    }
  }

  // Event Listeners for Driver QR Modals
  const btnStartCamera = document.querySelector('#btn-start-camera')
  if (btnStartCamera) {
    btnStartCamera.addEventListener('click', async () => {
      const video = document.querySelector('#qr-video')
      const statusText = document.querySelector('#camera-status-text')
      if (!statusText || !video) return

      statusText.textContent = '請求開啟相機權限中...'
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        video.srcObject = mediaStream
        statusText.textContent = '🟢 相機鏡頭已開啟，請對準作業節點 QR Code'
      } catch (err) {
        statusText.textContent = `❌ 相機開啟失敗 (Camera Permission Denied): ${err.message}`
      }
    })
  }

  const closeQrModalBtn = document.querySelector('#close-qr-modal')
  if (closeQrModalBtn) {
    closeQrModalBtn.addEventListener('click', () => {
      closeAndRemoveCameraStream()
      const qrModal = document.querySelector('#qr-modal')
      if (qrModal) qrModal.classList.remove('active')
    })
  }

  document.querySelectorAll('.qr-node-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { handleScanCode(e.target.getAttribute('data-code')) })
  })

  const scanManualBtn = document.querySelector('#scan-manual-btn')
  if (scanManualBtn) {
    scanManualBtn.addEventListener('click', () => {
      const input = document.querySelector('#manual-qr-input')
      const val = input ? input.value.trim() : ''
      if (val) handleScanCode(val)
    })
  }

  const forceConfirmBtn = document.querySelector('#force-confirm-seq-btn')
  if (forceConfirmBtn) {
    forceConfirmBtn.addEventListener('click', () => {
      const confirmModal = document.querySelector('#confirm-modal')
      if (confirmModal) confirmModal.classList.remove('active')
      if (pendingOutOfSeqCode) handleScanCode(pendingOutOfSeqCode, true)
    })
  }

  const cancelOutSeqBtn = document.querySelector('#cancel-out-seq-btn')
  if (cancelOutSeqBtn) {
    cancelOutSeqBtn.addEventListener('click', () => {
      const confirmModal = document.querySelector('#confirm-modal')
      const qrModal = document.querySelector('#qr-modal')
      if (confirmModal) confirmModal.classList.remove('active')
      if (qrModal) qrModal.classList.add('active')
    })
  }
}

function closeAndRemoveCameraStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }
  const video = document.querySelector('#qr-video')
  if (video) {
    video.srcObject = null
  }
}

function closeAndRemoveQrModals() {
  closeAndRemoveCameraStream()
  const container = document.querySelector('#qr-modals-container')
  if (container) {
    container.innerHTML = ''
  }
}

// Render Supervisor Dashboard (Mounted ONLY for SUPERVISOR role)
async function renderSupervisorDashboard() {
  const kpiContainer = document.querySelector('#kpi-cards-container')
  const workflowContainer = document.querySelector('#workflow-progress-container')
  const tableContainer = document.querySelector('#kpi-table-container')

  if (!kpiContainer) return

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

    const { trucks, statuses, plans } = await getLogisticsTodayStatus()
    const effectiveEvents = await getEffectiveTripEvents()

    const nodes = ['YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB']
    const workflowHtml = (trucks || []).map(t => {
      const status = (statuses || []).find(s => s.truck_id === t.truck_id) || {}
      const activePlan = (plans || []).find(p => p.truck_id === t.truck_id && p.trip_status !== 'CANCELLED' && p.trip_status !== 'COMPLETED')
      const currentTripId = status.current_trip_id || (activePlan ? activePlan.trip_id : null)

      // Calculate N (currentTripNo) and M (totalTrips) for truck t on current plan_date
      const truckTrips = (plans || [])
        .filter(p => p.truck_id === t.truck_id && p.trip_status !== 'CANCELLED')
        .sort((a, b) => {
          const timeCompare = new Date(a.plan_departure) - new Date(b.plan_departure)
          if (timeCompare !== 0) return timeCompare
          return String(a.trip_id).localeCompare(String(b.trip_id))
        })

      const totalTrips = truckTrips.length
      const currentIndex = currentTripId ? truckTrips.findIndex(p => p.trip_id === currentTripId) : -1
      const currentTripNo = currentIndex >= 0 ? currentIndex + 1 : null

      let tripProgressBadge = ''
      if (totalTrips === 0) {
        tripProgressBadge = '今日無排程'
      } else if (currentTripNo !== null) {
        tripProgressBadge = `第 ${currentTripNo} 趟 / 共 ${totalTrips} 趟`
      } else {
        const allCompleted = truckTrips.length > 0 && truckTrips.every(p => p.trip_status === 'COMPLETED')
        if (allCompleted) {
          tripProgressBadge = `第 ${totalTrips} 趟 / 共 ${totalTrips} 趟 ｜ 已完成`
        } else {
          tripProgressBadge = `今日共 ${totalTrips} 趟 ｜ 目前無執行中趟次`
        }
      }

      // Filter events strictly by currentTripId for Cycle Isolation & Auto-Reset
      const currentTripEvents = currentTripId
        ? (effectiveEvents || []).filter(e => e.trip_id === currentTripId)
        : []
      const completedCodes = new Set(currentTripEvents.map(e => e.event_code))

      const nodeStepsHtml = nodes.map(code => {
        const evt = currentTripEvents.find(e => e.event_code === code)
        let stateClass = 'node-pending'
        let icon = '○'

        if (completedCodes.has(code)) {
          stateClass = 'node-completed'
          icon = '●'
        } else if (code === status.next_event_code || (!completedCodes.size && code === 'YM_OUT')) {
          stateClass = 'node-current'
          icon = '◉'
        }

        const timeStr = evt ? formatTime24(evt.effective_event_time) : '--:--'
        const displayLabel = SHORT_EVENT_LABELS[code] || code
        return `
          <div class="workflow-step ${stateClass}">
            <span class="step-icon">${icon}</span>
            <span class="step-code" title="${code}">${displayLabel}</span>
            <span class="step-time">${timeStr}</span>
          </div>
        `
      }).join('<span class="workflow-line"></span>')

      const statusText = (() => {
        const isLastTrip = currentIndex >= 0 && currentIndex === totalTrips - 1
        const allCompleted = totalTrips > 0 && truckTrips.every(p => p.trip_status === 'COMPLETED')
        if (totalTrips === 0) return '今日無排程'
        if (allCompleted || (isLastTrip && completedCodes.has('YM_CAB'))) return '當日作業結束'
        if (completedCodes.has('YM_CAB')) return '準備下一趟'
        if (completedCodes.size === 0) return '楊梅廠準備出廠'
        return STATUS_LABELS[status.current_status] || status.current_status || '-'
      })()
      return `
        <div class="workflow-card">
          <div class="wf-truck-header">
            <strong>${t.truck_no} (${t.truck_name || t.truck_id}) ｜ <span class="text-primary">${tripProgressBadge}</span></strong>
            <span class="badge-tag">${statusText}</span>
          </div>
          <div class="workflow-steps">${nodeStepsHtml}</div>
        </div>
      `
    }).join('')

    if (workflowContainer) workflowContainer.innerHTML = workflowHtml || '<p>目前無車輛流程</p>'

    const detailsRes = await getKpiTripDetails(currentPeriod)
    const details = detailsRes.data || []

    const tableRows = details.map(d => {
      const statusText = STATUS_LABELS[d.status] || d.status || '-'
      return `
        <tr>
          <td><code>${d.planDate}</code></td>
          <td>第 ${d.tripNo} 趟 (<code>${d.tripId}</code>)</td>
          <td>${d.truckId}</td>
          <td>${formatTime24(d.planDeparture)}</td>
          <td>${d.actualYmOut ? formatTime24(d.actualYmOut) : '-'}</td>
          <td>${d.departureDifferenceMinutes !== null ? `${d.departureDifferenceMinutes > 0 ? '+' : ''}${d.departureDifferenceMinutes} 分` : '-'}</td>
          <td><span class="badge ${d.departureOnTime ? 'badge-role-driver' : 'badge-fail'}">${d.departureOnTime ? '準時' : '未準時'}</span></td>
          <td><span class="badge ${d.operationalComplete ? 'badge-role-driver' : 'badge-role-default'}">${statusText}</span></td>
        </tr>
      `
    }).join('')

    if (tableContainer) {
      tableContainer.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead><tr><th>計畫日期</th><th>趟次 / ID</th><th>指派車輛</th><th>計畫發車時間</th><th>實際楊梅出發</th><th>發車時差</th><th>出發判定</th><th>當前狀態</th></tr></thead>
            <tbody>${tableRows || '<tr><td colspan="8">無車趟明細</td></tr>'}</tbody>
          </table>
        </div>
      `
    }
    renderCharts(kpi)
  } catch (err) {
    if (kpiContainer) kpiContainer.innerHTML = `<div class="status-box error">❌ 讀取 KPI 失敗: ${err.message}</div>`
  }
}

function renderCharts(kpi) {
  const chartCycle = document.querySelector('#chart-cycle-time')
  const chartAch = document.querySelector('#chart-achievement')
  const chartDep = document.querySelector('#chart-departure')
  const chartExc = document.querySelector('#chart-exception')

  if (chartCycle) {
    chartCycle.innerHTML = `
      <div class="bar-chart-mock">
        <div class="bar-item"><span class="bar-label">平均 Cycle</span><div class="bar-fill" style="width: ${Math.min(100, (kpi.averageCycleMinutes || 120) / 1.5)}%;"></div><span>${kpi.averageCycleMinutes || 120} 分</span></div>
        <div class="bar-item"><span class="bar-label">標準 Cycle</span><div class="bar-fill standard" style="width: 80%;"></div><span>120 分</span></div>
      </div>
    `
  }
  if (chartAch) {
    chartAch.innerHTML = `
      <div class="bar-chart-mock">
        <div class="bar-item"><span class="bar-label">計畫 Trip</span><div class="bar-fill" style="width: 100%;"></div><span>${kpi.plannedTrips} 趟</span></div>
        <div class="bar-item"><span class="bar-label">完成 Trip</span><div class="bar-fill success" style="width: ${kpi.achievementRate}%;"></div><span>${kpi.completedTrips} 趟</span></div>
      </div>
    `
  }
  if (chartDep) {
    chartDep.innerHTML = `
      <div class="bar-chart-mock">
        <div class="bar-item"><span class="bar-label">出發準時率</span><div class="bar-fill info" style="width: ${kpi.departurePunctualityRate}%;"></div><span>${kpi.departurePunctualityRate}%</span></div>
      </div>
    `
  }
  if (chartExc) {
    chartExc.innerHTML = `
      <div class="bar-chart-mock">
        <div class="bar-item"><span class="bar-label">異常趟數</span><div class="bar-fill warning" style="width: ${Math.min(100, kpi.exceptionRate * 3)}%;"></div><span>${kpi.exceptionTrips} 趟</span></div>
      </div>
    `
  }
}

// Logistics Operational UI Render (Mounted ONLY for LOGISTICS / ADMIN role)
// Renders 3 Operational Monitoring components: Realtime Status, 7-Node Workflow, and Read-Only Trip Execution Table
// Uses ONLY operational data sources (getLogisticsTodayStatus, getEffectiveTripEvents), ZERO KPI RPC calls!
async function renderLogisticsToday() {
  const realtimeContainer = document.querySelector('#logistics-realtime-status')
  const progressContainer = document.querySelector('#logistics-7node-progress')
  const tableContainer = document.querySelector('#logistics-trip-execution-table')

  if (!realtimeContainer) return

  try {
    const { trucks, statuses, plans } = await getLogisticsTodayStatus()
    const effectiveEvents = await getEffectiveTripEvents()

    // 1. Render 車輛即時車況 (#logistics-realtime-status)
    const cardsHtml = (trucks || []).map(t => {
      const s = (statuses || []).find(st => st.truck_id === t.truck_id) || {}
      const activePlan = (plans || []).find(p => p.truck_id === t.truck_id && p.trip_status !== 'CANCELLED' && p.trip_status !== 'COMPLETED')
      const currentTripId = s.current_trip_id || (activePlan ? activePlan.trip_id : null)
      const currentTripEvts = currentTripId ? (effectiveEvents || []).filter(e => e.trip_id === currentTripId) : []
      const truckTrips = (plans || []).filter(p => p.truck_id === t.truck_id && p.trip_status !== 'CANCELLED')

      let statusText = STATUS_LABELS[s.current_status] || s.current_status || '-'
      if (truckTrips.length > 0 && currentTripEvts.length === 0) {
        statusText = '楊梅廠準備出廠'
      }

      const lastEventText = SHORT_EVENT_LABELS[s.last_event_code] || s.last_event_code || '無'
      const nextEventText = SHORT_EVENT_LABELS[s.next_event_code] || s.next_event_code || '楊梅出廠'

      return `
        <div class="truck-card">
          <div class="truck-card-header">
            <h4>${t.truck_no} (${t.truck_name || t.truck_id})</h4>
            <span class="status-pill status-green">${statusText}</span>
          </div>
          <div class="truck-card-body">
            <p>最近回報: <strong>${lastEventText}</strong> (${s.last_event_time ? formatTime24(s.last_event_time) : '-'})</p>
            <p>下一預期節點: <code>${nextEventText}</code></p>
            ${s.exception_flag ? `<p class="text-warning">⚠️ ${s.exception_type || '作業異常'}</p>` : ''}
          </div>
        </div>
      `
    }).join('')

    realtimeContainer.innerHTML = `<div class="trucks-grid">${cardsHtml}</div>`

    // 2. Render 7 節點橫式流程進度 (#logistics-7node-progress) with N / M progress badge & strict Trip-Level Cycle Reset
    const nodes = ['YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB']
    const workflowHtml = (trucks || []).map(t => {
      const status = (statuses || []).find(s => s.truck_id === t.truck_id) || {}
      const activePlan = (plans || []).find(p => p.truck_id === t.truck_id && p.trip_status !== 'CANCELLED' && p.trip_status !== 'COMPLETED')
      const currentTripId = status.current_trip_id || (activePlan ? activePlan.trip_id : null)

      // Calculate N (currentTripNo) and M (totalTrips) for truck t on current plan_date
      const truckTrips = (plans || [])
        .filter(p => p.truck_id === t.truck_id && p.trip_status !== 'CANCELLED')
        .sort((a, b) => {
          const timeCompare = new Date(a.plan_departure) - new Date(b.plan_departure)
          if (timeCompare !== 0) return timeCompare
          return String(a.trip_id).localeCompare(String(b.trip_id))
        })

      const totalTrips = truckTrips.length
      const currentIndex = currentTripId ? truckTrips.findIndex(p => p.trip_id === currentTripId) : -1
      const currentTripNo = currentIndex >= 0 ? currentIndex + 1 : null

      let tripProgressBadge = ''
      if (totalTrips === 0) {
        tripProgressBadge = '今日無排程'
      } else if (currentTripNo !== null) {
        tripProgressBadge = `第 ${currentTripNo} 趟 / 共 ${totalTrips} 趟`
      } else {
        const allCompleted = truckTrips.length > 0 && truckTrips.every(p => p.trip_status === 'COMPLETED')
        if (allCompleted) {
          tripProgressBadge = `第 ${totalTrips} 趟 / 共 ${totalTrips} 趟 ｜ 已完成`
        } else {
          tripProgressBadge = `今日共 ${totalTrips} 趟 ｜ 目前無執行中趟次`
        }
      }

      // Filter events strictly by currentTripId for Cycle Isolation & Auto-Reset
      const currentTripEvents = currentTripId
        ? (effectiveEvents || []).filter(e => e.trip_id === currentTripId)
        : []
      const completedCodes = new Set(currentTripEvents.map(e => e.event_code))

      const nodeStepsHtml = nodes.map(code => {
        const evt = currentTripEvents.find(e => e.event_code === code)
        let stateClass = 'node-pending'
        let icon = '○'

        if (completedCodes.has(code)) {
          stateClass = 'node-completed'
          icon = '●'
        } else if (code === status.next_event_code || (!completedCodes.size && code === 'YM_OUT')) {
          stateClass = 'node-current'
          icon = '◉'
        }

        const timeStr = evt ? formatTime24(evt.effective_event_time) : '--:--'
        const displayLabel = SHORT_EVENT_LABELS[code] || code
        return `
          <div class="workflow-step ${stateClass}">
            <span class="step-icon">${icon}</span>
            <span class="step-code" title="${code}">${displayLabel}</span>
            <span class="step-time">${timeStr}</span>
          </div>
        `
      }).join('<span class="workflow-line"></span>')

      const statusText = (() => {
        const isLastTrip = currentIndex >= 0 && currentIndex === totalTrips - 1
        const allCompleted = totalTrips > 0 && truckTrips.every(p => p.trip_status === 'COMPLETED')
        if (totalTrips === 0) return '今日無排程'
        if (allCompleted || (isLastTrip && completedCodes.has('YM_CAB'))) return '當日作業結束'
        if (completedCodes.has('YM_CAB')) return '準備下一趟'
        if (completedCodes.size === 0) return '楊梅廠準備出廠'
        return STATUS_LABELS[status.current_status] || status.current_status || '-'
      })()

      return `
        <div class="workflow-card">
          <div class="wf-truck-header">
            <strong>${t.truck_no} (${t.truck_name || t.truck_id}) ｜ <span class="text-primary">${tripProgressBadge}</span></strong>
            <span class="badge-tag">${statusText}</span>
          </div>
          <div class="workflow-steps">${nodeStepsHtml}</div>
        </div>
      `
    }).join('')

    if (progressContainer) progressContainer.innerHTML = workflowHtml || '<p>目前無車輛流程</p>'

    // 3. Render 車趟排程計畫與執行實績 Table (#logistics-trip-execution-table) using active period filter
    await renderLogisticsExecutionTable()
  } catch (err) {
    if (realtimeContainer) realtimeContainer.innerHTML = `<div class="status-box error">❌ 載入營運監控失敗: ${err.message}</div>`
  }
}

/**
 * Date Range Helper for LOGISTICS Execution Period Filter
 * Calculates Monday ~ Saturday date range for Asia/Taipei timezone.
 */
export function getLogisticsPeriodDates(periodKey) {
  const now = new Date()

  const formatYMD = (d) => {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  const todayYmd = formatYMD(now)

  if (periodKey === 'today') {
    return {
      startDate: todayYmd,
      endDate: todayYmd,
      displayLabel: `顯示期間：${todayYmd}`
    }
  }

  // Calculate Monday to Saturday for thisWeek (offset 0) or nextWeek (offset 1)
  const offsetWeeks = periodKey === 'nextWeek' ? 1 : 0
  const day = now.getDay() // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day

  const monday = new Date(now)
  monday.setDate(now.getDate() + diffToMonday + offsetWeeks * 7)

  const saturday = new Date(monday)
  saturday.setDate(monday.getDate() + 5)

  const startYmd = formatYMD(monday)
  const endYmd = formatYMD(saturday)

  return {
    startDate: startYmd,
    endDate: endYmd,
    displayLabel: `顯示期間：${startYmd} ～ ${endYmd}`
  }
}

/**
 * Helper to compute minute of day from time/timestamp string (HH:mm) in Asia/Taipei local time for deterministic sorting
 * Handles timestamptz ISO strings (e.g. "2026-08-31T23:00:00Z") by converting to local hours and minutes (UTC+8)
 */
export function getMinutesOfDay(value) {
  if (!value) return Number.MAX_SAFE_INTEGER

  const text = String(value).trim()

  // 1. If text is a simple time string like "07:00" or "07:00:00" (no date/timezone)
  const simpleTimeMatch = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (simpleTimeMatch) {
    const hour = Number(simpleTimeMatch[1])
    const minute = Number(simpleTimeMatch[2])
    if (Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return hour * 60 + minute
    }
  }

  // 2. Parse as Date object for timestamptz ISO strings (e.g. "2026-08-31T23:00:00Z" or "2026-09-01T07:00:00+08:00")
  const d = new Date(text)
  if (!isNaN(d.getTime())) {
    return d.getHours() * 60 + d.getMinutes()
  }

  // 3. Fallback regex match for (T|whitespace|^)(HH):(MM)
  const match = text.match(/(?:T|\s|^)(\d{1,2}):(\d{2})/)
  if (match) {
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return hour * 60 + minute
    }
  }

  return Number.MAX_SAFE_INTEGER
}

let logisticsExecutionPeriod = localStorage.getItem('logistics.execution.period') || 'today'
let currentExecutionRequestId = 0

async function renderLogisticsExecutionTable(targetPeriod) {
  if (targetPeriod) {
    logisticsExecutionPeriod = targetPeriod
    localStorage.setItem('logistics.execution.period', targetPeriod)
  }

  const periodKey = logisticsExecutionPeriod
  const container = document.querySelector('#logistics-trip-execution-table')
  const rangeDisplayEl = document.querySelector('#execution-period-range')
  if (!container) return

  // Update Period Button Active UI Highlight
  document.querySelectorAll('.period-filter-btn').forEach(btn => {
    const btnPeriod = btn.getAttribute('data-period')
    if (btnPeriod === periodKey) {
      btn.classList.add('active')
    } else {
      btn.classList.remove('active')
    }
  })

  const dates = getLogisticsPeriodDates(periodKey)
  if (rangeDisplayEl) {
    rangeDisplayEl.textContent = dates.displayLabel
  }

  container.innerHTML = '<div class="spinner"></div><span>載入車趟排程與執行實績中...</span>'

  const requestId = ++currentExecutionRequestId

  try {
    const plans = await getTripExecutionByRange(dates.startDate, dates.endDate)
    if (requestId !== currentExecutionRequestId) return

    const { trucks, statuses } = await getLogisticsTodayStatus()
    if (requestId !== currentExecutionRequestId) return

    const effectiveEvents = await getEffectiveTripEvents()
    if (requestId !== currentExecutionRequestId) return

    let drivers = []
    try {
      drivers = await getLogisticsDrivers()
    } catch (err) {
      console.warn('[DEBUG LOGISTICS] failed to fetch drivers for table:', err.message)
    }

    const truckMap = new Map((trucks || []).map(t => [t.truck_id || t.truckId, t.truck_name || t.truck_no || t.truck_id]))
    const driverMap = new Map((drivers || []).map(d => [d.driver_id || d.driverId, d.driver_name || d.driverName || d.driver_id]))

    if (!plans || plans.length === 0) {
      container.innerHTML = '<p class="placeholder-text margin-top">此期間無排程資料</p>'
      return
    }

    // Frontend Deterministic Sorting: 1. plan_date ASC -> 2. plan_departure (HH:mm local mins) ASC -> 3. truck_id ASC -> 4. trip_id ASC
    plans.sort((a, b) => {
      const dateA = String(a.plan_date || a.planDate || '')
      const dateB = String(b.plan_date || b.planDate || '')
      const dateCompare = dateA.localeCompare(dateB)
      if (dateCompare !== 0) return dateCompare

      const minA = getMinutesOfDay(a.plan_departure || a.planDeparture)
      const minB = getMinutesOfDay(b.plan_departure || b.planDeparture)
      const timeCompare = minA - minB
      if (timeCompare !== 0) return timeCompare

      const truckA = String(a.truck_id || a.truckId || '')
      const truckB = String(b.truck_id || b.truckId || '')
      const truckCompare = truckA.localeCompare(truckB)
      if (truckCompare !== 0) return truckCompare

      const tripIdA = String(a.trip_id || a.tripId || '')
      const tripIdB = String(b.trip_id || b.tripId || '')
      return tripIdA.localeCompare(tripIdB)
    })

    // Console Debug Logging for Verification Evidence
    console.log('[DEBUG TABLE SORT] final execution plans rendering array:', plans.length, 'items')
    console.table(
      plans.map(r => ({
        date: r.plan_date || r.planDate,
        rawDeparture: r.plan_departure || r.planDeparture,
        minutes: getMinutesOfDay(r.plan_departure || r.planDeparture),
        formattedTime: formatTime24(r.plan_departure || r.planDeparture),
        tripId: r.trip_id || r.tripId,
        truckId: r.truck_id || r.truckId,
        truckName: truckMap.get(r.truck_id || r.truckId) || r.truck_id,
        driverId: r.driver_id || r.driverId,
        driverName: driverMap.get(r.driver_id || r.driverId) || r.driver_id
      }))
    )

    const tableRows = plans.map(p => {
      const st = (statuses || []).find(s => s.truck_id === p.truck_id) || {}
      const pEvents = (effectiveEvents || []).filter(e => e.trip_id === p.trip_id)
      const ymOutEvt = pEvents.find(e => e.event_code === 'YM_OUT')

      const statusText = STATUS_LABELS[p.trip_status] || p.trip_status || '-'
      const lastEventText = SHORT_EVENT_LABELS[st.last_event_code] || st.last_event_code || '-'
      const nextEventText = SHORT_EVENT_LABELS[st.next_event_code] || st.next_event_code || '-'

      const isFutureOrUnstarted = p.trip_status === 'WAITING' && pEvents.length === 0

      // Map Master Data Names: truck_name & driver_name (with default_driver_id fallback if NULL)
      const truckName = truckMap.get(p.truck_id) || p.truck_id || '-'
      const truckObj = (trucks || []).find(t => t.truck_id === p.truck_id)
      const rawDriverId = p.driver_id || truckObj?.default_driver_id
      const driverName = driverMap.get(rawDriverId) || rawDriverId || '-'

      return `
        <tr>
          <td><code>${p.plan_date}</code></td>
          <td>第 ${p.trip_no} 趟 (<code>${p.trip_id}</code>)</td>
          <td><strong>${truckName}</strong></td>
          <td>${driverName}</td>
          <td>${formatTime24(p.plan_departure)}</td>
          <td>${ymOutEvt ? formatTime24(ymOutEvt.effective_event_time) : '-'}</td>
          <td><span class="badge ${p.trip_status === 'COMPLETE' || p.trip_status === 'COMPLETED' ? 'badge-role-driver' : (p.trip_status === 'CANCELLED' ? 'badge-fail' : 'badge-role-default')}">${statusText}</span></td>
          <td>${isFutureOrUnstarted ? '-' : lastEventText}</td>
          <td>${isFutureOrUnstarted ? '-' : nextEventText}</td>
          <td>${st.exception_flag ? `<span class="text-warning">⚠️ ${st.exception_type || '作業異常'}</span>` : '-'}</td>
        </tr>
      `
    }).join('')

    container.innerHTML = `
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>計畫日期</th>
              <th>趟次 / ID</th>
              <th>指派車輛</th>
              <th>指派司機</th>
              <th>計畫發車時間</th>
              <th>實際楊梅出發</th>
              <th>當前狀態</th>
              <th>最近回報節點</th>
              <th>下一預期節點</th>
              <th>異常狀況</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `
  } catch (err) {
    if (requestId !== currentExecutionRequestId) return
    console.error('[DEBUG LOGISTICS] renderLogisticsExecutionTable error:', err.message)
    container.innerHTML = `<div class="msg-box error">❌ 讀取資料失敗: ${err.message}</div>`
  }
}

async function renderWeeklyPlan() {
  const container = document.querySelector('#weekly-plan-content')
  if (!container) return

  const todayStr = new Date().toISOString().split('T')[0]
  try {
    console.log('[DEBUG LOGISTICS] loading weekly plan for date:', todayStr)
    const plans = await getWeeklyTripPlan(todayStr)
    console.log('[DEBUG LOGISTICS] weekly plan loaded:', { count: plans?.length ?? 0 })

    if (!plans || plans.length === 0) {
      container.innerHTML = `<div class="status-box info">ℹ 本週目前尚無車趟計畫 (可點擊上方「＋新增 Trip」或「自動排車」建置計畫)</div>`
      return
    }

    const rowsHtml = plans.map(p => {
      const isWaiting = p.trip_status === 'WAITING'
      const typeText = TRIP_TYPE_LABELS[p.plan_type] || p.plan_type
      const statusText = STATUS_LABELS[p.trip_status] || p.trip_status || '-'

      return `
        <tr>
          <td><code>${p.plan_date}</code></td>
          <td>第 ${p.trip_no} 趟</td>
          <td><code>${p.trip_id}</code></td>
          <td><strong>${p.truck_id}</strong></td>
          <td>${p.driver_id || '未指派'}</td>
          <td>${formatTime24(p.plan_departure)}</td>
          <td><span class="badge ${p.plan_type === 'ADDED' ? 'badge-role-driver' : 'badge-role-default'}">${typeText}</span></td>
          <td><span class="badge ${p.trip_status === 'CANCELLED' ? 'badge-fail' : (p.trip_status === 'COMPLETED' ? 'badge-role-driver' : 'badge-role-default')}">${statusText}</span></td>
          <td>
            ${isWaiting ? `<button class="btn btn-sm btn-danger btn-cancel-trip" data-id="${p.trip_id}">取消 Trip</button>` : '-'}
          </td>
        </tr>
      `
    }).join('')

    container.innerHTML = `
      <div class="table-responsive margin-top">
        <table class="data-table">
          <thead>
            <tr>
              <th>計畫日期</th>
              <th>趟次</th>
              <th>Trip ID</th>
              <th>指派車輛</th>
              <th>指派司機</th>
              <th>計畫發車時間</th>
              <th>車趟類型</th>
              <th>當前狀態</th>
              <th>操作功能</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `

    // Bind Cancel Trip Handlers
    container.querySelectorAll('.btn-cancel-trip').forEach(btn => {
      btn.onclick = async (e) => {
        const tripId = e.target.getAttribute('data-id')
        if (tripId) await handleCancelTrip(tripId)
      }
    })

  } catch (err) {
    console.error('[DEBUG LOGISTICS] renderWeeklyPlan error:', err.message)
    container.innerHTML = `<div class="status-box error">❌ 載入週間計畫失敗: ${err.message}</div>`
  }
}

// Driver Home UI Render (Mounted ONLY for DRIVER role)
async function renderDriverHome() {
  const container = document.querySelector('#driver-home-content')
  if (!container) return
  try {
    const homeData = await getDriverHome()

    // Calculate driver's/truck's own valid non-cancelled trips (N) and current trip's 1-based index (M)
    const validTasks = (homeData.todayTasks || [])
      .filter(t => t.tripStatus !== 'CANCELLED')
      .sort((a, b) => {
        const timeCompare = String(a.planDeparture || '').localeCompare(String(b.planDeparture || ''))
        if (timeCompare !== 0) return timeCompare
        return String(a.tripId || '').localeCompare(String(b.tripId || ''))
      })

    const totalTrips = validTasks.length
    const currentIndex = homeData.currentTripId
      ? validTasks.findIndex(t => t.tripId === homeData.currentTripId)
      : -1
    const currentTripNumber = currentIndex >= 0 ? currentIndex + 1 : null

    const isDayEnd = homeData.currentStatus === 'DAY_END' && totalTrips > 0
    const isNoTrip = homeData.currentStatus === 'NO_TRIP' || totalTrips === 0

    let tripProgressText = ''
    if (isDayEnd) {
      tripProgressText = `今日總趟次 ${totalTrips} 趟已全數完成`
    } else if (currentTripNumber !== null && totalTrips > 0) {
      tripProgressText = `第 ${currentTripNumber} 趟 / 共 ${totalTrips} 趟`
    } else if (isNoTrip) {
      tripProgressText = '今日無排程'
    } else if (totalTrips > 0) {
      tripProgressText = `共 ${totalTrips} 趟`
    } else {
      tripProgressText = '今日無排程'
    }

    const nextNodeInfo = isDayEnd
      ? '當日作業結束'
      : (homeData.nextEventCode ? (SHORT_EVENT_LABELS[homeData.nextEventCode] || EVENT_CODES[homeData.nextEventCode]?.name || homeData.nextEventCode) : '無')

    const lastEventDisplay = homeData.lastEventCode
      ? `${SHORT_EVENT_LABELS[homeData.lastEventCode] || homeData.lastEventCode} (${formatTime24(homeData.lastEventTime)})`
      : '無 (-)'

    const planDepartureTimeStr = (isNoTrip || isDayEnd || !homeData.planDeparture)
      ? '-'
      : formatTime24(homeData.planDeparture)

    const statusText = isDayEnd
      ? '當日作業結束'
      : (STATUS_LABELS[homeData.currentStatus] || homeData.currentStatus || '-')

    container.innerHTML = `
      <div class="driver-card-header">
        <div class="driver-info">
          <h2>${homeData.truckNo} (${homeData.truckName || homeData.truckNo}) ｜ 司機：${homeData.driverName}</h2>
        </div>
        <div class="status-pill status-${homeData.exceptionFlag ? 'red' : (isNoTrip ? 'yellow' : 'green')}">
          ${homeData.exceptionFlag ? `⚠️ ${homeData.exceptionType || '作業異常'}` : `🟢 ${statusText}`}
        </div>
      </div>

      <div class="driver-status-body margin-top">
        <div class="driver-metrics-grid">
          <div class="metric-box"><span class="label">車號：</span><strong class="value">${homeData.truckNo}</strong></div>
          <div class="metric-box"><span class="label">司機：</span><strong class="value">${homeData.driverName}</strong></div>
          <div class="metric-box"><span class="label">今日趟次：</span><strong class="value">${tripProgressText}</strong></div>
          <div class="metric-box"><span class="label">計畫出發：</span><strong class="value">${planDepartureTimeStr}</strong></div>
          <div class="metric-box"><span class="label">目前狀態：</span><strong class="value text-success">${statusText}</strong></div>
          <div class="metric-box"><span class="label">最近回報：</span><strong class="value">${lastEventDisplay}</strong></div>
        </div>

        <div class="next-node-box margin-top">
          <span class="label">下一預期作業節點：</span>
          <strong class="value text-primary">${nextNodeInfo}</strong>
        </div>

        ${homeData.exceptionFlag ? `<div class="msg-box error margin-top">⚠️ 異常訊息：${homeData.exceptionType || '超時未回報或掃碼順序不符'}</div>` : ''}

        <div class="driver-actions margin-top">
          <button id="open-qr-scan-btn" class="btn btn-primary btn-block btn-lg" ${homeData.hasTrip === false ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>📷 掃描 QR Code / 節點回報</button>
        </div>
      </div>
    `
    const openQrScanBtn = document.querySelector('#open-qr-scan-btn')
    if (openQrScanBtn && homeData.hasTrip !== false) {
      openQrScanBtn.addEventListener('click', () => {
        const qrModal = document.querySelector('#qr-modal')
        if (qrModal) qrModal.classList.add('active')
      })
    }
  } catch (err) {
    console.error('[DEBUG UI LOGIN] renderDriverHome error:', err.message)
    container.innerHTML = `
      <div class="driver-card-header">
        <div class="driver-info"><h2>司機端作業首頁</h2></div>
        <div class="status-pill status-yellow">⚠️ 車況紀錄</div>
      </div>
      <div class="driver-status-body">
        <div class="status-box error">❌ 載入司機資料失敗: ${err.message}</div>
      </div>
    `
  }
}

// QR Code Scanning Trigger Logic (Role Guarded for DRIVER role only)
async function handleScanCode(eventCode, forceAccept = false) {
  const msgBox = document.querySelector('#qr-scan-msg')
  
  if (!currentProfile || currentProfile.role !== 'DRIVER') {
    if (msgBox) {
      msgBox.className = 'msg-box error'
      msgBox.textContent = '❌ 權限被拒：僅有司機 (DRIVER) 身分可以使用作業節點 QR Code 掃描與回報'
    }
    return
  }

  if (!EVENT_CODES[eventCode]) {
    if (msgBox) {
      msgBox.className = 'msg-box error'
      msgBox.textContent = '❌ 無效的 QR Code (拒絕執行非 7 合法節點之 URL/Script Payload)'
    }
    return
  }

  if (msgBox) {
    msgBox.className = 'msg-box loading'
    msgBox.textContent = `處理中 (${eventCode})...`
  }

  try {
    let res = forceAccept ? await confirmOutOfSequenceEvent(eventCode) : await scanEvent(eventCode)

    if (res.success) {
      if (msgBox) {
        msgBox.className = 'msg-box success'
        msgBox.textContent = res.alreadyProcessed ? `ℹ 事件先前已成功處理過 (${eventCode})` : `✅ 回報成功！節點：${eventCode}`
      }
      setTimeout(() => {
        const qrModal = document.querySelector('#qr-modal')
        if (qrModal) qrModal.classList.remove('active')
        if (msgBox) msgBox.style.display = 'none'
        renderApp()
      }, 1000)
    } else if (res.requiresConfirm) {
      const qrModal = document.querySelector('#qr-modal')
      if (qrModal) qrModal.classList.remove('active')
      pendingOutOfSeqCode = eventCode
      const expectedText = document.querySelector('#expected-node-text')
      const actualText = document.querySelector('#actual-node-text')
      if (expectedText) expectedText.textContent = EVENT_CODES[res.data.expected] ? EVENT_CODES[res.data.expected].name : res.data.expected
      if (actualText) actualText.textContent = EVENT_CODES[res.data.actual] ? EVENT_CODES[res.data.actual].name : res.data.actual
      const confirmModal = document.querySelector('#confirm-modal')
      if (confirmModal) confirmModal.classList.add('active')
    } else {
      if (msgBox) {
        msgBox.className = 'msg-box error'
        msgBox.textContent = `❌ [${res.errorCode || 'ERROR'}] ${res.message}`
      }
    }
  } catch (err) {
    if (msgBox) {
      msgBox.className = 'msg-box error'
      msgBox.textContent = `❌ 錯誤: ${err.message}`
    }
  }
}

// Bind Driver & Management Login Form Handlers
document.querySelector('#driver-login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const truckId = document.querySelector('#driver-truck-select').value
  const pwd = document.querySelector('#driver-password').value

  console.log('[DEBUG UI LOGIN] login result: initiating loginDriver', { truckId })

  try {
    const res = await loginDriver(truckId, pwd)
    console.log('[DEBUG UI LOGIN] login result success:', res)
    console.log('[DEBUG UI LOGIN] app state after login:', {
      currentProfile: res.profile,
      role: res.profile ? res.profile.role : null
    })
    console.log('[DEBUG UI LOGIN] selected route: DRIVER')
    console.log('[DEBUG UI LOGIN] before render: renderApp')
    await renderApp()
    console.log('[DEBUG UI LOGIN] after render: DRIVER UI rendered successfully')
  } catch (err) {
    console.error('[DEBUG UI LOGIN] driver login failed error:', err.message)
    alert(`登入失敗: ${err.message}`)
  }
})

document.querySelector('#mgmt-login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const loginName = document.querySelector('#mgmt-login-name').value
  const pwd = document.querySelector('#mgmt-password').value

  console.log('[DEBUG UI LOGIN] login result: initiating loginManagement', { loginName })

  try {
    const res = await loginManagement(loginName, pwd)
    console.log('[DEBUG UI LOGIN] login result success:', res)
    await renderApp()
  } catch (err) {
    console.error('[DEBUG UI LOGIN] mgmt login failed error:', err.message)
    alert(`登入失敗: ${err.message}`)
  }
})

// Options & Truck Select Helper
async function loadTruckOptions() {
  const selectEl = document.querySelector('#driver-truck-select')
  try {
    const trucks = await getActiveTrucks()
    selectEl.innerHTML = (trucks || []).map(t => `<option value="${t.truck_id}">${t.truck_name || t.truck_no} (${t.truck_no})</option>`).join('')
  } catch (err) {
    selectEl.innerHTML = `<option value="">載入車輛失敗</option>`
  }
}

// Initializations
loadTruckOptions()
setupRealtimeSubscription()
renderApp()