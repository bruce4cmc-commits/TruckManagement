-- 卡車管理系統 Migration SQL V1.2 (Phase ④ Data Gate: Effective Event Security & Anti-Duplicate Fix)
-- 目的：
-- 1. 重建 effective_trip_events 檢視表，採用 with (security_invoker = true)，強制走呼叫者的底層 RLS (驅動 DRIVER 資料隔離)
-- 2. 嚴格限定每組 trip_id + event_code 最多輸出 1 筆 Base Effective Event (保證唯一性)
-- 3. 更正版本選擇邏輯：多筆更正時，依據創置/上傳時間 (uploaded_at desc) 取最新更正，不依據 event_time 大小
-- 4. 升級 manual_add_trip_event() 防重機制：已有有效 Base Event 時禁止二次 manual_add，拋出 EVENT_005

begin;

-- ============================================================
-- 1. 建立安全且具資料隔離效果之 effective_trip_events View
-- ============================================================

drop view if exists public.effective_trip_events cascade;

create or replace view public.effective_trip_events
with (security_invoker = true)
as
with base_events as (
  select
    event_id,
    trip_id,
    truck_id,
    driver_id,
    event_code,
    event_time,
    scan_time,
    report_type,
    offline_flag,
    is_manual_correction,
    created_by,
    uploaded_at,
    row_number() over (
      partition by trip_id, event_code
      order by uploaded_at asc, event_time asc
    ) as base_rn
  from public.trip_event
  where original_event_id is null and valid_flag = true
),
latest_corrections as (
  select
    original_event_id,
    event_id as correction_event_id,
    event_time as corrected_event_time,
    created_by as corrected_by,
    uploaded_at as corrected_at,
    row_number() over (
      partition by original_event_id
      order by uploaded_at desc, event_id desc
    ) as corr_rn
  from public.trip_event
  where original_event_id is not null and valid_flag = true
)
select
  b.event_id as original_event_id,
  c.correction_event_id,
  b.trip_id,
  b.truck_id,
  b.driver_id,
  b.event_code,
  b.scan_time as original_scan_time,
  b.event_time as original_event_time,
  coalesce(c.corrected_event_time, b.event_time) as effective_event_time,
  b.report_type,
  b.offline_flag,
  b.is_manual_correction,
  (c.correction_event_id is not null) as has_correction,
  c.corrected_by,
  c.corrected_at,
  b.created_by,
  b.uploaded_at
from base_events b
left join latest_corrections c on c.original_event_id = b.event_id and c.corr_rn = 1
where b.base_rn = 1;

-- 授權 View 存取
grant select on table public.effective_trip_events to authenticated;
revoke select on table public.effective_trip_events from anon;


-- ============================================================
-- 2. 升級 manual_add_trip_event() 防重機制
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
  v_existing_base boolean;
begin
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    return jsonb_build_object('success', false, 'errorCode', 'AUTH_003', 'message', '未登入');
  end if;

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

  return jsonb_build_object('success', true, 'message', '人工補正成功 (標記為 MANUAL)');
end;
$$;

revoke all on function public.manual_add_trip_event(text, text, timestamptz) from public;
grant execute on function public.manual_add_trip_event(text, text, timestamptz) to authenticated;

commit;
