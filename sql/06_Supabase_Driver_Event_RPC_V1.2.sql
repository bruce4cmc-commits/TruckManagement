-- 卡車管理系統 Migration SQL V1.2 (Driver Core + QR Event Transaction RPC)
-- 目的：
-- 1. 收緊 trip_event 直接 INSERT 權限 (司機只能透過 scan_trip_event RPC 寫入)
-- 2. 建立 scan_trip_event() RPC (包含七節點驗證、重複掃描判定、順序不一致警示、超時解除、狀態轉換與原子交易)
-- 3. 建立 get_driver_home() RPC (依 auth.uid() 安全回傳司機首頁與今日任務資料)
-- 4. 提供預設今日測試 Trip 產出輔助邏輯

begin;

-- ============================================================
-- 1. 收緊 trip_event 直接寫入權限 (司機僅能呼叫 RPC)
-- ============================================================

drop policy if exists trip_event_insert_scope on public.trip_event;
drop policy if exists trip_event_insert_logistics on public.trip_event;

create policy trip_event_insert_logistics
on public.trip_event for insert to authenticated
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));


-- ============================================================
-- 2. 建立 scan_trip_event() 複合交易 RPC
-- ============================================================

create or replace function public.scan_trip_event(
  p_event_code text,
  p_scan_time timestamptz default now(),
  p_offline_flag boolean default false,
  p_force_accept boolean default false
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
begin
  -- 1. 驗證 auth.uid()
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'EVENT_004',
      'message', '未登入或 Session 已失效'
    );
  end if;

  -- 2. 驗證目前使用者為有效司機
  select d.driver_id, d.driver_name, coalesce(d.default_truck_id, t.truck_id)
  into v_driver_id, v_driver_name, v_truck_id
  from public.driver_master d
  left join public.truck_master t on t.default_driver_id = d.driver_id
  where d.auth_user_id = v_auth_uid and d.active = true
  limit 1;

  if v_driver_id is null or v_truck_id is null then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'EVENT_005',
      'message', '當前使用者非有效司機或未分配車輛'
    );
  end if;

  -- 3. 驗證 event_code 是否為合法七節點之一
  if p_event_code not in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB') then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'EVENT_001',
      'message', '無效的 QR Code 作業節點代碼'
    );
  end if;

  -- 4. 尋找今日該車輛當前執行中或待執行之 Trip Plan
  select trip_id, trip_no
  into v_trip_id, v_trip_no
  from public.trip_plan
  where truck_id = v_truck_id
    and plan_date = current_date
    and trip_status in ('WAITING','RUNNING')
  order by trip_no asc
  limit 1;

  -- 若今日尚無計畫，自動產出測試 Trip 1 (確保系統運作不中斷)
  if v_trip_id is null then
    v_trip_id := to_char(current_date, 'YYYYMMDD') || '-001';
    v_trip_no := 1;
    insert into public.trip_plan (
      trip_id, plan_date, trip_no, plan_departure, truck_id, driver_id, plan_type, trip_status, created_by
    ) values (
      v_trip_id, current_date, 1, now(), v_truck_id, v_driver_id, 'NORMAL', 'WAITING', v_driver_id
    ) on conflict (trip_id) do update set trip_status = 'WAITING';
  end if;

  -- 5. 讀取目前 trip_status 與最後有效掃描紀錄
  select current_status, last_event_code, last_event_time
  into v_current_status, v_last_event_code, v_last_event_time
  from public.trip_status
  where truck_id = v_truck_id;

  -- 6. 重複掃描判定 (同一車輛 + 相同 event_code，且距上次有效掃描 <= 100 分鐘)
  if v_last_event_code = p_event_code and v_last_event_time is not null then
    v_elapsed_minutes := extract(epoch from (p_scan_time - v_last_event_time)) / 60;
    if v_elapsed_minutes <= 100 then
      return jsonb_build_object(
        'success', false,
        'errorCode', 'EVENT_002',
        'message', '重複掃描：100分鐘內已記錄相同節點'
      );
    end if;
  end if;

  -- 7. 判定目前預期節點
  if v_last_event_code is null or v_current_status = 'WAITING' or v_current_status = 'READY' then
    v_expected_code := 'YM_OUT';
  elsif v_last_event_code = 'YM_OUT' then
    v_expected_code := 'HC_IN';
  elsif v_last_event_code = 'HC_IN' then
    v_expected_code := 'HC_WH';
  elsif v_last_event_code = 'HC_WH' then
    v_expected_code := 'HC_OUT';
  elsif v_last_event_code = 'HC_OUT' then
    v_expected_code := 'YM_IN';
  elsif v_last_event_code = 'YM_IN' then
    v_expected_code := 'YM_ENGINE';
  elsif v_last_event_code = 'YM_ENGINE' then
    v_expected_code := 'YM_CAB';
  elsif v_last_event_code = 'YM_CAB' then
    v_expected_code := 'YM_OUT';
  else
    v_expected_code := 'YM_OUT';
  end if;

  -- 8. 順序不一致判定 (掃錯 QR 警示但不阻擋)
  if p_event_code != v_expected_code and not p_force_accept then
    return jsonb_build_object(
      'success', false,
      'requiresConfirm', true,
      'errorCode', 'EVENT_003',
      'message', '掃描節點與預期不一致',
      'data', jsonb_build_object(
        'expected', v_expected_code,
        'actual', p_event_code
      )
    );
  end if;

  -- 9. 建立 trip_event 紀錄 (使用 actual p_scan_time)
  v_event_id := 'EVT-' || gen_random_uuid()::text;

  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code,
    event_time, scan_time, report_type, is_manual_correction,
    offline_flag, valid_flag, created_by
  ) values (
    v_event_id, v_trip_id, v_truck_id, v_driver_id, p_event_code,
    p_scan_time, p_scan_time, 'QR', false,
    p_offline_flag, true, v_driver_id
  );

  -- 10. 計算新狀態與下一預期節點
  case p_event_code
    when 'YM_OUT' then
      v_new_status := 'YM_TO_HC';
      v_next_code := 'HC_IN';
    when 'HC_IN' then
      v_new_status := 'HC_INTERNAL';
      v_next_code := 'HC_WH';
    when 'HC_WH' then
      v_new_status := 'HC_LOADING';
      v_next_code := 'HC_OUT';
    when 'HC_OUT' then
      v_new_status := 'HC_TO_YM';
      v_next_code := 'YM_IN';
    when 'YM_IN' then
      v_new_status := 'YM_INTERNAL';
      v_next_code := 'YM_ENGINE';
    when 'YM_ENGINE' then
      v_new_status := 'YM_UNLOADING';
      v_next_code := 'YM_CAB';
    when 'YM_CAB' then
      v_new_status := 'READY';
      v_next_code := 'YM_OUT';
    else
      v_new_status := 'WAITING';
      v_next_code := 'YM_OUT';
  end case;

  -- 11. 更新 trip_status 與 trip_plan
  insert into public.trip_status (
    truck_id, current_trip_id, driver_id, current_status,
    last_event_code, last_event_time, next_event_code, updated_at
  ) values (
    v_truck_id, v_trip_id, v_driver_id, v_new_status,
    p_event_code, p_scan_time, v_next_code, now()
  ) on conflict (truck_id) do update set
    current_trip_id = excluded.current_trip_id,
    driver_id = excluded.driver_id,
    current_status = excluded.current_status,
    last_event_code = excluded.last_event_code,
    last_event_time = excluded.last_event_time,
    next_event_code = excluded.next_event_code,
    updated_at = now();

  if p_event_code = 'YM_OUT' then
    update public.trip_plan set trip_status = 'RUNNING', updated_at = now() where trip_id = v_trip_id;
  elsif p_event_code = 'YM_CAB' then
    update public.trip_plan set trip_status = 'COMPLETE', updated_at = now() where trip_id = v_trip_id;
  end if;

  -- 12. 解除上一階段 OPEN OVERTIME 異常 (若存在)
  update public.exception_log
  set status = 'CLOSED',
      end_time = p_scan_time,
      duration_minutes = round(extract(epoch from (p_scan_time - start_time)) / 60)
  where truck_id = v_truck_id
    and exception_type = 'OVERTIME'
    and status = 'OPEN';

  -- 13. 回傳成功結果
  return jsonb_build_object(
    'success', true,
    'message', '回報成功',
    'data', jsonb_build_object(
      'eventId', v_event_id,
      'eventCode', p_event_code,
      'eventTime', p_scan_time,
      'currentStatus', v_new_status,
      'nextEventCode', v_next_code,
      'tripId', v_trip_id
    )
  );
