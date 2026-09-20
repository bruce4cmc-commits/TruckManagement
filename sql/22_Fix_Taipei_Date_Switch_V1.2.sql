-- ============================================================================
-- 卡車循環運輸管理系統 V1.2 - Migration 22: Asia/Taipei 00:00 當日計畫切換與時區修正
-- 檔案名稱: 22_Fix_Taipei_Date_Switch_V1.2.sql
-- 說明: 修正 get_driver_home()、get_dashboard_kpi()、get_kpi_trip_details()、check_departure_reminders()
--       統一使用 (now() at time zone 'Asia/Taipei')::date 進行日期切換判定，
--       確保每日 00:00 跨日即刻切換為當日 (plan_date = 今天) 排程與 KPI，不得延至 07:00 切換。
-- ============================================================================

-- 1. 修正 public.get_driver_home() RPC
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
  v_total_trips integer := 0;
  v_remaining_trips integer := 0;
  v_today_tasks jsonb;
  v_elapsed_minutes integer := 0;
  v_current_status text;
  v_next_event_code text;
  v_last_event_code text := null;
  v_last_event_time timestamptz := null;
  v_has_trip boolean := false;
  v_today_date date := (now() at time zone 'Asia/Taipei')::date;
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

  -- 3. 嘗試確定當前車輛 v_truck_id (以 Asia/Taipei 當地日期為準)
  select truck_id into v_truck_id
  from public.trip_plan
  where driver_id = v_driver_id
    and plan_date = v_today_date
    and trip_status != 'CANCELLED'
  order by trip_no asc, plan_departure asc, trip_id asc
  limit 1;

  if v_truck_id is null then
    v_truck_id := v_default_truck_id;
  end if;

  -- 4. 計算今日該司機/車輛的所有有效 (非 CANCELLED) Trip 總數
  select count(*) into v_total_trips
  from public.trip_plan
  where (driver_id = v_driver_id or (v_truck_id is not null and truck_id = v_truck_id))
    and plan_date = v_today_date
    and trip_status != 'CANCELLED';

  -- 5. 取得車輛基本資料
  if v_truck_id is not null then
    select truck_no, truck_name into v_truck_no, v_truck_name
    from public.truck_master where truck_id = v_truck_id;
  end if;

  -- 6. 取得今日任務列表 (僅限 plan_date = v_today_date)
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
    and plan_date = v_today_date;

  -- 7. 核心判定流程：區分 NO_TRIP / WAITING / RUNNING / DAY_END
  if v_total_trips = 0 then
    -- 狀況 A: 今天完全沒有排程 ➔ NO_TRIP
    v_has_trip := false;
    v_current_status := 'NO_TRIP';
    v_next_event_code := null;
    v_last_event_code := null;
    v_last_event_time := null;
  else
    v_has_trip := true;

    -- 優先搜尋今日未完成的 current Trip (WAITING 或 RUNNING)
    select * into v_current_trip
    from public.trip_plan
    where (driver_id = v_driver_id or (v_truck_id is not null and truck_id = v_truck_id))
      and plan_date = v_today_date
      and trip_status in ('WAITING','RUNNING')
    order by trip_no asc, plan_departure asc, trip_id asc
    limit 1;

    if v_current_trip.trip_id is not null then
      -- 狀況 B: 今日尚有進行中或待發車 Trip
      select count(*), max(effective_event_time)
      into v_event_count, v_last_event_time
      from public.effective_trip_events
      where trip_id = v_current_trip.trip_id;

      if v_event_count = 0 then
        -- 尚未點報 Event ➔ 準備楊梅廠出廠
        v_current_status := 'DAY_START_READY';
        v_next_event_code := 'YM_OUT';
        v_last_event_code := null;
        v_last_event_time := null;
      else
        -- 已有點報 Event ➔ 取當趟最後點報
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
        where (driver_id = v_driver_id or (v_truck_id is not null and truck_id = v_truck_id))
          and plan_date = v_today_date
          and trip_status != 'CANCELLED'
          and (plan_departure > v_current_trip.plan_departure or (plan_departure = v_current_trip.plan_departure and trip_no > v_current_trip.trip_no));

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

    else
      -- 狀況 C: 今日 totalTrips > 0，但找不到任何未完成 Trip ➔ 當日所有 Trip 已全數完成 (DAY_END)
      v_current_status := 'DAY_END';
      v_next_event_code := null;

      -- 取得當日最後一筆完成的 Trip 作為 Context
      select * into v_current_trip
      from public.trip_plan
      where (driver_id = v_driver_id or (v_truck_id is not null and truck_id = v_truck_id))
        and plan_date = v_today_date
        and trip_status = 'COMPLETED'
      order by plan_departure desc, trip_no desc, trip_id desc
      limit 1;

      if v_current_trip.trip_id is not null then
        select event_code, effective_event_time into v_last_event
        from public.effective_trip_events
        where trip_id = v_current_trip.trip_id
        order by effective_event_time desc
        limit 1;

        v_last_event_code := coalesce(v_last_event.event_code, 'YM_CAB');
        v_last_event_time := v_last_event.effective_event_time;

        if v_last_event_time is not null then
          v_elapsed_minutes := round(extract(epoch from (now() - v_last_event_time)) / 60);
        end if;
      else
        v_last_event_code := 'YM_CAB';
      end if;
    end if;
  end if;

  -- 8. 回傳資料
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


