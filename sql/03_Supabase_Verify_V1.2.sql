-- Supabase V1.2 安裝驗證
select 'truck_master' as table_name, count(*) as row_count from public.truck_master
union all select 'driver_master', count(*) from public.driver_master
union all select 'user_master', count(*) from public.user_master
union all select 'trip_plan', count(*) from public.trip_plan
union all select 'trip_event', count(*) from public.trip_event
union all select 'trip_status', count(*) from public.trip_status
union all select 'exception_log', count(*) from public.exception_log
union all select 'system_config', count(*) from public.system_config
union all select 'dashboard_data', count(*) from public.dashboard_data;

select config_key, value
from public.system_config
order by config_key;


-- V1.2 Auth 綁定檢查
select 'driver_without_auth' as check_name, count(*) as row_count
from public.driver_master where active = true and auth_user_id is null
union all
select 'user_without_auth', count(*)
from public.user_master where active = true and auth_user_id is null;

-- RLS 啟用狀態
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'truck_master','driver_master','user_master','trip_plan','trip_event',
    'trip_status','exception_log','system_config','dashboard_data'
  )
order by tablename;
