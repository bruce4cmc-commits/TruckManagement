-- 卡車管理系統 Supabase PostgreSQL Schema V1.2 (Direct)
-- 架構：Web App -> Supabase Auth / REST(PostgREST) / RLS / RPC -> PostgreSQL
-- 前端僅使用 Publishable key；不得持有 Secret/service_role key。

begin;

create table if not exists public.truck_master (
  truck_id text primary key,
  truck_no text not null unique,
  truck_name text,
  default_driver_id text,
  active boolean not null default true,
  sort_order integer not null default 999,
  remark text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.driver_master (
  driver_id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  driver_name text not null,
  default_truck_id text,
  password_hash text not null default '',
  active boolean not null default true,
  notify_overtime boolean not null default true,
  notify_traffic boolean not null default true,
  notify_departure boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_master (
  user_id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  user_name text not null,
  login_name text not null unique,
  password_hash text not null default '',
  role text not null check (role in ('LOGISTICS','SUPERVISOR','ADMIN')),
  active boolean not null default true,
  notify_overtime boolean not null default true,
  notify_traffic boolean not null default true,
  notify_departure boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.truck_master
  drop constraint if exists fk_truck_default_driver;
alter table public.truck_master
  add constraint fk_truck_default_driver
  foreign key (default_driver_id) references public.driver_master(driver_id)
  on update cascade on delete set null;

alter table public.driver_master
  drop constraint if exists fk_driver_default_truck;
alter table public.driver_master
  add constraint fk_driver_default_truck
  foreign key (default_truck_id) references public.truck_master(truck_id)
  on update cascade on delete set null;

create table if not exists public.trip_plan (
  trip_id text primary key,
  plan_date date not null,
  trip_no integer not null check (trip_no > 0),
  plan_departure timestamptz not null,
  truck_id text not null references public.truck_master(truck_id) on update cascade,
  driver_id text references public.driver_master(driver_id) on update cascade,
  plan_type text not null default 'NORMAL' check (plan_type in ('NORMAL','ADDED')),
  trip_status text not null default 'WAITING'
    check (trip_status in ('WAITING','RUNNING','COMPLETE','CANCELLED')),
  add_reason text,
  cancel_reason text,
  cancel_remark text,
  is_conflict boolean not null default false,
  force_save boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  unique(plan_date, trip_no)
);

create table if not exists public.trip_event (
  event_id text primary key,
  trip_id text not null references public.trip_plan(trip_id) on update cascade,
  truck_id text not null references public.truck_master(truck_id) on update cascade,
  driver_id text references public.driver_master(driver_id) on update cascade,
  event_code text not null
    check (event_code in ('YM_OUT','HC_IN','HC_WH','HC_OUT','YM_IN','YM_ENGINE','YM_CAB')),
  event_time timestamptz not null,
  scan_time timestamptz,
  report_type text not null check (report_type in ('QR','MANUAL')),
  is_manual_correction boolean not null default false,
  original_event_id text references public.trip_event(event_id) on update cascade,
  offline_flag boolean not null default false,
  uploaded_at timestamptz not null default now(),
  valid_flag boolean not null default true,
  created_by text
);

create table if not exists public.trip_status (
  truck_id text primary key references public.truck_master(truck_id) on update cascade,
  current_trip_id text references public.trip_plan(trip_id) on update cascade,
  driver_id text references public.driver_master(driver_id) on update cascade,
  current_status text not null default 'WAITING'
    check (current_status in (
      'WAITING','YM_TO_HC','HC_INTERNAL','HC_LOADING','HC_TO_YM',
      'YM_INTERNAL','YM_UNLOADING','READY','OVERTIME'
    )),
  last_event_code text,
  last_event_time timestamptz,
  next_event_code text,
  elapsed_minutes integer not null default 0,
  expected_time timestamptz,
  alert_time timestamptz,
  delay_minutes integer not null default 0,
  exception_flag boolean not null default false,
  exception_type text,
  updated_at timestamptz not null default now()
);

create table if not exists public.exception_log (
  exception_id text primary key,
  trip_id text references public.trip_plan(trip_id) on update cascade,
  truck_id text references public.truck_master(truck_id) on update cascade,
  driver_id text references public.driver_master(driver_id) on update cascade,
  exception_type text not null
    check (exception_type in ('OVERTIME','TRAFFIC_JAM','ACCIDENT','TRUCK_FAILURE','OTHER')),
  event_code text,
  start_time timestamptz not null,
  end_time timestamptz,
  duration_minutes integer,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  remark text,
  reported_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.system_config (
  config_key text primary key,
  value text not null,
  data_type text not null default 'NUMBER',
  active boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  remark text
);

create table if not exists public.dashboard_data (
  dashboard_id bigint generated always as identity primary key,
  period_type text not null check (period_type in ('DAY','WEEK','MONTH')),
  period_key text not null,
  plan_trip_count integer not null default 0,
  completed_trip_count integer not null default 0,
  trip_achievement_rate numeric(8,5) not null default 0,
  departure_on_time_rate numeric(8,5) not null default 0,
  average_cycle_minutes numeric(10,2) not null default 0,
  cycle_on_time_rate numeric(8,5) not null default 0,
  exception_trip_count integer not null default 0,
  exception_rate numeric(8,5) not null default 0,
  added_trip_count integer not null default 0,
  cancelled_trip_count integer not null default 0,
  truck_trip_summary jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique(period_type, period_key)
);

create index if not exists idx_trip_plan_date on public.trip_plan(plan_date);
create index if not exists idx_trip_plan_truck_departure on public.trip_plan(truck_id, plan_departure);
create index if not exists idx_trip_plan_status on public.trip_plan(trip_status);
create index if not exists idx_trip_event_trip_time on public.trip_event(trip_id, event_time);
create index if not exists idx_trip_event_truck_code_time on public.trip_event(truck_id, event_code, event_time desc);
create index if not exists idx_exception_trip_status on public.exception_log(trip_id, status);
create index if not exists idx_exception_start_time on public.exception_log(start_time desc);

-- V1.2: Frontend accesses Supabase Data API directly with Publishable key + Auth JWT.
-- RLS is the mandatory authorization boundary.
alter table public.truck_master enable row level security;
alter table public.driver_master enable row level security;
alter table public.user_master enable row level security;
alter table public.trip_plan enable row level security;
alter table public.trip_event enable row level security;
alter table public.trip_status enable row level security;
alter table public.exception_log enable row level security;
alter table public.system_config enable row level security;
alter table public.dashboard_data enable row level security;

-- Browser users are authenticated via Supabase Auth.
-- Base privileges are granted to authenticated; RLS policies still decide which rows are visible/writable.
revoke all on table
  public.truck_master,
  public.driver_master,
  public.user_master,
  public.trip_plan,
  public.trip_event,
  public.trip_status,
  public.exception_log,
  public.system_config,
  public.dashboard_data
from anon;

grant select on table
  public.truck_master,
  public.driver_master,
  public.user_master,
  public.trip_plan,
  public.trip_event,
  public.trip_status,
  public.exception_log,
  public.system_config,
  public.dashboard_data
to authenticated;

grant insert, update on table
  public.trip_plan,
  public.trip_event,
  public.trip_status,
  public.exception_log
to authenticated;

-- Helper functions for RLS. SECURITY DEFINER is used only to resolve the current app identity/role.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.user_master where auth_user_id = auth.uid() and active = true limit 1),
    case when exists (
      select 1 from public.driver_master where auth_user_id = auth.uid() and active = true
    ) then 'DRIVER' end
  );
$$;

create or replace function public.current_driver_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select driver_id
  from public.driver_master
  where auth_user_id = auth.uid() and active = true
  limit 1;
$$;

revoke all on function public.current_app_role() from public;
revoke all on function public.current_driver_id() from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.current_driver_id() to authenticated;

-- Reference/master read policies
create policy truck_master_read_authenticated
on public.truck_master for select to authenticated
using (active = true or public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN'));

create policy driver_master_read_scope
on public.driver_master for select to authenticated
using (
  auth_user_id = auth.uid()
  or public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
);

create policy user_master_read_self_or_management
on public.user_master for select to authenticated
using (
  auth_user_id = auth.uid()
  or public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
);

create policy system_config_read_authenticated
on public.system_config for select to authenticated
using (active = true);

-- Trip read
create policy trip_plan_read_scope
on public.trip_plan for select to authenticated
using (
  public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
  or driver_id = public.current_driver_id()
);

-- Only logistics/admin may directly write trip_plan. Prefer RPC for business operations.
create policy trip_plan_insert_logistics
on public.trip_plan for insert to authenticated
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

create policy trip_plan_update_logistics
on public.trip_plan for update to authenticated
using (public.current_app_role() in ('LOGISTICS','ADMIN'))
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

-- Events: drivers can read/write their own rows; management can read all.
create policy trip_event_read_scope
on public.trip_event for select to authenticated
using (
  public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
  or driver_id = public.current_driver_id()
);

create policy trip_event_insert_scope
on public.trip_event for insert to authenticated
with check (
  public.current_app_role() in ('LOGISTICS','ADMIN')
  or driver_id = public.current_driver_id()
);

-- Status read
create policy trip_status_read_scope
on public.trip_status for select to authenticated
using (
  public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
  or driver_id = public.current_driver_id()
);

-- Direct status writes limited to logistics/admin; normal QR flow should update status through RPC.
create policy trip_status_update_logistics
on public.trip_status for update to authenticated
using (public.current_app_role() in ('LOGISTICS','ADMIN'))
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

-- Exceptions
create policy exception_read_scope
on public.exception_log for select to authenticated
using (
  public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
  or driver_id = public.current_driver_id()
);

create policy exception_insert_scope
on public.exception_log for insert to authenticated
with check (
  public.current_app_role() in ('LOGISTICS','ADMIN')
  or driver_id = public.current_driver_id()
);

-- Dashboard read-only for logistics/supervisor/admin.
create policy dashboard_read_management
on public.dashboard_data for select to authenticated
using (public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN'));

-- No delete policies are created for business/history tables.
-- Privileged maintenance should be executed from Supabase Dashboard or a secured backend function.


commit;