-- 2. 修正 public.get_dashboard_kpi() RPC 預設日期
create or replace function public.get_dashboard_kpi(
  p_period_type text default 'DAY',
  p_reference_date date default (now() at time zone 'Asia/Taipei')::date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_uid uuid;
  v_role text;
  v_start_date date;
  v_end_date date;
  
  v_planned_trips integer := 0;
  v_completed_trips integer := 0;
  v_added_trips integer := 0;
  v_cancelled_trips integer := 0;
  v_achievement_rate numeric := 0.0;
  
  v_executed_ym_out_count integer := 0;
  v_on_time_departure_count integer := 0;
  v_departure_punctuality_rate numeric := 0.0;
  
  v_measurable_cycle_count integer := 0;
  v_on_time_cycle_count integer := 0;
  v_total_cycle_minutes numeric := 0.0;
  v_average_cycle_minutes numeric := null;
  v_cycle_punctuality_rate numeric := 0.0;
  
  v_exception_trips integer := 0;
  v_executed_trips integer := 0;
  v_exception_rate numeric := 0.0;
  
  v_completed_by_truck jsonb := '[]'::jsonb;
  v_rec record;
  v_truck_rec record;
  v_prev_ym_out timestamptz;
  v_curr_ym_out timestamptz;
  v_cycle_min numeric;
begin
  -- 1. 身份驗證 (僅限 LOGISTICS, SUPERVISOR, ADMIN，未傳 UID 時開放測試讀取)
  v_auth_uid := auth.uid();
  if v_auth_uid is not null then
    select role into v_role from public.user_master
    where auth_user_id = v_auth_uid and active = true limit 1;

    if v_role not in ('LOGISTICS','SUPERVISOR','ADMIN') then
      return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限查看 Dashboard KPI');
    end if;
  end if;

  -- 2. 計算 Asia/Taipei 期間區間
  if p_period_type = 'DAY' then
    v_start_date := p_reference_date;
    v_end_date := p_reference_date;
  elsif p_period_type = 'WEEK' then
    v_start_date := p_reference_date - (extract(isodow from p_reference_date)::integer - 1);
    v_end_date := v_start_date + 5; -- 週一~週六
  elsif p_period_type = 'MONTH' then
    v_start_date := date_trunc('month', p_reference_date)::date;
    v_end_date := (date_trunc('month', p_reference_date) + interval '1 month - 1 day')::date;
  else
    v_start_date := p_reference_date;
    v_end_date := p_reference_date;
  end if;

  -- 3. 計算 Trip 計畫與完成度 KPI
  select
    count(*) filter (where trip_status != 'CANCELLED'),
    count(*) filter (where trip_status = 'COMPLETE'),
    count(*) filter (where plan_type = 'ADDED'),
    count(*) filter (where trip_status = 'CANCELLED')
  into v_planned_trips, v_completed_trips, v_added_trips, v_cancelled_trips
  from public.trip_plan
  where plan_date between v_start_date and v_end_date;

  if v_planned_trips > 0 then
    v_achievement_rate := round((v_completed_trips::numeric / v_planned_trips::numeric) * 100.0, 1);
  end if;

  -- 4. 發車準時率
  select
    count(*),
    count(*) filter (where abs(extract(epoch from (e.effective_event_time - p.plan_departure)) / 60.0) <= 20.0)
  into v_executed_ym_out_count, v_on_time_departure_count
  from public.trip_plan p
  join public.effective_trip_events e on e.trip_id = p.trip_id and e.event_code = 'YM_OUT'
  where p.plan_date between v_start_date and v_end_date;

  if v_executed_ym_out_count > 0 then
    v_departure_punctuality_rate := round((v_on_time_departure_count::numeric / v_executed_ym_out_count::numeric) * 100.0, 1);
  end if;

  -- 5. 循環時間與準時率
  for v_truck_rec in (
    select distinct truck_id from public.trip_plan where plan_date between v_start_date and v_end_date
  ) loop
    v_prev_ym_out := null;
    for v_rec in (
      select p.plan_date, e.effective_event_time as ym_out_time
      from public.trip_plan p
      join public.effective_trip_events e on e.trip_id = p.trip_id and e.event_code = 'YM_OUT'
      where p.truck_id = v_truck_rec.truck_id and p.plan_date between v_start_date and v_end_date and p.trip_status != 'CANCELLED'
      order by p.plan_date asc, e.effective_event_time asc
    ) loop
      if v_prev_ym_out is not null and date(v_prev_ym_out at time zone 'Asia/Taipei') = v_rec.plan_date then
        v_cycle_min := round(extract(epoch from (v_rec.ym_out_time - v_prev_ym_out)) / 60.0, 1);
        v_measurable_cycle_count := v_measurable_cycle_count + 1;
        v_total_cycle_minutes := v_total_cycle_minutes + v_cycle_min;
        if v_cycle_min <= 140.0 then
          v_on_time_cycle_count := v_on_time_cycle_count + 1;
        end if;
      end if;
      v_prev_ym_out := v_rec.ym_out_time;
    end loop;
  end loop;

  if v_measurable_cycle_count > 0 then
    v_average_cycle_minutes := round(v_total_cycle_minutes / v_measurable_cycle_count::numeric, 1);
    v_cycle_punctuality_rate := round((v_on_time_cycle_count::numeric / v_measurable_cycle_count::numeric) * 100.0, 1);
  end if;

  -- 6. 計算 異常 Trip 數與異常率
  select count(distinct trip_id) into v_exception_trips
  from public.exception_log
  where exception_type in ('OVERTIME','TRAFFIC_JAM','ACCIDENT','TRUCK_FAILURE','OTHER')
    and trip_id in (select trip_id from public.trip_plan where plan_date between v_start_date and v_end_date);

  select count(distinct p.trip_id)
  into v_executed_trips
  from public.trip_plan p
  join public.effective_trip_events e on e.trip_id = p.trip_id
  where p.plan_date between v_start_date and v_end_date;

  if v_executed_trips > 0 then
    v_exception_rate := round((v_exception_trips::numeric / v_executed_trips::numeric) * 100.0, 1);
  end if;

  -- 7. 車輛完成趟數統計
  select coalesce(jsonb_agg(jsonb_build_object(
    'truckId', truck_id,
    'completedCount', completed_count
  )), '[]'::jsonb)
  into v_completed_by_truck
  from (
    select truck_id, count(*) as completed_count
    from public.trip_plan
    where plan_date between v_start_date and v_end_date and trip_status = 'COMPLETE'
    group by truck_id
    order by truck_id
  ) t;

  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'periodType', p_period_type,
      'startDate', v_start_date,
      'endDate', v_end_date,
      'plannedTrips', v_planned_trips,
      'completedTrips', v_completed_trips,
      'addedTrips', v_added_trips,
      'cancelledTrips', v_cancelled_trips,
      'achievementRate', v_achievement_rate,
      'executedYmOutCount', v_executed_ym_out_count,
      'onTimeDepartureCount', v_on_time_departure_count,
      'departurePunctualityRate', v_departure_punctuality_rate,
      'measurableCycleCount', v_measurable_cycle_count,
      'onTimeCycleCount', v_on_time_cycle_count,
      'averageCycleMinutes', v_average_cycle_minutes,
      'cyclePunctualityRate', v_cycle_punctuality_rate,
      'exceptionTrips', v_exception_trips,
      'executedTrips', v_executed_trips,
      'exceptionRate', v_exception_rate,
      'completedByTruck', v_completed_by_truck
    )
  );
