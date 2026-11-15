-- HireLink Schema
DROP DATABASE IF EXISTS college_placement_internship;
CREATE DATABASE college_placement_internship;
USE college_placement_internship;

CREATE TABLE DEPARTMENT (
    dept_code       VARCHAR(20) PRIMARY KEY,
    dept_name       VARCHAR(100) NOT NULL UNIQUE,
    office_location VARCHAR(150),
    contact_number  VARCHAR(15)
);

CREATE TABLE DEGREE_PROGRAM (
    program_code   VARCHAR(20) PRIMARY KEY,
    program_name   VARCHAR(100) NOT NULL,
    degree_type    VARCHAR(50),
    duration_years DECIMAL(3,1),
    dept_code      VARCHAR(20) NOT NULL,
    FOREIGN KEY (dept_code) REFERENCES DEPARTMENT(dept_code)
);

CREATE TABLE STUDENT (
    student_id      INT PRIMARY KEY,
    first_name      VARCHAR(50)  NOT NULL,
    last_name       VARCHAR(50)  NOT NULL,
    dob             DATE,
    gender          VARCHAR(20),
    email           VARCHAR(150) NOT NULL UNIQUE,
    house_no        VARCHAR(20),
    street          VARCHAR(100),
    city            VARCHAR(50),
    state           VARCHAR(50),
    pin_code        VARCHAR(10),
    year_of_study   TINYINT NOT NULL,
    graduation_year YEAR,
    cgpa            DECIMAL(4,2),
    academic_status ENUM('active','graduated','withdrawn') DEFAULT 'active',
    dept_code       VARCHAR(20) NOT NULL,
    program_code    VARCHAR(20) NOT NULL,
    FOREIGN KEY (dept_code)    REFERENCES DEPARTMENT(dept_code),
    FOREIGN KEY (program_code) REFERENCES DEGREE_PROGRAM(program_code),
    CHECK (cgpa >= 0.00 AND cgpa <= 10.00),
    CHECK (year_of_study BETWEEN 1 AND 6)
);

CREATE TABLE SKILL (
    skill_id   INT PRIMARY KEY AUTO_INCREMENT,
    skill_name VARCHAR(100) NOT NULL UNIQUE,
    category   VARCHAR(50)
);

CREATE TABLE COMPANY (
    company_id   INT PRIMARY KEY AUTO_INCREMENT,
    company_name VARCHAR(150) NOT NULL UNIQUE,
    industry     VARCHAR(100),
    website      VARCHAR(300),
    email        VARCHAR(150),
    phone_number VARCHAR(15),
    headquarters VARCHAR(150)
);

CREATE TABLE RECRUITMENT_DRIVE (
    drive_id       INT PRIMARY KEY AUTO_INCREMENT,
    academic_year  VARCHAR(9) NOT NULL,
    reg_start_date DATE NOT NULL,
    reg_end_date   DATE NOT NULL,
    drive_date     DATE NOT NULL,
    venue          VARCHAR(150),
    drive_mode     ENUM('online','offline') NOT NULL,
    drive_status   ENUM('open','closed','completed') DEFAULT 'open',
    company_id     INT NOT NULL,
    FOREIGN KEY (company_id) REFERENCES COMPANY(company_id),
    CHECK (reg_end_date >= reg_start_date AND drive_date >= reg_end_date)
);

CREATE TABLE JOB_OPENING (
    job_id          INT PRIMARY KEY AUTO_INCREMENT,
    job_title       VARCHAR(150) NOT NULL,
    job_description TEXT,
    employment_type VARCHAR(50),
    work_location   VARCHAR(150),
    vacancies       INT NOT NULL,
    min_cgpa        DECIMAL(4,2),
    salary_package  DECIMAL(12,2),
    drive_id        INT NOT NULL,
    FOREIGN KEY (drive_id) REFERENCES RECRUITMENT_DRIVE(drive_id),
    CHECK (vacancies > 0),
    CHECK (min_cgpa >= 0 AND min_cgpa <= 10)
);

CREATE TABLE APPLICATION (
    application_id           INT PRIMARY KEY AUTO_INCREMENT,
    application_date         DATE NOT NULL,
    application_status       ENUM('submitted','shortlisted','rejected','selected','withdrawn') DEFAULT 'submitted',
    resume_submission_status VARCHAR(30),
    student_id               INT NOT NULL,
    job_id                   INT NOT NULL,
    FOREIGN KEY (student_id) REFERENCES STUDENT(student_id),
    FOREIGN KEY (job_id)     REFERENCES JOB_OPENING(job_id),
    UNIQUE (student_id, job_id)
);

CREATE TABLE SELECTION_STAGE (
    stage_id   INT PRIMARY KEY,
    stage_name VARCHAR(100) NOT NULL,
    stage_type VARCHAR(50),
    max_score  DECIMAL(6,2)
);

