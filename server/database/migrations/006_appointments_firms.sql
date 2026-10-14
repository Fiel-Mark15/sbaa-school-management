CREATE TABLE IF NOT EXISTS appointment_availability (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  faculty_id BIGINT UNSIGNED NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  buffer_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (faculty_id) REFERENCES faculty(id),
  INDEX idx_availability_faculty_day (faculty_id,weekday,active),
  CHECK (weekday BETWEEN 1 AND 7), CHECK (start_time < end_time)
);

CREATE TABLE IF NOT EXISTS appointment_exceptions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  faculty_id BIGINT UNSIGNED NOT NULL,
  unavailable_date DATE NOT NULL,
  reason VARCHAR(200) NULL,
  FOREIGN KEY (faculty_id) REFERENCES faculty(id),
  UNIQUE KEY uq_appointment_exception (faculty_id,unavailable_date)
);

CREATE TABLE IF NOT EXISTS appointment_settings (
  id TINYINT UNSIGNED PRIMARY KEY,
  advance_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  cancellation_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO appointment_settings(id,advance_days,cancellation_hours) VALUES (1,30,24);

CREATE TABLE IF NOT EXISTS firms (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(180) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  public_address VARCHAR(300) NULL,
  public_contact VARCHAR(190) NULL,
  website VARCHAR(500) NULL,
  status ENUM('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_firm_status_name(status,name)
);
