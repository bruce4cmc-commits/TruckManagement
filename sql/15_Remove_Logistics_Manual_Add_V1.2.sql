-- 卡車管理系統 Migration SQL V1.2 (Remove Logistics Manual Add Event)
-- 目的：
-- 1. 調整 public.manual_add_trip_event() RPC 之權限檢查：限制僅系統管理員 (ADMIN) 可進行人工補登。
-- 2. 拒絕 LOGISTICS / SUPERVISOR / DRIVER / anon 等身分直接進行人工補登 (回傳 AUTH_005 權限不足)。
-- 3. LOGISTICS 仍可完整使用 correct_trip_event() 進行既有事件時間修正。

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
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

  select role, user_name into v_role, v_user_name from public.user_master
  where auth_user_id = v_auth_uid and active = true limit 1;

  -- 權限控制：僅限系統管理員 (ADMIN) 執行人工補登，LOGISTICS 人員拒絕執行
  if v_role is null or v_role <> 'ADMIN' then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_005', 'message', '權限被拒：僅系統管理員 (ADMIN) 可執行人工補登作業');
  end if;

  if p_event_code not in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB') then
    return jsonb_build_object('success', false, 'errorCode', 'EVENT_001', 'message', '無效的作業節點代碼');
  end if;

  select * into v_trip from public.trip_plan where trip_id = p_trip_id;
  if v_trip.trip_id is null then
    return jsonb_build_object('success', false, 'errorCode', 'TRIP_001', 'message', 'Trip 不存在');
  end if;

  -- 防重機制：檢查該 trip_id + event_code 是否已有有效 Base Event
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

  v_event_id := 'EVT-MAN-' || gen_random_uuid()::text;

  insert into public.trip_event (
    event_id, trip_id, truck_id, driver_id, event_code,
    event_time, scan_time, report_type, is_manual_correction,
    offline_flag, valid_flag, created_by
  ) values (
    v_event_id, p_trip_id, v_trip.truck_id, v_trip.driver_id, p_event_code,
    p_event_time, now(), 'MANUAL', true, false, true, v_user_name
  );

  return jsonb_build_object('success', true, 'message', '系統管理員人工補登成功');
end;
$$;

revoke all on function public.manual_add_trip_event(text, text, timestamptz) from public;
grant execute on function public.manual_add_trip_event(text, text, timestamptz) to authenticated;

commit;
