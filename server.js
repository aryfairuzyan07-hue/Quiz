const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Koneksi ke MySQL Railway (variabel lingkungan otomatis)
const db = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
    connectionLimit: 10
});

// Inisialisasi tabel (otomatis)
async function init() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            has_completed TINYINT DEFAULT 0
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS questions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            text TEXT NOT NULL,
            opt1 VARCHAR(255) NOT NULL,
            opt2 VARCHAR(255) NOT NULL,
            opt3 VARCHAR(255) NOT NULL,
            opt4 VARCHAR(255) NOT NULL,
            correct_index INT NOT NULL
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS quiz_settings (
            id INT PRIMARY KEY DEFAULT 1,
            timer_duration INT DEFAULT 15
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS leaderboard (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) NOT NULL,
            score_percent INT NOT NULL,
            total_correct INT NOT NULL,
            total_questions INT NOT NULL,
            tanggal VARCHAR(50) NOT NULL
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_results (
            username VARCHAR(50) PRIMARY KEY,
            result_json TEXT NOT NULL
        )
    `);

    // Data awal jika kosong
    const [rows] = await db.execute("SELECT COUNT(*) as count FROM questions");
    if (rows[0].count === 0) {
        const defaultQuestions = [
            { text: "Apa ibu kota Indonesia?", opt1: "Surabaya", opt2: "Jakarta", opt3: "Bandung", opt4: "Medan", correct: 1 },
            { text: "Presiden pertama RI?", opt1: "Soeharto", opt2: "Habibie", opt3: "Soekarno", opt4: "Megawati", correct: 2 },
            { text: "Planet terdekat Matahari?", opt1: "Venus", opt2: "Bumi", opt3: "Mars", opt4: "Merkurius", correct: 3 },
            { text: "12 × 7 = ?", opt1: "74", opt2: "84", opt3: "94", opt4: "64", correct: 1 },
            { text: "Sungai terpanjang dunia?", opt1: "Amazon", opt2: "Nil", opt3: "Mississippi", opt4: "Yangtze", correct: 1 }
        ];
        for (const q of defaultQuestions) {
            await db.execute(`INSERT INTO questions (text, opt1, opt2, opt3, opt4, correct_index) VALUES (?,?,?,?,?,?)`,
                [q.text, q.opt1, q.opt2, q.opt3, q.opt4, q.correct]);
        }
    }
    const [timerRows] = await db.execute("SELECT COUNT(*) as count FROM quiz_settings");
    if (timerRows[0].count === 0) {
        await db.execute("INSERT INTO quiz_settings (timer_duration) VALUES (15)");
    }
}
init().catch(console.error);

// ========== API endpoints ==========
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Isi semua!" });
    const hashed = await bcrypt.hash(password, 10);
    try {
        await db.execute("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashed]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: "Username sudah ada!" });
        res.status(500).json({ error: "Terjadi kesalahan server" });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const [rows] = await db.execute("SELECT * FROM users WHERE username = ?", [username]);
    if (rows.length === 0) return res.status(401).json({ error: "Username belum terdaftar!" });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Password salah!" });
    res.json({ username: user.username, hasCompleted: user.has_completed === 1 });
});

app.get('/api/quiz-data', async (req, res) => {
    const [questions] = await db.execute("SELECT * FROM questions ORDER BY id");
    const [setting] = await db.execute("SELECT timer_duration FROM quiz_settings WHERE id = 1");
    const formatted = questions.map(q => ({
        text: q.text,
        options: [q.opt1, q.opt2, q.opt3, q.opt4],
        correct: q.correct_index
    }));
    res.json({
        questions: formatted,
        timerDuration: setting[0]?.timer_duration || 15
    });
});

app.post('/api/save-result', async (req, res) => {
    const { username, scorePercent, totalCorrect, totalQuestions, correctionHtml } = req.body;
    const tanggal = new Date().toLocaleString();
    await db.execute(`INSERT INTO leaderboard (username, score_percent, total_correct, total_questions, tanggal) VALUES (?,?,?,?,?)`,
        [username, scorePercent, totalCorrect, totalQuestions, tanggal]);
    await db.execute(`REPLACE INTO user_results (username, result_json) VALUES (?,?)`,
        [username, JSON.stringify({ scorePercent, totalQuestions, correctionHtml })]);
    await db.execute(`UPDATE users SET has_completed = 1 WHERE username = ?`, [username]);
    res.json({ success: true });
});

app.get('/api/user-result/:username', async (req, res) => {
    const [rows] = await db.execute("SELECT result_json FROM user_results WHERE username = ?", [req.params.username]);
    if (rows.length) res.json(JSON.parse(rows[0].result_json));
    else res.json(null);
});

app.get('/api/leaderboard', async (req, res) => {
    const [rows] = await db.execute("SELECT username, score_percent, total_correct, total_questions, tanggal FROM leaderboard ORDER BY score_percent DESC LIMIT 30");
    res.json(rows);
});

app.post('/api/admin/update', async (req, res) => {
    const { questions, timerDuration, adminToken } = req.body;
    if (adminToken !== 'admin123') return res.status(403).json({ error: "Unauthorized" });
    await db.execute("DELETE FROM questions");
    for (const q of questions) {
        await db.execute(`INSERT INTO questions (text, opt1, opt2, opt3, opt4, correct_index) VALUES (?,?,?,?,?,?)`,
            [q.text, q.options[0], q.options[1], q.options[2], q.options[3], q.correct]);
    }
    await db.execute("UPDATE quiz_settings SET timer_duration = ? WHERE id = 1", [timerDuration]);
    res.json({ success: true });
});

app.post('/api/admin/reset-leaderboard', async (req, res) => {
    const { adminToken } = req.body;
    if (adminToken !== 'admin123') return res.status(403).json({ error: "Unauthorized" });
    await db.execute("DELETE FROM leaderboard");
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
