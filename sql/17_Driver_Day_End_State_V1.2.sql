-- ============================================================================
-- 卡車循環運輸管理系統 V1.2 - Migration 17: 當日最後一趟完成與 DAY_END 狀態導出 Patch
-- 檔案名稱: 17_Driver_Day_End_State_V1.2.sql
-- 說明: 修正 get_driver_home() RPC，當當日最後一趟車趟完成 YM_CAB 且無後續有效未取消 Trip 時，
--       狀態導出為 DAY_END (當日作業結束)；若當日仍有後續趟次，完成 YM_CAB 後導出為 READY (準備下一趟)。
-- ============================================================================

create or replace function public.get_driver_home()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_uid uuid;
  v_driver_id text;
  v_driver_name text;
  v_default_truck_id text;
  v_truck_id text;
  v_truck_no text;
  v_truck_name text;
  v_current_trip record;
  v_last_event record;
  v_event_count integer := 0;
  v_remaining_trips integer := 0;
  v_today_tasks jsonb;
  v_elapsed_minutes integer := 0;
  v_current_status text;
  v_next_event_code text;
  v_last_event_code text := null;
  v_last_event_time timestamptz := null;
  v_has_trip boolean := false;
begin
  -- 1. 驗證 auth.uid()
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  -- 2. 取得司機基本資料
  select d.driver_id, d.driver_name, d.default_truck_id
  into v_driver_id, v_driver_name, v_default_truck_id
  from public.driver_master d
  where d.auth_user_id = v_auth_uid and d.active = true
  limit 1;

  if v_driver_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_004', 'message', '當前使用者非有效司機身分');
  end if;

  -- 3. 優先搜尋今日指派給該司機或預設車輛之未完成 Trip (WAITAING 或 RUNNING)
  select * into v_current_trip
  from public.trip_plan
  where driver_id = v_driver_id
    and plan_date = current_date
    and trip_status in ('WAITING','RUNNING')
  order by trip_no asc
  limit 1;

  if v_current_trip.trip_id is not null then
    v_truck_id := v_current_trip.truck_id;
  else
    v_truck_id := v_default_truck_id;
    -- 搜尋預設車輛今日未完成之 Trip
    select * into v_current_trip
    from public.trip_plan
    where truck_id = v_default_truck_id
      and plan_date = current_date
      and trip_status in ('WAITING','RUNNING')
    order by trip_no asc
    limit 1;
  end if;

  -- 若今日沒有未完成之 Trip，檢查今日是否有已完成 (COMPLETED) 之最後趟次
  if v_current_trip.trip_id is null then
    select * into v_current_trip
    from public.trip_plan
    where (driver_id = v_driver_id or (v_default_truck_id is not null and truck_id = v_default_truck_id))
      and plan_date = current_date
      and trip_status = 'COMPLETED'
    order by trip_no desc
    limit 1;
    if v_current_trip.trip_id is not null then
      v_truck_id := v_current_trip.truck_id;
    end if;
  end if;

  -- 4. 取得車輛基本資料
  if v_truck_id is not null then
    select truck_no, truck_name into v_truck_no, v_truck_name
    from public.truck_master where truck_id = v_truck_id;
  end if;

  -- 5. 取得今日任務列表 (僅限 plan_date = current_date)
  select coalesce(jsonb_agg(jsonb_build_object(
    'tripId', trip_id,
    'tripNo', trip_no,
    'planDeparture', plan_departure,
    'tripStatus', trip_status,
    'planType', plan_type
  ) order by trip_no asc), '[]'::jsonb)
  into v_today_tasks
  from public.trip_plan
  where (driver_id = v_driver_id or (v_truck_id is not null and truck_id = v_truck_id))
    and plan_date = current_date;

  -- 6. 狀態與 Event 衍生
  if v_current_trip.trip_id is null then
    -- 狀況 A: 今日無排程
    v_has_trip := false;
    v_current_status := 'NO_TRIP';
    v_next_event_code := null;
    v_last_event_code := null;
    v_last_event_time := null;
  else
    v_has_trip := true;

    -- 查詢當趟 effective events 數量與最後一筆時間
    select count(*), max(effective_event_time)
    into v_event_count, v_last_event_time
    from public.effective_trip_events
    where trip_id = v_current_trip.trip_id;

    if v_event_count = 0 then
      -- 狀況 B: 當前 Trip 尚無點報任何 Event ➔ 準備楊梅廠出廠
      v_current_status := 'DAY_START_READY';
      v_next_event_code := 'YM_OUT';
      v_last_event_code := null;
      v_last_event_time := null;
    else
      -- 狀況 C: 當前 Trip 已有 Event
      select event_code, effective_event_time into v_last_event
      from public.effective_trip_events
      where trip_id = v_current_trip.trip_id
      order by effective_event_time desc
      limit 1;

      v_last_event_code := v_last_event.event_code;
      v_last_event_time := v_last_event.effective_event_time;

      if v_last_event_time is not null then
        v_elapsed_minutes := round(extract(epoch from (now() - v_last_event_time)) / 60);
      end if;

      -- 計算今日在當前 Trip 之後是否還有其他非取消的有效 Trip
      select count(*) into v_remaining_trips
      from public.trip_plan
      where truck_id = v_truck_id
        and plan_date = current_date
        and trip_status != 'CANCELLED'
        and trip_no > v_current_trip.trip_no;

      -- 依最後事件推導當前狀態與下一預期節點
      case v_last_event_code
        when 'YM_OUT' then
          v_current_status := 'YM_TO_HC';
          v_next_event_code := 'HC_IN';
        when 'HC_IN' then
          v_current_status := 'HC_INTERNAL';
          v_next_event_code := 'HC_WH';
        when 'HC_WH' then
          v_current_status := 'HC_LOADING';
          v_next_event_code := 'HC_OUT';
        when 'HC_OUT' then
          v_current_status := 'HC_TO_YM';
          v_next_event_code := 'YM_IN';
        when 'YM_IN' then
          v_current_status := 'YM_INTERNAL';
          v_next_event_code := 'YM_ENGINE';
        when 'YM_ENGINE' then
          v_current_status := 'YM_UNLOADING';
          v_next_event_code := 'YM_CAB';
        when 'YM_CAB' then
          if v_remaining_trips > 0 then
            v_current_status := 'READY'; -- 中間趟次完成：準備下一趟
            v_next_event_code := null;
          else
            v_current_status := 'DAY_END'; -- 當日最後一趟完成：當日作業結束
            v_next_event_code := null;
          end if;
        else
          v_current_status := 'DAY_START_READY';
          v_next_event_code := 'YM_OUT';
      end case;
    end if;
  end if;

  -- 7. 回傳資料
  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'driverId', v_driver_id,
      'driverName', v_driver_name,
      'truckId', coalesce(v_truck_id, '-'),
      'truckNo', coalesce(v_truck_no, v_truck_id, '-'),
      'truckName', v_truck_name,
      'currentTripId', coalesce(v_current_trip.trip_id, null),
      'tripNo', coalesce(v_current_trip.trip_no, null),
      'planDeparture', v_current_trip.plan_departure,
      'currentStatus', v_current_status,
      'lastEventCode', v_last_event_code,
      'lastEventTime', v_last_event_time,
      'elapsedMinutes', v_elapsed_minutes,
      'nextEventCode', v_next_event_code,
      'hasTrip', v_has_trip,
      'todayTasks', v_today_tasks
    )
  );
end;
$$;

revoke all on function public.get_driver_home() from public;
grant execute on function public.get_driver_home() to authenticated;

notify pgrst, 'reload schema';
