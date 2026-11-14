# hirelink


-- =====================================================================
-- HireLink  |  06_demo_tests.sql  |  Self-check of every transaction, trigger and view
-- Run on a FRESH database (01 -> 05) because it changes data. Execute block by block and
-- compare each result with the 'expected' line. SUCCESS = committed, ERROR = rolled back.
-- Use this script to rehearse the demo and the viva.
-- =====================================================================
USE college_placement_internship;

-- ############ 1. RECORD STAGE RESULT (Neharika) ############

-- 1a. application 1 is 'submitted'; pass stage 1 with score 78
-- expected: SUCCESS ... Application is now shortlisted. (trigger T4 changed the status)
CALL Proc_RecordStageResult(1, 1, 78, 'passed', 'demo', @m);
SELECT @m AS result;

-- 1b. same stage again
-- expected: ERROR: A result for this stage is already recorded ...
CALL Proc_RecordStageResult(1, 1, 80, 'passed', NULL, @m);
SELECT @m AS result;

-- 1c. score above the stage maximum (application 13)
-- expected: ERROR: Score 150.00 is above the maximum of 100.00 for this stage.
CALL Proc_RecordStageResult(13, 1, 150, 'passed', NULL, @m);
SELECT @m AS result;

-- 1d. fail stage 1 (application 15)
-- expected: SUCCESS ... Application is now rejected.
CALL Proc_RecordStageResult(15, 1, 20, 'failed', 'below cut-off', @m);
SELECT @m AS result;

-- 1e. application 3 is already rejected
-- expected: ERROR: Cannot record a stage result: the application is already rejected.
CALL Proc_RecordStageResult(3, 1, 60, 'passed', NULL, @m);
SELECT @m AS result;

-- 1f. check: statuses and the audit trail written by trigger T7
-- expected: 1 shortlisted, 15 rejected; log rows for both
SELECT application_id, application_status FROM APPLICATION WHERE application_id IN (1, 15);
SELECT * FROM APPLICATION_STATUS_LOG ORDER BY log_id DESC LIMIT 5;

-- ############ 2. SCHEDULE INTERVIEW (Krupalini) ############

-- 2a. application 2 (shortlisted) with interviewer 1
-- expected: SUCCESS: Interview #... scheduled
CALL Proc_ScheduleInterview(2, '2026-12-01', '10:00', '11:00', 'Online', 'https://meet.example.com/demo', 1, @m);
SELECT @m AS result;

-- 2b. a different candidate (application 10) with the same interviewer at an overlapping time
-- expected: ERROR: The interviewer is already booked at an overlapping time.
CALL Proc_ScheduleInterview(10, '2026-12-01', '10:30', '11:30', 'Online', 'x', 1, @m);
SELECT @m AS result;

-- 2c. interviewer 3 belongs to another company
-- expected: ERROR: This interviewer does not work for the company that posted the job.
CALL Proc_ScheduleInterview(16, '2026-12-02', '10:00', '11:00', 'Online', 'x', 3, @m);
SELECT @m AS result;

-- 2d. application 13 is only 'submitted'
-- expected: ERROR: Only shortlisted candidates can be scheduled for an interview.
CALL Proc_ScheduleInterview(13, '2026-12-02', '10:00', '11:00', 'Online', 'x', 1, @m);
SELECT @m AS result;

-- ############ 3. RECORD INTERVIEW RESULT (Neharika) ############

-- 3a. interview 1 passed
-- expected: SUCCESS ... recorded as passed. Application is now shortlisted.
CALL Proc_RecordInterviewResult(1, 'passed', @m);
SELECT @m AS result;

-- 3b. interview 1 again
-- expected: ERROR: A result is already recorded for this interview (passed).
CALL Proc_RecordInterviewResult(1, 'failed', @m);
SELECT @m AS result;

-- 3c. interview 7 failed
-- expected: SUCCESS ... Application is now rejected.
CALL Proc_RecordInterviewResult(7, 'failed', @m);
SELECT @m AS result;

-- 3d. unknown interview
-- expected: ERROR: Interview not found.
CALL Proc_RecordInterviewResult(99999, 'passed', @m);
SELECT @m AS result;

-- 3e. invalid result word
-- expected: ERROR: Result must be passed, failed or no_show.
CALL Proc_RecordInterviewResult(14, 'maybe', @m);
SELECT @m AS result;

-- ############ 4. SELECT CANDIDATE (Krupalini) ############

-- 4a. application 5 is shortlisted and has a passed interview
-- expected: SUCCESS ... is now selected.
CALL Proc_SelectCandidate(5, @m);
SELECT @m AS result;

-- 4b. application 28 has no passed interview
-- expected: ERROR: The candidate must pass at least one interview before being selected.
CALL Proc_SelectCandidate(28, @m);
SELECT @m AS result;

-- ############ 5. ISSUE OFFER (Krupalini) ############

-- 5a. application 21 is selected
-- expected: SUCCESS: Offer #... issued
CALL Proc_IssueOffer(21, DATE_ADD(CURDATE(), INTERVAL 90 DAY), 'Hyderabad', @m);
SELECT @m AS result;

