-- HireLink Views 
USE college_placement_internship;

-- VIEWS
CREATE OR REPLACE VIEW VW_LOW_CGPA_STUDENTS AS
SELECT student_id, first_name, last_name, cgpa, dept_code
FROM STUDENT
WHERE cgpa < 7.00;

CREATE OR REPLACE VIEW VW_HIGH_CGPA_STUDENTS AS
SELECT student_id, first_name, last_name, cgpa, dept_code
FROM STUDENT
WHERE cgpa >= 8.50;

CREATE OR REPLACE VIEW VW_STUDENT_DETAILS AS
SELECT student_id, first_name, last_name, dob,
       TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age,
       gender, email, cgpa, academic_status, dept_code, program_code
FROM STUDENT;

CREATE OR REPLACE VIEW STUDENT_PLACEMENT_SUMMARY AS
SELECT s.student_id,
       CONCAT(s.first_name, ' ', s.last_name) AS student_name,
       TIMESTAMPDIFF(YEAR, s.dob, CURDATE())   AS age,
       COUNT(DISTINCT a.application_id)        AS total_applications,
       COUNT(DISTINCT o.offer_id)              AS total_offers_received,
       COUNT(DISTINCT CASE WHEN o.job_status = 'accepted' THEN o.offer_id END) AS offers_accepted
FROM STUDENT s
LEFT JOIN APPLICATION a ON a.student_id = s.student_id
LEFT JOIN OFFER o       ON o.application_id = a.application_id
GROUP BY s.student_id, s.first_name, s.last_name, s.dob;


CREATE OR REPLACE VIEW JOB_VACANCY_STATUS AS
SELECT j.job_id, j.job_title,
       j.vacancies AS total_vacancies,
       COUNT(CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS filled_vacancies,
       j.vacancies - COUNT(CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS remaining_vacancies
FROM JOB_OPENING j
LEFT JOIN APPLICATION a ON a.job_id = j.job_id
LEFT JOIN OFFER o       ON o.application_id = a.application_id
GROUP BY j.job_id, j.job_title, j.vacancies;
