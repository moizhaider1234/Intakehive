/**
 * IntakeHive Backend API
 * Express + SQLite (sql.js) — no native build deps
 *
 * Endpoints:
 *   POST   /api/leads          — submit a new lead
 *   GET    /api/leads          — list/search leads (auth required)
 *   GET    /api/leads/:id      — get single lead (auth required)
 *   DELETE /api/leads/:id      — delete lead (auth required)
 *   GET    /api/leads/export   — CSV export (auth required)
 *   GET    /api/stats          — aggregate counts (auth required)
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const fs         = require('fs');
const path       = require('path');
const initSqlJs  = require('sql.js');
const https      = require('https');

const app  = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'data', 'intakehive.db');

// ActiveProspect TrustedForm — set TRUSTEDFORM_API_KEY in your .env
const TRUSTEDFORM_API_KEY = process.env.TRUSTEDFORM_API_KEY || '';

/**
 * Claim a TrustedForm certificate.
 * Fires after a lead is saved; failure is logged but never blocks the response.
 * @param {string} certUrl  — the xxTrustedFormCertUrl value from the form
 * @param {object} lead     — { firstName, lastName, email, phone }
 */
function claimTrustedForm(certUrl, lead) {
  if (!TRUSTEDFORM_API_KEY || !certUrl) return;

  // The cert URL looks like https://cert.trustedform.com/<token>
  // We POST to that URL with Basic auth (API key as password, empty username)
  try {
    const url  = new URL(certUrl);
    const body = JSON.stringify({
      reference: `${lead.firstName} ${lead.lastName}`,
      vendor:    'IntakeHive',
    });

    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  'Basic ' + Buffer.from(':' + TRUSTEDFORM_API_KEY).toString('base64'),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          console.log(`✅ TrustedForm cert claimed: ${certUrl}`);
        } else {
          console.warn(`⚠️  TrustedForm claim returned ${res.statusCode}:`, data);
        }
      });
    });

    req.on('error', err => {
      console.error('TrustedForm claim error:', err.message);
    });

    req.write(body);
    req.end();
  } catch (err) {
    console.error('TrustedForm claim failed (invalid cert URL?):', err.message);
  }
}

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*',
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-admin-key'],
}));
app.use(express.json({ limit: '50kb' }));

// Rate limiting — 30 submissions per IP per 15 min
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests — please try again later.' },
});

// ── SQLite database (sql.js, pure JS) ────────────────────────────────────────
let db;

async function initDB() {
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
  }

  const SQL = await initSqlJs();

  // Load existing DB file or create fresh
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('📂 Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('🆕 Created new database at', DB_PATH);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id          TEXT PRIMARY KEY,
      tort        TEXT NOT NULL,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      phone       TEXT NOT NULL,
      email       TEXT NOT NULL,
      state       TEXT,
      diagnosis   TEXT,
      diag_year   TEXT,
      injury_year TEXT,
      used_years  TEXT,
      extra_json  TEXT,
      ip          TEXT,
      created_at  TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_tort    ON leads(tort)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_state   ON leads(state)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created ON leads(created_at)`);

  persistDB(); // save initial schema
  console.log('✅ Database ready');
}

// Persist to disk after every write
function persistDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Helper: generate a simple unique ID ──────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Auth middleware (admin endpoints) ────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'IH2026';

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Input validation ──────────────────────────────────────────────────────────
const VALID_TORTS = ['talcum','roundup','paraquat','depo','hairrelaxer','cgm'];

function validateLead(data) {
  const errors = [];
  if (!data.tort || !VALID_TORTS.includes(data.tort))
    errors.push('Invalid or missing tort type.');
  if (!data.firstName || data.firstName.trim().length < 1)
    errors.push('First name is required.');
  if (!data.lastName || data.lastName.trim().length < 1)
    errors.push('Last name is required.');
  if (!data.phone || data.phone.replace(/\D/g,'').length < 10)
    errors.push('A valid phone number is required.');
  if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
    errors.push('A valid email address is required.');
  return errors;
}

// ── Sanitize string ───────────────────────────────────────────────────────────
function s(v) {
  if (v == null) return null;
  return String(v).trim().slice(0, 500);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// POST /api/leads — public, rate limited
app.post('/api/leads', submitLimiter, (req, res) => {
  const body = req.body || {};
  const errors = validateLead(body);
  if (errors.length) return res.status(422).json({ errors });

  // Separate known fields from extras
  const {
    tort, firstName, lastName, phone, email,
    state, diagnosis, diagYear, injuryYear, usedYears,
    xxTrustedFormCertUrl,
    ...rest
  } = body;

  // Strip known keys from "rest" to avoid duplication
  const extraKeys = Object.keys(rest).filter(k =>
    !['tort','firstName','lastName','phone','email',
      'state','diagnosis','diagYear','injuryYear','usedYears','xxTrustedFormCertUrl'].includes(k)
  );
  const extraObj = Object.fromEntries(extraKeys.map(k => [k, rest[k]]));
  if (xxTrustedFormCertUrl) extraObj.xxTrustedFormCertUrl = xxTrustedFormCertUrl;
  const extra = Object.keys(extraObj).length ? JSON.stringify(extraObj) : null;

  const id  = uid();
  const now = new Date().toISOString();
  const ip  = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || null;

  try {
    db.run(
      `INSERT INTO leads
         (id, tort, first_name, last_name, phone, email,
          state, diagnosis, diag_year, injury_year, used_years,
          extra_json, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, s(tort), s(firstName), s(lastName), s(phone), s(email),
        s(state), s(diagnosis), s(diagYear), s(injuryYear), s(usedYears),
        extra, s(ip), now,
      ]
    );
    persistDB();
    console.log(`✔ New lead [${id}] — ${tort} | ${firstName} ${lastName}`);

    // Claim TrustedForm certificate asynchronously (non-blocking)
    const certUrl = body.xxTrustedFormCertUrl;
    if (certUrl) {
      claimTrustedForm(certUrl, { firstName, lastName, email, phone });
    }

    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('DB insert error:', err);
    res.status(500).json({ error: 'Database error. Please try again.' });
  }
});

