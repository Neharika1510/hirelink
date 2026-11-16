const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));


const pool = mysql.createPool({
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || 'password',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'college_placement_internship',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true          
});


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



const crypto = require('crypto');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set. Using the default "admin123". Set ADMIN_PASSWORD before deploying.');

const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(token) {
    if (!token || token.indexOf('.') < 0) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        return p.exp && p.exp > Date.now() ? p : null;
    } catch (e) { return null; }
}
app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    req.user = verify(h.startsWith('Bearer ') ? h.slice(7) : null);
    next();
});
const needLogin = (req, res, next) =>
    req.user ? next() : res.status(401).json({ success: false, error: 'Please log in.' });

const allow = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Please log in.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Your role does not have permission for this.' });
    next();
};
const adminOnly = allow('admin');
const attempts = new Map();   
function tooManyAttempts(ip) {
    const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
    attempts.set(ip, list);
    return list.length >= 10;
}
function noteFailure(ip) { attempts.set(ip, (attempts.get(ip) || []).concat(Date.now())); }


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


function transaction(procName, pickArgs) {
    return async (req, res) => {
        try {
            const message = await callProc(procName, pickArgs(req.body || {}, req));
            if (message && message.startsWith('SUCCESS')) {
                return res.json({ success: true, message: message.replace(/^SUCCESS:\s*/, '') });
            }
            return res.status(400).json({ success: false, error: (message || 'Unknown error').replace(/^ERROR:\s*/, '') });
        } catch (err) {
            return res.status(400).json({ success: false, error: friendlyDbError(err) });
        }
    };
}


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


app.get('/api/jobs', needLogin, reader(`
    SELECT j.job_id, j.job_title, j.job_description, j.employment_type, j.work_location,
           j.vacancies, j.min_cgpa, j.salary_package, j.drive_id,
           c.company_name, d.drive_status, d.drive_date,
           v.filled_vacancies, v.remaining_vacancies
    FROM JOB_OPENING j
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    JOIN JOB_VACANCY_STATUS v ON v.job_id = j.job_id
    ORDER BY j.job_id`));

app.get('/api/students', adminOnly, reader(`
    SELECT v.student_id, v.first_name, v.last_name, v.age, v.gender, v.email, v.cgpa,
           v.academic_status, v.dept_code, v.program_code,
           p.total_applications, p.offers_accepted,
           (SELECT c.company_name FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
              JOIN JOB_OPENING j ON j.job_id = a.job_id JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
              JOIN COMPANY c ON c.company_id = d.company_id
             WHERE a.student_id = v.student_id AND o.job_status = 'accepted' LIMIT 1) AS placed_company
    FROM VW_STUDENT_DETAILS v
    JOIN STUDENT_PLACEMENT_SUMMARY p ON p.student_id = v.student_id
    ORDER BY v.student_id`));

app.get('/api/applications', adminOnly, reader(`
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

app.get('/api/offers', adminOnly, reader(`
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


function scoped(build) {
    return async (req, res) => {
        try {
            const q = build(req);
            const [rows] = await pool.query(q.sql, q.params || []);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ success: false, error: friendlyDbError(err) });
        }
    };
}
const INT_SELECT = `
    SELECT i.interview_id, i.interview_date, i.start_time, i.end_time, i.interview_mode, i.venue_or_link, i.result,
           a.application_id, s.student_id, s.cgpa, s.dept_code, CONCAT(s.first_name, ' ', s.last_name) AS student_name,
           j.job_title, c.company_name,
           GROUP_CONCAT(iv.interviewer_name SEPARATOR ', ') AS interviewers
    FROM INTERVIEW i
    JOIN APPLICATION a       ON a.application_id = i.application_id
    JOIN STUDENT s           ON s.student_id = a.student_id
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    LEFT JOIN INTERVIEW_INTERVIEWER ii ON ii.interview_id = i.interview_id
    LEFT JOIN INTERVIEWER iv           ON iv.interviewer_id = ii.interviewer_id`;
