CREATE TABLE email_jobs (
  id uuid PRIMARY KEY,
  notification_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  worker_id text,
  locked_at timestamptz,
  delivery jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_jobs_claim_idx ON email_jobs(status,next_attempt_at,created_at);
CREATE INDEX email_jobs_notification_idx ON email_jobs(notification_key,created_at DESC);