// GET /api/leads — admin: list with search/filter/pagination
app.get('/api/leads', adminAuth, (req, res) => {
  const {
    search, tort, state,
    page = '1', limit = '50',
    sort = 'created_at', order = 'desc',
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const pageSize = Math.min(200, parseInt(limit,10) || 50);
  const offset   = (pageNum - 1) * pageSize;

  const allowed = ['created_at','tort','state','first_name','last_name','diagnosis'];
  const sortCol = allowed.includes(sort) ? sort : 'created_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  const wheres = [];
  const params = [];

  if (tort)   { wheres.push('tort = ?');  params.push(tort);  }
  if (state)  { wheres.push('state = ?'); params.push(state); }
  if (search) {
    wheres.push(`(
      first_name LIKE ? OR last_name LIKE ? OR
      email LIKE ? OR phone LIKE ? OR diagnosis LIKE ?
    )`);
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }

  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  try {
    const countResult = db.exec(
      `SELECT COUNT(*) AS n FROM leads ${where}`,
      params
    );
    const total = countResult[0]?.values[0][0] ?? 0;

    const rows = db.exec(
      `SELECT id, tort, first_name, last_name, phone, email,
              state, diagnosis, diag_year, injury_year, used_years,
              created_at
       FROM leads ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const leads = rows[0]
      ? rows[0].values.map(r => Object.fromEntries(
          rows[0].columns.map((c, i) => [c, r[i]])
        ))
      : [];

    res.json({
      leads,
      pagination: { total, page: pageNum, limit: pageSize,
                    pages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    console.error('DB query error:', err);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/leads/export — CSV download
app.get('/api/leads/export', adminAuth, (req, res) => {
  const { tort, state } = req.query;
  const wheres = [];
  const params = [];
  if (tort)  { wheres.push('tort = ?');  params.push(tort);  }
  if (state) { wheres.push('state = ?'); params.push(state); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  try {
    const rows = db.exec(
      `SELECT id, tort, first_name, last_name, phone, email,
              state, diagnosis, diag_year, injury_year, used_years,
              created_at
       FROM leads ${where} ORDER BY created_at DESC`,
      params
    );

    const headers = [
      'ID','Tort','First Name','Last Name','Phone','Email',
      'State','Diagnosis','Diag Year','Injury Year','Used Years','Submitted At',
    ];

    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = [headers.map(esc).join(',')];

    if (rows[0]) {
      rows[0].values.forEach(r => {
        lines.push(r.map(esc).join(','));
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
      `attachment; filename="intakehive_leads_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// GET /api/stats — aggregate dashboard stats
app.get('/api/stats', adminAuth, (req, res) => {
  try {
    const total = db.exec('SELECT COUNT(*) FROM leads')[0]?.values[0][0] ?? 0;

    const today = new Date().toISOString().slice(0, 10);
    const todayCount = db.exec(
      `SELECT COUNT(*) FROM leads WHERE created_at >= ?`,
      [today + 'T00:00:00']
    )[0]?.values[0][0] ?? 0;

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const weekCount = db.exec(
      `SELECT COUNT(*) FROM leads WHERE created_at >= ?`,
      [weekAgo]
    )[0]?.values[0][0] ?? 0;

    const byTort = db.exec(
      `SELECT tort, COUNT(*) AS n FROM leads GROUP BY tort ORDER BY n DESC`
    )[0];
    const tortStats = byTort
      ? Object.fromEntries(byTort.values.map(r => [r[0], r[1]]))
      : {};

    const byState = db.exec(
      `SELECT state, COUNT(*) AS n FROM leads
       WHERE state IS NOT NULL GROUP BY state ORDER BY n DESC LIMIT 10`
    )[0];
    const stateStats = byState
      ? byState.values.map(r => ({ state: r[0], count: r[1] }))
      : [];

    res.json({ total, today: todayCount, week: weekCount, byTort: tortStats, byState: stateStats });
  } catch (err) {
    res.status(500).json({ error: 'Stats error.' });
  }
});

// GET /api/leads/:id
app.get('/api/leads/:id', adminAuth, (req, res) => {
  try {
    const rows = db.exec(
      `SELECT * FROM leads WHERE id = ?`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
    const lead = Object.fromEntries(
      rows[0].columns.map((c, i) => [c, rows[0].values[0][i]])
    );
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: 'Database error.' });
  }
});

// DELETE /api/leads/:id
app.delete('/api/leads/:id', adminAuth, (req, res) => {
  try {
    db.run(`DELETE FROM leads WHERE id = ?`, [req.params.id]);
    persistDB();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 IntakeHive API running at http://localhost:${PORT}`);
    console.log(`   Admin key: ${ADMIN_KEY}`);
    console.log(`   Database : ${DB_PATH}\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
