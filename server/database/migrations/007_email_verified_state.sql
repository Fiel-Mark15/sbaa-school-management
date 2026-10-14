-- Applied by migrate.js only when absent. Existing accounts remain unverified until a confirmed address change or school verification workflow.
ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL;
