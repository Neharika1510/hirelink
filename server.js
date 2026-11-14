// =====================================================================
// HireLink backend  |  Node + Express + MySQL
// Start:  npm install   then   npm start     (http://localhost:5000)
// Password: set the environment variable DB_PASSWORD (do NOT commit it to GitHub).
//   Windows (cmd):         set DB_PASSWORD=yourpassword && npm start
//   Windows (PowerShell):  $env:DB_PASSWORD="yourpassword"; npm start
//   Mac/Linux:             DB_PASSWORD=yourpassword npm start
// =====================================================================
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'PUT_YOUR_MYSQL_PASSWORD_HERE',
    database: 'college_placement_internship',
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true          // return DATE/TIME as plain strings (no timezone shifts)
});

// ---------- helpers ----------
class BadRequest extends Error {}

function needInt(body, key) {
    const v = Number.parseInt(body[key], 10);
    if (Number.isNaN(v)) throw new BadRequest(`"${key}" must be a number.`);
    return v;
}
function needText(body, key) {
    const v = body[key];
    if (v === undefined || v === null || String(v).trim() === '') throw new BadRequest(`"${key}" is required.`);
    return String(v).trim();
}
function numOrNull(v) {
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? null : n;
}
function optText(body, key) {
    const v = body[key];
    return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}
function friendlyDbError(err) {
    if (err instanceof BadRequest) return err.message;
    if (err.code === 'ER_DUP_ENTRY') return 'Duplicate value: a record with this ID or email already exists.';
    if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') return 'A value is outside the allowed range (check CGPA 0-10, dates and times).';
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return 'A referenced record (department, program, job ...) does not exist.';
    if (err.code === 'ECONNREFUSED') return 'Cannot connect to MySQL. Is the MySQL server running?';
    return err.sqlMessage || err.message;
}

// Runs a stored procedure that has an OUT parameter as its LAST argument.
// A dedicated connection is used so that @msg belongs to the same session.
async function callProc(name, args) {
    const conn = await pool.getConnection();
    try {
        const marks = args.map(() => '?').concat('@msg').join(', ');
        await conn.query(`CALL ${name}(${marks})`, args.map(a => (a === undefined ? null : a)));
        const [rows] = await conn.query('SELECT @msg AS message');
        return rows[0].message;
    } finally {
        conn.release();
    }
}

// Builds an Express handler for one transaction (stored procedure)
function transaction(procName, pickArgs) {
    return async (req, res) => {
        try {
            const message = await callProc(procName, pickArgs(req.body || {}));
            if (message && message.startsWith('SUCCESS')) {
                return res.json({ success: true, message: message.replace(/^SUCCESS:\s*/, '') });
            }
            return res.status(400).json({ success: false, error: (message || 'Unknown error').replace(/^ERROR:\s*/, '') });
        } catch (err) {
            return res.status(400).json({ success: false, error: friendlyDbError(err) });
        }
    };
}

// Builds an Express handler for a read-only query
function reader(sql) {
    return async (req, res) => {
        try {
            const [rows] = await pool.query(sql);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ success: false, error: friendlyDbError(err) });
        }
    };
}

// ---------- READ APIs ----------
app.get('/api/jobs', reader(`
    SELECT j.job_id, j.job_title, j.job_description, j.employment_type, j.work_location,
           j.vacancies, j.min_cgpa, j.salary_package, j.drive_id,
           c.company_name, d.drive_status, d.drive_date,
           v.filled_vacancies, v.remaining_vacancies
    FROM JOB_OPENING j
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    JOIN JOB_VACANCY_STATUS v ON v.job_id = j.job_id
    ORDER BY j.job_id`));

app.get('/api/students', reader(`
    SELECT v.student_id, v.first_name, v.last_name, v.age, v.gender, v.email, v.cgpa,
           v.academic_status, v.dept_code, v.program_code,
           p.total_applications, p.offers_accepted
    FROM VW_STUDENT_DETAILS v
    JOIN STUDENT_PLACEMENT_SUMMARY p ON p.student_id = v.student_id
    ORDER BY v.student_id`));

app.get('/api/applications', reader(`
    SELECT a.application_id, a.application_date, a.application_status,
           s.student_id, CONCAT(s.first_name, ' ', s.last_name) AS student_name,
           j.job_id, j.job_title, j.work_location, d.company_id, c.company_name,
           o.offer_id, o.job_status AS offer_status
    FROM APPLICATION a
    JOIN STUDENT s           ON s.student_id = a.student_id
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    LEFT JOIN OFFER o        ON o.application_id = a.application_id
    ORDER BY a.application_id DESC`));

