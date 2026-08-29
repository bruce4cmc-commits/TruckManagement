# Supabase 技術依據（V1.2 Direct）

本改版移除 Google Apps Script，中介邏輯改由 Supabase 原生能力承接。

核心原則：
- Browser / Web App 使用 Publishable key；Publishable key 可公開，但必須搭配 RLS。
- Secret key / legacy service_role 具有高權限並可繞過 RLS，禁止放在 Browser。
- 前端使用 Supabase Auth 取得使用者 JWT。
- Data API / REST/PostgREST 直接對 PostgreSQL tables/views/functions 存取。
- RLS 是前端直接存取 Supabase 時的主要資料授權機制。
- 複合交易與需集中驗證的商業邏輯使用 PostgreSQL Function / RPC。
- 定時工作使用 Supabase Cron（pg_cron）；若需外部通知可再呼叫受保護的 Edge Function。
- 即時看板可使用 Supabase Realtime，或維持輪詢。

正式導入仍應以 Supabase Dashboard 當下 API Key 類型、Auth、RLS 與 Data API 設定為準。

**版本：V1.2**  
**日期：2026-08-29**
