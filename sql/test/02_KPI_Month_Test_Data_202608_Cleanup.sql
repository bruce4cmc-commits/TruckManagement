-- ============================================================================
-- 卡車循環運輸管理系統 V1.2 - 1 個月 KPI 測試資料 清理腳本 (Cleanup SQL)
-- 檔案名稱: 02_KPI_Month_Test_Data_202608_Cleanup.sql
-- 安全機制: 僅刪除 trip_id LIKE 'KPI202608-%' 之 Test Fixture 資料，絕不誤刪真實生產/歷史資料
-- ============================================================================

begin;

-- 1. 清理測試 exception_log
delete from public.exception_log
where trip_id like 'KPI202608-%';

-- 2. 清理測試 trip_event
delete from public.trip_event
where trip_id like 'KPI202608-%';

-- 3. 清理測試 trip_plan
delete from public.trip_plan
where trip_id like 'KPI202608-%';

commit;

notify pgrst, 'reload schema';
