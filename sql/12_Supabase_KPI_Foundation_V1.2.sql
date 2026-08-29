-- 卡車管理系統 Migration SQL V1.2 (Phase ⑤: KPI Engine + Supervisor Dashboard Foundation)
-- 目的：
-- 1. 修正 Trip Complete 邊界：YM_CAB 掃描完成即將 trip_plan.trip_status 設為 COMPLETE
-- 2. 修正 Cycle Boundary：下一個 YM_OUT 僅用於建立新 Cycle 邊界與結算前趟 Cycle Time，不影響前趟已 COMPLETE 之狀態
-- 3. 每日最後一趟無下一 YM_OUT 時，狀態仍為 COMPLETE，但 cycle_time = NULL (不納入 Cycle 平均與準時率分母)
-- 4. 建立 public.get_dashboard_kpi() RPC (支援 DAY / WEEK / MONTH，全數以 Asia/Taipei 為準)
-- 5. 建立 public.get_kpi_trip_details() RPC (提供 Supervisor 車趟 KPI 明細查詢)

begin;

-- ============================================================
-- 0. 升級 scan_trip_event() RPC - 修正 Trip Complete 邊界
-- ============================================================

create or replace function public.scan_trip_event(
  p_event_code text,
  p_scan_time timestamptz default now(),
  p_offline_flag boolean default false,
  p_force_accept boolean default false,
  p_client_event_id uuid default null
)
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
  v_trip_id text;
  v_trip_no integer;
  v_event_id text;
  v_last_event_code text;
  v_last_event_time timestamptz;
  v_current_status text;
  v_expected_code text;
  v_new_status text;
  v_next_code text;
  v_elapsed_minutes integer;
  v_existing_event record;
