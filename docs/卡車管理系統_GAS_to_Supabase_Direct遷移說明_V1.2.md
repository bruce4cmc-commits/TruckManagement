# 卡車管理系統－V1.1（GAS）→ V1.2（Supabase Direct）遷移說明

## 1. 原則
本次不再只是替換資料庫層，而是正式移除 Google Apps Script。

新架構：
```text
HTML / CSS / JavaScript Web App
        ↓
Supabase Auth + REST/PostgREST + RLS/RPC
        ↓
Supabase PostgreSQL
```

## 2. 維持不變
- 三端 Web App 定位
- QR 流程
- 週間計畫
- 車輛交錯
- 異常規則
- KPI 定義
- 不使用 GPS
- 九張主要業務表概念

## 3. 必須改寫
1. 所有 `google.script.run`
2. Apps Script Service / Repository / Validator
3. Script Properties
4. Apps Script Trigger
5. Apps Script LockService / CacheService
6. 自建 password_hash 驗證流程
7. 任何依賴 Secret key 的 Browser 呼叫

## 4. 對應替換

| V1.1 | V1.2 |
|---|---|
| Google Apps Script | 移除 |
| SupabaseRepository.gs | supabase-js / PostgREST |
| AuthService.gs | Supabase Auth |
| Service 權限判斷 | RLS + auth.uid() |
| 複合 Service | PostgreSQL RPC |
| Trigger | Supabase Cron |
| LockService | PostgreSQL transaction / row lock / unique constraint |
| CacheService | 前端快取 / DB view / dashboard_data |
| Secret key in Script Properties | Browser 僅 Publishable key |

## 5. Auth 遷移
- 為每位 driver / user 建立 Supabase Auth account。
- 回填 `driver_master.auth_user_id` / `user_master.auth_user_id`。
- 完成後停止使用 `password_hash`。
- 司機畫面仍可維持「車號 + 密碼」。

## 6. RLS 上線順序
1. 先在測試環境建立 auth_user_id。
2. 建立角色判斷 helper function。
3. 建立 SELECT/INSERT/UPDATE policies。
4. 使用 DRIVER / LOGISTICS / SUPERVISOR 三種實際帳號測試。
5. 確認無越權後才切正式前端。

## 7. 切換完成條件
- 前端無任何 `google.script.run`
- 前端無 Secret/service_role key
- 三角色 Auth 登入通過
- RLS 越權測試通過
- QR RPC UAT 通過
- Trip 管理 UAT 通過
- Cron 超時/KPI 測試通過
- Dashboard 即時更新通過

**版本：V1.2**  
**日期：2026-08-29**
