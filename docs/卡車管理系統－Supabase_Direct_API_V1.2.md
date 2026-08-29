# 卡車管理系統－Supabase Direct REST/PostgREST API 規格 V1.2

## 1. 文件目的

本文件取代 V1.1「Google Apps Script + Supabase API」架構，定義移除 Google Apps Script 後的 Web App、Supabase Auth、REST/PostgREST、RLS、RPC、Realtime 與排程設計原則。

本版系統基礎：
- 前端：HTML / CSS / JavaScript Web App
- 資料庫：Supabase PostgreSQL（REST/PostgREST）
- 司機端：手機 Web App
- 物流管理端：手機 / PC Web
- 主管端：PC / 平板 Dashboard
- 不使用 GPS

> 技術實作說明：移除 Google Apps Script 後，瀏覽器端使用 Supabase Publishable key 存取 Data API；登入與身分識別使用 Supabase Auth，資料授權由 PostgreSQL RLS 控制。複雜且需一致性之寫入邏輯可使用 PostgreSQL Function / RPC，定時工作使用 Supabase Cron。Secret key / service_role 不得放入瀏覽器。


---

# 2. 系統架構

```text
司機 Web App
物流管理 Web
主管 Dashboard
        │
        ├─ Supabase Auth（登入 / Session / JWT）
        │
        ├─ Supabase Data API（REST/PostgREST）
        │
        ├─ PostgreSQL RLS（資料權限）
        │
        ├─ PostgreSQL Function / RPC（複合交易邏輯）
        │
        ├─ Supabase Realtime（即時畫面，可選）
        │
        └─ Supabase Cron（超時 / KPI / 提醒排程）
        │
        ▼
Supabase PostgreSQL
```

## 2.1 前端連線原則

```text
HTML / CSS / JavaScript
  ↓
supabase-js 或 HTTPS /rest/v1
  ↓  Publishable key + 使用者 JWT
Supabase API Gateway
  ↓
RLS / SQL Function
  ↓
PostgreSQL
```

前端僅可保存：
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

禁止放入前端：
- Supabase Secret key
- legacy `service_role`
- PostgreSQL connection string

---

# 3. 認證與角色

## 3.1 認證方式
所有正式登入改由 Supabase Auth 管理密碼與 Session，不再由前端讀取或比對 `password_hash`。

### 司機 UI
操作仍維持：
- 選擇車號
- 輸入密碼
- 登入

實作可將車號對應至內部 Auth 登入識別；該識別不需呈現在司機畫面。

### 物流 / 主管 UI
操作維持：
- 登入名稱
- 密碼

登入成功後依 `user_master.auth_user_id = auth.uid()` 取得角色：
- `LOGISTICS`
- `SUPERVISOR`
- `ADMIN`

## 3.2 RLS 原則
- `DRIVER`：僅可讀取本人 / 本車 / 本日任務及建立本人 QR/異常回報。
- `LOGISTICS`：可管理 Trip、車輛、司機、補正、更正與異常。
- `SUPERVISOR`：原則上唯讀，可讀 Dashboard、KPI、Trip、異常。
- `ADMIN`：系統管理用途。
- 所有權限以 JWT + RLS 判斷，不信任前端傳入的 role。

---

# 4. 前端資料存取方式

## 4.1 單表 CRUD
使用 Supabase Data API / PostgREST，例如：
- `truck_master`
- `trip_plan`
- `trip_status`
- `exception_log`

## 4.2 複合交易
下列功能不得拆成多個互不保證一致性的前端 CRUD，應改用 PostgreSQL Function / RPC：
- QR 掃描成立 + Event 建立 + Trip Status 更新 + 前一超時解除
- 人工補正
- 已完成 Trip 更正
- 新增 / 追加 / 取消 Trip
- 自動交錯排程
- 排程衝突判定與強制儲存
- KPI 重算

RPC 回傳沿用統一格式概念：
```json
{
  "success": true,
  "message": "OK",
  "data": {}
}
```

---

# 5. QR Code 掃描

建議 RPC：
`rpc/scan_trip_event`

輸入：
```json
{
  "p_event_code": "HC_IN",
  "p_scan_time": "2026-08-15T09:31:00+08:00",
  "p_offline_flag": false,
  "p_force_accept": false
}
```

資料庫端依 `auth.uid()` 自動判斷使用者與可操作車輛，不接受前端自行冒用 driverId。