begin
  -- 1. 驗證 auth.uid()
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入或 Session 已失效');
  end if;

  -- 2. 驗證目前使用者為有效司機
  select d.driver_id, d.driver_name, d.default_truck_id
  into v_driver_id, v_driver_name, v_default_truck_id
  from public.driver_master d
  where d.auth_user_id = v_auth_uid and d.active = true
  limit 1;

  if v_driver_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_004', 'message', '當前使用者非有效司機身分');
  end if;

  -- 3. 冪等性檢查
  if p_client_event_id is not null then
    select event_id, event_code, trip_id, event_time into v_existing_event
    from public.trip_event where client_event_id = p_client_event_id;

    if v_existing_event.event_id is not null then
      return jsonb_build_object(
        'success', true, 'alreadyProcessed', true, 'message', '事件先前已成功處理',
        'data', jsonb_build_object('eventId', v_existing_event.event_id, 'eventCode', v_existing_event.event_code, 'tripId', v_existing_event.trip_id)
      );
    end if;
  end if;

  -- 4. 驗證 event_code
  if p_event_code not in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB') then
    return jsonb_build_object('success', false, 'errorCode', 'EVENT_001', 'message', '無效的 QR Code 作業節點代碼');
  end if;

  -- 5. 動態車輛與目前 Trip 判定
  select trip_id, trip_no, truck_id
  into v_trip_id, v_trip_no, v_truck_id
  from public.trip_plan
  where driver_id = v_driver_id
    and plan_date = current_date
    and trip_status in ('WAITING','RUNNING')
  order by trip_no asc
  limit 1;

  if v_trip_id is null and v_default_truck_id is not null then
    select trip_id, trip_no, truck_id
    into v_trip_id, v_trip_no, v_truck_id
    from public.trip_plan
    where truck_id = v_default_truck_id
      and (driver_id is null or driver_id = v_driver_id)
      and plan_date = current_date
      and trip_status in ('WAITING','RUNNING')
    order by trip_no asc
    limit 1;
  end if;

  if v_trip_id is null or v_truck_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_001', 'message', '找不到目前 Trip (尚未建立今日車趟計畫)');
  end if;

  -- 6. 讀取目前狀態
  select current_status, last_event_code, last_event_time
  into v_current_status, v_last_event_code, v_last_event_time
  from public.trip_status where truck_id = v_truck_id;

  -- 7. 重複掃描判定 (<= 100 分鐘)
  if v_last_event_code = p_event_code and v_last_event_time is not null then
    v_elapsed_minutes := extract(epoch from (p_scan_time - v_last_event_time)) / 60;
    if v_elapsed_minutes <= 100 then
      return jsonb_build_object('success', false, 'errorCode', 'EVENT_002', 'message', '重複掃描：100分鐘內已記錄相同節點');
    end if;
  end if;

  -- 8. 預期節點判定
  if v_last_event_code is null or v_current_status = 'WAITING' or v_current_status = 'READY' then
    v_expected_code := 'YM_OUT';
  elsif v_last_event_code = 'YM_OUT' then v_expected_code := 'HC_IN';
  elsif v_last_event_code = 'HC_IN' then v_expected_code := 'HC_WH';
  elsif v_last_event_code = 'HC_WH' then v_expected_code := 'HC_OUT';
  elsif v_last_event_code = 'HC_OUT' then v_expected_code := 'YM_IN';
  elsif v_last_event_code = 'YM_IN' then v_expected_code := 'YM_ENGINE';
  elsif v_last_event_code = 'YM_ENGINE' then v_expected_code := 'YM_CAB';
  elsif v_last_event_code = 'YM_CAB' then v_expected_code := 'YM_OUT';
  else v_expected_code := 'YM_OUT';
  end if;

  if p_event_code != v_expected_code and not p_force_accept then
    return jsonb_build_object(
      'success', false, 'requiresConfirm', true, 'errorCode', 'EVENT_003',
      'message', '掃描節點與預期不一致',
      'data', jsonb_build_object('expected', v_expected_code, 'actual', p_event_code)
    );
  end if;

  -- 9. Trip 狀態更新規範 (Phase ⑤ 正式定義)
  --    - YM_OUT: 將當前 Trip 設為 RUNNING
  --    - YM_CAB: 7個節點全數完成，將當前 Trip 正式設為 COMPLETE
  if p_event_code = 'YM_OUT' then
    update public.trip_plan set trip_status = 'RUNNING', updated_at = now() where trip_id = v_trip_id;
  elsif p_event_code = 'YM_CAB' then
    update public.trip_plan set trip_status = 'COMPLETE', updated_at = now() where trip_id = v_trip_id;
  end if;

  -- 10. 建立 trip_event 紀錄
  v_event_id := 'EVT-' || gen_random_uuid()::text;
  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code, event_time, scan_time, report_type,
    is_manual_correction, offline_flag, valid_flag, client_event_id, created_by
  ) values (
    v_event_id, v_trip_id, v_truck_id, v_driver_id, p_event_code, p_scan_time, p_scan_time, 'QR',
    false, p_offline_flag, true, p_client_event_id, v_driver_id
  );

  -- 11. 更新狀態與下一節點
  case p_event_code
    when 'YM_OUT' then v_new_status := 'YM_TO_HC'; v_next_code := 'HC_IN';
    when 'HC_IN' then v_new_status := 'HC_INTERNAL'; v_next_code := 'HC_WH';
    when 'HC_WH' then v_new_status := 'HC_LOADING'; v_next_code := 'HC_OUT';
    when 'HC_OUT' then v_new_status := 'HC_TO_YM'; v_next_code := 'YM_IN';
    when 'YM_IN' then v_new_status := 'YM_INTERNAL'; v_next_code := 'YM_ENGINE';
    when 'YM_ENGINE' then v_new_status := 'YM_UNLOADING'; v_next_code := 'YM_CAB';
    when 'YM_CAB' then v_new_status := 'READY'; v_next_code := 'YM_OUT';
    else v_new_status := 'WAITING'; v_next_code := 'YM_OUT';
  end case;

  insert into public.trip_status (
    truck_id, current_trip_id, driver_id, current_status, last_event_code, last_event_time, next_event_code, updated_at
  ) values (
    v_truck_id, v_trip_id, v_driver_id, v_new_status, p_event_code, p_scan_time, v_next_code, now()
  ) on conflict (truck_id) do update set
    current_trip_id = excluded.current_trip_id, driver_id = excluded.driver_id,
    current_status = excluded.current_status, last_event_code = excluded.last_event_code,
    last_event_time = excluded.last_event_time, next_event_code = excluded.next_event_code, updated_at = now();

  -- 12. 解除 OVERTIME 異常
  update public.exception_log set status = 'CLOSED', end_time = p_scan_time, duration_minutes = round(extract(epoch from (p_scan_time - start_time)) / 60)
  where truck_id = v_truck_id and exception_type = 'OVERTIME' and status = 'OPEN';

  return jsonb_build_object(
    'success', true, 'alreadyProcessed', false, 'message', '回報成功',
    'data', jsonb_build_object('eventId', v_event_id, 'clientEventId', p_client_event_id, 'eventCode', p_event_code, 'currentStatus', v_new_status, 'nextEventCode', v_next_code, 'tripId', v_trip_id)
  );
