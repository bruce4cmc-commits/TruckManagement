-- 卡車管理系統 Supabase Seed V1.2
-- 建議先執行 01_schema.sql，再執行本檔。
-- 密碼改由 Supabase Auth 管理。請先於 Auth 建立帳號，再回填 driver_master/user_master.auth_user_id。

insert into public.system_config(config_key,value,data_type,remark) values
('CYCLE_STANDARD','120','NUMBER','標準Cycle分鐘'),
('CYCLE_ON_TIME_MAX','140','NUMBER','Cycle準時上限'),
('DEPARTURE_TOLERANCE','20','NUMBER','楊梅出發允許±分鐘'),
('ALERT_BUFFER','15','NUMBER','節點警示緩衝'),
('DUPLICATE_THRESHOLD','100','NUMBER','重複掃描判斷分鐘'),
('DEPARTURE_REMINDER','10','NUMBER','出發前提醒分鐘'),
('YM_OUT_HC_IN','30','NUMBER','楊梅出廠→新竹入廠'),
('HC_IN_HC_WH','5','NUMBER','新竹入廠→新竹車頭庫房'),
('HC_WH_HC_OUT','25','NUMBER','新竹庫房裝卸→新竹出廠'),
('HC_OUT_YM_IN','30','NUMBER','新竹出廠→楊梅入廠'),
('YM_IN_ENGINE','5','NUMBER','楊梅入廠→楊梅引擎庫'),
('ENGINE_CAB','10','NUMBER','卸引擎→楊梅車頭庫'),
('CAB_NEXT_OUT','15','NUMBER','裝車頭→下一次楊梅出廠')
on conflict (config_key) do update
set value=excluded.value,
    data_type=excluded.data_type,
    remark=excluded.remark,
    updated_at=now();

-- 測試/初始主檔，可依正式車牌與姓名修改。
insert into public.driver_master(
  driver_id,driver_name,default_truck_id,password_hash,active,
  notify_overtime,notify_traffic,notify_departure
) values
('D001','司機01',null,'',true,true,true,true),
('D002','司機02',null,'',true,true,true,true)
on conflict (driver_id) do nothing;

insert into public.truck_master(
  truck_id,truck_no,truck_name,default_driver_id,active,sort_order
) values
('T001','車01','車01','D001',true,1),
('T002','車02','車02','D002',true,2)
on conflict (truck_id) do nothing;

update public.driver_master set default_truck_id='T001' where driver_id='D001';
update public.driver_master set default_truck_id='T002' where driver_id='D002';

insert into public.user_master(
  user_id,user_name,login_name,password_hash,role,active,
  notify_overtime,notify_traffic,notify_departure
) values
('U001','物流管理員','logistics01','','LOGISTICS',true,true,true,false),
('U002','物流主管','supervisor01','','SUPERVISOR',true,true,true,false)
on conflict (user_id) do nothing;