app.get('/api/offers', reader(`
    SELECT o.offer_id, o.offer_date, o.salary_package, o.joining_date, o.job_location, o.job_status,
           a.application_id, s.student_id, CONCAT(s.first_name, ' ', s.last_name) AS student_name,
           j.job_title, c.company_name
    FROM OFFER o
    JOIN APPLICATION a       ON a.application_id = o.application_id
    JOIN STUDENT s           ON s.student_id = a.student_id
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    ORDER BY o.offer_id DESC`));

// extra lookups used by the frontend forms
app.get('/api/interviews', reader(`
    SELECT i.interview_id, i.interview_date, i.start_time, i.end_time, i.interview_mode, i.venue_or_link, i.result,
           a.application_id, CONCAT(s.first_name, ' ', s.last_name) AS student_name, j.job_title, c.company_name,
           GROUP_CONCAT(iv.interviewer_name SEPARATOR ', ') AS interviewers
    FROM INTERVIEW i
    JOIN APPLICATION a       ON a.application_id = i.application_id
    JOIN STUDENT s           ON s.student_id = a.student_id
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    LEFT JOIN INTERVIEW_INTERVIEWER ii ON ii.interview_id = i.interview_id
    LEFT JOIN INTERVIEWER iv           ON iv.interviewer_id = ii.interviewer_id
    GROUP BY i.interview_id, i.interview_date, i.start_time, i.end_time, i.interview_mode, i.venue_or_link, i.result,
             a.application_id, s.first_name, s.last_name, j.job_title, c.company_name
    ORDER BY (i.result = 'scheduled') DESC, i.interview_date DESC, i.start_time`));

app.get('/api/interviewers', reader(`
    SELECT iv.interviewer_id, iv.interviewer_name, iv.designation, iv.company_id, c.company_name
    FROM INTERVIEWER iv JOIN COMPANY c ON c.company_id = iv.company_id
    ORDER BY c.company_name, iv.interviewer_name`));

app.get('/api/stages', reader(`SELECT stage_id, stage_name, stage_type, max_score FROM SELECTION_STAGE ORDER BY stage_id`));

app.get('/api/audit', reader(`
    SELECT l.log_id, l.application_id, CONCAT(s.first_name, ' ', s.last_name) AS student_name,
           l.old_status, l.new_status, l.changed_at
    FROM APPLICATION_STATUS_LOG l
    JOIN APPLICATION a ON a.application_id = l.application_id
    JOIN STUDENT s     ON s.student_id = a.student_id
    ORDER BY l.log_id DESC LIMIT 50`));

app.get('/api/summary', async (req, res) => {
    try {
        const [[r]] = await pool.query(`
            SELECT
              (SELECT COUNT(*) FROM STUDENT WHERE academic_status = 'active')                         AS active_students,
              (SELECT COUNT(*) FROM JOB_OPENING j JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
                 WHERE d.drive_status = 'open')                                                        AS open_jobs,
              (SELECT COUNT(*) FROM APPLICATION)                                                       AS applications,
              (SELECT COUNT(*) FROM OFFER WHERE job_status = 'pending')                                AS pending_offers,
              (SELECT COUNT(DISTINCT a.student_id) FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
                 WHERE o.job_status = 'accepted')                                                      AS placed_students`);
        res.json(r);
    } catch (err) {
        res.status(500).json({ success: false, error: friendlyDbError(err) });
    }
});

