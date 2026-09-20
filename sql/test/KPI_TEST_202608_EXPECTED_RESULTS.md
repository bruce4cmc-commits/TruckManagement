# KPI_TEST_202608_EXPECTED_RESULTS.md

## 卡車循環運輸管理系統 V1.2 - 1 個月 KPI 確定性測試預期答案集

本檔案記錄 `sql/test/01_KPI_Month_Test_Data_202608.sql` 測試 Seed 資料集之**確切計算結果 (Expected Results)**。
用於直接對照 Supervisor / Logistics Dashboard 與 Supabase RPC `get_dashboard_kpi()` 之查詢回傳值。

---

### 一、整體測試期間與資料總覽 (2026-08-01 ～ 2026-09-18)

* **測試日期範圍**：2026-08-01 ～ 2026-09-18 (包含 42 個營運日，週一～週六，星期日不排程)
* **資料識別 Prefix**：`KPI202608-`

| 資料表 (Table) | 總資料筆數 |
|---|---|
| **trip_plan** | **379** 筆 |
| **trip_event** | **2618** 筆 (含 14 筆 Correction Events) |
| **exception_log** | **12** 筆 |

---

### 二、2026 年 8 月整月 (2026-08-01 ～ 2026-08-31) KPI 確切預期數值

> **計算範圍**：2026-08-01 ～ 2026-08-31 (共 26 個營運日)

| KPI 指標項目 | 確切預期數值 (Expected Value) | 說明與公式 |
|---|---|---|
| **總計畫車趟 (plannedTrips)** | **230** 趟 | 排除 CANCELLED 車趟 (trip_status != CANCELLED) |
| **實際完成車趟 (completedTrips)** | **230** 趟 | trip_status = COMPLETE |
| **取消車趟 (cancelledTrips)** | **4** 趟 | trip_status = CANCELLED |
| **追加車趟 (addedTrips)** | **9** 趟 | plan_type = ADDED |
| **計畫達成率 (achievementRate)** | **100%** | (completedTrips / plannedTrips) * 100% |
| **執行發車次數 (executedYmOutCount)** | **230** 趟 | 具有有效 YM_OUT Event 之車趟 |
| **準時發車數 (onTimeDepartureCount)** | **209** 趟 | |actual_ym_out - plan_departure| <= 20 min |
| **延誤發車數 (lateDepartureCount)** | **21** 趟 | |actual_ym_out - plan_departure| > 20 min |
| **發車準時率 (departurePunctualityRate)** | **90.9%** | (onTimeDepartureCount / executedYmOutCount) * 100% |
| **可量測循環數 (measurableCycleCount)** | **178** 次 | 同車同日相鄰 YM_OUT (每日可量測 Cycle = 當日實際執行 Trips - 每台有執行任務車輛的當日最後一趟) |
| **準時循環數 (onTimeCycleCount)** | **155** 次 | Cycle Time <= 140 分鐘 |
| **超時循環數 (overtimeCycleCount)** | **23** 次 | Cycle Time > 140 分鐘 |
| **平均循環時間 (averageCycleMinutes)** | **121.1** 分鐘 | 總循環分鐘數 / 可量測 Cycle |
| **循環準時率 (cyclePunctualityRate)** | **87.1%** | (onTimeCycleCount / measurableCycleCount) * 100% |
| **異常 Trip 數 (exceptionTrips)** | **8** 趟 | 於 exception_log 有記錄之不重複 trip_id 數 |
| **異常率 (exceptionRate)** | **3.5%** | (exceptionTrips / executedTrips) * 100% |
| **Event 更正筆數 (correctionsCount)** | **9** 筆 | 帶有 is_manual_correction = true 之修正事件 |

#### Exception 異常類型分項統計 (2026-08-01 ～ 2026-08-31)
* TRAFFIC_JAM (嚴重塞車)：**2** 筆
* ACCIDENT (車禍事故)：**2** 筆
* TRUCK_FAILURE (車輛故障)：**2** 筆
* OTHER (其他異常)：**2** 筆

---

### 三、指定 5 個日期之 Daily KPI 確切數值

用於驗證 **Daily → Weekly → Monthly** 三層級之精準度。