const INT_TAIL = `
    GROUP BY i.interview_id, i.interview_date, i.start_time, i.end_time, i.interview_mode, i.venue_or_link, i.result,
             a.application_id, s.student_id, s.cgpa, s.dept_code, s.first_name, s.last_name, j.job_title, c.company_name
    ORDER BY (i.result = 'scheduled') DESC, i.interview_date DESC, i.start_time`;
app.get('/api/interviews', allow('admin', 'interviewer'), scoped(req => req.user.role === 'interviewer'
    ? { sql: INT_SELECT + ' WHERE i.interview_id IN (SELECT interview_id FROM INTERVIEW_INTERVIEWER WHERE interviewer_id = ?) ' + INT_TAIL,
        params: [req.user.interviewer_id] }
    : { sql: INT_SELECT + INT_TAIL }));


app.get('/api/interviewers', adminOnly, reader(`
    SELECT iv.interviewer_id, iv.interviewer_name, iv.designation, iv.company_id, c.company_name
    FROM INTERVIEWER iv JOIN COMPANY c ON c.company_id = iv.company_id
    ORDER BY c.company_name, iv.interviewer_name`));

app.get('/api/stages', adminOnly, reader(`SELECT stage_id, stage_name, stage_type, max_score FROM SELECTION_STAGE ORDER BY stage_id`));

app.get('/api/audit', adminOnly, reader(`
    SELECT l.log_id, l.application_id, CONCAT(s.first_name, ' ', s.last_name) AS student_name,
           l.old_status, l.new_status, l.changed_at
    FROM APPLICATION_STATUS_LOG l
    JOIN APPLICATION a ON a.application_id = l.application_id
    JOIN STUDENT s     ON s.student_id = a.student_id
    ORDER BY l.log_id DESC LIMIT 50`));

app.get('/api/summary', adminOnly, async (req, res) => {
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
app.get('/api/report/:n', adminOnly, async (req, res) => {
    const sql = REPORTS[req.params.n];
    if (!sql) return res.status(404).json({ success: false, error: 'Report number must be between 1 and 7.' });
    try {
        const [rows] = await pool.query(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, error: friendlyDbError(err) });
    }
});


app.post('/api/login', async (req, res) => {
    const ip = req.ip;
    try {
        if (tooManyAttempts(ip)) return res.status(429).json({ success: false, error: 'Too many failed attempts. Try again in 15 minutes.' });
        const b = req.body || {};
        if (b.role === 'admin') {
            if (!safeEqual(b.password || '', ADMIN_PASSWORD)) { noteFailure(ip); return res.status(401).json({ success: false, error: 'Wrong admin password.' }); }
            return res.json({ success: true, role: 'admin', name: 'Placement Coordinator',
                              token: sign({ role: 'admin', exp: Date.now() + 8 * 3600 * 1000 }) });
        }
        if (b.role === 'interviewer') {
            const [r] = await pool.query('SELECT interviewer_id, interviewer_name FROM INTERVIEWER WHERE email = ? AND phone_number = ?',
                                         [needText(b, 'email'), needText(b, 'phone')]);
            if (!r.length) { noteFailure(ip); return res.status(401).json({ success: false, error: 'Interviewer email and phone do not match.' }); }
            return res.json({ success: true, role: 'interviewer', name: r[0].interviewer_name,
                              token: sign({ role: 'interviewer', interviewer_id: r[0].interviewer_id, exp: Date.now() + 8 * 3600 * 1000 }) });
        }
        const student_id = needInt(b, 'student_id');
        const dob = needText(b, 'dob');
        const [rows] = await pool.query('SELECT student_id, first_name, last_name FROM STUDENT WHERE student_id = ? AND dob = ?', [student_id, dob]);
        if (!rows.length) { noteFailure(ip); return res.status(401).json({ success: false, error: 'Student ID and date of birth do not match.' }); }
        const st = rows[0];
        res.json({ success: true, role: 'student', student_id: st.student_id, name: st.first_name + ' ' + st.last_name,
                   token: sign({ role: 'student', student_id: st.student_id, exp: Date.now() + 8 * 3600 * 1000 }) });
    } catch (err) {
        res.status(400).json({ success: false, error: friendlyDbError(err) });
    }
});


const studentOnly = (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Please log in.' });
    if (req.user.role !== 'student') return res.status(403).json({ success: false, error: 'Student login required.' });
    next();
};
function mine(sql) {
    return async (req, res) => {
        try {
            const [rows] = await pool.query(sql, [req.user.student_id]);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ success: false, error: friendlyDbError(err) });
        }
    };
}
app.get('/api/me', studentOnly, mine(`
    SELECT v.student_id, v.first_name, v.last_name, v.age, v.gender, v.email, v.cgpa, v.academic_status,
           v.dept_code, v.program_code, p.total_applications, p.offers_accepted,
           (SELECT c.company_name FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
              JOIN JOB_OPENING j ON j.job_id = a.job_id JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
              JOIN COMPANY c ON c.company_id = d.company_id
             WHERE a.student_id = v.student_id AND o.job_status = 'accepted' LIMIT 1) AS placed_company
    FROM VW_STUDENT_DETAILS v JOIN STUDENT_PLACEMENT_SUMMARY p ON p.student_id = v.student_id
    WHERE v.student_id = ?`));

