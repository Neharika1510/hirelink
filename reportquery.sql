-- QUERY 1: STUDENT PLACEMENT REPORT

SELECT
    s.student_id,
    CONCAT(s.first_name, ' ', s.last_name) AS student_name,
    s.email,
    d.dept_name,
    s.cgpa,
    jo.job_title,
    c.company_name,
    a.application_date,
    a.application_status,
    o.job_status AS offer_status,
    o.salary_package

FROM STUDENT s

JOIN DEPARTMENT d
    ON s.dept_code = d.dept_code

LEFT JOIN APPLICATION a
    ON s.student_id = a.student_id

LEFT JOIN JOB_OPENING jo
    ON a.job_id = jo.job_id

LEFT JOIN RECRUITMENT_DRIVE rd
    ON jo.drive_id = rd.drive_id

LEFT JOIN COMPANY c
    ON rd.company_id = c.company_id

LEFT JOIN OFFER o
    ON a.application_id = o.application_id

ORDER BY s.student_id;



-- QUERY 2: COMPANY-WISE RECRUITMENT REPORT

WITH JobStats AS (
    SELECT
        rd.company_id,
        COUNT(jo.job_id) AS total_jobs,
        SUM(jo.vacancies) AS total_vacancies
    FROM RECRUITMENT_DRIVE rd
    JOIN JOB_OPENING jo
        ON rd.drive_id = jo.drive_id
    GROUP BY rd.company_id
),

ApplicationStats AS (
    SELECT
        rd.company_id,
        COUNT(a.application_id) AS total_applications,
        COUNT(CASE
            WHEN a.application_status = 'selected'
            THEN 1
        END) AS selected_candidates
    FROM RECRUITMENT_DRIVE rd
    JOIN JOB_OPENING jo
        ON rd.drive_id = jo.drive_id
    LEFT JOIN APPLICATION a
        ON jo.job_id = a.job_id
    GROUP BY rd.company_id
),

OfferStats AS (
    SELECT
        rd.company_id,
        COUNT(CASE
            WHEN o.job_status = 'accepted'
            THEN 1
        END) AS accepted_offers
    FROM RECRUITMENT_DRIVE rd
    JOIN JOB_OPENING jo
        ON rd.drive_id = jo.drive_id
    JOIN APPLICATION a
        ON jo.job_id = a.job_id
    JOIN OFFER o
        ON a.application_id = o.application_id
    GROUP BY rd.company_id
)

SELECT
    c.company_id,
    c.company_name,
    COALESCE(j.total_jobs, 0) AS total_jobs,
    COALESCE(j.total_vacancies, 0) AS total_vacancies,
    COALESCE(a.total_applications, 0) AS total_applications,
    COALESCE(a.selected_candidates, 0) AS selected_candidates,
    COALESCE(o.accepted_offers, 0) AS accepted_offers

FROM COMPANY c

LEFT JOIN JobStats j
    ON c.company_id = j.company_id

LEFT JOIN ApplicationStats a
    ON c.company_id = a.company_id

LEFT JOIN OfferStats o
    ON c.company_id = o.company_id

ORDER BY total_applications DESC;



-- QUERY 3: JOB-WISE APPLICATION REPORT

SELECT
    jo.job_id,
    jo.job_title,
    c.company_name,
    jo.employment_type,
    jo.work_location,
    jo.vacancies,

    COUNT(a.application_id) AS total_applications,

    COUNT(CASE
        WHEN a.application_status = 'shortlisted'
        THEN 1
    END) AS shortlisted,

    COUNT(CASE
        WHEN a.application_status = 'selected'
        THEN 1
    END) AS selected,

    COUNT(CASE
        WHEN a.application_status = 'rejected'
        THEN 1
    END) AS rejected,

    COUNT(CASE
        WHEN a.application_status = 'withdrawn'
        THEN 1
    END) AS withdrawn

FROM JOB_OPENING jo

JOIN RECRUITMENT_DRIVE rd
    ON jo.drive_id = rd.drive_id

JOIN COMPANY c
    ON rd.company_id = c.company_id

LEFT JOIN APPLICATION a
    ON jo.job_id = a.job_id

GROUP BY
    jo.job_id,
    jo.job_title,
    c.company_name,
    jo.employment_type,
    jo.work_location,
    jo.vacancies

