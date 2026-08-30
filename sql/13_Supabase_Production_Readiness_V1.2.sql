-- 卡車管理系統 Migration SQL V1.2 (Phase ⑥: Production Readiness & Automation)
-- 目的：
-- 1. 建立 public.notification_log 站內發送與提醒紀錄表
-- 2. 建立 check_trip_overtime() 引擎 (根據標準 + 15 分鐘門檻自動 OPEN OVERTIME 異常)
-- 3. 建立 check_departure_reminders() 引擎 (出發前 <= 10 分鐘自動建立發車提醒，防重複寫入)
-- 4. 設定 pg_cron 排程任務 (每 5 分鐘自動巡檢 Overtime 與出發提醒)

begin;

-- ============================================================
-- 1. 建立 notification_log 站內提醒紀錄表
-- ============================================================

create table if not exists public.notification_log (
  notification_id text primary key default ('NOTIF-' || gen_random_uuid()::text),
  trip_id text references public.trip_plan(trip_id) on delete cascade,
  truck_id text references public.truck_master(truck_id),
  driver_id text references public.driver_master(driver_id),
  notification_type text not null, -- DEPARTURE_REMINDER, OVERTIME_ALERT, SYSTEM
  title text not null,
  message text not null,
  status text not null default 'UNREAD', -- UNREAD, READ
  created_at timestamptz not null default now(),
  unique(trip_id, notification_type) -- 防重複提醒
);

alter table public.notification_log enable row level security;

create policy notif_read_scope on public.notification_log
  for select to authenticated
  using (true);

-- ============================================================
-- 2. 建立 check_trip_overtime() 自動化超時巡檢引擎
-- ============================================================

create or replace function public.check_trip_overtime()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec record;
  v_threshold_minutes integer;
  v_elapsed_minutes integer;
  v_created_count integer := 0;
  v_exc_id text;
begin
  for v_rec in (
    select s.truck_id, s.current_trip_id, s.driver_id, s.last_event_code, s.last_event_time, s.current_status
    from public.trip_status s
    where s.current_status not in ('WAITING', 'READY') and s.last_event_time is not null
  ) loop
    -- 依節點標準 + 15 分鐘判定過期門檻
    case v_rec.last_event_code
      when 'YM_OUT' then v_threshold_minutes := 30 + 15; -- 45 分鐘
      when 'HC_IN' then v_threshold_minutes := 5 + 15;   -- 20 分鐘
      when 'HC_WH' then v_threshold_minutes := 25 + 15;  -- 40 分鐘
      when 'HC_OUT' then v_threshold_minutes := 30 + 15; -- 45 分鐘
      when 'YM_IN' then v_threshold_minutes := 5 + 15;   -- 20 分鐘
      when 'YM_ENGINE' then v_threshold_minutes := 10 + 15; -- 25 分鐘
      when 'YM_CAB' then v_threshold_minutes := 15 + 15; -- 30 分鐘
      else v_threshold_minutes := 45;
    end case;

    v_elapsed_minutes := extract(epoch from (now() - v_rec.last_event_time)) / 60;

    if v_elapsed_minutes > v_threshold_minutes then
      -- 檢查是否已有 OPEN 的 OVERTIME 異常
      if not exists (
        select 1 from public.exception_log
        where truck_id = v_rec.truck_id and exception_type = 'OVERTIME' and status = 'OPEN'
      ) then
        v_exc_id := 'EXC-' || gen_random_uuid()::text;
        insert into public.exception_log (
          exception_id, trip_id, truck_id, driver_id, exception_type,
          start_time, status, description
        ) values (
          v_exc_id, v_rec.current_trip_id, v_rec.truck_id, v_rec.driver_id, 'OVERTIME',
          v_rec.last_event_time, 'OPEN', '作業逾時：節點 ' || v_rec.last_event_code || ' 已停留 ' || v_elapsed_minutes || ' 分鐘 (超過門檻 ' || v_threshold_minutes || ' 分鐘)'
        );
        v_created_count := v_created_count + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('success', true, 'message', 'Overtime 巡檢完成', 'data', jsonb_build_object('createdCount', v_created_count));
end;
$$;


-- ============================================================
-- 3. 建立 check_departure_reminders() 發車提醒引擎
-- ============================================================

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
      and plan_date = current_date
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
      -- 已建立過發車提醒，忽視重複
      null;
    end;
  end loop;

  return jsonb_build_object('success', true, 'message', '發車提醒巡檢完成', 'data', jsonb_build_object('createdCount', v_created_count));
end;
$$;


-- ============================================================
-- 4. 註冊 pg_cron 排程任務 (每 5 分鐘自動執行)
-- ============================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('check_overtime_job', '*/5 * * * *', 'select public.check_trip_overtime()');
    perform cron.schedule('check_reminders_job', '*/5 * * * *', 'select public.check_departure_reminders()');
  end if;
exception when others then
  null; -- 若非 Cloud/DB 超級權限環境，忽略排程註冊
end $$;

-- 權限收緊：Cron / Internal 專用 Function 限制，禁止外部 RPC 直接調用
revoke all on function public.check_trip_overtime() from public, anon, authenticated;
revoke all on function public.check_departure_reminders() from public, anon, authenticated;

commit;
