UPDATE sync_jobs SET status='completed' WHERE status='succeeded';
ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_status_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_status_check CHECK(status IN ('queued','running','completed','partial','failed'));
