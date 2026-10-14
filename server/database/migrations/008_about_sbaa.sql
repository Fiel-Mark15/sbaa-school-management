CREATE TABLE IF NOT EXISTS about_sbaa (
  id TINYINT UNSIGNED PRIMARY KEY,
  overview TEXT NOT NULL,
  history TEXT NOT NULL,
  mission TEXT NOT NULL,
  vision TEXT NOT NULL,
  department_values TEXT NOT NULL,
  programs TEXT NOT NULL,
  services TEXT NOT NULL,
  contact TEXT NOT NULL,
  status ENUM('DRAFT','PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO about_sbaa(id,overview,history,mission,vision,department_values,programs,services,contact,status)
VALUES (1,'','','','','','','','','DRAFT');
