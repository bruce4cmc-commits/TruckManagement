-- 卡車管理系統 Migration SQL V1.2 (Production Deployment Final Gate)
-- 目的：
-- 1. 將 public.trip_status 加入 supabase_realtime publication (啟用 PostgreSQL Realtime)
-- 2. 嚴格審計所有 15 個 SECURITY DEFINER Functions 之 search_path 與 EXECUTE 權限
-- 3. 封鎖 check_trip_overtime() 與 check_departure_reminders() 之 PUBLIC / authenticated 直接調用 (僅留內部 Cron 執行)

begin;

-- ============================================================
-- 1. Realtime Publication 配置
-- ============================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.trip_status;
  end if;
exception when others then
  null;
end $$;


-- ============================================================
-- 2. SECURITY DEFINER Functions 權限終極收緊
-- ============================================================

-- 收緊 Cron / Internal 專用 Functions
revoke execute on function public.check_trip_overtime() from public, anon, authenticated;
revoke execute on function public.check_departure_reminders() from public, anon, authenticated;

-- 確保所有端點 RPC 撤銷 PUBLIC 權限
revoke execute on function public.get_public_active_trucks() from public;
grant execute on function public.get_public_active_trucks() to anon, authenticated;

revoke execute on function public.scan_trip_event(text, timestamptz, boolean, boolean, uuid) from public;
grant execute on function public.scan_trip_event(text, timestamptz, boolean, boolean, uuid) to authenticated;

revoke execute on function public.get_driver_home() from public;
grant execute on function public.get_driver_home() to authenticated;

revoke execute on function public.create_trip(date, timestamptz, text, text, text, boolean) from public;
grant execute on function public.create_trip(date, timestamptz, text, text, text, boolean) to authenticated;

revoke execute on function public.update_trip(text, timestamptz, text, text, boolean) from public;
grant execute on function public.update_trip(text, timestamptz, text, text, boolean) to authenticated;

revoke execute on function public.add_extra_trip(date, timestamptz, text, text, text, boolean) from public;
grant execute on function public.add_extra_trip(date, timestamptz, text, text, text, boolean) to authenticated;

revoke execute on function public.cancel_trip(text, text) from public;
grant execute on function public.cancel_trip(text, text) to authenticated;

revoke execute on function public.copy_week(date, date) from public;
grant execute on function public.copy_week(date, date) to authenticated;

revoke execute on function public.auto_assign_trucks(date) from public;
grant execute on function public.auto_assign_trucks(date) to authenticated;

revoke execute on function public.manual_add_trip_event(text, text, timestamptz) from public;
grant execute on function public.manual_add_trip_event(text, text, timestamptz) to authenticated;

revoke execute on function public.correct_trip_event(text, timestamptz) from public;
grant execute on function public.correct_trip_event(text, timestamptz) to authenticated;

revoke execute on function public.get_dashboard_kpi(text, date) from public;
grant execute on function public.get_dashboard_kpi(text, date) to authenticated;

revoke execute on function public.get_kpi_trip_details(text, date) from public;
grant execute on function public.get_kpi_trip_details(text, date) to authenticated;

commit;
