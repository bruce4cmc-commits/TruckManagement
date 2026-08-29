-- 卡車管理系統 Migration SQL V1.2 (Phase ④: Logistics Trip Management + Event Ledger RPC)
-- 目的：
-- 1. 補強 Phase ③ 安全 Patch: default_truck_id fallback 不得取得已指派給其他司機的 Trip
-- 2. 收緊 trip_event：完全撤銷 LOGISTICS/authenticated 對 trip_event 的直接 INSERT/UPDATE/DELETE，成為 Audit Ledger
-- 3. 建立 create_trip() RPC (含排程衝突檢查 & Force Save 紀錄)
-- 4. 建立 update_trip() RPC (未開始 Trip 允許修改，RUNNING/COMPLETE/CANCELLED 嚴格限制)
-- 5. 建立 add_extra_trip() RPC (必填追加原因)
-- 6. 建立 cancel_trip() RPC (僅限未開始 Trip，必填原因，禁止 DELETE)
-- 7. 建立 copy_week() RPC (複製週計畫，平移日期，產生新 Trip ID)
-- 8. 建立 auto_assign_trucks() RPC (多車動態交錯與奇數趟首車切換)
-- 9. 建立 manual_add_trip_event() RPC (漏掃人工補正，不覆寫原 Event)
-- 10. 建立 correct_trip_event() RPC (Event 更正，保留原 Event 並註記新 Event)

begin;

-- ============================================================
-- 0. Phase ③ 安全 Patch: 收緊 scan_trip_event & get_driver_home 之 fallback 判斷
-- ============================================================

-- 在 08 中升級 scan_trip_event()，確保 fallback 時 (driver_id is null or driver_id = v_driver_id)
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

  -- 5. 動態車輛與目前 Trip 判定 (修復：fallback 不得取得已指派給其他司機的 Trip)
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
      and (driver_id is null or driver_id = v_driver_id) -- 安全控制：嚴禁取得其他司機之專屬 Trip
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

  -- 9. Cycle Boundary
  if p_event_code = 'YM_OUT' then
    select trip_id into v_prev_running_trip
    from public.trip_plan
    where truck_id = v_truck_id and trip_status = 'RUNNING' and trip_id != v_trip_id
    order by plan_departure desc limit 1;

    if v_prev_running_trip.trip_id is not null then
      update public.trip_plan set trip_status = 'COMPLETE', updated_at = now() where trip_id = v_prev_running_trip.trip_id;
    end if;

    update public.trip_plan set trip_status = 'RUNNING', updated_at = now() where trip_id = v_trip_id;
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
-- 1. 收緊 Event Ledger (全數收回 trip_event 直接 INSERT/UPDATE/DELETE)
-- ============================================================

drop policy if exists trip_event_insert_logistics on public.trip_event;
revoke insert, update, delete on table public.trip_event from authenticated, anon, public;


-- ============================================================
-- 2. 建立 create_trip() RPC (含排程衝突檢查)
-- ============================================================