end;
$$;

revoke all on function public.get_dashboard_kpi(text, date) from public;
grant execute on function public.get_dashboard_kpi(text, date) to authenticated;


-- 3. 修正 public.get_kpi_trip_details() RPC 預設日期
create or replace function public.get_kpi_trip_details(
  p_period_type text default 'DAY',
  p_reference_date date default (now() at time zone 'Asia/Taipei')::date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_uid uuid;
  v_role text;
  v_start_date date;
  v_end_date date;
  v_details jsonb;
begin
  v_auth_uid := auth.uid();
  if v_auth_uid is not null then
    select role into v_role from public.user_master
    where auth_user_id = v_auth_uid and active = true limit 1;

    if v_role not in ('LOGISTICS','SUPERVISOR','ADMIN') then
      return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限查看 KPI 明細');
    end if;
  end if;

  if p_period_type = 'DAY' then v_start_date := p_reference_date; v_end_date := p_reference_date;
  elsif p_period_type = 'WEEK' then v_start_date := p_reference_date - (extract(isodow from p_reference_date)::integer - 1); v_end_date := v_start_date + 5;
  elsif p_period_type = 'MONTH' then v_start_date := date_trunc('month', p_reference_date)::date; v_end_date := (date_trunc('month', p_reference_date) + interval '1 month - 1 day')::date;
  else v_start_date := p_reference_date; v_end_date := p_reference_date;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'tripId', p.trip_id,
      'tripNo', p.trip_no,
      'planDate', p.plan_date,
      'truckId', p.truck_id,
      'driverId', p.driver_id,
      'planDeparture', p.plan_departure,
      'actualYmOut', e.effective_event_time,
      'departureDifferenceMinutes', case when e.effective_event_time is not null then round(extract(epoch from (e.effective_event_time - p.plan_departure)) / 60.0, 1) else null end,
      'departureOnTime', case when e.effective_event_time is not null then abs(extract(epoch from (e.effective_event_time - p.plan_departure)) / 60.0) <= 20.0 else false end,
      'operationalComplete', (p.trip_status = 'COMPLETE'),
      'planType', p.plan_type,
      'status', p.trip_status
    ) order by p.plan_date asc, p.trip_no asc
  ) into v_details
  from public.trip_plan p
  left join public.effective_trip_events e on e.trip_id = p.trip_id and e.event_code = 'YM_OUT'
  where p.plan_date between v_start_date and v_end_date;

  return jsonb_build_object('success', true, 'data', coalesce(v_details, '[]'::jsonb));
