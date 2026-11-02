CREATE TABLE IF NOT EXISTS meego_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id varchar(64) NOT NULL,
  work_item_type varchar(64),
  work_item_name varchar(255),
  project varchar(128),
  mode varchar(16) NOT NULL DEFAULT 'create',
  group_name varchar(64),
  description varchar(200),
  changed_text text,
  existing_chat_id varchar(64),
  status varchar(16) NOT NULL DEFAULT 'pending',
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_meego_pending_work_item ON meego_pending (work_item_id);
CREATE INDEX IF NOT EXISTS idx_meego_pending_status ON meego_pending (status);

COMMENT ON COLUMN meego_pending.mode IS 'create=新建群 update=更新已有群';
COMMENT ON COLUMN meego_pending.status IS 'pending=待确认 confirmed=已处理';

ALTER TABLE meego_pending ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON meego_pending
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON meego_pending
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON meego_pending
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON meego_pending
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );

CREATE TABLE IF NOT EXISTS workitem_group_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id varchar(64) NOT NULL,
  chat_id varchar(64) NOT NULL,
  chat_name varchar(64),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_workitem_group_map_item ON workitem_group_map (work_item_id);

ALTER TABLE workitem_group_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON workitem_group_map
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON workitem_group_map
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON workitem_group_map
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON workitem_group_map
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );
