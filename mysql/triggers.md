-- HireLink Views + Triggers
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

-- filled_vacancies = offers that currently hold a seat (pending + accepted).

CREATE OR REPLACE VIEW JOB_VACANCY_STATUS AS
SELECT j.job_id, j.job_title,
       j.vacancies AS total_vacancies,
       COUNT(CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS filled_vacancies,
       j.vacancies - COUNT(CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS remaining_vacancies
FROM JOB_OPENING j
LEFT JOIN APPLICATION a ON a.job_id = j.job_id
LEFT JOIN OFFER o       ON o.application_id = a.application_id
GROUP BY j.job_id, j.job_title, j.vacancies;

-- TRIGGERS

DROP TRIGGER IF EXISTS trg_check_vacancy_before_offer;
DROP TRIGGER IF EXISTS trg_validate_stage_score;
DROP TRIGGER IF EXISTS trg_prevent_interview_time_overlap;
DROP TRIGGER IF EXISTS trg_update_application_on_stage_result;
DROP TRIGGER IF EXISTS trg_on_student_status_change;
DROP TRIGGER IF EXISTS trg_student_program_matches_dept;
DROP TRIGGER IF EXISTS trg_log_application_status;

DELIMITER //

-- T1: an offer may only go to a SELECTED candidate and never above the job's vacancies
CREATE TRIGGER trg_check_vacancy_before_offer
BEFORE INSERT ON OFFER
FOR EACH ROW
BEGIN
    DECLARE v_job_id INT;
    DECLARE v_status VARCHAR(20);
    DECLARE v_vacancies INT;
    DECLARE v_offers_issued INT;

    SELECT job_id, application_status INTO v_job_id, v_status
    FROM APPLICATION WHERE application_id = NEW.application_id;

    IF v_status IS NULL OR v_status <> 'selected' THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Offers can only be issued to candidates whose application is selected.';
    END IF;

    SELECT vacancies INTO v_vacancies FROM JOB_OPENING WHERE job_id = v_job_id;

    SELECT COUNT(*) INTO v_offers_issued
    FROM OFFER o
    JOIN APPLICATION a ON a.application_id = o.application_id
    WHERE a.job_id = v_job_id AND o.job_status IN ('pending','accepted');

    IF v_offers_issued >= v_vacancies THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot issue offer: all vacancies for this job opening are already filled or offered.';
    END IF;
END //

-- T2: a stage score can never exceed the stage's maximum score
CREATE TRIGGER trg_validate_stage_score
BEFORE INSERT ON APPLICATION_STAGE
FOR EACH ROW
BEGIN
    DECLARE v_max_score DECIMAL(6,2);

    SELECT max_score INTO v_max_score FROM SELECTION_STAGE WHERE stage_id = NEW.stage_id;

    IF v_max_score IS NOT NULL AND NEW.score > v_max_score THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Score awarded exceeds the maximum score allowed for this selection stage.';
    END IF;
END //

-- T3: a student cannot have two interviews overlapping on the same day
CREATE TRIGGER trg_prevent_interview_time_overlap
BEFORE INSERT ON INTERVIEW
FOR EACH ROW
BEGIN
    DECLARE v_student_id INT;
    DECLARE v_conflicts INT;

    SELECT student_id INTO v_student_id FROM APPLICATION WHERE application_id = NEW.application_id;

    SELECT COUNT(*) INTO v_conflicts
    FROM INTERVIEW i
    JOIN APPLICATION a ON a.application_id = i.application_id
    WHERE a.student_id = v_student_id
      AND i.interview_date = NEW.interview_date
      AND i.result = 'scheduled'
      AND NEW.start_time < i.end_time
      AND NEW.end_time   > i.start_time;

    IF v_conflicts > 0 THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Student already has another interview scheduled at an overlapping time on this date.';
    END IF;
END //

-- T4: a recorded stage result automatically moves the application forward / out
CREATE TRIGGER trg_update_application_on_stage_result
AFTER INSERT ON APPLICATION_STAGE
FOR EACH ROW
BEGIN
    IF NEW.result IN ('failed','rejected','disqualified') THEN
        UPDATE APPLICATION SET application_status = 'rejected'
        WHERE application_id = NEW.application_id
          AND application_status IN ('submitted','shortlisted');
    ELSEIF NEW.result IN ('passed','shortlisted') THEN
        UPDATE APPLICATION SET application_status = 'shortlisted'
        WHERE application_id = NEW.application_id
          AND application_status = 'submitted';
    END IF;
END //

-- T5: when a student withdraws from college, their open applications and pending offers are cancelled
CREATE TRIGGER trg_on_student_status_change
AFTER UPDATE ON STUDENT
FOR EACH ROW
BEGIN
    IF NEW.academic_status = 'withdrawn' AND OLD.academic_status <> 'withdrawn' THEN
        UPDATE OFFER o
        JOIN APPLICATION a ON a.application_id = o.application_id
        SET o.job_status = 'rejected'
        WHERE a.student_id = NEW.student_id AND o.job_status = 'pending';

        UPDATE APPLICATION
        SET application_status = 'withdrawn'
        WHERE student_id = NEW.student_id
          AND application_status IN ('submitted','shortlisted','selected');
    END IF;
END //

-- T6: the degree program must belong to the student's department
CREATE TRIGGER trg_student_program_matches_dept
BEFORE INSERT ON STUDENT
FOR EACH ROW
BEGIN
    DECLARE v_dept VARCHAR(20);

    SELECT dept_code INTO v_dept FROM DEGREE_PROGRAM WHERE program_code = NEW.program_code;

    IF v_dept IS NOT NULL AND v_dept <> NEW.dept_code THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'The selected degree program does not belong to the selected department.';
    END IF;
END //

-- T7 (audit): every change of application_status is logged
CREATE TRIGGER trg_log_application_status
AFTER UPDATE ON APPLICATION
FOR EACH ROW
BEGIN
    IF NEW.application_status <> OLD.application_status THEN
        INSERT INTO APPLICATION_STATUS_LOG (application_id, old_status, new_status)
        VALUES (NEW.application_id, OLD.application_status, NEW.application_status);
    END IF;
END //

DELIMITER ;

