-- Applied through migrate.js only when the column is missing.
ALTER TABLE profile_contacts ADD COLUMN theme_preference ENUM('light','dark','system') NOT NULL DEFAULT 'system';