-- 5b. same application again
-- expected: ERROR: An offer has already been issued for this application.
CALL Proc_IssueOffer(21, DATE_ADD(CURDATE(), INTERVAL 90 DAY), NULL, @m);
SELECT @m AS result;

-- 5c. application 28 is not selected
-- expected: ERROR: An offer can only be issued to a selected candidate.
CALL Proc_IssueOffer(28, DATE_ADD(CURDATE(), INTERVAL 90 DAY), NULL, @m);
SELECT @m AS result;

-- ############ 6. ACCEPT / REJECT OFFER ############

-- 6a. accept offer 1 (Krupalini)
-- expected: SUCCESS ... accepted. N other offer(s) cancelled and M other application(s) withdrawn.
CALL Proc_AcceptOffer(1, @m);
SELECT @m AS result;

-- 6b. accept it again
-- expected: ERROR: This offer is already accepted and cannot be accepted.
CALL Proc_AcceptOffer(1, @m);
SELECT @m AS result;

-- 6c. reject offer 4 (Dwithi)
-- expected: SUCCESS: Offer #... rejected. The seat is free for another candidate.
CALL Proc_RejectOffer(4, @m);
SELECT @m AS result;

-- 6d. reject an accepted offer
-- expected: ERROR: This offer is already accepted and cannot be rejected.
CALL Proc_RejectOffer(1, @m);
SELECT @m AS result;

-- ############ 7. WITHDRAW APPLICATION (Dwithi) ############

-- 7a. withdraw application 24
-- expected: SUCCESS ... withdrawn.
CALL Proc_WithdrawApplication(24, @m);
SELECT @m AS result;

-- 7b. withdraw it again
-- expected: ERROR: This application is already withdrawn.
CALL Proc_WithdrawApplication(24, @m);
SELECT @m AS result;

-- ############ 8. APPLY ############

-- 8a. student 101 applies for job 1
-- expected: SUCCESS: Application #... submitted
CALL Proc_SubmitStudentApplication(101, 1, 'submitted', @m);
SELECT @m AS result;

-- 8b. same again
-- expected: ERROR: Student has already applied for this job opening.
CALL Proc_SubmitStudentApplication(101, 1, 'submitted', @m);
SELECT @m AS result;

-- 8c. student 103 (CGPA below 8.0) applies for job 7
-- expected: ERROR: Not eligible: your CGPA ... is below the minimum 8.00 for this job.
CALL Proc_SubmitStudentApplication(103, 7, 'submitted', @m);
SELECT @m AS result;

-- 8d. student 101 applies for job 8 (drive completed)
-- expected: ERROR: Applications are closed for this recruitment drive.
CALL Proc_SubmitStudentApplication(101, 8, 'submitted', @m);
SELECT @m AS result;

-- ############ 9. TRIGGERS fired directly ############

-- T1: offer for application 27 which is not selected
-- expected: ERROR 1644: Offers can only be issued to candidates whose application is selected.
INSERT INTO OFFER (offer_date, salary_package, joining_date, job_location, application_id)
VALUES (CURDATE(), 500000, DATE_ADD(CURDATE(), INTERVAL 30 DAY), 'Pune', 27);

-- T2: score above the maximum written directly
-- expected: ERROR 1644: Score awarded exceeds the maximum score allowed for this selection stage.
INSERT INTO APPLICATION_STAGE (application_id, stage_id, stage_date, score, result) VALUES (27, 5, CURDATE(), 99, 'passed');

-- T3: second interview at the same time for the candidate of application 30
-- expected: ERROR 1644: Student already has another interview scheduled at an overlapping time on this date.
INSERT INTO INTERVIEW (interview_date, start_time, end_time, interview_mode, venue_or_link, application_id)
VALUES ('2026-11-18', '11:00:00', '11:45:00', 'Online', 'x', 30);

-- T6: program from another department
-- expected: ERROR 1644: The selected degree program does not belong to the selected department.
INSERT INTO STUDENT (student_id, first_name, last_name, email, year_of_study, cgpa, dept_code, program_code)
VALUES (9001, 'Test', 'Mismatch', 'mismatch@student.college.edu', 3, 7.5, 'CSE', 'BTECH_MECH');

-- T5 (run last): student 102 withdraws from college
-- expected: that student's open applications become withdrawn and pending offers rejected
UPDATE STUDENT SET academic_status = 'withdrawn' WHERE student_id = 102;
SELECT application_id, application_status FROM APPLICATION WHERE student_id = 102;

-- ############ 10. VIEWS ############
SELECT * FROM JOB_VACANCY_STATUS;
SELECT * FROM STUDENT_PLACEMENT_SUMMARY ORDER BY offers_accepted DESC, total_applications DESC LIMIT 10;
SELECT COUNT(*) AS low_cgpa FROM VW_LOW_CGPA_STUDENTS;
SELECT COUNT(*) AS high_cgpa FROM VW_HIGH_CGPA_STUDENTS;