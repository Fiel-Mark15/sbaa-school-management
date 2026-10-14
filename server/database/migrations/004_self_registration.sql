-- Applied through migrate.js after checking whether the column exists.
ALTER TABLE students ADD COLUMN identity_status ENUM('UNVERIFIED','VERIFIED') NOT NULL DEFAULT 'UNVERIFIED';
