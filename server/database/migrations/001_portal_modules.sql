-- Additive migration. Run once after the original schema; it preserves existing rows.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_digest CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_sessions_user (user_id, revoked_at, expires_at)
);

CREATE TABLE IF NOT EXISTS subject_offerings (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  subject_id BIGINT UNSIGNED NOT NULL,
  term_id BIGINT UNSIGNED NOT NULL,
  section_id BIGINT UNSIGNED NOT NULL,
  faculty_id BIGINT UNSIGNED NULL,
  status ENUM('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (term_id) REFERENCES academic_terms(id),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (faculty_id) REFERENCES faculty(id),
  UNIQUE KEY uq_offering (subject_id, term_id, section_id),
  INDEX idx_offering_faculty_term (faculty_id, term_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  student_id BIGINT UNSIGNED NOT NULL,
  offering_id BIGINT UNSIGNED NOT NULL,
  status ENUM('ENROLLED','DROPPED') NOT NULL DEFAULT 'ENROLLED',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (offering_id) REFERENCES subject_offerings(id),
  UNIQUE KEY uq_enrollment (student_id, offering_id),
  INDEX idx_enrollment_offering (offering_id, status)
);

CREATE TABLE IF NOT EXISTS rooms (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  capacity SMALLINT UNSIGNED NULL,
  status ENUM('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS schedule_meetings (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  offering_id BIGINT UNSIGNED NOT NULL,
  room_id BIGINT UNSIGNED NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL COMMENT '1=Monday, 7=Sunday',
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status ENUM('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (offering_id) REFERENCES subject_offerings(id),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  INDEX idx_schedule_day_time (weekday, start_time, end_time),
  CONSTRAINT chk_schedule_day CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT chk_schedule_time CHECK (start_time < end_time)
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  resource_type VARCHAR(40) NULL,
  resource_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  read_at DATETIME NULL,
  PRIMARY KEY (notification_id, user_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_recipient_unread (user_id, read_at)
);

CREATE TABLE IF NOT EXISTS profile_contacts (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  phone VARCHAR(30) NULL,
  receive_optional_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_digest CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_reset_user (user_id, used_at)
);
