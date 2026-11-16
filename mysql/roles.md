-- HireLink Users, roles and privileges
USE college_placement_internship;

CREATE ROLE IF NOT EXISTS 'student_role';
GRANT SELECT ON college_placement_internship.JOB_VACANCY_STATUS TO 'student_role';
GRANT SELECT ON college_placement_internship.JOB_OPENING        TO 'student_role';
GRANT SELECT ON college_placement_internship.VW_STUDENT_DETAILS TO 'student_role';

CREATE ROLE IF NOT EXISTS 'coordinator_role';
GRANT SELECT, INSERT, UPDATE ON college_placement_internship.* TO 'coordinator_role';
GRANT EXECUTE ON college_placement_internship.* TO 'coordinator_role';

CREATE USER IF NOT EXISTS 'admin_user'@'localhost'   IDENTIFIED BY 'ChangeMe_Admin1!';
CREATE USER IF NOT EXISTS 'student_user'@'localhost' IDENTIFIED BY 'ChangeMe_Student1!';

GRANT ALL PRIVILEGES ON college_placement_internship.* TO 'admin_user'@'localhost';
GRANT 'student_role' TO 'student_user'@'localhost';
SET DEFAULT ROLE 'student_role' TO 'student_user'@'localhost';
