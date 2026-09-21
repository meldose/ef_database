CREATE TABLE cost_entries (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  robot_id text NOT NULL,
  category text NOT NULL CHECK(category IN ('labor','parts','travel','subscription','other')),
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK(quantity > 0),
  unit_cost_cents bigint NOT NULL CHECK(unit_cost_cents >= 0),
  net_cents bigint NOT NULL CHECK(net_cents >= 0),
  tax_cents bigint NOT NULL CHECK(tax_cents >= 0),
  gross_cents bigint NOT NULL CHECK(gross_cents >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK(status IN ('active','voided')),
  occurred_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX cost_entries_tenant_time_idx ON cost_entries(tenant_id,occurred_at DESC);
CREATE INDEX cost_entries_robot_time_idx ON cost_entries(robot_id,occurred_at DESC);