create or replace function public.create_trip(
  p_plan_date date,
  p_plan_departure timestamptz,
  p_truck_id text,
  p_driver_id text default null,
  p_plan_type text default 'NORMAL',
  p_force_save boolean default false
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
  v_trip_no integer;
  v_trip_id text;
  v_conflict boolean := false;
  v_existing record;
begin
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '僅物流管理員或系統管理員可建立車趟');
  end if;

  -- 衝突檢查：同一 truck_id 當日前後 Trip 出發時間間隔 < 120 分鐘
  for v_existing in (
    select trip_id, plan_departure from public.trip_plan
    where truck_id = p_truck_id and plan_date = p_plan_date and trip_status != 'CANCELLED'
  ) loop
    if abs(extract(epoch from (p_plan_departure - v_existing.plan_departure)) / 60) < 120 then
      v_conflict := true;
      exit;
    end if;
  end loop;

  if v_conflict and not p_force_save then
    return jsonb_build_object(
      'success', false,
      'requiresConfirm', true,
      'errorCode', 'TRIP_002',
      'message', '排程衝突：同一車輛前後車趟間隔小於 120 分鐘'
    );
  end if;

  -- 計算 trip_no 與產生 trip_id
  select coalesce(max(trip_no), 0) + 1 into v_trip_no
  from public.trip_plan where plan_date = p_plan_date;

  v_trip_id := to_char(p_plan_date, 'YYYYMMDD') || '-' || lpad(v_trip_no::text, 3, '0');

  insert into public.trip_plan (
    trip_id, plan_date, trip_no, plan_departure, truck_id, driver_id,
    plan_type, trip_status, is_conflict, force_save, created_by
  ) values (
    v_trip_id, p_plan_date, v_trip_no, p_plan_departure, p_truck_id, p_driver_id,
    p_plan_type, 'WAITING', v_conflict, p_force_save, v_user_name
  );

  return jsonb_build_object(
    'success', true,
    'message', '車趟計畫建立成功',
    'data', jsonb_build_object(
      'tripId', v_trip_id,
      'tripNo', v_trip_no,
      'isConflict', v_conflict,
      'forceSave', p_force_save
    )
  );
end;
$$;


-- ============================================================
-- 3. 建立 update_trip() RPC
-- ============================================================

