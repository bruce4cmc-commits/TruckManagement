-- 卡車管理系統 Migration SQL V1.2 (Security Fix)
-- 目的：
-- 1. 移除 anon 對 public.truck_master 的直接 SELECT 權限。
-- 2. 建立僅回傳必要公開欄位 (truck_id, truck_no, truck_name, sort_order) 之 get_public_active_trucks() RPC。
-- 3. 移除基於 raw_user_meta_data 之不安全 Auth 自動認領 Trigger。
-- 4. 嚴格限定授權判斷僅能基於資料庫與 auth.uid()。

begin;

-- ============================================================
-- A. 移除 anon 直接讀取 truck_master，改用受限 RPC
-- ============================================================

-- 收回 anon 對 truck_master 的直接 SELECT 權限
revoke select on table public.truck_master from anon;

-- 建立安全的 RPC function，僅暴露登入下拉選單所需的 4 個無害欄位
create or replace function public.get_public_active_trucks()
returns table (
  truck_id text,
  truck_no text,
  truck_name text,
  sort_order integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    truck_id,
    truck_no,
    truck_name,
    sort_order
  from public.truck_master
  where active = true
  order by sort_order asc;
$$;

-- 設定 RPC 執行權限 (僅開放 EXECUTE 給 anon 與 authenticated)
revoke all on function public.get_public_active_trucks() from public;
grant execute on function public.get_public_active_trucks() to anon, authenticated;

-- ============================================================
-- B. 移除不安全之 Auth 自動帳號認領 Trigger
-- ============================================================

-- 移除利用 raw_user_meta_data 自動寫入 auth_user_id 的 Trigger 與 Function
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_auth_user_linked();

-- 備註：正式環境身份綁定 auth.users.id -> driver_master/user_master.auth_user_id
-- 必須由系統管理員或微服務在後端事前設定完成，禁止使用者前端自行透過 metadata 認領角色。

commit;