ORDER BY total_applications DESC;



-- QUERY 4: DEPARTMENT-WISE PLACEMENT REPORT

SELECT
    d.dept_code,
    d.dept_name,

    COUNT(DISTINCT s.student_id) AS total_students,

    COUNT(DISTINCT a.application_id) AS total_applications,

    COUNT(DISTINCT
        CASE
            WHEN o.job_status = 'accepted'
            THEN s.student_id
        END
    ) AS placed_students,

    ROUND(
        100.0 *
        COUNT(DISTINCT
            CASE
                WHEN o.job_status = 'accepted'
                THEN s.student_id
            END
        ) /
        NULLIF(COUNT(DISTINCT s.student_id), 0),
        2
    ) AS placement_percentage

FROM DEPARTMENT d

LEFT JOIN STUDENT s
    ON d.dept_code = s.dept_code

LEFT JOIN APPLICATION a
    ON s.student_id = a.student_id

LEFT JOIN OFFER o
    ON a.application_id = o.application_id

GROUP BY
    d.dept_code,
    d.dept_name

ORDER BY placement_percentage DESC;



-- QUERY 5: OFFER STATUS REPORT

SELECT
    o.offer_id,

    CONCAT(s.first_name, ' ', s.last_name)
        AS student_name,

    s.student_id,

    jo.job_title,

    c.company_name,

    o.offer_date,
    o.salary_package,
    o.joining_date,
    o.job_location,
    o.job_status AS offer_status

FROM OFFER o

JOIN APPLICATION a
    ON o.application_id = a.application_id

JOIN STUDENT s
    ON a.student_id = s.student_id

JOIN JOB_OPENING jo
    ON a.job_id = jo.job_id

JOIN RECRUITMENT_DRIVE rd
    ON jo.drive_id = rd.drive_id

JOIN COMPANY c
    ON rd.company_id = c.company_id

ORDER BY
    CASE o.job_status
        WHEN 'pending' THEN 1
        WHEN 'accepted' THEN 2
        WHEN 'rejected' THEN 3
    END,
    o.offer_date DESC;



-- QUERY 6: INTERVIEW PERFORMANCE REPORT

SELECT
    c.company_id,
    c.company_name,

    COUNT(i.interview_id) AS total_interviews,

    COUNT(CASE
        WHEN i.result = 'passed'
        THEN 1
    END) AS passed_interviews,

    COUNT(CASE
        WHEN i.result = 'failed'
        THEN 1
    END) AS failed_interviews,

    COUNT(CASE
        WHEN i.result = 'scheduled'
        THEN 1
    END) AS scheduled_interviews,

    COUNT(CASE
        WHEN i.result = 'no_show'
        THEN 1
    END) AS no_show_interviews

FROM COMPANY c

LEFT JOIN RECRUITMENT_DRIVE rd
    ON c.company_id = rd.company_id

LEFT JOIN JOB_OPENING jo
    ON rd.drive_id = jo.drive_id

LEFT JOIN APPLICATION a
    ON jo.job_id = a.job_id

LEFT JOIN INTERVIEW i
    ON a.application_id = i.application_id

GROUP BY
    c.company_id,
    c.company_name

ORDER BY total_interviews DESC;



-- QUERY 7: SKILL DEMAND REPORT

WITH RequiredSkills AS (
    SELECT
        skill_id,
        COUNT(DISTINCT job_id) AS jobs_requiring_skill
    FROM JOB_REQUIRED_SKILL
    GROUP BY skill_id
),

StudentSkills AS (
    SELECT
        skill_id,
        COUNT(DISTINCT student_id) AS students_with_skill
    FROM STUDENT_SKILL
    GROUP BY skill_id
)

SELECT
    sk.skill_id,
    sk.skill_name,
    sk.category,

    COALESCE(r.jobs_requiring_skill, 0)
        AS jobs_requiring_skill,

    COALESCE(s.students_with_skill, 0)
        AS students_with_skill

FROM SKILL sk

LEFT JOIN RequiredSkills r
    ON sk.skill_id = r.skill_id

LEFT JOIN StudentSkills s
    ON sk.skill_id = s.skill_id

ORDER BY jobs_requiring_skill DESC;
