CREATE TABLE IF NOT EXISTS risk_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_key varchar(64) NOT NULL,
  risk_hash varchar(40) NOT NULL,
  risk_desc text NOT NULL,
  owner_open_id varchar(64) NOT NULL,
  owner_name varchar(128),
  status varchar(16) NOT NULL DEFAULT 'pending',
  feedback text,
  deadline TIMESTAMP(3) WITH TIME ZONE,
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

CREATE UNIQUE INDEX IF NOT EXISTS uk_risk_feedback_cycle_hash ON risk_feedback (cycle_key, risk_hash);
CREATE INDEX IF NOT EXISTS idx_risk_feedback_cycle ON risk_feedback (cycle_key);
CREATE INDEX IF NOT EXISTS idx_risk_feedback_status ON risk_feedback (status);

COMMENT ON COLUMN risk_feedback.status IS 'pending=待反馈 responded=已反馈 overdue=已逾期';
COMMENT ON COLUMN risk_feedback.risk_hash IS 'sha1(cycleKey|desc|owner) 前 40 位，同周期同风险幂等';

ALTER TABLE risk_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON risk_feedback
  TO service_role USING (true);

CREATE POLICY "修改全部数据" ON risk_feedback
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "查看全部数据" ON risk_feedback
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY "修改本人数据" ON risk_feedback
  AS PERMISSIVE FOR ALL TO authenticated USING (
    (current_setting('app.user_id'::text) = ANY (ARRAY[]::text[]))
    AND (current_setting('app.user_id'::text) = ((_created_by).user_id)::text)
  );