// ---------- 7 REPORT QUERIES ----------
const REPORTS = {
    1: `SELECT j.job_id, j.job_title, c.company_name, j.min_cgpa, COUNT(s.student_id) AS eligible_students
        FROM JOB_OPENING j
        JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
        JOIN COMPANY c           ON c.company_id = d.company_id
        LEFT JOIN STUDENT s      ON s.cgpa >= j.min_cgpa AND s.academic_status = 'active'
        GROUP BY j.job_id, j.job_title, c.company_name, j.min_cgpa
        ORDER BY eligible_students DESC, j.job_id`,
    2: `SELECT s.dept_code, COUNT(DISTINCT s.student_id) AS placed_students,
               ROUND(AVG(o.salary_package), 2) AS avg_package,
               MAX(o.salary_package) AS highest_package, MIN(o.salary_package) AS lowest_package
        FROM OFFER o
        JOIN APPLICATION a ON a.application_id = o.application_id
        JOIN STUDENT s     ON s.student_id = a.student_id
        WHERE o.job_status = 'accepted'
        GROUP BY s.dept_code
        ORDER BY avg_package DESC`,
    3: `SELECT d.dept_code, d.dept_name, COUNT(DISTINCT s.student_id) AS total_students,
               COUNT(DISTINCT CASE WHEN o.job_status = 'accepted' THEN s.student_id END) AS placed_students,
               ROUND(100 * COUNT(DISTINCT CASE WHEN o.job_status = 'accepted' THEN s.student_id END)
                     / NULLIF(COUNT(DISTINCT s.student_id), 0), 1) AS placement_percent
        FROM DEPARTMENT d
        LEFT JOIN STUDENT s     ON s.dept_code = d.dept_code
        LEFT JOIN APPLICATION a ON a.student_id = s.student_id
        LEFT JOIN OFFER o       ON o.application_id = a.application_id
        GROUP BY d.dept_code, d.dept_name
        ORDER BY placement_percent DESC, d.dept_code`,
    4: `SELECT c.company_name, COUNT(DISTINCT d.drive_id) AS drives, COUNT(DISTINCT j.job_id) AS openings,
               COUNT(DISTINCT a.application_id) AS applications,
               COUNT(DISTINCT CASE WHEN o.job_status IN ('pending','accepted') THEN o.offer_id END) AS offers_made,
               COUNT(DISTINCT CASE WHEN o.job_status = 'accepted' THEN o.offer_id END) AS offers_accepted
        FROM COMPANY c
        LEFT JOIN RECRUITMENT_DRIVE d ON d.company_id = c.company_id
        LEFT JOIN JOB_OPENING j       ON j.drive_id = d.drive_id
        LEFT JOIN APPLICATION a       ON a.job_id = j.job_id
        LEFT JOIN OFFER o             ON o.application_id = a.application_id
        GROUP BY c.company_id, c.company_name
        ORDER BY offers_accepted DESC, applications DESC, c.company_name`,
    5: `SELECT ss.stage_id, ss.stage_name, ss.max_score,
               COUNT(ast.application_id) AS candidates,
               COUNT(CASE WHEN ast.result = 'passed' THEN 1 END) AS passed,
               COUNT(CASE WHEN ast.result = 'failed' THEN 1 END) AS failed,
               ROUND(AVG(ast.score), 2) AS avg_score
        FROM SELECTION_STAGE ss
        LEFT JOIN APPLICATION_STAGE ast ON ast.stage_id = ss.stage_id
        GROUP BY ss.stage_id, ss.stage_name, ss.max_score
        ORDER BY ss.stage_id`,
    6: `SELECT sk.skill_name, sk.category,
               COUNT(DISTINCT jr.job_id) AS jobs_requiring,
               COUNT(DISTINCT st.student_id) AS students_with_skill
        FROM SKILL sk
        LEFT JOIN JOB_REQUIRED_SKILL jr ON jr.skill_id = sk.skill_id
        LEFT JOIN STUDENT_SKILL st      ON st.skill_id = sk.skill_id
        GROUP BY sk.skill_id, sk.skill_name, sk.category
        ORDER BY jobs_requiring DESC, students_with_skill DESC, sk.skill_name`,
    7: `SELECT iv.interviewer_id, iv.interviewer_name, c.company_name,
               COUNT(i.interview_id) AS interviews_assigned,
               COUNT(CASE WHEN i.result = 'passed' THEN 1 END) AS candidates_passed,
               COUNT(CASE WHEN i.result IN ('failed','no_show') THEN 1 END) AS failed_or_no_show,
               COUNT(CASE WHEN i.result = 'scheduled' THEN 1 END) AS upcoming
        FROM INTERVIEWER iv
        JOIN COMPANY c                     ON c.company_id = iv.company_id
        LEFT JOIN INTERVIEW_INTERVIEWER ii ON ii.interviewer_id = iv.interviewer_id
        LEFT JOIN INTERVIEW i              ON i.interview_id = ii.interview_id
        GROUP BY iv.interviewer_id, iv.interviewer_name, c.company_name
        ORDER BY interviews_assigned DESC, iv.interviewer_name`
};
app.get('/api/report/:n', async (req, res) => {
    const sql = REPORTS[req.params.n];
    if (!sql) return res.status(404).json({ success: false, error: 'Report number must be between 1 and 7.' });
    try {
        const [rows] = await pool.query(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, error: friendlyDbError(err) });
    }
});