app.get('/api/my/applications', studentOnly, mine(`
    SELECT a.application_id, a.application_date, a.application_status, j.job_id, j.job_title, j.work_location,
           c.company_name, o.offer_id, o.job_status AS offer_status
    FROM APPLICATION a
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    LEFT JOIN OFFER o        ON o.application_id = a.application_id
    WHERE a.student_id = ?
    ORDER BY a.application_id DESC`));

app.get('/api/my/interviews', studentOnly, mine(`
    SELECT i.interview_id, i.interview_date, i.start_time, i.end_time, i.interview_mode, i.venue_or_link, i.result,
           j.job_title, c.company_name, GROUP_CONCAT(iv.interviewer_name SEPARATOR ', ') AS interviewers
    FROM INTERVIEW i
    JOIN APPLICATION a       ON a.application_id = i.application_id
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    LEFT JOIN INTERVIEW_INTERVIEWER ii ON ii.interview_id = i.interview_id
    LEFT JOIN INTERVIEWER iv           ON iv.interviewer_id = ii.interviewer_id
    WHERE a.student_id = ?
    GROUP BY i.interview_id, i.interview_date, i.start_time, i.end_time, i.interview_mode, i.venue_or_link, i.result,
             j.job_title, c.company_name
    ORDER BY i.interview_date DESC, i.start_time`));

app.get('/api/my/offers', studentOnly, mine(`
    SELECT o.offer_id, o.offer_date, o.salary_package, o.joining_date, o.job_location, o.job_status,
           j.job_title, c.company_name
    FROM OFFER o
    JOIN APPLICATION a       ON a.application_id = o.application_id
    JOIN JOB_OPENING j       ON j.job_id = a.job_id
    JOIN RECRUITMENT_DRIVE d ON d.drive_id = j.drive_id
    JOIN COMPANY c           ON c.company_id = d.company_id
    WHERE a.student_id = ?
    ORDER BY o.offer_id DESC`));


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

app.post('/api/apply', allow('student', 'admin'), transaction('Proc_SubmitStudentApplication',
    (b, req) => [req.user.role === 'student' ? req.user.student_id : needInt(b, 'student_id'), needInt(b, 'job_id'), 'submitted']));

app.post('/api/stage-result', adminOnly, transaction('Proc_RecordStageResult',
    b => [needInt(b, 'application_id'), needInt(b, 'stage_id'), numOrNull(b.score), needText(b, 'result'), optText(b, 'remarks')]));

app.post('/api/schedule-interview', adminOnly, transaction('Proc_ScheduleInterview',
    b => [needInt(b, 'application_id'), needText(b, 'interview_date'), needText(b, 'start_time'), needText(b, 'end_time'),
          optText(b, 'interview_mode') || 'Online', optText(b, 'venue_or_link'), needInt(b, 'interviewer_id')]));

