-- ============================================================================
-- 卡車循環運輸管理系統 V1.2 - Migration 19: Excel 批次匯入 Trip 計畫 V1.0 (batch_create_trips RPC)
-- 檔案名稱: 19_Batch_Create_Trip_Plan_V1.2.sql
-- 說明: 建立 batch_create_trips() RPC，供 LOGISTICS 與 ADMIN 權限進行 Excel 批次建立車趟。
--       採 All-or-Nothing 交易模式，包含全域重複檢查、同名司機歧義檢查與角色安全驗證。
-- ============================================================================

create or replace function public.batch_create_trips(
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_uid uuid;
  v_role text;
  v_user_name text;
  v_item jsonb;
  v_plan_date date;
  v_plan_departure timestamptz;
  v_truck_param text;
  v_driver_param text;
  v_truck_id text;
  v_driver_id text;
  v_default_driver_id text;
  v_remark text;
  v_trip_no integer;
  v_trip_id text;
  v_truck_count integer := 0;
  v_driver_count integer := 0;
  v_dup_count integer := 0;
  v_created_count integer := 0;
  v_created_ids text[] := array[]::text[];
begin
  -- 1. 權限檢查：驗證 auth.uid()
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  -- 2. 角色檢查：僅 LOGISTICS 與 ADMIN 可進行批次建立
  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '僅物流管理員或系統管理員可批次建立車趟計畫');
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('success', false, 'errorCode', 'PARAM_001', 'message', '匯入資料不可為空');
  end if;

  -- 3. 預先進行全表整批資料嚴格驗證 (All-or-Nothing Pre-check)
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_plan_date := (v_item->>'planDate')::date;
    v_truck_param := v_item->>'truckId';
    v_driver_param := v_item->>'driverId';
    v_plan_departure := (v_item->>'planDeparture')::timestamptz;

    -- A. 驗證車輛 Truck 存在且 Active
    select count(*), max(truck_id), max(default_driver_id)
    into v_truck_count, v_truck_id, v_default_driver_id
    from public.truck_master
    where (truck_id = v_truck_param or truck_no = v_truck_param) and active = true;

    if v_truck_count = 0 then
      raise exception 'INVALID_TRUCK: 車輛 % 不存在或非啟用狀態 (Active)', v_truck_param;
    end if;

    -- B. 驗證司機 Driver
    if v_driver_param is not null and trim(v_driver_param) != '' then
      select count(*), max(driver_id)
      into v_driver_count, v_driver_id
      from public.driver_master
      where (driver_id = v_driver_param or driver_name = v_driver_param) and active = true;

      if v_driver_count = 0 then
        raise exception 'INVALID_DRIVER: 司機 % 不存在或非啟用狀態 (Active)', v_driver_param;
      elsif v_driver_count > 1 then
        raise exception 'DRIVER_AMBIGUOUS: 同名司機 % 存在多筆有效紀錄，請使用司機 ID 區分', v_driver_param;
      end if;
    else
      -- 司機空白 ➔ 使用車輛預設司機 default_driver_id
      v_driver_id := v_default_driver_id;
      if v_driver_id is null then
        raise exception 'MISSING_DEFAULT_DRIVER: 車輛 % 未設定預設司機，且司機欄位為空', v_truck_param;
      end if;
    end if;

    -- C. DB 重複車趟檢查
    select count(*) into v_dup_count
    from public.trip_plan
    where plan_date = v_plan_date
      and truck_id = v_truck_id
      and plan_departure = v_plan_departure
      and trip_status != 'CANCELLED';

    if v_dup_count > 0 then
      raise exception 'DUPLICATE_TRIP: 日期 % 車輛 % 發車時間 % 已存在相同有效車趟計畫',
        v_plan_date, v_truck_param, to_char(v_plan_departure, 'HH24:MI');
    end if;
  end loop;

  -- 4. 批次寫入 trip_plan (All-or-Nothing Transaction)
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_plan_date := (v_item->>'planDate')::date;
    v_plan_departure := (v_item->>'planDeparture')::timestamptz;
    v_truck_param := v_item->>'truckId';
    v_driver_param := v_item->>'driverId';
    v_remark := v_item->>'remark';

    -- 取確切 truck_id 與 driver_id
    select truck_id, default_driver_id into v_truck_id, v_default_driver_id
    from public.truck_master
    where (truck_id = v_truck_param or truck_no = v_truck_param) and active = true limit 1;

    if v_driver_param is not null and trim(v_driver_param) != '' then
      select driver_id into v_driver_id
      from public.driver_master
      where (driver_id = v_driver_param or driver_name = v_driver_param) and active = true limit 1;
    else
      v_driver_id := v_default_driver_id;
    end if;

    -- 計算當日 trip_no 與 trip_id
    select coalesce(max(trip_no), 0) + 1 into v_trip_no
    from public.trip_plan where plan_date = v_plan_date;

    v_trip_id := to_char(v_plan_date, 'YYYYMMDD') || '-' || lpad(v_trip_no::text, 3, '0');

    insert into public.trip_plan (
      trip_id, plan_date, trip_no, plan_departure, truck_id, driver_id,
      plan_type, trip_status, add_reason, force_save, created_by
    ) values (
      v_trip_id, v_plan_date, v_trip_no, v_plan_departure, v_truck_id, v_driver_id,
      'NORMAL', 'WAITING', v_remark, false, v_user_name
    );

    v_created_count := v_created_count + 1;
    v_created_ids := array_append(v_created_ids, v_trip_id);
  end loop;

  return jsonb_build_object(
    'success', true,
    'message', '批次建立車趟計畫成功',
    'createdCount', v_created_count,
    'createdTripIds', v_created_ids
  );

exception
  when others then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'BATCH_CREATE_FAILED',
      'message', SQLERRM
    );
end;
$$;

revoke all on function public.batch_create_trips(jsonb) from public;
grant execute on function public.batch_create_trips(jsonb) to authenticated;

notify pgrst, 'reload schema';
