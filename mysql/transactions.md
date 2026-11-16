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

-- 1. APPLY FOR A JOB
CREATE PROCEDURE Proc_SubmitStudentApplication(
    IN p_student_id INT, IN p_job_id INT, IN p_resume_status VARCHAR(30), OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_cgpa DECIMAL(4,2);
    DECLARE v_min DECIMAL(4,2);
    DECLARE v_drive VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                      
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                         
    SELECT academic_status, cgpa INTO v_status, v_cgpa FROM STUDENT WHERE student_id = p_student_id;
    SELECT jo.min_cgpa, d.drive_status INTO v_min, v_drive
    FROM JOB_OPENING jo JOIN RECRUITMENT_DRIVE d ON d.drive_id = jo.drive_id WHERE jo.job_id = p_job_id;

    IF v_status IS NULL OR v_status <> 'active' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Student not found or not active.';
    END IF;
    IF v_drive IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Job opening not found.';
    END IF;
    IF v_drive <> 'open' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Applications are closed for this recruitment drive.';
    END IF;
    IF v_cgpa < v_min THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Not eligible: CGPA is below the minimum for this job.';
    END IF;
    IF EXISTS (SELECT 1 FROM APPLICATION WHERE student_id = p_student_id AND job_id = p_job_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Student has already applied for this job opening.';
    END IF;
    IF EXISTS (SELECT 1 FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
               WHERE a.student_id = p_student_id AND o.job_status = 'accepted') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Student has already accepted an offer.';
    END IF;

    INSERT INTO APPLICATION (application_date, application_status, resume_submission_status, student_id, job_id)
    VALUES (CURDATE(), 'submitted', p_resume_status, p_student_id, p_job_id);

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Application submitted.';
END //


-- 2. RECORD STAGE RESULT
CREATE PROCEDURE Proc_RecordStageResult(
    IN p_application_id INT, IN p_stage_id INT, IN p_score DECIMAL(6,2),
    IN p_result VARCHAR(30), IN p_remarks VARCHAR(255), OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                      
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                         
    SELECT application_status INTO v_status FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status NOT IN ('submitted', 'shortlisted') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This application is already closed (rejected, selected or withdrawn).';
    END IF;
    IF p_result IS NULL OR p_result NOT IN ('passed', 'failed') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Result must be passed or failed.';
    END IF;
    IF EXISTS (SELECT 1 FROM APPLICATION_STAGE WHERE application_id = p_application_id AND stage_id = p_stage_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A result for this stage is already recorded for this application.';
    END IF;

    INSERT INTO APPLICATION_STAGE (application_id, stage_id, stage_date, score, result, remarks)
    VALUES (p_application_id, p_stage_id, CURDATE(), p_score, p_result, NULLIF(p_remarks, ''));

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Stage result saved. The application status was updated automatically.';
END //

-- 3. RECORD INTERVIEW RESULT 
CREATE PROCEDURE Proc_RecordInterviewResult(
    IN p_interview_id INT, IN p_result VARCHAR(20), OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_app INT;
    DECLARE v_current VARCHAR(50);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                      
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                         
    SELECT application_id, result INTO v_app, v_current FROM INTERVIEW WHERE interview_id = p_interview_id FOR UPDATE;

    IF v_app IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Interview not found.';
    END IF;
    IF v_current <> 'scheduled' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A result is already recorded for this interview.';
    END IF;
    IF p_result IS NULL OR p_result NOT IN ('passed', 'failed', 'no_show') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Result must be passed, failed or no_show.';
    END IF;

    UPDATE INTERVIEW SET result = p_result WHERE interview_id = p_interview_id;

    IF p_result = 'passed' THEN
        UPDATE APPLICATION SET application_status = 'shortlisted'
        WHERE application_id = v_app AND application_status = 'submitted';
    ELSE
        UPDATE APPLICATION SET application_status = 'rejected'
        WHERE application_id = v_app AND application_status IN ('submitted', 'shortlisted');
    END IF;

    COMMIT;                                                    
    SET p_message = CONCAT('SUCCESS: Interview result saved as ', p_result, '.');
END //

-- 4. SCHEDULE INTERVIEW  
CREATE PROCEDURE Proc_ScheduleInterview(
    IN p_application_id INT, IN p_date DATE, IN p_start TIME, IN p_end TIME,
    IN p_mode VARCHAR(30), IN p_venue VARCHAR(255), IN p_interviewer_id INT, OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_company INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                     
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                        
    SELECT application_status INTO v_status FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;
    SELECT d.company_id INTO v_company
    FROM APPLICATION a JOIN JOB_OPENING j ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id WHERE a.application_id = p_application_id;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status <> 'shortlisted' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only shortlisted candidates can be scheduled for an interview.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INTERVIEWER WHERE interviewer_id = p_interviewer_id AND company_id = v_company) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This interviewer does not work for the company that posted the job.';
    END IF;
    IF EXISTS (SELECT 1 FROM INTERVIEW i JOIN INTERVIEW_INTERVIEWER ii ON ii.interview_id = i.interview_id
               WHERE ii.interviewer_id = p_interviewer_id AND i.interview_date = p_date
                 AND i.result = 'scheduled' AND p_start < i.end_time AND p_end > i.start_time) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The interviewer is already booked at an overlapping time.';
    END IF;

    INSERT INTO INTERVIEW (interview_date, start_time, end_time, interview_mode, venue_or_link, result, application_id)
    VALUES (p_date, p_start, p_end, p_mode, NULLIF(p_venue, ''), 'scheduled', p_application_id);

    INSERT INTO INTERVIEW_INTERVIEWER (interview_id, interviewer_id) VALUES (LAST_INSERT_ID(), p_interviewer_id);

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Interview scheduled.';
END //

-- 5. SELECT CANDIDATE 
CREATE PROCEDURE Proc_SelectCandidate(IN p_application_id INT, OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_job INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                      
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                        
    SELECT application_status, job_id INTO v_status, v_job FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status <> 'shortlisted' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only shortlisted candidates can be selected.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INTERVIEW WHERE application_id = p_application_id AND result = 'passed') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The candidate must pass at least one interview before being selected.';
    END IF;
    IF (SELECT COUNT(*) FROM APPLICATION WHERE job_id = v_job AND application_status = 'selected')
       >= (SELECT vacancies FROM JOB_OPENING WHERE job_id = v_job) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'All vacancies for this job opening are already filled.';
    END IF;

    UPDATE APPLICATION SET application_status = 'selected' WHERE application_id = p_application_id;

    COMMIT;                                                   
    SET p_message = 'SUCCESS: Candidate selected. You can now issue the offer.';
END //

-- 6. ISSUE OFFER  
CREATE PROCEDURE Proc_IssueOffer(
    IN p_application_id INT, IN p_joining_date DATE, IN p_location VARCHAR(150), OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                      
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                        
    SELECT application_status INTO v_status FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status <> 'selected' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An offer can only be issued to a selected candidate.';
    END IF;
    IF EXISTS (SELECT 1 FROM OFFER WHERE application_id = p_application_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An offer has already been issued for this application.';
    END IF;

    INSERT INTO OFFER (offer_date, salary_package, joining_date, job_location, job_status, application_id)
    SELECT CURDATE(), j.salary_package, p_joining_date, IFNULL(NULLIF(p_location, ''), j.work_location), 'pending', a.application_id
    FROM APPLICATION a JOIN JOB_OPENING j ON j.job_id = a.job_id
    WHERE a.application_id = p_application_id;

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Offer issued. It is waiting for the student''s reply.';
END //

-- 7. ACCEPT OFFER  (Krupalini)   
CREATE PROCEDURE Proc_AcceptOffer(IN p_offer_id INT, OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_app INT;
    DECLARE v_student INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                     
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                        
    SELECT o.job_status, o.application_id, a.student_id INTO v_status, v_app, v_student
    FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
    WHERE o.offer_id = p_offer_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Offer not found.';
    END IF;
    IF v_status <> 'pending' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a pending offer can be accepted.';
    END IF;

    -- (a) accept this offer
    UPDATE OFFER SET job_status = 'accepted' WHERE offer_id = p_offer_id;

    -- (b) cancel the student's other pending offers
    UPDATE OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
    SET o.job_status = 'rejected'
    WHERE a.student_id = v_student AND o.offer_id <> p_offer_id AND o.job_status = 'pending';

    -- (c) withdraw the student's other open applications
    UPDATE APPLICATION SET application_status = 'withdrawn'
    WHERE student_id = v_student AND application_id <> v_app
      AND application_status IN ('submitted', 'shortlisted', 'selected');

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Offer accepted. The student''s other offers and applications were cancelled.';
END //

-- 8. REJECT OFFER 
CREATE PROCEDURE Proc_RejectOffer(IN p_offer_id INT, OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);
    DECLARE v_app INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                      
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                         
    SELECT job_status, application_id INTO v_status, v_app FROM OFFER WHERE offer_id = p_offer_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Offer not found.';
    END IF;
    IF v_status <> 'pending' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a pending offer can be rejected.';
    END IF;

    UPDATE OFFER SET job_status = 'rejected' WHERE offer_id = p_offer_id;
    UPDATE APPLICATION SET application_status = 'withdrawn' WHERE application_id = v_app;

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Offer rejected. The vacancy is free again.';
END //

-- 9. WITHDRAW APPLICATION  
CREATE PROCEDURE Proc_WithdrawApplication(IN p_application_id INT, OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION                     
    BEGIN
        GET DIAGNOSTICS CONDITION 1 v_err = MESSAGE_TEXT;
        ROLLBACK;
        SET p_message = CONCAT('ERROR: ', v_err);
    END;

    START TRANSACTION;                                        
    SELECT application_status INTO v_status FROM APPLICATION WHERE application_id = p_application_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Application not found.';
    END IF;
    IF v_status IN ('withdrawn', 'rejected') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This application is already finished (withdrawn or rejected).';
    END IF;
    IF EXISTS (SELECT 1 FROM OFFER WHERE application_id = p_application_id AND job_status = 'accepted') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot withdraw: the offer was already accepted.';
    END IF;

    UPDATE OFFER SET job_status = 'rejected' WHERE application_id = p_application_id AND job_status = 'pending';
    UPDATE INTERVIEW SET result = 'cancelled' WHERE application_id = p_application_id AND result = 'scheduled';
    UPDATE APPLICATION SET application_status = 'withdrawn' WHERE application_id = p_application_id;

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Application withdrawn. Its pending offer and interview were cancelled.';
END //


-- 10. CLOSE A RECRUITMENT DRIVE
CREATE PROCEDURE Proc_CloseRecruitmentDrive(IN p_drive_id INT, OUT p_message VARCHAR(255))
BEGIN
    DECLARE v_err VARCHAR(255);
    DECLARE v_status VARCHAR(20);

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

    UPDATE APPLICATION a JOIN JOB_OPENING jo ON jo.job_id = a.job_id
    SET a.application_status = 'rejected'
    WHERE jo.drive_id = p_drive_id AND a.application_status IN ('submitted', 'shortlisted');

    COMMIT;                                                    
    SET p_message = 'SUCCESS: Drive completed. Unfinished applications were closed as rejected.';
END //

DELIMITER ;