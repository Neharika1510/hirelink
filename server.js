// server.js
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors()); // Allows frontend to talk to backend
app.use(express.json()); // Parses incoming JSON data from forms

// 1. Connect to MySQL
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Nani@4160', // <--- PUT YOUR MYSQL PASSWORD HERE
    database: 'college_placement_internship'
});

db.connect((err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to MySQL Database: college_placement_internship');
    }
});

// 2. READ API: Get all active Job Openings
app.get('/api/jobs', (req, res) => {
    const query = 'SELECT * FROM JOB_OPENING';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 3. READ API: Get all Students
app.get('/api/students', (req, res) => {
    const query = 'SELECT * FROM VW_STUDENT_DETAILS LIMIT 20';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 4. WRITE API: Insert a NEW Student Record
app.post('/api/add-student', (req, res) => {
    const { student_id, first_name, last_name, dob, gender, email, year_of_study, cgpa, dept_code, program_code } = req.body;

    const query = `
        INSERT INTO STUDENT 
        (student_id, first_name, last_name, dob, gender, email, year_of_study, graduation_year, cgpa, academic_status, dept_code, program_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, 2026, ?, 'active', ?, ?)
    `;

    db.query(query, [student_id, first_name, last_name, dob, gender, email, year_of_study, cgpa, dept_code, program_code], (err, result) => {
        if (err) {
            // This will capture trigger errors or duplicate key errors
            return res.status(400).json({ error: err.message });
        }
        res.json({ message: 'Student registered successfully in MySQL!' });
    });
});

// 5. TRANSACTION API: Submit Job Application via Stored Procedure
app.post('/api/apply', (req, res) => {
    const { student_id, job_id } = req.body;

    // Calls your Stored Procedure: Proc_SubmitStudentApplication
    const sql = 'CALL Proc_SubmitStudentApplication(?, ?, "submitted", @msg)';

    db.query(sql, [student_id, job_id], (err) => {
        if (err) return res.status(400).json({ error: err.message });

        // Retrieve output message from procedure/trigger
        db.query('SELECT @msg AS message', (err, msgResult) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: msgResult[0].message });
        });
    });
});

// Start backend server
app.listen(5000, () => {
    console.log('HireLink Backend server running on http://localhost:5000');
});

// 4. WRITE API: Insert a NEW Student Record
app.post('/api/add-student', (req, res) => {
    const { student_id, first_name, last_name, dob, gender, email, year_of_study, cgpa, dept_code, program_code } = req.body;

    const query = `
        INSERT INTO STUDENT 
        (student_id, first_name, last_name, dob, gender, email, year_of_study, graduation_year, cgpa, academic_status, dept_code, program_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, 2026, ?, 'active', ?, ?)
    `;

    db.query(query, [student_id, first_name, last_name, dob, gender, email, year_of_study, cgpa, dept_code, program_code], (err, result) => {
        if (err) {
            console.error('MySQL Insertion Error:', err.sqlMessage); // <--- THIS PRINTS THE EXACT MYSQL ERROR
            return res.status(400).json({ error: err.sqlMessage });
        }
        res.json({ message: 'Student registered successfully in MySQL!' });
    });
});