ALTER TABLE pd_sites ADD COLUMN revenue_event TEXT;
ALTER TABLE pd_sites ADD COLUMN revenue_currency TEXT;

ALTER TABLE pd_events ADD COLUMN revenue_amount REAL;
ALTER TABLE pd_events ADD COLUMN revenue_currency TEXT;

CREATE INDEX IF NOT EXISTS pd_events_site_name_ts
  ON pd_events(site_id, name, ts);
