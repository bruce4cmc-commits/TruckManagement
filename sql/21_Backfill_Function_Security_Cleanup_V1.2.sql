-- ============================================================================
-- 卡車循環運輸管理系統 V1.2 - Migration 21: Backfill Function Security Cleanup
-- 檔案名稱: 21_Backfill_Function_Security_Cleanup_V1.2.sql
-- 說明: 撤銷與移除一次性歷史修復 Function execute_backfill_trip_default_driver()
--       防止 SECURITY DEFINER 權限暴露。
-- ============================================================================

begin;

-- 1. 撤銷所有權限 (public, anon, authenticated)
revoke all on function public.execute_backfill_trip_default_driver() from public;
revoke all on function public.execute_backfill_trip_default_driver() from anon;
revoke all on function public.execute_backfill_trip_default_driver() from authenticated;

-- 2. 刪除一次性 Function
drop function if exists public.execute_backfill_trip_default_driver();

-- 3. 通知 PostgREST 重新載入 Schema
notify pgrst, 'reload schema';

commit;
