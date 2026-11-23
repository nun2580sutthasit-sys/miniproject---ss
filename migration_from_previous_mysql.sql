-- Legacy MySQL migration; this file is not compatible with PostgreSQL/pgAdmin.
-- Do not run this file against the PostgreSQL database used by the current backend.
USE save_share;

ALTER TABLE users
ADD COLUMN university_id BIGINT UNSIGNED NULL AFTER password_hash;

UPDATE users u
JOIN universities un ON un.university_name = u.university
SET
  u.university_id = un.id;

UPDATE users
SET
  university_id = (
    SELECT
      id
    FROM
      universities
    WHERE
      university_name = 'มหาวิทยาลัยธุรกิจบัณฑิตย์'
    LIMIT
      1
  )
WHERE
  university_id IS NULL;

ALTER TABLE users
MODIFY university_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE users
ADD CONSTRAINT fk_users_university FOREIGN KEY (university_id) REFERENCES universities (id);

ALTER TABLE users
ADD INDEX idx_users_university (university_id);

ALTER TABLE users
ADD INDEX idx_users_verification (verification_status);

ALTER TABLE student_verifications
ADD COLUMN university_id BIGINT UNSIGNED NULL AFTER user_id;

UPDATE student_verifications sv
JOIN users u ON u.id = sv.user_id
SET
  sv.university_id = u.university_id;

ALTER TABLE student_verifications
MODIFY university_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE student_verifications
ADD CONSTRAINT fk_verifications_university FOREIGN KEY (university_id) REFERENCES universities (id);

-- เปลี่ยนจากข้อความเดิมเป็น foreign key เพื่อให้ schema ตรงกับ REST API รุ่นนี้
ALTER TABLE users
DROP COLUMN university;

ALTER TABLE student_verifications
DROP COLUMN university;
