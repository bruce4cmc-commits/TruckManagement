# 卡車管理系統－Supabase 資料庫欄位規格 V1.2（Direct）

## 1. 改版原則

本版系統基礎：
- 前端：HTML / CSS / JavaScript Web App
- 資料庫：Supabase PostgreSQL（REST/PostgREST）
- 司機端：手機 Web App
- 物流管理端：手機 / PC Web
- 主管端：PC / 平板 Dashboard
- 不使用 GPS

> 技術實作說明：移除 Google Apps Script 後，瀏覽器端使用 Supabase Publishable key 存取 Data API；登入與身分識別使用 Supabase Auth，資料授權由 PostgreSQL RLS 控制。複雜且需一致性之寫入邏輯可使用 PostgreSQL Function / RPC，定時工作使用 Supabase Cron。Secret key / service_role 不得放入瀏覽器。


V1.2 移除 Google Apps Script 中介層。Browser 使用 Publishable key + Supabase Auth JWT，所有 Data API 存取由 RLS 控制。

## 2. 資料表

沿用 V1.1 九張主要業務表：
- `truck_master`
- `driver_master`
- `user_master`
- `trip_plan`
- `trip_event`
- `trip_status`
- `exception_log`
- `system_config`
- `dashboard_data`

## 3. V1.2 必要欄位調整

### driver_master
新增：
- `auth_user_id uuid unique references auth.users(id)`

`password_hash` 改為不再使用，建議完成 Auth 遷移後移除。

### user_master
新增：
- `auth_user_id uuid unique references auth.users(id)`

`password_hash` 改為不再使用，建議完成 Auth 遷移後移除。

## 4. 安全設計

- 所有 public tables 啟用 RLS。
- `anon` 不直接取得業務資料 CRUD 權限。
- `authenticated` 僅取得基礎 SQL privilege；真正資料範圍由 RLS policy 限制。
- 前端使用 Publishable key。
- Secret key / service_role 不得出現在前端。
- 角色由 `auth.uid()` 對應 `driver_master` / `user_master` 判斷。
- 管理型 SECURITY DEFINER function 限制 `EXECUTE` 給 authenticated，並在 function 內再次驗證角色。

## 5. 時間欄位

資料庫日期時間維持 `timestamptz`。前端以 `Asia/Taipei` 顯示與計算。

## 6. ID

沿用：
- Truck：`T001`
- Driver：`D001`
- User：`U001`
- Trip：`YYYYMMDD-001`
- Event / Exception：前端可使用 `crypto.randomUUID()`，或由 PostgreSQL Function 產生 UUID-based ID。

## 7. 查詢方式

V1.2 不再使用「先抓所有 rows 再由 Apps Script 過濾」。

前端 / RPC 必須優先使用 PostgREST filter：
- `plan_date`
- `truck_id`
- `driver_id`
- `trip_id`
- `trip_status`
- `event_time`

## 8. 交易一致性

以下採 PostgreSQL Function / RPC：
- QR Event 寫入 + Status 更新
- 超時解除
- 人工補正 / 更正
- Trip 新增 / 取消 / 追加
- 車輛自動交錯排程
- KPI 重算

## 9. 建置檔

依序：
1. `01_Supabase_Schema_V1.2.sql`
2. 建立 Supabase Auth 使用者並回填 `auth_user_id`
3. 建立 RLS / RPC
4. `02_Supabase_Seed_V1.2.sql`
5. `03_Supabase_Verify_V1.2.sql`

**文件版本：V1.2（Supabase Direct）**  
**文件日期：2026-08-29**