end;
$$;


-- ============================================================
-- 1. 建立 get_dashboard_kpi() RPC (核心 KPI 計算引擎)
-- ============================================================

create or replace function public.get_dashboard_kpi(
  p_period_type text default 'DAY',
  p_reference_date date default current_date
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
  -- 1. 身份驗證 (僅限 LOGISTICS, SUPERVISOR, ADMIN)
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  select role into v_role from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','SUPERVISOR','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限查看 Dashboard KPI');
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

  -- 3. 計算 Trip 計畫與完成度 KPI (依據 effective_trip_events View)
  select
    count(*) filter (where trip_status != 'CANCELLED'),
    count(*) filter (where trip_status = 'COMPLETE'),
    count(*) filter (where plan_type = 'ADDED'),
    count(*) filter (where trip_status = 'CANCELLED'),
    count(*) filter (where trip_status in ('RUNNING','COMPLETE'))
  into v_planned_trips, v_completed_trips, v_added_trips, v_cancelled_trips, v_executed_trips
  from public.trip_plan
  where plan_date between v_start_date and v_end_date;

  if v_planned_trips > 0 then
    v_achievement_rate := round((v_completed_trips::numeric / v_planned_trips::numeric) * 100.0, 1);
  end if;

  -- 4. 計算 楊梅出發準時率 (±20 分鐘視為準時，全數使用 effective_trip_events View)
  for v_rec in (
    select p.plan_departure, e.effective_event_time as actual_ym_out
    from public.trip_plan p
    inner join public.effective_trip_events e on e.trip_id = p.trip_id and e.event_code = 'YM_OUT'
    where p.plan_date between v_start_date and v_end_date and p.trip_status != 'CANCELLED'
  ) loop
    v_executed_ym_out_count := v_executed_ym_out_count + 1;
    if abs(extract(epoch from (v_rec.actual_ym_out - v_rec.plan_departure)) / 60.0) <= 20.0 then
      v_on_time_departure_count := v_on_time_departure_count + 1;
    end if;
  end loop;

  if v_executed_ym_out_count > 0 then
    v_departure_punctuality_rate := round((v_on_time_departure_count::numeric / v_executed_ym_out_count::numeric) * 100.0, 1);
  end if;

  -- 5. 計算 平均 Cycle Time 與 Cycle 準時率 (同車同日相鄰 YM_OUT 算 1 Cycle，<=140分視為準時)
  for v_truck_rec in (
    select distinct truck_id from public.trip_plan where plan_date between v_start_date and v_end_date
  ) loop
    for v_rec in (
      select p.plan_date, e.effective_event_time as ym_out_time
      from public.trip_plan p
      inner join public.effective_trip_events e on e.trip_id = p.trip_id and e.event_code = 'YM_OUT'
      where p.truck_id = v_truck_rec.truck_id and p.plan_date between v_start_date and v_end_date and p.trip_status != 'CANCELLED'
      order by p.plan_date asc, e.effective_event_time asc
    ) loop
      if v_prev_ym_out is not null and date(v_prev_ym_out at time zone 'Asia/Taipei') = v_rec.plan_date then
        v_cycle_min := extract(epoch from (v_rec.ym_out_time - v_prev_ym_out)) / 60.0;
        v_total_cycle_minutes := v_total_cycle_minutes + v_cycle_min;
        v_measurable_cycle_count := v_measurable_cycle_count + 1;
        if v_cycle_min <= 140.0 then
          v_on_time_cycle_count := v_on_time_cycle_count + 1;
        end if;
      end if;
      v_prev_ym_out := v_rec.ym_out_time;
    end loop;
    v_prev_ym_out := null; -- 重置跨車
  end loop;

  if v_measurable_cycle_count > 0 then
    v_average_cycle_minutes := round(v_total_cycle_minutes / v_measurable_cycle_count::numeric, 1);
    v_cycle_punctuality_rate := round((v_on_time_cycle_count::numeric / v_measurable_cycle_count::numeric) * 100.0, 1);
  end if;

  -- 6. 計算 異常 Trip 數與異常率 (不包含漏掃，COUNT DISTINCT trip_id)
  select count(distinct trip_id) into v_exception_trips
  from public.exception_log
  where exception_type in ('OVERTIME','TRAFFIC_JAM','ACCIDENT','TRUCK_FAILURE','OTHER')
    and trip_id in (select trip_id from public.trip_plan where plan_date between v_start_date and v_end_date);

  if v_executed_trips > 0 then
    v_exception_rate := round((v_exception_trips::numeric / v_executed_trips::numeric) * 100.0, 1);
  end if;

  -- 7. 計算 各車完成 Trip 數 (Group by truck_id)
  select jsonb_agg(jsonb_build_object('truckId', truck_id, 'completedTrips', c_count))
  into v_completed_by_truck
  from (
    select truck_id, count(*) as c_count
    from public.trip_plan
    where plan_date between v_start_date and v_end_date and trip_status = 'COMPLETE'
    group by truck_id order by truck_id asc
  ) t;

  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'periodType', p_period_type,
      'periodStart', v_start_date,
      'periodEnd', v_end_date,
      'plannedTrips', v_planned_trips,
      'completedTrips', v_completed_trips,
      'achievementRate', v_achievement_rate,
      'departurePunctualityRate', v_departure_punctuality_rate,
      'averageCycleMinutes', v_average_cycle_minutes,
      'cyclePunctualityRate', v_cycle_punctuality_rate,
      'exceptionTrips', v_exception_trips,
      'exceptionRate', v_exception_rate,
      'addedTrips', v_added_trips,
      'cancelledTrips', v_cancelled_trips,
      'completedByTruck', coalesce(v_completed_by_truck, '[]'::jsonb)
    )
  );
end;
$$;


-- ============================================================
-- 2. 建立 get_kpi_trip_details() RPC (提供 Supervisor 追溯車趟明細)
-- ============================================================

create or replace function public.get_kpi_trip_details(
  p_period_type text default 'DAY',
  p_reference_date date default current_date
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
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  select role into v_role from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','SUPERVISOR','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限查看 KPI 明細');
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


-- 權限控制
revoke all on function public.get_dashboard_kpi(text, date) from public;
grant execute on function public.get_dashboard_kpi(text, date) to authenticated;

revoke all on function public.get_kpi_trip_details(text, date) from public;
grant execute on function public.get_kpi_trip_details(text, date) to authenticated;

commit;
