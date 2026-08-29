-- 卡車管理系統 Migration SQL V1.2 (Phase ④ Final SQL Verification)
-- 目的：
-- 1. 嚴格確認與強化 manual_add_trip_event() RPC:
--    - 確保在取用 v_trip.truck_id 與 v_trip.driver_id 前，必先從 trip_plan 執行 SELECT ... INTO v_trip
--    - 若找不到 trip_id 必拋出 TRIP_001 (Trip 不存在)，且絕不建立 Event
--    - 限定 p_event_code 為 7 個合法節點，否則拋出 EVENT_001
--    - Event 寫入之 truck_id 與 driver_id 100% 來自該 trip_plan，禁止瀏覽器傳入
--    - 確保人工補正絕不異動 trip_status 快照與 Runtime Stage (Snapshot 不倒退)

begin;

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
  v_existing_base boolean;
begin
  -- 1. 身份與 Session 驗證
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入或 Session 已失效');
  end if;

  -- 2. 角色權限驗證
  select role, user_name into v_role, v_user_name
  from public.user_master
  where auth_user_id = v_auth_uid and active = true
  limit 1;

  if v_role not in ('LOGISTICS','ADMIN') then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '僅物流管理員或系統管理員可執行人工補正');
  end if;

  -- 3. 七個合法作業節點驗證
  if p_event_code not in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB') then
    return jsonb_build_object('success', false, 'errorCode', 'EVENT_001', 'message', '無效的作業節點代碼');
  end if;

  -- 4. 關鍵步驟：先從 trip_plan 檢索目標 Trip 資料
  select * into v_trip
  from public.trip_plan
  where trip_id = p_trip_id;

  -- 5. 不存在 trip_id 時拒絕並中斷，絕不建立 Event
  if v_trip.trip_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_001', 'message', 'Trip 不存在');
  end if;

  -- 6. 防重機制：檢查該 trip_id + event_code 是否已有有效 Base Event
  select exists (
    select 1 from public.trip_event
    where trip_id = p_trip_id
      and event_code = p_event_code
      and original_event_id is null
      and valid_flag = true
  ) into v_existing_base;

  if v_existing_base then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'EVENT_005',
      'message', '該節點已有有效紀錄 (如需修正時間請使用 Event 更正功能)'
    );
  end if;

  -- 7. 寫入 trip_event，truck_id 與 driver_id 100% 來自 trip_plan (v_trip.truck_id, v_trip.driver_id)
  v_event_id := 'EVT-MAN-' || gen_random_uuid()::text;

  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code,
    event_time, scan_time, report_type, is_manual_correction,
    offline_flag, valid_flag, created_by
  ) values (
    v_event_id, p_trip_id, v_trip.truck_id, v_trip.driver_id, p_event_code,
    p_event_time, now(), 'MANUAL', true,
    false, true, v_user_name
  );

  -- 8. 人工補正僅寫入 Event Ledger，不改動 trip_status (保證 Snapshot 不倒退)
  return jsonb_build_object(
    'success', true,
    'message', '人工補正成功 (標記為 MANUAL，資料源自 trip_plan)',
    'data', jsonb_build_object(
      'eventId', v_event_id,
      'tripId', p_trip_id,
      'truckId', v_trip.truck_id,
      'driverId', v_trip.driver_id,
      'eventCode', p_event_code,
      'eventTime', p_event_time
    )
  );
end;
$$;

revoke all on function public.manual_add_trip_event(text, text, timestamptz) from public;
grant execute on function public.manual_add_trip_event(text, text, timestamptz) to authenticated;

commit;
