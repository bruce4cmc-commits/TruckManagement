-- 卡車管理系統 Migration SQL V1.2 (Phase ④ Final Gate)
-- 目的：
-- 1. 建立 public.effective_trip_events 檢視表 (統一全系統有效 Event 時間定義)
-- 2. 徹底封鎖 trip_event 任何層級之直接 INSERT/UPDATE/DELETE (Audit Ledger 終極防禦)
-- 3. 確保 get_public_active_trucks, scan_trip_event, manual_add_trip_event, correct_trip_event 具備正確安全性與權限

begin;

-- ============================================================
-- 1. 建立 effective_trip_events 檢視表 (Unified Effective Event View)
-- ============================================================

drop view if exists public.effective_trip_events cascade;

create or replace view public.effective_trip_events as
with latest_corrections as (
  select
    original_event_id,
    event_id as correction_event_id,
    event_time as corrected_event_time,
    created_by as corrected_by,
    uploaded_at as corrected_at,
    row_number() over (partition by original_event_id order by uploaded_at desc, event_time desc) as rn
  from public.trip_event
  where original_event_id is not null and valid_flag = true
)
select
  e.event_id as original_event_id,
  c.correction_event_id,
  e.trip_id,
  e.truck_id,
  e.driver_id,
  e.event_code,
  e.scan_time as original_scan_time,
  e.event_time as original_event_time,
  coalesce(c.corrected_event_time, e.event_time) as effective_event_time,
  e.report_type,
  e.offline_flag,
  e.is_manual_correction,
  (c.correction_event_id is not null) as has_correction,
  c.corrected_by,
  c.corrected_at,
  e.created_by,
  e.uploaded_at
from public.trip_event e
left join latest_corrections c on c.original_event_id = e.event_id and c.rn = 1
where e.original_event_id is null and e.valid_flag = true;

-- 授權 View 讀取權限
grant select on table public.effective_trip_events to authenticated;
revoke select on table public.effective_trip_events from anon;


-- ============================================================
-- 2. 最終封鎖 trip_event 直寫權限 (Event Ledger 終極防線)
-- ============================================================

revoke insert, update, delete on table public.trip_event from authenticated, anon, public;

-- 確定只有 RPC 能寫入 Event
grant execute on function public.scan_trip_event to authenticated;
grant execute on function public.manual_add_trip_event to authenticated;
grant execute on function public.correct_trip_event to authenticated;

commit;