CREATE TABLE APPLICATION_STAGE (
    application_id INT NOT NULL,
    stage_id       INT NOT NULL,
    stage_date     DATE,
    score          DECIMAL(6,2),
    result         VARCHAR(30),
    remarks        VARCHAR(255),
    PRIMARY KEY (application_id, stage_id),
    FOREIGN KEY (application_id) REFERENCES APPLICATION(application_id),
    FOREIGN KEY (stage_id)       REFERENCES SELECTION_STAGE(stage_id),
    CHECK (score >= 0)
);

CREATE TABLE INTERVIEW (
    interview_id   INT PRIMARY KEY AUTO_INCREMENT,
    interview_date DATE NOT NULL,
    start_time     TIME,
    end_time       TIME,
    interview_mode VARCHAR(30),
    venue_or_link  VARCHAR(255),
    result         VARCHAR(50) DEFAULT 'scheduled',   -- scheduled | passed | failed | no_show | cancelled
    application_id INT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES APPLICATION(application_id),
    CHECK (end_time > start_time)
);

CREATE TABLE INTERVIEWER (
    interviewer_id   INT PRIMARY KEY AUTO_INCREMENT,
    interviewer_name VARCHAR(100) NOT NULL,
    email            VARCHAR(150) NOT NULL UNIQUE,
    designation      VARCHAR(100),
    phone_number     VARCHAR(15),
    company_id       INT NOT NULL,
    FOREIGN KEY (company_id) REFERENCES COMPANY(company_id)
);

CREATE TABLE OFFER (
    offer_id       INT PRIMARY KEY AUTO_INCREMENT,
    offer_date     DATE NOT NULL,
    salary_package DECIMAL(12,2),
    joining_date   DATE,
    job_location   VARCHAR(150),
    job_status     ENUM('pending','accepted','rejected') DEFAULT 'pending',
    application_id INT NOT NULL UNIQUE,
    FOREIGN KEY (application_id) REFERENCES APPLICATION(application_id),
    CHECK (joining_date >= offer_date),
    CHECK (salary_package >= 0)
);

CREATE TABLE PLACEMENT_COORDINATOR (
    coordinator_id   INT PRIMARY KEY AUTO_INCREMENT,
    coordinator_name VARCHAR(100) NOT NULL,
    email            VARCHAR(150) NOT NULL UNIQUE,
    phone_number     VARCHAR(15),
    dept_code        VARCHAR(20) NOT NULL,
    FOREIGN KEY (dept_code) REFERENCES DEPARTMENT(dept_code)
);

CREATE TABLE STUDENT_PHONE (
    student_id   INT NOT NULL,
    phone_number VARCHAR(15) NOT NULL,
    PRIMARY KEY (student_id, phone_number),
    FOREIGN KEY (student_id) REFERENCES STUDENT(student_id)
);

CREATE TABLE STUDENT_SKILL (
    student_id        INT NOT NULL,
    skill_id          INT NOT NULL,
    proficiency_level VARCHAR(50),
    PRIMARY KEY (student_id, skill_id),
    FOREIGN KEY (student_id) REFERENCES STUDENT(student_id),
    FOREIGN KEY (skill_id)   REFERENCES SKILL(skill_id)
);

CREATE TABLE JOB_REQUIRED_SKILL (
    job_id   INT NOT NULL,
    skill_id INT NOT NULL,
    PRIMARY KEY (job_id, skill_id),
    FOREIGN KEY (job_id)   REFERENCES JOB_OPENING(job_id),
    FOREIGN KEY (skill_id) REFERENCES SKILL(skill_id)
);

CREATE TABLE INTERVIEW_INTERVIEWER (
    interview_id   INT NOT NULL,
    interviewer_id INT NOT NULL,
    PRIMARY KEY (interview_id, interviewer_id),
    FOREIGN KEY (interview_id)   REFERENCES INTERVIEW(interview_id),
    FOREIGN KEY (interviewer_id) REFERENCES INTERVIEWER(interviewer_id)
);

CREATE TABLE DRIVE_COORDINATOR (
    drive_id       INT NOT NULL,
    coordinator_id INT NOT NULL,
    PRIMARY KEY (drive_id, coordinator_id),
    FOREIGN KEY (drive_id)       REFERENCES RECRUITMENT_DRIVE(drive_id),
    FOREIGN KEY (coordinator_id) REFERENCES PLACEMENT_COORDINATOR(coordinator_id)
);

-- ---------------------------------------------------------------------
-- EXTRA TABLE (not in the Assignment-4 design): audit trail filled by a trigger.
-- Mention it in the report as an enhancement.
-- ---------------------------------------------------------------------
CREATE TABLE APPLICATION_STATUS_LOG (
    log_id         INT PRIMARY KEY AUTO_INCREMENT,
    application_id INT NOT NULL,
    old_status     VARCHAR(20),
    new_status     VARCHAR(20),
    changed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (application_id) REFERENCES APPLICATION(application_id)
);

