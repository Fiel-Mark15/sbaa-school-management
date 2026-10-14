CREATE TABLE IF NOT EXISTS schedule_exceptions (
  meeting_id BIGINT UNSIGNED NOT NULL,
  occurrence_date DATE NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(meeting_id,occurrence_date),
  FOREIGN KEY (meeting_id) REFERENCES schedule_meetings(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS class_reminder_deliveries (
  meeting_id BIGINT UNSIGNED NOT NULL,
  occurrence_date DATE NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  notification_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(meeting_id,occurrence_date,user_id),
  FOREIGN KEY (meeting_id) REFERENCES schedule_meetings(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id)
);