end;
$$;

revoke all on function public.get_kpi_trip_details(text, date) from public;
grant execute on function public.get_kpi_trip_details(text, date) to authenticated;


-- 4. 修正 public.check_departure_reminders() RPC
create or replace function public.check_departure_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec record;
  v_created_count integer := 0;
begin
  for v_rec in (
    select trip_id, truck_id, driver_id, plan_departure, trip_no
    from public.trip_plan
    where trip_status = 'WAITING'
      and plan_date = (now() at time zone 'Asia/Taipei')::date
      and plan_departure - now() <= interval '10 minutes'
      and plan_departure >= now() - interval '30 minutes'
  ) loop
    begin
      insert into public.notification_log (
        trip_id, truck_id, driver_id, notification_type, title, message
      ) values (
        v_rec.trip_id, v_rec.truck_id, v_rec.driver_id, 'DEPARTURE_REMINDER',
        '發車提醒', '車趟 ' || v_rec.trip_id || ' (第 ' || v_rec.trip_no || ' 趟) 計畫將於 10 分鐘內出發，請準備進行 YM_OUT 掃碼作業'
      );
      v_created_count := v_created_count + 1;
    exception when unique_violation then
      null;
    end;
  end loop;

  return jsonb_build_object('success', true, 'message', '發車提醒巡檢完成', 'data', jsonb_build_object('createdCount', v_created_count));
end;
$$;

revoke all on function public.check_departure_reminders() from public;
grant execute on function public.check_departure_reminders() to authenticated;

notify pgrst, 'reload schema';
