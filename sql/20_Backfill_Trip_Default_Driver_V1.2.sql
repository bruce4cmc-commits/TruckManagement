-- ============================================================================
-- 卡車循環運輸管理系統 V1.2 - Migration 20: 歷史 Trip 預設司機回補 (Backfill Default Driver)
-- 檔案名稱: 20_Backfill_Trip_Default_Driver_V1.2.sql
-- 說明: 將歷史 trip_plan 中 driver_id IS NULL 且 truck_master.default_driver_id
--       有值的資料進行安全補值，不覆蓋已有 driver_id 之紀錄。
-- ============================================================================

create or replace function public.execute_backfill_trip_default_driver()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_null_before integer := 0;
  v_can_backfill integer := 0;
  v_no_default integer := 0;
  v_null_after integer := 0;
  v_updated_count integer := 0;
begin
  -- 1. 統計修復前 NULL 筆數
  select count(*) into v_null_before
  from public.trip_plan
  where driver_id is null;

  -- 2. 統計可補值筆數與無預設司機筆數
  select count(*) into v_can_backfill
  from public.trip_plan p
  join public.truck_master t on p.truck_id = t.truck_id
  where p.driver_id is null and t.default_driver_id is not null;

  select count(*) into v_no_default
  from public.trip_plan p
  left join public.truck_master t on p.truck_id = t.truck_id
  where p.driver_id is null and (t.default_driver_id is null or t.truck_id is null);

  -- 3. 執行安全 UPDATE (僅針對 driver_id IS NULL 且 default_driver_id IS NOT NULL)
  update public.trip_plan p
  set driver_id = t.default_driver_id
  from public.truck_master t
  where p.truck_id = t.truck_id
    and p.driver_id is null
    and t.default_driver_id is not null;

  get diagnostics v_updated_count = row_count;

  -- 4. 統計修復後 NULL 筆數
  select count(*) into v_null_after
  from public.trip_plan
  where driver_id is null;

  return jsonb_build_object(
    'null_before', v_null_before,
    'can_backfill', v_can_backfill,
    'no_default', v_no_default,
    'updated_count', v_updated_count,
    'null_after', v_null_after
  );
end;
$$;

-- 5. 授權 authenticated / anon (即時相容性測試執行)
grant execute on function public.execute_backfill_trip_default_driver() to anon, authenticated, service_role;

-- 6. 執行一次補值並通知 Schema reload
select public.execute_backfill_trip_default_driver();
notify pgrst, 'reload schema';