async function canRecordInterview(req, res, next) {
    if (req.user.role === 'admin') return next();
    try {
        const [r] = await pool.query('SELECT 1 FROM INTERVIEW_INTERVIEWER WHERE interview_id = ? AND interviewer_id = ?',
                                     [needInt(req.body || {}, 'interview_id'), req.user.interviewer_id]);
        if (r.length) return next();
        return res.status(403).json({ success: false, error: 'This interview is not assigned to you.' });
    } catch (err) { return res.status(400).json({ success: false, error: friendlyDbError(err) }); }
}
app.post('/api/interview-result', allow('admin', 'interviewer'), canRecordInterview, transaction('Proc_RecordInterviewResult',
    b => [needInt(b, 'interview_id'), needText(b, 'result')]));

app.post('/api/select', adminOnly, transaction('Proc_SelectCandidate',
    b => [needInt(b, 'application_id')]));

app.post('/api/issue-offer', adminOnly, transaction('Proc_IssueOffer',
    b => [needInt(b, 'application_id'), optText(b, 'joining_date'), optText(b, 'job_location')]));


async function ownsOffer(req, res, next) {
    if (req.user.role === 'admin') return next();
    try {
        const [r] = await pool.query(`SELECT a.student_id FROM OFFER o JOIN APPLICATION a ON a.application_id = o.application_id
                                      WHERE o.offer_id = ?`, [needInt(req.body || {}, 'offer_id')]);
        if (r.length && r[0].student_id === req.user.student_id) return next();
        return res.status(403).json({ success: false, error: 'This offer does not belong to you.' });
    } catch (err) { return res.status(400).json({ success: false, error: friendlyDbError(err) }); }
}
async function ownsApplication(req, res, next) {
    if (req.user.role === 'admin') return next();
    try {
        const [r] = await pool.query('SELECT student_id FROM APPLICATION WHERE application_id = ?', [needInt(req.body || {}, 'application_id')]);
        if (r.length && r[0].student_id === req.user.student_id) return next();
        return res.status(403).json({ success: false, error: 'This application does not belong to you.' });
    } catch (err) { return res.status(400).json({ success: false, error: friendlyDbError(err) }); }
}
app.post('/api/accept-offer', allow('student', 'admin'), ownsOffer, transaction('Proc_AcceptOffer', b => [needInt(b, 'offer_id')]));
app.post('/api/reject-offer', allow('student', 'admin'), ownsOffer, transaction('Proc_RejectOffer', b => [needInt(b, 'offer_id')]));
app.post('/api/withdraw', allow('student', 'admin'), ownsApplication, transaction('Proc_WithdrawApplication', b => [needInt(b, 'application_id')]));
app.post('/api/close-drive', adminOnly, transaction('Proc_CloseRecruitmentDrive', b => [needInt(b, 'drive_id')]));



function cleanFields(body, spec) {
    const out = {};
    for (const f of spec) {
        const raw = body[f.col];
        const empty = raw === undefined || raw === null || String(raw).trim() === '';
        if (empty) { if (f.required) throw new BadRequest(`${f.label} is required.`); continue; }
        const val = String(raw).trim();
        if (f.type === 'int') { const n = Number.parseInt(val, 10); if (Number.isNaN(n)) throw new BadRequest(`${f.label} must be a whole number.`); out[f.col] = n; }
        else if (f.type === 'num') { const n = Number.parseFloat(val); if (Number.isNaN(n)) throw new BadRequest(`${f.label} must be a number.`); out[f.col] = n; }
        else if (f.options) { if (!f.options.includes(val)) throw new BadRequest(`${f.label} must be one of: ${f.options.join(', ')}.`); out[f.col] = val; }
        else out[f.col] = val;
    }
    return out;
}
function createRoute(path, table, spec, label) {
    app.post(path, adminOnly, async (req, res) => {
        try {
            const row = cleanFields(req.body || {}, spec);
            const [r] = await pool.query('INSERT INTO ?? SET ?', [table, row]);
            res.json({ success: true, id: r.insertId, message: `${label} added successfully${r.insertId ? ' (ID ' + r.insertId + ')' : ''}.` });
        } catch (err) { res.status(400).json({ success: false, error: friendlyDbError(err) }); }
    });
}
createRoute('/api/companies', 'COMPANY', [
    { col: 'company_name', label: 'Company name', required: true }, { col: 'industry', label: 'Industry' },
    { col: 'website', label: 'Website' }, { col: 'email', label: 'Email' },
    { col: 'phone_number', label: 'Phone' }, { col: 'headquarters', label: 'Headquarters' }], 'Company');
