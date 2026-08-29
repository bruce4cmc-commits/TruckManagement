-- 卡車管理系統 Migration SQL V1.2 (Phase ③ Fix Gate: Driver Event Fix)
-- 目的：
-- 1. 新增 trip_event.client_event_id 欄位與 UNIQUE 索引 (離線冪等性)
-- 2. 修正 scan_trip_event() RPC：
--    - 禁止找不到 Trip 時自動建立 trip_plan，回傳 TRIP_001
--    - 修正 Cycle Boundary：YM_CAB 僅進入 READY；全 Cycle 以 (前次 YM_OUT -> 次次 YM_OUT) 結算並完成前一 Trip
--    - 支援動態指定/臨時代班 Trip 車輛判定 (不硬綁 default_truck_id)
--    - 整合 client_event_id 冪等處理 (已處理則回傳 alreadyProcessed: true)
--    - 統一 Error Code 規範 (AUTH_003, AUTH_004, TRIP_001, EVENT_001, EVENT_002, EVENT_003)
-- 3. 標記 LOGISTICS 直接寫入 trip_event TODO (Phase ④ 完成 RPC 後全數收緊)

begin;

-- ============================================================
-- 1. 新增 trip_event.client_event_id (冪等性索引)
-- ============================================================

alter table public.trip_event
  add column if not exists client_event_id uuid unique;

-- TODO (Phase ④ 提示)：當 Phase ④ 完成 manual_add_trip_event() 及 correct_trip_event() 後，
-- 需將 trip_event_insert_logistics 政策移除，全數改由 SECURITY DEFINER RPC 進行稽核寫入。


-- ============================================================
-- 2. 重建 scan_trip_event() RPC (修復邏輯與冪等性)
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
  v_prev_running_trip record;
  v_prev_ym_out_time timestamptz;
begin
  -- 1. 驗證 auth.uid()
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'AUTH_003',
      'message', '未登入或 Session 已失效'
    );
  end if;

  -- 2. 驗證目前使用者為有效司機
  select d.driver_id, d.driver_name, d.default_truck_id
  into v_driver_id, v_driver_name, v_default_truck_id
  from public.driver_master d
  where d.auth_user_id = v_auth_uid and d.active = true
  limit 1;

  if v_driver_id is null then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'AUTH_004',
      'message', '當前使用者非有效司機身分'
    );
  end if;

  -- 3. 離線與重試冪等性檢查 (Client Event ID)
  if p_client_event_id is not null then
    select event_id, event_code, trip_id, event_time, offline_flag
    into v_existing_event
    from public.trip_event
    where client_event_id = p_client_event_id;

    if v_existing_event.event_id is not null then
      return jsonb_build_object(
        'success', true,
        'alreadyProcessed', true,
        'message', '事件先前已成功處理',
        'data', jsonb_build_object(
          'eventId', v_existing_event.event_id,
          'eventCode', v_existing_event.event_code,
          'tripId', v_existing_event.trip_id,
          'eventTime', v_existing_event.event_time
        )
      );
    end if;
  end if;

  -- 4. 驗證 event_code 是否為合法七節點之一
  if p_event_code not in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB') then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'EVENT_001',
      'message', '無效的 QR Code 作業節點代碼'
    );
  end if;

  -- 5. 動態車輛與目前 Trip 判定 (支持臨時代班，禁止自動建立 Trip)
  -- 優先搜尋直接指派給該司機的今日未完成 Trip
  select trip_id, trip_no, truck_id
  into v_trip_id, v_trip_no, v_truck_id
  from public.trip_plan
  where driver_id = v_driver_id
    and plan_date = current_date
    and trip_status in ('WAITING','RUNNING')
  order by trip_no asc
  limit 1;

  -- 若無直接指派，改搜尋預設車輛之今日未完成 Trip
  if v_trip_id is null and v_default_truck_id is not null then
    select trip_id, trip_no, truck_id
    into v_trip_id, v_trip_no, v_truck_id
    from public.trip_plan
    where truck_id = v_default_truck_id
      and plan_date = current_date
      and trip_status in ('WAITING','RUNNING')
    order by trip_no asc
    limit 1;
  end if;

  -- 若仍找不到有效 Trip，禁止 RPC 自動建立 Trip，直接拋出 TRIP_001 並中斷交易
  if v_trip_id is null or v_truck_id is null then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'TRIP_001',
      'message', '找不到目前 Trip (尚未建立今日車趟計畫)'
    );
  end if;

  -- 6. 讀取目前 trip_status 與最後有效掃描紀錄
  select current_status, last_event_code, last_event_time
  into v_current_status, v_last_event_code, v_last_event_time
  from public.trip_status
  where truck_id = v_truck_id;

  -- 7. 重複掃描判定 (相同 event_code 且距上次有效掃描 <= 100 分鐘)
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

  -- 8. 判定目前預期節點
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

  -- 9. 順序不一致判定 (掃錯 QR 警示但不阻擋)
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

  -- 10. Cycle Boundary & Completion 判定 (僅當 YM_OUT 觸發時結算前一 Cycle)
  if p_event_code = 'YM_OUT' then
    -- 搜尋同車輛上一次處於 RUNNING 狀態之 Trip
    select trip_id into v_prev_running_trip
    from public.trip_plan
    where truck_id = v_truck_id
      and trip_status = 'RUNNING'
      and trip_id != v_trip_id
    order by plan_departure desc
    limit 1;

    if v_prev_running_trip.trip_id is not null then
      -- 將前一 Trip 標記為 COMPLETE
      update public.trip_plan
      set trip_status = 'COMPLETE', updated_at = now()
      where trip_id = v_prev_running_trip.trip_id;
    end if;

    -- 將當前 Trip 設為 RUNNING
    update public.trip_plan
    set trip_status = 'RUNNING', updated_at = now()
    where trip_id = v_trip_id;
  end if;

  -- 11. 建立 trip_event 紀錄 (包含 client_event_id)
  v_event_id := 'EVT-' || gen_random_uuid()::text;

  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code,
    event_time, scan_time, report_type, is_manual_correction,
    offline_flag, valid_flag, client_event_id, created_by
  ) values (
    v_event_id, v_trip_id, v_truck_id, v_driver_id, p_event_code,
    p_scan_time, p_scan_time, 'QR', false,
    p_offline_flag, true, p_client_event_id, v_driver_id
  );

  -- 12. 計算新狀態與下一預期節點
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
      v_new_status := 'READY'; -- 規格指定：YM_CAB 僅進入 READY，不直接完成 Trip
      v_next_code := 'YM_OUT';
    else
      v_new_status := 'WAITING';
      v_next_code := 'YM_OUT';
  end case;

  -- 13. 更新 trip_status
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

  -- 14. 解除上一階段 OPEN OVERTIME 異常 (若存在)
  update public.exception_log
  set status = 'CLOSED',
      end_time = p_scan_time,
      duration_minutes = round(extract(epoch from (p_scan_time - start_time)) / 60)
  where truck_id = v_truck_id
    and exception_type = 'OVERTIME'
    and status = 'OPEN';

  -- 15. 回傳成功結果
  return jsonb_build_object(
    'success', true,
    'alreadyProcessed', false,
    'message', '回報成功',
    'data', jsonb_build_object(
      'eventId', v_event_id,
      'clientEventId', p_client_event_id,
      'eventCode', p_event_code,
      'eventTime', p_scan_time,
      'currentStatus', v_new_status,
      'nextEventCode', v_next_code,
      'tripId', v_trip_id
    )
  );