// ---------- WRITE API: register a student (insert student + phone in one DB transaction) ----------
app.post('/api/add-student', async (req, res) => {
    let conn;
    try {
        const b = req.body || {};
        const first_name = needText(b, 'first_name');
        const last_name = needText(b, 'last_name');
        const dob = needText(b, 'dob');
        const email = needText(b, 'email');
        const dept_code = needText(b, 'dept_code');
        const program_code = needText(b, 'program_code');
        const gender = optText(b, 'gender') || 'Female';
        const year_of_study = b.year_of_study ? needInt(b, 'year_of_study') : 4;
        const cgpa = Number.parseFloat(b.cgpa);
        if (Number.isNaN(cgpa) || cgpa < 0 || cgpa > 10) throw new BadRequest('CGPA must be a number between 0 and 10.');
        const phone = optText(b, 'phone');
        if (phone && !/^[0-9+\-\s]{7,15}$/.test(phone)) throw new BadRequest('Phone number must have 7 to 15 digits.');
        const graduation_year = 2031 - year_of_study;

        conn = await pool.getConnection();
        await conn.beginTransaction();

        let student_id = b.student_id ? needInt(b, 'student_id') : null;
        if (student_id === null) {
            const [[m]] = await conn.query('SELECT IFNULL(MAX(student_id), 100) + 1 AS next_id FROM STUDENT FOR UPDATE');
            student_id = m.next_id;
        }

        await conn.query(
            `INSERT INTO STUDENT (student_id, first_name, last_name, dob, gender, email, year_of_study, graduation_year,
                                  cgpa, academic_status, dept_code, program_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            [student_id, first_name, last_name, dob, gender, email, year_of_study, graduation_year, cgpa, dept_code, program_code]);

        if (phone) await conn.query('INSERT INTO STUDENT_PHONE (student_id, phone_number) VALUES (?, ?)', [student_id, phone]);

        await conn.commit();
        res.json({ success: true, student_id, message: `Student registered successfully with ID ${student_id}.` });
    } catch (err) {
        if (conn) { try { await conn.rollback(); } catch (e) { /* ignore */ } }
        res.status(400).json({ success: false, error: friendlyDbError(err) });
    } finally {
        if (conn) conn.release();
    }
});

// ---------- TRANSACTION APIs (each one = one stored procedure) ----------
app.post('/api/apply', transaction('Proc_SubmitStudentApplication',
    b => [needInt(b, 'student_id'), needInt(b, 'job_id'), 'submitted']));

app.post('/api/stage-result', transaction('Proc_RecordStageResult',
    b => [needInt(b, 'application_id'), needInt(b, 'stage_id'), numOrNull(b.score), needText(b, 'result'), optText(b, 'remarks')]));

app.post('/api/schedule-interview', transaction('Proc_ScheduleInterview',
    b => [needInt(b, 'application_id'), needText(b, 'interview_date'), needText(b, 'start_time'), needText(b, 'end_time'),
          optText(b, 'interview_mode') || 'Online', optText(b, 'venue_or_link'), needInt(b, 'interviewer_id')]));

app.post('/api/interview-result', transaction('Proc_RecordInterviewResult',
    b => [needInt(b, 'interview_id'), needText(b, 'result')]));

app.post('/api/select', transaction('Proc_SelectCandidate',
    b => [needInt(b, 'application_id')]));

app.post('/api/issue-offer', transaction('Proc_IssueOffer',
    b => [needInt(b, 'application_id'), optText(b, 'joining_date'), optText(b, 'job_location')]));

app.post('/api/accept-offer', transaction('Proc_AcceptOffer', b => [needInt(b, 'offer_id')]));
app.post('/api/reject-offer', transaction('Proc_RejectOffer', b => [needInt(b, 'offer_id')]));
app.post('/api/withdraw', transaction('Proc_WithdrawApplication', b => [needInt(b, 'application_id')]));
app.post('/api/close-drive', transaction('Proc_CloseRecruitmentDrive', b => [needInt(b, 'drive_id')]));

// ---------- start ----------
const PORT = process.env.PORT || 5000;
pool.query('SELECT 1')
    .then(() => console.log('Connected to MySQL database: college_placement_internship'))
    .catch(err => console.error('Database connection error:', friendlyDbError(err)));
app.listen(PORT, () => console.log(`HireLink backend running on http://localhost:${PORT}`));