> **每日可量測 Cycle 公式**：`當日實際執行 Trips - 每台有執行任務車輛的當日最後一趟` (依每日趟數與車輛數動態計算，不固定為 7)`

#### 1. 2026-08-03 (週一)
* **計畫車趟 (plannedTrips)**：8 趟 (T001: 5 趟, T002: 4 趟)
* **完成車趟 (completedTrips)**：8 趟
* **取消車趟 (cancelledTrips)**：0 趟
* **準時發車 (onTimeDepartureCount)**：7 趟
* **延誤發車 (lateDepartureCount)**：1 趟 (Trip 3 發車延誤 +25 min)
* **發車準時率 (departurePunctualityRate)**：87.5%
* **可量測 Cycle (measurableCycleCount)**：6 次 (T001: 4 次, T002: 3 次；每車最後 1 趟排除)
* **準時 Cycle (onTimeCycleCount)**：5 次
* **超時 Cycle (overtimeCycleCount)**：1 次
* **循環準時率 (cyclePunctualityRate)**：83.3%
* **異常 Trip 數 (exceptionTrips)**：1 趟 (TRAFFIC_JAM)

#### 2. 2026-08-10 (週一)
* **計畫車趟 (plannedTrips)**：9 趟
* **完成車趟 (completedTrips)**：9 趟
* **取消車趟 (cancelledTrips)**：0 趟
* **準時發車 (onTimeDepartureCount)**：8 趟
* **延誤發車 (lateDepartureCount)**：1 趟
* **發車準時率 (departurePunctualityRate)**：88.9%
* **可量測 Cycle (measurableCycleCount)**：7 次
* **準時 Cycle (onTimeCycleCount)**：6 次
* **超時 Cycle (overtimeCycleCount)**：1 次
* **循環準時率 (cyclePunctualityRate)**：85.7%
* **異常 Trip 數 (exceptionTrips)**：0 趟

#### 3. 2026-08-17 (週一)
* **計畫車趟 (plannedTrips)**：10 趟
* **完成車趟 (completedTrips)**：10 趟
* **取消車趟 (cancelledTrips)**：0 趟
* **準時發車 (onTimeDepartureCount)**：9 趟
* **延誤發車 (lateDepartureCount)**：1 趟
* **發車準時率 (departurePunctualityRate)**：90%
* **可量測 Cycle (measurableCycleCount)**：8 次
* **準時 Cycle (onTimeCycleCount)**：7 次
* **超時 Cycle (overtimeCycleCount)**：1 次
* **循環準時率 (cyclePunctualityRate)**：87.5%
* **異常 Trip 數 (exceptionTrips)**：1 趟 (TRAFFIC_JAM)

#### 4. 2026-08-24 (週一)
* **計畫車趟 (plannedTrips)**：8 趟
* **完成車趟 (completedTrips)**：8 趟
* **取消車趟 (cancelledTrips)**：0 趟
* **準時發車 (onTimeDepartureCount)**：7 趟
* **延誤發車 (lateDepartureCount)**：1 趟
* **發車準時率 (departurePunctualityRate)**：87.5%
* **可量測 Cycle (measurableCycleCount)**：6 次
* **準時 Cycle (onTimeCycleCount)**：5 次
* **超時 Cycle (overtimeCycleCount)**：1 次
* **循環準時率 (cyclePunctualityRate)**：83.3%
* **異常 Trip 數 (exceptionTrips)**：0 趟

#### 5. 2026-08-31 (週一)
* **計畫車趟 (plannedTrips)**：9 趟
* **完成車趟 (completedTrips)**：9 趟
* **取消車趟 (cancelledTrips)**：0 趟
* **準時發車 (onTimeDepartureCount)**：8 趟
* **延誤發車 (lateDepartureCount)**：1 趟
* **發車準時率 (departurePunctualityRate)**：88.9%
* **可量測 Cycle (measurableCycleCount)**：7 次
* **準時 Cycle (onTimeCycleCount)**：6 次
* **超時 Cycle (overtimeCycleCount)**：1 次
* **循環準時率 (cyclePunctualityRate)**：85.7%
* **異常 Trip 數 (exceptionTrips)**：0 趟

---

### 四、全測試期間 (2026-08-01 ～ 2026-09-18) KPI 確切預期數值

| KPI 指標項目 | 確切預期數值 (Expected Value) |
|---|---|
| **總計畫車趟 (plannedTrips)** | **372** 趟 |
| **實際完成車趟 (completedTrips)** | **372** 趟 |
| **取消車趟 (cancelledTrips)** | **7** 趟 |
| **追加車趟 (addedTrips)** | **14** 趟 |
| **計畫達成率 (achievementRate)** | **100%** |
| **發車準時率 (departurePunctualityRate)** | **90.6%** (337 趟準時 / 372 趟總發車) |
| **可量測循環數 (measurableCycleCount)** | **288** 次 |
| **循環準時率 (cyclePunctualityRate)** | **86.8%** (250 次準時 / 288 次可量測) |
| **異常 Trip 數 (exceptionTrips)** | **12** 趟 (異常率 3.2%) |
| **Event 更正筆數 (correctionsCount)** | **14** 筆 |