處理：
```text
驗證登入者
↓
取得目前 Trip
↓
確認掃描節點
↓
重複掃描判定
↓
順序判定
↓
建立 trip_event
↓
更新 trip_status
↓
解除上一階段 OVERTIME
↓
回傳下一節點
```

掃錯 QR：
- 第一次回傳 `requiresConfirm = true`
- 使用者確認後以 `p_force_accept = true` 再送出
- 警示但不阻擋

漏掃：
- 不阻擋
- 不列異常 Trip
- 不發異常通知
- 可由物流人員事後補正

離線：
- 前端以 IndexedDB / localStorage 暫存實際掃描時間
- 網路恢復後補傳
- DB 仍保存原始 `scan_time`

---

# 6. 週間計畫 / Trip

建議 RPC：
- `create_trip`
- `update_trip`
- `add_extra_trip`
- `cancel_trip`
- `copy_week`
- `auto_assign_trucks`

衝突判定：
```text
同一 truck_id
↓
前後 plan_departure
↓
間隔 < 120 分鐘
↓
is_conflict = true
```

物流管理人員可 `force_save = true` 強制儲存。

---

# 7. 即時車況

前端可直接讀：
- `trip_status`
- 今日 `trip_plan`
- 最新有效 `trip_event`

如需即時刷新：
- 優先使用 Supabase Realtime 訂閱 `trip_status`
- 或採固定輪詢

即時車況仍依最後有效 QR Event 判斷，不使用 GPS。

---

# 8. 超時與排程

原 Apps Script Trigger 全部移除。

改為 Supabase Cron：
- 超時檢查：每 5 分鐘
- 出發提醒判定：每 5 分鐘
- KPI 更新：每 15 分鐘或 Event 後
- 日結：每日固定時間
- 歷史一致性檢查：每日一次

Cron 可直接執行 SQL Function；若未來需要外部 Push / Email / LINE 等通知，再由 Cron 呼叫受保護的 Supabase Edge Function。

---

# 9. 通知

V1.2 分兩層：
1. **站內通知 / 畫面警示**：可完全由 PostgreSQL + Realtime 完成。
2. **瀏覽器 Push / 外部通知**：需要安全的伺服器端送信憑證，建議使用 Supabase Edge Function；不能把推播私鑰放在 HTML/JavaScript。

---

# 10. 密碼與管理功能

- 不再保留可由 Web App 讀取的 `password_hash`。
- 密碼由 Supabase Auth 管理。
- 使用者可變更自己的密碼。
- 「物流管理人員直接重設另一名司機密碼」屬管理員權限，若要保留此功能，必須透過受保護的 Supabase Edge Function / Admin API；純前端不得持有 Secret key。

---

# 11. 安全原則

1. 前端只使用 Publishable key。
2. Secret key / service_role 永不出現在瀏覽器。
3. 所有 public tables 啟用 RLS。
4. 以 `auth.uid()` 判斷使用者，不信任前端 role 欄位。
5. 寫入權限採最小化。
6. 複合資料修改使用 RPC 保證一致性。
7. 原始 QR Event 不因人工更正而覆寫。
8. 取消 Trip 保留歷史。
9. SECURITY DEFINER Function 必須固定 `search_path` 並限制 `EXECUTE` 權限。

---

# 12. V1.1 → V1.2 主要差異

| 項目 | V1.1 | V1.2 |
|---|---|---|
| 中介後端 | Google Apps Script | 移除 |
| 前端資料存取 | `google.script.run` → GAS | Supabase Data API / RPC |
| Browser Key | 無 | Publishable key |
| 高權限 Secret | Apps Script Properties | 不在一般前端使用 |
| Login | 自建 password hash | Supabase Auth |
| 權限 | Apps Script Service 判斷 | JWT + RLS |
| Trigger | Apps Script Trigger | Supabase Cron |
| 即時更新 | 輪詢 / GAS | Realtime / 輪詢 |
| 複合交易 | Apps Script Service | PostgreSQL RPC |
| 密碼管理 | Apps Script | Supabase Auth |

---

# 13. 後續開發順序

```text
Supabase Schema / RLS V1.2
        ↓
Supabase Auth 使用者綁定
        ↓
PostgreSQL RPC
        ↓
Web App Supabase Client
        ↓
司機端
        ↓
物流管理端
        ↓
主管 Dashboard
        ↓
Cron / Realtime
        ↓
整合測試
        ↓
正式上線
```

**文件版本：V1.2（Supabase Direct）**  
**文件日期：2026-08-29**
