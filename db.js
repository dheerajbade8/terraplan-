'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const file = process.env.DB_PATH || path.join(__dirname, 'data', 'terraplan.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','supervisor')),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  loc TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  budget REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sup TEXT REFERENCES users(id),
  prog INTEGER NOT NULL DEFAULT 0,
  plan INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Not started',
  budget REAL NOT NULL DEFAULT 0,
  ps TEXT NOT NULL DEFAULT '',
  pe TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trade TEXT NOT NULL,
  rate REAL NOT NULL,
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS wages (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  attendance TEXT NOT NULL,
  ot_hours REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
  approved_by TEXT REFERENCES users(id),
  UNIQUE (worker_id, work_date)
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  required REAL NOT NULL,
  available REAL NOT NULL,
  used REAL NOT NULL DEFAULT 0,
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  urgency TEXT NOT NULL,
  reason TEXT NOT NULL,
  req_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected'))
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  report_date TEXT NOT NULL,
  progress INTEGER NOT NULL,
  note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  exp_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_areas_sup ON areas(sup);
CREATE INDEX IF NOT EXISTS idx_wages_area ON wages(area_id, status);
`);

// Demo data (same as the original single-file app). Disable with SEED_DEMO=false.
function seed() {
  if (process.env.SEED_DEMO === 'false') return;
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return;
  const hash = bcrypt.hashSync('demo123', 10);
  db.transaction(() => {
    const u = db.prepare('INSERT INTO users (id,name,role,email,password_hash,skills) VALUES (?,?,?,?,?,?)');
    u.run('m1', 'Meera Rao', 'manager', 'manager@terraplan.demo', hash, '');
    u.run('s1', 'Ravi Kumar', 'supervisor', 'ravi@terraplan.demo', hash, 'Structural, Foundation');
    u.run('s2', 'Anita Das', 'supervisor', 'anita@terraplan.demo', hash, 'Electrical, Plumbing');
    u.run('s3', 'Dev Patel', 'supervisor', 'dev@terraplan.demo', hash, 'Finishing, Landscaping');

    db.prepare('INSERT INTO projects (id,name,loc,client,budget) VALUES (?,?,?,?,?)')
      .run('P-001', 'Pump Station Expansion (demo)', 'Bongaigaon, Assam', '', 2500000);

    const a = db.prepare('INSERT INTO areas (id,project_id,name,sup,prog,plan,status,budget) VALUES (?,?,?,?,?,?,?,?)');
    a.run('A1', 'P-001', 'Foundation', 's1', 60, 70, 'In progress', 800000);
    a.run('A2', 'P-001', 'Electrical work', 's2', 20, 30, 'In progress', 500000);

    const w = db.prepare('INSERT INTO workers (id,name,trade,rate,area_id) VALUES (?,?,?,?,?)');
    w.run('W1', 'Suresh', 'Mason', 700, 'A1');
    w.run('W2', 'Kiran', 'Helper', 500, 'A1');
    w.run('W3', 'Imran', 'Electrician', 900, 'A2');

    const r = db.prepare('INSERT INTO resources (id,name,unit,required,available,used,area_id) VALUES (?,?,?,?,?,?,?)');
    r.run('R1', 'Cement', 'bags', 500, 320, 180, 'A1');
    r.run('R2', 'Steel', 'kg', 4000, 2500, 1500, 'A1');
    r.run('R3', 'Cable', 'm', 900, 150, 300, 'A2');
  })();
}
seed();

module.exports = db;