createRoute('/api/drives', 'RECRUITMENT_DRIVE', [
    { col: 'company_id', label: 'Company', type: 'int', required: true }, { col: 'academic_year', label: 'Academic year', required: true },
    { col: 'reg_start_date', label: 'Registration start', required: true }, { col: 'reg_end_date', label: 'Registration end', required: true },
    { col: 'drive_date', label: 'Drive date', required: true }, { col: 'venue', label: 'Venue' },
    { col: 'drive_mode', label: 'Mode', required: true, options: ['online', 'offline'] }], 'Recruitment drive');
createRoute('/api/jobs', 'JOB_OPENING', [
    { col: 'drive_id', label: 'Drive', type: 'int', required: true }, { col: 'job_title', label: 'Job title', required: true },
    { col: 'job_description', label: 'Description' }, { col: 'employment_type', label: 'Type' }, { col: 'work_location', label: 'Work location' },
    { col: 'vacancies', label: 'Vacancies', type: 'int', required: true }, { col: 'min_cgpa', label: 'Minimum CGPA', type: 'num' },
    { col: 'salary_package', label: 'Salary package', type: 'num' }], 'Job opening');
createRoute('/api/interviewers', 'INTERVIEWER', [
    { col: 'company_id', label: 'Company', type: 'int', required: true }, { col: 'interviewer_name', label: 'Name', required: true },
    { col: 'email', label: 'Email', required: true }, { col: 'designation', label: 'Designation' }, { col: 'phone_number', label: 'Phone', required: true }], 'Interviewer');
app.post('/api/stages', adminOnly, async (req, res) => {          // stage_id is not auto-numbered, so take the next free number
    try {
        const row = cleanFields(req.body || {}, [
            { col: 'stage_name', label: 'Stage name', required: true }, { col: 'stage_type', label: 'Stage type' },
            { col: 'max_score', label: 'Maximum score', type: 'num', required: true }]);
        if (row.max_score <= 0) throw new BadRequest('Maximum score must be above zero.');
        const [[m]] = await pool.query('SELECT IFNULL(MAX(stage_id), 0) + 1 AS next_id FROM SELECTION_STAGE');
        await pool.query('INSERT INTO SELECTION_STAGE SET ?', [Object.assign({ stage_id: m.next_id }, row)]);
        res.json({ success: true, id: m.next_id, message: `Selection stage added (ID ${m.next_id}, maximum score ${row.max_score}).` });
    } catch (err) { res.status(400).json({ success: false, error: friendlyDbError(err) }); }
});
app.get('/api/companies', adminOnly, reader('SELECT company_id, company_name FROM COMPANY ORDER BY company_name'));
app.get('/api/drives', adminOnly, reader(`SELECT d.drive_id, d.drive_status, d.drive_date, c.company_name
                                          FROM RECRUITMENT_DRIVE d JOIN COMPANY c ON c.company_id = d.company_id ORDER BY d.drive_id DESC`));


const PORT = process.env.PORT || 5000;
pool.query('SELECT 1')
    .then(() => console.log('Connected to MySQL database: college_placement_internship'))
    .catch(err => console.error('Database connection error:', friendlyDbError(err)));
app.listen(PORT, () => console.log(`HireLink backend running on http://localhost:${PORT}`));