end;
$$;

-- 重建 RPC 執行權限
revoke all on function public.scan_trip_event(text, timestamptz, boolean, boolean, uuid) from public;
grant execute on function public.scan_trip_event(text, timestamptz, boolean, boolean, uuid) to authenticated;


-- ============================================================
-- 3. 重建 get_driver_home() RPC (支援臨時代班與無 Trip 安全提示)
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
  v_default_truck_id text;
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
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  -- 2. 取得司機
  select d.driver_id, d.driver_name, d.default_truck_id
  into v_driver_id, v_driver_name, v_default_truck_id
  from public.driver_master d
  where d.auth_user_id = v_auth_uid and d.active = true
  limit 1;

  if v_driver_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_004', 'message', '當前使用者非有效司機身分');
  end if;

  -- 3. 優先搜尋今日指派給該司機的 Trip，決定當前執行的車輛 v_truck_id
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
    -- 若無直接指派，嘗試搜尋預設車輛之 Trip
    select * into v_current_trip
    from public.trip_plan
    where truck_id = v_default_truck_id
      and plan_date = current_date
      and trip_status in ('WAITING','RUNNING')
    order by trip_no asc
    limit 1;
  end if;

  -- 4. 取得車輛基本資料
  if v_truck_id is not null then
    select truck_no, truck_name into v_truck_no, v_truck_name
    from public.truck_master where truck_id = v_truck_id;
  end if;

  -- 5. 取得當前車況狀態
  if v_truck_id is not null then
    select * into v_status_rec from public.trip_status where truck_id = v_truck_id;
  end if;

  if v_status_rec.last_event_time is not null then
    v_elapsed_minutes := round(extract(epoch from (now() - v_status_rec.last_event_time)) / 60);
  end if;

  -- 6. 取得今日任務列表 (包含指派給該司機或該車輛之 Trip)
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

-- 重建 RPC 執行權限
revoke all on function public.get_driver_home() from public;
grant execute on function public.get_driver_home() to authenticated;

commit;
