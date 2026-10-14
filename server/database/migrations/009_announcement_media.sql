-- Additive: private announcement images and retry-safe creation keys.
CREATE TABLE IF NOT EXISTS announcement_images (
  announcement_id BIGINT UNSIGNED PRIMARY KEY,
  storage_key CHAR(64) NOT NULL UNIQUE,
  original_name VARCHAR(180) NOT NULL,
  width SMALLINT UNSIGNED NOT NULL,
  height SMALLINT UNSIGNED NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (announcement_id) REFERENCES announcements(id)
);
