-- =====================================================================
-- HireLink  |  03_views_triggers.sql  |  Views + Triggers
-- Run AFTER 02_seed.sql (so the bulk seed data does not fire the triggers).
-- Use the mysql client or MySQL Workbench (DELIMITER is a client command).
-- =====================================================================
USE college_placement_internship;

-- ---------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------
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
-- This is exactly what trg_check_vacancy_before_offer enforces.
CREATE OR REPLACE VIEW JOB_VACANCY_STATUS AS
SELECT j.job_id, j.job_title,
       j.vacancies AS total_vacancies,
       COUNT(CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS filled_vacancies,
       j.vacancies - COUNT(CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS remaining_vacancies
FROM JOB_OPENING j
LEFT JOIN APPLICATION a ON a.job_id = j.job_id
LEFT JOIN OFFER o       ON o.application_id = a.application_id
GROUP BY j.job_id, j.job_title, j.vacancies;

-- ---------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------
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



-- =====================================================================
-- HireLink  |  04_procedures.sql  |  Transactions (stored procedures)
-- Run AFTER 03_views_triggers.sql.
--
-- Every procedure follows the same pattern:
--   START TRANSACTION -> validate (SIGNAL on a problem) -> change tables -> COMMIT
--   EXIT HANDLER      -> ROLLBACK everything and return 'ERROR: <reason>'
--   success           -> returns 'SUCCESS: <what happened>'
-- The Node API reads the OUT parameter p_message.
--
-- Owners (from the work split):
--   Neharika : Proc_RecordStageResult, Proc_RecordInterviewResult   (+ Proc_SubmitStudentApplication, Proc_CloseRecruitmentDrive: existing)
--   Krupalini: Proc_ScheduleInterview, Proc_SelectCandidate, Proc_IssueOffer, Proc_AcceptOffer
--   Dwithi   : Proc_RejectOffer, Proc_WithdrawApplication
-- =====================================================================
USE college_placement_internship;

DROP PROCEDURE IF EXISTS Proc_SubmitStudentApplication;
DROP PROCEDURE IF EXISTS Proc_RecordStageResult;
DROP PROCEDURE IF EXISTS Proc_RecordInterviewResult;
DROP PROCEDURE IF EXISTS Proc_ScheduleInterview;
DROP PROCEDURE IF EXISTS Proc_SelectCandidate;
DROP PROCEDURE IF EXISTS Proc_IssueOffer;
DROP PROCEDURE IF EXISTS Proc_AcceptOffer;
DROP PROCEDURE IF EXISTS Proc_RejectOffer;
DROP PROCEDURE IF EXISTS Proc_WithdrawApplication;
DROP PROCEDURE IF EXISTS Proc_CloseRecruitmentDrive;

DELIMITER //

-- ---------------------------------------------------------------------
-- 1. APPLY  (existing transaction, error handling fixed)
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_SubmitStudentApplication(
    IN  p_student_id    INT,
    IN  p_job_id        INT,
    IN  p_resume_status VARCHAR(30),
    OUT p_message       VARCHAR(255)
)
BEGIN
    DECLARE v_err          VARCHAR(255);
    DECLARE v_msg          VARCHAR(255);
    DECLARE v_acad         VARCHAR(20);
    DECLARE v_cgpa         DECIMAL(4,2);
    DECLARE v_min_cgpa     DECIMAL(4,2);
    DECLARE v_drive_status VARCHAR(20);
    DECLARE v_job_title    VARCHAR(150);
    DECLARE v_placed       INT;
    DECLARE v_dup          INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT academic_status, cgpa INTO v_acad, v_cgpa
    FROM STUDENT WHERE student_id = p_student_id FOR UPDATE;

    IF v_acad IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Student not found.';
    END IF;
    IF v_acad <> 'active' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only active students can apply for recruitment drives.';
    END IF;

    SELECT jo.job_title, jo.min_cgpa, d.drive_status INTO v_job_title, v_min_cgpa, v_drive_status
    FROM JOB_OPENING jo JOIN RECRUITMENT_DRIVE d ON d.drive_id = jo.drive_id
    WHERE jo.job_id = p_job_id;

    IF v_job_title IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Job opening not found.';
    END IF;
    IF v_drive_status <> 'open' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Applications are closed for this recruitment drive.';
    END IF;
    IF IFNULL(v_cgpa, 0) < IFNULL(v_min_cgpa, 0) THEN
        SET v_msg = CONCAT('Not eligible: your CGPA ', v_cgpa, ' is below the minimum ', v_min_cgpa, ' for this job.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    SELECT COUNT(*) INTO v_placed
    FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
    WHERE a.student_id = p_student_id AND o.job_status = 'accepted';
    IF v_placed > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This student has already accepted an offer and cannot apply again.';
    END IF;

    SELECT COUNT(*) INTO v_dup FROM APPLICATION WHERE student_id = p_student_id AND job_id = p_job_id;
    IF v_dup > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Student has already applied for this job opening.';
    END IF;

    INSERT INTO APPLICATION (application_date, application_status, resume_submission_status, student_id, job_id)
    VALUES (CURDATE(), 'submitted', p_resume_status, p_student_id, p_job_id);

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Application #', LAST_INSERT_ID(), ' submitted for ', v_job_title, '.');
END //

-- ---------------------------------------------------------------------
-- 2. RECORD STAGE RESULT   (Neharika)
-- One INSERT into APPLICATION_STAGE. Inside the same transaction the trigger
-- trg_validate_stage_score checks the maximum score (BEFORE INSERT) and
-- trg_update_application_on_stage_result moves the application to
-- shortlisted / rejected (AFTER INSERT). If any of them fails, all is undone.
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_RecordStageResult(
    IN  p_application_id INT,
    IN  p_stage_id       INT,
    IN  p_score          DECIMAL(6,2),
    IN  p_result         VARCHAR(30),
    IN  p_remarks        VARCHAR(255),
    OUT p_message        VARCHAR(255)
)
BEGIN
    DECLARE v_err        VARCHAR(255);
    DECLARE v_msg        VARCHAR(255);
    DECLARE v_status     VARCHAR(20);
    DECLARE v_stage_name VARCHAR(100);
    DECLARE v_max        DECIMAL(6,2);
    DECLARE v_dup        INT;
    DECLARE v_new_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT application_status INTO v_status
    FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status NOT IN ('submitted','shortlisted') THEN
        SET v_msg = CONCAT('Cannot record a stage result: the application is already ', v_status, '.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    SELECT stage_name, max_score INTO v_stage_name, v_max
    FROM SELECTION_STAGE WHERE stage_id = p_stage_id;

    IF v_stage_name IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Selection stage not found.';
    END IF;
    IF p_result IS NULL OR LOWER(p_result) NOT IN ('passed','failed') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Result must be either passed or failed.';
    END IF;
    IF p_score IS NULL OR p_score < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Score must be a number that is zero or more.';
    END IF;
    IF v_max IS NOT NULL AND p_score > v_max THEN
        SET v_msg = CONCAT('Score ', p_score, ' is above the maximum of ', v_max, ' for this stage.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    SELECT COUNT(*) INTO v_dup
    FROM APPLICATION_STAGE WHERE application_id = p_application_id AND stage_id = p_stage_id;
    IF v_dup > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A result for this stage is already recorded for this application.';
    END IF;

    INSERT INTO APPLICATION_STAGE (application_id, stage_id, stage_date, score, result, remarks)
    VALUES (p_application_id, p_stage_id, CURDATE(), p_score, LOWER(p_result), NULLIF(p_remarks, ''));

    SELECT application_status INTO v_new_status FROM APPLICATION WHERE application_id = p_application_id;

    COMMIT;
    SET p_message = CONCAT('SUCCESS: ', v_stage_name, ' recorded as ', LOWER(p_result),
                           '. Application is now ', v_new_status, '.');
END //

-- ---------------------------------------------------------------------
-- 3. RECORD INTERVIEW RESULT   (Neharika)
-- Updates INTERVIEW and APPLICATION together (two tables, all or nothing).
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_RecordInterviewResult(
    IN  p_interview_id INT,
    IN  p_result       VARCHAR(20),
    OUT p_message      VARCHAR(255)
)
BEGIN
    DECLARE v_err        VARCHAR(255);
    DECLARE v_msg        VARCHAR(255);
    DECLARE v_app_id     INT;
    DECLARE v_current    VARCHAR(50);
    DECLARE v_new_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT application_id, result INTO v_app_id, v_current
    FROM INTERVIEW WHERE interview_id = p_interview_id FOR UPDATE;

    IF v_app_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Interview not found.';
    END IF;
    IF v_current IS NOT NULL AND v_current <> 'scheduled' THEN
        SET v_msg = CONCAT('A result is already recorded for this interview (', v_current, ').');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
    IF p_result IS NULL OR LOWER(p_result) NOT IN ('passed','failed','no_show') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Result must be passed, failed or no_show.';
    END IF;

    UPDATE INTERVIEW SET result = LOWER(p_result) WHERE interview_id = p_interview_id;

    IF LOWER(p_result) IN ('failed','no_show') THEN
        UPDATE APPLICATION SET application_status = 'rejected'
        WHERE application_id = v_app_id AND application_status IN ('submitted','shortlisted');
    ELSE
        UPDATE APPLICATION SET application_status = 'shortlisted'
        WHERE application_id = v_app_id AND application_status = 'submitted';
    END IF;

    SELECT application_status INTO v_new_status FROM APPLICATION WHERE application_id = v_app_id;

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Interview #', p_interview_id, ' recorded as ', LOWER(p_result),
                           '. Application is now ', v_new_status, '.');
END //

-- ---------------------------------------------------------------------
-- 4. SCHEDULE INTERVIEW   (Krupalini)
-- Inserts INTERVIEW + INTERVIEW_INTERVIEWER. The student's own clash is
-- stopped by trg_prevent_interview_time_overlap; the interviewer's clash here.
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_ScheduleInterview(
    IN  p_application_id INT,
    IN  p_date           DATE,
    IN  p_start          TIME,
    IN  p_end            TIME,
    IN  p_mode           VARCHAR(30),
    IN  p_venue          VARCHAR(255),
    IN  p_interviewer_id INT,
    OUT p_message        VARCHAR(255)
)
BEGIN
    DECLARE v_err           VARCHAR(255);
    DECLARE v_status        VARCHAR(20);
    DECLARE v_job_company   INT;
    DECLARE v_iv_company    INT;
    DECLARE v_busy          INT;
    DECLARE v_open          INT;
    DECLARE v_interview_id  INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT application_status INTO v_status
    FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status <> 'shortlisted' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only shortlisted candidates can be scheduled for an interview.';
    END IF;
    IF p_date IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enter a date and a start time that is earlier than the end time.';
    END IF;

    SELECT d.company_id INTO v_job_company
    FROM APPLICATION a
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    WHERE a.application_id = p_application_id;

    SELECT company_id INTO v_iv_company FROM INTERVIEWER WHERE interviewer_id = p_interviewer_id;
    IF v_iv_company IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Interviewer not found.';
    END IF;
    IF v_iv_company <> v_job_company THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This interviewer does not work for the company that posted the job.';
    END IF;

    SELECT COUNT(*) INTO v_open
    FROM INTERVIEW WHERE application_id = p_application_id AND result = 'scheduled';
    IF v_open > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This candidate already has an interview waiting for a result. Record that result first.';
    END IF;

    SELECT COUNT(*) INTO v_busy
    FROM INTERVIEW i
    JOIN INTERVIEW_INTERVIEWER ii ON ii.interview_id = i.interview_id
    WHERE ii.interviewer_id = p_interviewer_id
      AND i.interview_date = p_date
      AND i.result = 'scheduled'
      AND p_start < i.end_time
      AND p_end   > i.start_time;
    IF v_busy > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The interviewer is already booked at an overlapping time.';
    END IF;

    INSERT INTO INTERVIEW (interview_date, start_time, end_time, interview_mode, venue_or_link, result, application_id)
    VALUES (p_date, p_start, p_end, p_mode, NULLIF(p_venue, ''), 'scheduled', p_application_id);

    SET v_interview_id = LAST_INSERT_ID();

    INSERT INTO INTERVIEW_INTERVIEWER (interview_id, interviewer_id) VALUES (v_interview_id, p_interviewer_id);

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Interview #', v_interview_id, ' scheduled on ', DATE_FORMAT(p_date, '%d-%b-%Y'),
                           ' from ', TIME_FORMAT(p_start, '%H:%i'), ' to ', TIME_FORMAT(p_end, '%H:%i'), '.');
END //

-- ---------------------------------------------------------------------
-- 5. SELECT CANDIDATE   (Krupalini)
-- Locks the job row so two coordinators cannot select beyond the vacancies.
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_SelectCandidate(
    IN  p_application_id INT,
    OUT p_message        VARCHAR(255)
)
BEGIN
    DECLARE v_err      VARCHAR(255);
    DECLARE v_status   VARCHAR(20);
    DECLARE v_job_id   INT;
    DECLARE v_vac      INT;
    DECLARE v_selected INT;
    DECLARE v_passed   INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT application_status, job_id INTO v_status, v_job_id
    FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status <> 'shortlisted' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only shortlisted candidates can be selected.';
    END IF;

    SELECT COUNT(*) INTO v_passed
    FROM INTERVIEW WHERE application_id = p_application_id AND result = 'passed';
    IF v_passed = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The candidate must pass at least one interview before being selected.';
    END IF;

    SELECT vacancies INTO v_vac FROM JOB_OPENING WHERE job_id = v_job_id FOR UPDATE;

    SELECT COUNT(*) INTO v_selected
    FROM APPLICATION WHERE job_id = v_job_id AND application_status = 'selected';
    IF v_selected >= v_vac THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'All vacancies for this job opening are already filled.';
    END IF;

    UPDATE APPLICATION SET application_status = 'selected' WHERE application_id = p_application_id;

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Application #', p_application_id, ' is now selected. You can issue the offer.');
END //

-- ---------------------------------------------------------------------
-- 6. ISSUE OFFER   (Krupalini)
-- Salary and location are copied from the job opening. Vacancy rule = trigger T1.
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_IssueOffer(
    IN  p_application_id INT,
    IN  p_joining_date   DATE,
    IN  p_location       VARCHAR(150),
    OUT p_message        VARCHAR(255)
)
BEGIN
    DECLARE v_err      VARCHAR(255);
    DECLARE v_status   VARCHAR(20);
    DECLARE v_salary   DECIMAL(12,2);
    DECLARE v_location VARCHAR(150);
    DECLARE v_existing INT;
    DECLARE v_offer_id INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT application_status INTO v_status
    FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status <> 'selected' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An offer can only be issued to a selected candidate.';
    END IF;

    SELECT COUNT(*) INTO v_existing FROM OFFER WHERE application_id = p_application_id;
    IF v_existing > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An offer has already been issued for this application.';
    END IF;

    IF p_joining_date IS NOT NULL AND p_joining_date < CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The joining date cannot be in the past.';
    END IF;

    SELECT j.salary_package, j.work_location INTO v_salary, v_location
    FROM APPLICATION a JOIN JOB_OPENING j ON j.job_id = a.job_id
    WHERE a.application_id = p_application_id;

    INSERT INTO OFFER (offer_date, salary_package, joining_date, job_location, job_status, application_id)
    VALUES (CURDATE(), v_salary, p_joining_date, IFNULL(NULLIF(p_location, ''), v_location), 'pending', p_application_id);

    SET v_offer_id = LAST_INSERT_ID();

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Offer #', v_offer_id, ' issued (pending the student''s reply).');
END //

-- ---------------------------------------------------------------------
-- 7. ACCEPT OFFER   (Krupalini)
-- Placement policy: one student, one placement. Accepting an offer
--   (a) marks this offer accepted
--   (b) rejects the student's other pending offers
--   (c) withdraws the student's other applications that are still open
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_AcceptOffer(
    IN  p_offer_id INT,
    OUT p_message  VARCHAR(255)
)
BEGIN
    DECLARE v_err        VARCHAR(255);
    DECLARE v_msg        VARCHAR(255);
    DECLARE v_status     VARCHAR(20);
    DECLARE v_app_id     INT;
    DECLARE v_student_id INT;
    DECLARE v_cancelled  INT DEFAULT 0;
    DECLARE v_withdrawn  INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT o.job_status, o.application_id, a.student_id INTO v_status, v_app_id, v_student_id
    FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
    WHERE o.offer_id = p_offer_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Offer not found.';
    END IF;
    IF v_status <> 'pending' THEN
        SET v_msg = CONCAT('This offer is already ', v_status, ' and cannot be accepted.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    UPDATE OFFER SET job_status = 'accepted' WHERE offer_id = p_offer_id;

    UPDATE OFFER o
    JOIN APPLICATION a ON a.application_id = o.application_id
    SET o.job_status = 'rejected'
    WHERE a.student_id = v_student_id AND o.offer_id <> p_offer_id AND o.job_status = 'pending';
    SET v_cancelled = ROW_COUNT();

    UPDATE APPLICATION SET application_status = 'withdrawn'
    WHERE student_id = v_student_id AND application_id <> v_app_id
      AND application_status IN ('submitted','shortlisted','selected');
    SET v_withdrawn = ROW_COUNT();

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Offer #', p_offer_id, ' accepted. ', v_cancelled,
                           ' other offer(s) cancelled and ', v_withdrawn, ' other application(s) withdrawn.');
END //

-- ---------------------------------------------------------------------
-- 8. REJECT OFFER   (Dwithi)
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_RejectOffer(
    IN  p_offer_id INT,
    OUT p_message  VARCHAR(255)
)
BEGIN
    DECLARE v_err    VARCHAR(255);
    DECLARE v_msg    VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_app_id INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT job_status, application_id INTO v_status, v_app_id
    FROM OFFER WHERE offer_id = p_offer_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Offer not found.';
    END IF;
    IF v_status <> 'pending' THEN
        SET v_msg = CONCAT('This offer is already ', v_status, ' and cannot be rejected.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    UPDATE OFFER SET job_status = 'rejected' WHERE offer_id = p_offer_id;

    UPDATE APPLICATION SET application_status = 'withdrawn'
    WHERE application_id = v_app_id AND application_status = 'selected';

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Offer #', p_offer_id, ' rejected. The seat is free for another candidate.');
END //

-- ---------------------------------------------------------------------
-- 9. WITHDRAW APPLICATION   (Dwithi)
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_WithdrawApplication(
    IN  p_application_id INT,
    OUT p_message        VARCHAR(255)
)
BEGIN
    DECLARE v_err      VARCHAR(255);
    DECLARE v_msg      VARCHAR(255);
    DECLARE v_status   VARCHAR(20);
    DECLARE v_accepted INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT application_status INTO v_status
    FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status IN ('withdrawn','rejected') THEN
        SET v_msg = CONCAT('This application is already ', v_status, '.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    SELECT COUNT(*) INTO v_accepted FROM OFFER WHERE application_id = p_application_id AND job_status = 'accepted';
    IF v_accepted > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot withdraw: the offer for this application was already accepted.';
    END IF;

    UPDATE OFFER SET job_status = 'rejected'
    WHERE application_id = p_application_id AND job_status = 'pending';

    UPDATE INTERVIEW SET result = 'cancelled'
    WHERE application_id = p_application_id AND result = 'scheduled';

    UPDATE APPLICATION SET application_status = 'withdrawn' WHERE application_id = p_application_id;

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Application #', p_application_id, ' withdrawn. Pending offer and interview (if any) were cancelled.');
END //

-- ---------------------------------------------------------------------
-- 10. CLOSE RECRUITMENT DRIVE  (existing transaction, handler fixed)
-- ---------------------------------------------------------------------
CREATE PROCEDURE Proc_CloseRecruitmentDrive(
    IN  p_drive_id INT,
    OUT p_message  VARCHAR(255)
)
BEGIN
    DECLARE v_err    VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_closed INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;

    SELECT drive_status INTO v_status FROM RECRUITMENT_DRIVE WHERE drive_id = p_drive_id FOR UPDATE;
    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Recruitment drive not found.';
    END IF;
    IF v_status = 'completed' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This recruitment drive is already completed.';
    END IF;

    UPDATE RECRUITMENT_DRIVE SET drive_status = 'completed' WHERE drive_id = p_drive_id;

    UPDATE APPLICATION a
    JOIN JOB_OPENING jo ON jo.job_id = a.job_id
    SET a.application_status = 'rejected'
    WHERE jo.drive_id = p_drive_id AND a.application_status IN ('submitted','shortlisted');
    SET v_closed = ROW_COUNT();

    COMMIT;
    SET p_message = CONCAT('SUCCESS: Drive #', p_drive_id, ' completed. ', v_closed, ' unfinished application(s) were closed as rejected.');
END //

DELIMITER ;