end;
$$;

-- 權限設置
revoke all on function public.scan_trip_event(text, timestamptz, boolean, boolean) from public;
grant execute on function public.scan_trip_event(text, timestamptz, boolean, boolean) to authenticated;


-- ============================================================
-- 3. 建立 get_driver_home() RPC (安全查詢司機首頁與任務)
-- ============================================================

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
  v_truck_id text;
  v_truck_no text;
  v_truck_name text;
  v_status_rec record;
  v_current_trip record;
  v_today_tasks jsonb;
  v_elapsed_minutes integer := 0;
begin
  -- 1. 驗證 auth.uid()
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'message', '未登入');
  end if;

  -- 2. 取得司機與車輛
  select d.driver_id, d.driver_name, coalesce(d.default_truck_id, t.truck_id), t.truck_no, t.truck_name
  into v_driver_id, v_driver_name, v_truck_id, v_truck_no, v_truck_name
  from public.driver_master d
  left join public.truck_master t on t.default_driver_id = d.driver_id
  where d.auth_user_id = v_auth_uid and d.active = true
  limit 1;

  if v_driver_id is null then
    return jsonb_build_object('success', false, 'message', '非有效司機身分');
  end if;

  -- 3. 取得當前車況狀態
  select * into v_status_rec from public.trip_status where truck_id = v_truck_id;

  if v_status_rec.last_event_time is not null then
    v_elapsed_minutes := round(extract(epoch from (now() - v_status_rec.last_event_time)) / 60);
  end if;

  -- 4. 取得當前 Trip
  select * into v_current_trip
  from public.trip_plan
  where truck_id = v_truck_id
    and plan_date = current_date
    and trip_status in ('WAITING','RUNNING')
  order by trip_no asc
  limit 1;

  -- 5. 取得今日任務列表 (僅限本車)
  select coalesce(jsonb_agg(jsonb_build_object(
    'tripId', trip_id,
    'tripNo', trip_no,
    'planDeparture', plan_departure,
    'tripStatus', trip_status,
    'planType', plan_type
  ) order by trip_no asc), '[]'::jsonb)
  into v_today_tasks
  from public.trip_plan
  where truck_id = v_truck_id and plan_date = current_date;

  -- 6. 回傳資料
  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'driverId', v_driver_id,
      'driverName', v_driver_name,
      'truckId', v_truck_id,
      'truckNo', coalesce(v_truck_no, v_truck_id),
      'truckName', v_truck_name,
      'currentTripId', coalesce(v_current_trip.trip_id, '-'),
      'tripNo', coalesce(v_current_trip.trip_no, 1),
      'planDeparture', coalesce(v_current_trip.plan_departure, now()),
      'currentStatus', coalesce(v_status_rec.current_status, 'WAITING'),
      'lastEventCode', v_status_rec.last_event_code,
      'lastEventTime', v_status_rec.last_event_time,
      'elapsedMinutes', v_elapsed_minutes,
      'nextEventCode', coalesce(v_status_rec.next_event_code, 'YM_OUT'),
      'exceptionFlag', coalesce(v_status_rec.exception_flag, false),
      'exceptionType', v_status_rec.exception_type,
      'todayTasks', v_today_tasks
    )
  );
end;
$$;

-- 權限設置
revoke all on function public.get_driver_home() from public;
grant execute on function public.get_driver_home() to authenticated;

commit;
