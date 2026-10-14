CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  country_of_residence TEXT NOT NULL,
  linkedin TEXT,
  phone TEXT,
  whatsapp INTEGER NOT NULL DEFAULT 0,
  signal INTEGER NOT NULL DEFAULT 0,
  professional_expertise TEXT NOT NULL,
  thematic_expertise TEXT NOT NULL,
  additional_information TEXT,
  associate_interest INTEGER NOT NULL DEFAULT 0,
  privacy_consent INTEGER NOT NULL,
  cv_object_key TEXT NOT NULL,
  cv_filename TEXT NOT NULL,
  notification_sent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS applications_created_at_idx ON applications(created_at);
