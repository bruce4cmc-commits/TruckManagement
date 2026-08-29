-- 卡車管理系統 Migration SQL V1.2 (Auth & RLS 補強)
-- 目的：確保 auth_user_id 存在、精確授權 SQL Privileges 與 RLS Policies，並建置自動綁定觸發器。

begin;

-- 1. 檢查與確保 auth_user_id 欄位存在
alter table public.driver_master
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

alter table public.user_master
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

-- 2. 調整 SQL Table Privileges
-- anon (未登入者)：僅允許讀取 active = true 之 truck_master (供登入下拉選單選擇車號)，禁止讀取其餘所有敏感業務資料。
grant select on table public.truck_master to anon;

revoke all on table
  public.driver_master,
  public.user_master,
  public.trip_plan,
  public.trip_event,
  public.trip_status,
  public.exception_log,
  public.system_config,
  public.dashboard_data
from anon;

-- authenticated (已登入者)：授予基礎 SELECT/INSERT/UPDATE 權限，真正存取範圍由 RLS 嚴格管控。
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
  public.truck_master,
  public.driver_master,
  public.user_master,
  public.trip_plan,
  public.trip_event,
  public.trip_status,
  public.exception_log
to authenticated;

-- 3. 補充主檔 RLS Policies (LOGISTICS 管理維護寫入權限)
drop policy if exists truck_master_read_authenticated on public.truck_master;
create policy truck_master_read_authenticated
on public.truck_master for select to public
using (
  active = true 
  or public.current_app_role() in ('LOGISTICS','SUPERVISOR','ADMIN')
);

drop policy if exists truck_master_write_logistics on public.truck_master;
create policy truck_master_write_logistics
on public.truck_master for insert to authenticated
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

drop policy if exists truck_master_update_logistics on public.truck_master;
create policy truck_master_update_logistics
on public.truck_master for update to authenticated
using (public.current_app_role() in ('LOGISTICS','ADMIN'))
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

drop policy if exists driver_master_write_logistics on public.driver_master;
create policy driver_master_write_logistics
on public.driver_master for insert to authenticated
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

drop policy if exists driver_master_update_logistics on public.driver_master;
create policy driver_master_update_logistics
on public.driver_master for update to authenticated
using (
  auth_user_id = auth.uid() 
  or public.current_app_role() in ('LOGISTICS','ADMIN')
)
with check (
  auth_user_id = auth.uid() 
  or public.current_app_role() in ('LOGISTICS','ADMIN')
);

drop policy if exists user_master_write_logistics on public.user_master;
create policy user_master_write_logistics
on public.user_master for insert to authenticated
with check (public.current_app_role() in ('LOGISTICS','ADMIN'));

drop policy if exists user_master_update_logistics on public.user_master;
create policy user_master_update_logistics
on public.user_master for update to authenticated
using (
  auth_user_id = auth.uid() 
  or public.current_app_role() in ('LOGISTICS','ADMIN')
)
with check (
  auth_user_id = auth.uid() 
  or public.current_app_role() in ('LOGISTICS','ADMIN')
);

-- 4. 建立 Auth 使用者與主檔自動綁定 Trigger
create or replace function public.handle_auth_user_linked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref_id text;
  v_user_type text;
begin
  v_ref_id := new.raw_user_meta_data->>'ref_id';
  v_user_type := new.raw_user_meta_data->>'user_type';

  if v_ref_id is not null then
    if v_user_type = 'DRIVER' or v_ref_id like 'D%' then
      update public.driver_master
      set auth_user_id = new.id, updated_at = now()
      where driver_id = v_ref_id;
    elsif v_user_type = 'MANAGEMENT' or v_ref_id like 'U%' then
      update public.user_master
      set auth_user_id = new.id, updated_at = now()
      where user_id = v_ref_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_linked();

commit;