create or replace function public.update_trip(
  p_trip_id text,
  p_plan_departure timestamptz default null,
  p_truck_id text default null,
  p_driver_id text default null,
  p_force_save boolean default false
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
  v_trip record;
  v_conflict boolean := false;
  v_existing record;
  v_target_truck text;
  v_target_dep timestamptz;
begin
  v_auth_uid := auth.uid();
  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限修改');
  end if;

  select * into v_trip from public.trip_plan where trip_id = p_trip_id;
  if v_trip.trip_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_001', 'message', 'Trip 不存在');
  end if;

  -- 狀態限制：RUNNING Trip 不得變更車輛或刪除
  if v_trip.trip_status = 'RUNNING' and p_truck_id is not null and p_truck_id != v_trip.truck_id then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_003', 'message', '執行中 Trip 不得變更車輛');
  end if;

  if v_trip.trip_status in ('COMPLETE','CANCELLED') then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_004', 'message', '已完成或已取消 Trip 不得一般修改');
  end if;

  v_target_truck := coalesce(p_truck_id, v_trip.truck_id);
  v_target_dep := coalesce(p_plan_departure, v_trip.plan_departure);

  -- 衝突檢查
  for v_existing in (
    select trip_id, plan_departure from public.trip_plan
    where truck_id = v_target_truck and plan_date = v_trip.plan_date and trip_id != p_trip_id and trip_status != 'CANCELLED'
  ) loop
    if abs(extract(epoch from (v_target_dep - v_existing.plan_departure)) / 60) < 120 then
      v_conflict := true;
      exit;
    end if;
  end loop;

  if v_conflict and not p_force_save then
    return jsonb_build_object('success', false, 'requiresConfirm', true, 'errorCode', 'TRIP_002', 'message', '排程衝突：與同一車輛前後車趟間隔小於 120 分鐘');
  end if;

  update public.trip_plan set
    plan_departure = coalesce(p_plan_departure, plan_departure),
    truck_id = coalesce(p_truck_id, truck_id),
    driver_id = coalesce(p_driver_id, driver_id),
    is_conflict = v_conflict,
    force_save = p_force_save,
    updated_by = v_user_name,
    updated_at = now()
  where trip_id = p_trip_id;

  return jsonb_build_object('success', true, 'message', '修改成功');
end;
$$;


-- ============================================================
-- 4. 建立 add_extra_trip() RPC
-- ============================================================

create or replace function public.add_extra_trip(
  p_plan_date date,
  p_plan_departure timestamptz,
  p_truck_id text,
  p_driver_id text,
  p_add_reason text,
  p_force_save boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_add_reason not in ('STOCK_INCREASE','EXTRA_PARTS','TRUCK_ADJUST','OTHER') then
    return jsonb_build_object('success', false, 'errorCode', 'PARAM_001', 'message', '請選擇有效的追加原因');
  end if;

  return public.create_trip(p_plan_date, p_plan_departure, p_truck_id, p_driver_id, 'ADDED', p_force_save);
end;
$$;


-- ============================================================
-- 5. 建立 cancel_trip() RPC
-- ============================================================

create or replace function public.cancel_trip(
  p_trip_id text,
  p_cancel_reason text
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
  v_trip record;
begin
  v_auth_uid := auth.uid();
  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限取消');
  end if;

  if p_cancel_reason not in ('STOCK_DECREASE','TRUCK_FAILURE','OTHER') then
    return jsonb_build_object('success', false, 'errorCode', 'PARAM_001', 'message', '請選擇有效的取消原因');
  end if;

  select * into v_trip from public.trip_plan where trip_id = p_trip_id;
  if v_trip.trip_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_001', 'message', 'Trip 不存在');
  end if;

  if v_trip.trip_status != 'WAITING' then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_005', 'message', '僅未開始之 Trip 允許取消');
  end if;

  update public.trip_plan set
    trip_status = 'CANCELLED',
    cancel_reason = p_cancel_reason,
    updated_by = v_user_name,
    updated_at = now()
  where trip_id = p_trip_id;

  return jsonb_build_object('success', true, 'message', 'Trip 已成功取消 (保留歷史紀錄)');
end;
$$;


-- ============================================================
-- 6. 建立 copy_week() RPC
-- ============================================================

create or replace function public.copy_week(
  p_source_week_start date,
  p_target_week_start date
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
  v_rec record;
  v_target_date date;
  v_new_trip_id text;
  v_trip_no integer;
  v_count integer := 0;
begin
  v_auth_uid := auth.uid();
  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '無權限複製');
  end if;

  for v_rec in (
    select * from public.trip_plan
    where plan_date between p_source_week_start and (p_source_week_start + interval '5 days')::date
      and trip_status != 'CANCELLED'
    order by plan_date asc, trip_no asc
  ) loop
    v_target_date := p_target_week_start + (v_rec.plan_date - p_source_week_start);
    
    select coalesce(max(trip_no), 0) + 1 into v_trip_no
    from public.trip_plan where plan_date = v_target_date;

    v_new_trip_id := to_char(v_target_date, 'YYYYMMDD') || '-' || lpad(v_trip_no::text, 3, '0');

    insert into public.trip_plan (
      trip_id, plan_date, trip_no, plan_departure, truck_id, driver_id,
      plan_type, trip_status, is_conflict, force_save, created_by
    ) values (
      v_new_trip_id, v_target_date, v_trip_no,
      (v_target_date + (v_rec.plan_departure::time))::timestamptz,
      v_rec.truck_id, v_rec.driver_id, v_rec.plan_type, 'WAITING', false, false, v_user_name
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('success', true, 'message', '複製週計畫成功', 'data', jsonb_build_object('copiedCount', v_count));
end;
$$;


-- ============================================================
-- 7. 建立 auto_assign_trucks() RPC (支援動態多車與奇數趟結轉)
-- ============================================================

create or replace function public.auto_assign_trucks(
  p_plan_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trucks text[];
  v_truck_count integer;
  v_trip_rec record;
  v_index integer := 1;
  v_prev_last_truck text;
  v_start_offset integer := 0;
begin
  -- 取得所有啟用車輛列表
  select array_agg(truck_id order by sort_order asc) into v_trucks
  from public.truck_master where active = true;

  v_truck_count := array_length(v_trucks, 1);
  if v_truck_count is null or v_truck_count = 0 then
    return jsonb_build_object('success', false, 'message', '無可排程車輛');
  end if;

  -- 尋找前一工作日最後一趟車輛
  select truck_id into v_prev_last_truck
  from public.trip_plan
  where plan_date < p_plan_date and trip_status != 'CANCELLED'
  order by plan_date desc, trip_no desc limit 1;

  if v_prev_last_truck is not null then
    for i in 1..v_truck_count loop
      if v_trucks[i] = v_prev_last_truck then
        v_start_offset := i % v_truck_count;
        exit;
      end if;
    end loop;
  end if;

  -- 重新指派當日 Trip 之車輛
  for v_trip_rec in (
    select trip_id from public.trip_plan
    where plan_date = p_plan_date and trip_status = 'WAITING'
    order by trip_no asc
  ) loop
    update public.trip_plan
    set truck_id = v_trucks[((v_index - 1 + v_start_offset) % v_truck_count) + 1],
        updated_at = now()
    where trip_id = v_trip_rec.trip_id;
    v_index := v_index + 1;
  end loop;

  return jsonb_build_object('success', true, 'message', '自動交錯排車完成');
end;
$$;


-- ============================================================
-- 8. 建立 manual_add_trip_event() RPC (人工補正漏掃)
-- ============================================================

create or replace function public.manual_add_trip_event(
  p_trip_id text,
  p_event_code text,
  p_event_time timestamptz
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
  v_trip record;
  v_event_id text;
begin
  v_auth_uid := auth.uid();
  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '僅物流管理員可人工補正');
  end if;

  if p_event_code not in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB') then
    return jsonb_build_object('success', false, 'errorCode', 'EVENT_001', 'message', '無效的作業節點代碼');
  end if;

  select * into v_trip from public.trip_plan where trip_id = p_trip_id;
  if v_trip.trip_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_001', 'message', 'Trip 不存在');
  end if;

  v_event_id := 'EVT-MAN-' || gen_random_uuid()::text;

  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code,
    event_time, scan_time, report_type, is_manual_correction,
    offline_flag, valid_flag, created_by
  ) values (
    v_event_id, p_trip_id, v_trip.truck_id, v_trip.driver_id, p_event_code,
    p_event_time, now(), 'MANUAL', true, false, true, v_user_name
  );

  return jsonb_build_object('success', true, 'message', '人工補正成功 (標記為 MANUAL)');
end;
$$;


-- ============================================================
-- 9. 建立 correct_trip_event() RPC (Event 更正)
-- ============================================================

create or replace function public.correct_trip_event(
  p_original_event_id text,
  p_new_event_time timestamptz
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
  v_orig record;
  v_corr_event_id text;
begin
  v_auth_uid := auth.uid();
  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '僅物流管理員可更正 Event');
  end if;

  select * into v_orig from public.trip_event where event_id = p_original_event_id;
  if v_orig.event_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'EVENT_004', 'message', '原 Event 紀錄不存在');
  end if;

  v_corr_event_id := 'EVT-CORR-' || gen_random_uuid()::text;

  -- 建立更正 Event 紀錄，關聯 original_event_id，保留原 QR 紀錄 timestamp
  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code,
    event_time, scan_time, report_type, is_manual_correction,
    original_event_id, offline_flag, valid_flag, created_by
  ) values (
    v_corr_event_id, v_orig.trip_id, v_orig.truck_id, v_orig.driver_id, v_orig.event_code,
    p_new_event_time, now(), 'MANUAL', true, p_original_event_id, false, true, v_user_name
  );

  return jsonb_build_object('success', true, 'message', 'Event 更正成功 (保留原 QR 紀錄與歷史軌跡)');
end;
$$;


-- 權限設置
revoke all on function public.create_trip from public;
grant execute on function public.create_trip to authenticated;

revoke all on function public.update_trip from public;
grant execute on function public.update_trip to authenticated;

revoke all on function public.add_extra_trip from public;
grant execute on function public.add_extra_trip to authenticated;

revoke all on function public.cancel_trip from public;
grant execute on function public.cancel_trip to authenticated;

revoke all on function public.copy_week from public;
grant execute on function public.copy_week to authenticated;

revoke all on function public.auto_assign_trucks from public;
grant execute on function public.auto_assign_trucks to authenticated;

revoke all on function public.manual_add_trip_event from public;
grant execute on function public.manual_add_trip_event to authenticated;

revoke all on function public.correct_trip_event from public;
grant execute on function public.correct_trip_event to authenticated;

commit;
