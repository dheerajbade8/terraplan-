'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET is not set: using a temporary secret (everyone is logged out on restart).');
}

/* ---------- helpers ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const uid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const log = (u, action) => db.prepare('INSERT INTO audit (at,user_id,action) VALUES (?,?,?)').run(stamp(), u.id, action);
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

const str = (v, max, name, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw fail(400, `${name} is required.`);
  if (s.length > max) throw fail(400, `${name} is too long.`);
  return s;
};
const num = (v, min, max, msg) => {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) throw fail(400, msg);
  return n;
};
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw fail(400, `Invalid ${name}.`);
  return v;
};
const dateStr = (v) => {
  const s = String(v || '');
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail(400, 'Invalid date.');
  return s;
};
const ownArea = (u, id) => {
  const a = db.prepare('SELECT * FROM areas WHERE id=?').get(String(id));
  if (!a || a.sup !== u.id) throw fail(403, 'Not authorised for that area.');
  return a;
};
// Wage rule: Present = daily rate; Half-day = 50%; Absent/Leave = 0; overtime = 1.5 x hourly (rate / 8).
const pay = (rate, st, ot) => {
  const o = (ot * rate / 8) * 1.5;
  return st === 'Present' ? rate + o : st === 'Half-day' ? rate / 2 + o : 0;
};

/* ---------- auth ---------- */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const attempts = new Map();
const tooMany = (ip) => {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
};

app.post('/api/login', wrap(async (req, res) => {
  if (tooMany(req.ip)) throw fail(429, 'Too many failed attempts. Try again in a few minutes.');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) {
    attempts.get(req.ip).push(Date.now());
    throw fail(401, 'Invalid email or password.');
  }
  res.json({ token: jwt.sign({ sub: u.id }, SECRET, { expiresIn: '12h' }) });
}));

const auth = wrap((req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw fail(401, 'Please log in.');
  let payload;
  try { payload = jwt.verify(h.slice(7), SECRET); } catch (e) { throw fail(401, 'Session expired. Please log in again.'); }
  const u = db.prepare('SELECT id,name,role,email,skills FROM users WHERE id=?').get(payload.sub);
  if (!u) throw fail(401, 'Account not found.');
  req.user = u;
  next();
});
const only = (role) => (req, res, next) =>
  req.user.role === role ? next() : next(fail(403, 'You do not have permission to do that.'));
const MANAGER = [auth, only('manager')];
const SUPERVISOR = [auth, only('supervisor')];

/* ---------- state (shaped for the frontend, filtered by role) ---------- */
function buildState(u) {
  const M = u.role === 'manager';
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  let areas = all('SELECT * FROM areas ORDER BY rowid');
  if (!M) areas = areas.filter((a) => a.sup === u.id);
  const ids = new Set(areas.map((a) => a.id));
  const visible = (r) => M || ids.has(r.area_id);

  const projects = all('SELECT * FROM projects ORDER BY rowid')
    .filter((p) => areas.some((a) => a.project_id === p.id))
    .map((p) => ({
      id: p.id, name: p.name, loc: p.loc, client: p.client, budget: p.budget,
      areas: areas.filter((a) => a.project_id === p.id).map((a) => ({
        id: a.id, name: a.name, sup: a.sup || '', prog: a.prog, plan: a.plan,
        status: a.status, budget: a.budget, ps: a.ps, pe: a.pe,
      })),
    }));

  return {
    me: u.id,
    users: M
      ? all('SELECT id,name,role,email,skills FROM users ORDER BY rowid')
      : all("SELECT id,name,role,skills FROM users WHERE id=? OR role='manager'", u.id),
    projects,
    workers: all('SELECT * FROM workers ORDER BY rowid').filter(visible)
      .map((w) => ({ id: w.id, name: w.name, trade: w.trade, rate: w.rate, area: w.area_id })),
    wages: all('SELECT * FROM wages ORDER BY rowid').filter(visible).filter((w) => !M || w.status !== 'draft')
      .map((w) => ({
        id: w.id, w: w.worker_id, a: w.area_id, d: w.work_date, st: w.attendance,
        ot: w.ot_hours, t: w.total, s: w.status, by: w.approved_by || '',
      })),
    res: all('SELECT * FROM resources ORDER BY rowid').filter(visible)
      .map((r) => ({ id: r.id, name: r.name, unit: r.unit, req: r.required, avail: r.available, used: r.used, area: r.area_id })),
    reqs: (M ? all('SELECT * FROM requests ORDER BY rowid') : all('SELECT * FROM requests WHERE user_id=? ORDER BY rowid', u.id))
      .map((r) => ({ id: r.id, u: r.user_id, r: r.resource_id, q: r.qty, ur: r.urgency, n: r.reason, d: r.req_date, s: r.status })),
    reports: (M ? all('SELECT * FROM reports ORDER BY id') : all('SELECT * FROM reports WHERE user_id=? ORDER BY id', u.id))
      .map((r) => ({ a: r.area_id, u: r.user_id, d: r.report_date, p: r.progress, n: r.note })),
    exp: M ? all('SELECT * FROM expenses ORDER BY id').map((e) => ({ p: e.project_id, c: e.category, amt: e.amount, n: e.note, d: e.exp_date })) : [],
    iss: (M ? all('SELECT * FROM issues ORDER BY rowid') : all('SELECT * FROM issues WHERE user_id=? ORDER BY rowid', u.id))
      .map((i) => ({ id: i.id, a: i.area_id, u: i.user_id, t: i.type, x: i.description, d: i.issue_date, s: i.status })),
    audit: M
      ? all('SELECT * FROM (SELECT * FROM audit ORDER BY id DESC LIMIT 200) ORDER BY id').map((a) => ({ d: a.at, u: a.user_id, t: a.action }))
      : [],
  };
}

app.get('/api/state', auth, (req, res) => res.json(buildState(req.user)));

/* ---------- manager actions ---------- */
app.post('/api/projects', MANAGER, wrap((req, res) => {
  const b = req.body, u = req.user;
  const name = str(b.name, 120, 'Project name');
  const budget = num(b.budget, 1, 1e12, 'Enter a budget above 0.');
  if (!Array.isArray(b.areas) || !b.areas.length || b.areas.length > 30) throw fail(400, 'Add between 1 and 30 construction areas.');
  const areas = b.areas.map((a) => {
    const sup = a.sup ? String(a.sup) : null;
    if (sup && !db.prepare("SELECT 1 FROM users WHERE id=? AND role='supervisor'").get(sup)) throw fail(400, 'Unknown supervisor.');
    return { name: str(a.name, 120, 'Area name'), sup, budget: num(a.budget || 0, 0, 1e12, 'Invalid area budget.') };
  });
  const loc = str(b.loc, 160, 'Location', false), client = str(b.client, 160, 'Client', false);
  const id = db.transaction(() => {
    const pid = 'P-' + String(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c + 1).padStart(3, '0');
    db.prepare('INSERT INTO projects (id,name,loc,client,budget) VALUES (?,?,?,?,?)').run(pid, name, loc, client, budget);
    const ins = db.prepare("INSERT INTO areas (id,project_id,name,sup,prog,plan,status,budget) VALUES (?,?,?,?,0,0,'Not started',?)");
    areas.forEach((a, i) => ins.run(`${pid}-A${i + 1}`, pid, a.name, a.sup, a.budget));
    log(u, `Created project ${pid} (${name})`);
    return pid;
  })();
  res.status(201).json({ id });
}));

app.put('/api/areas/:id/schedule', MANAGER, wrap((req, res) => {
  const a = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
  if (!a) throw fail(404, 'Area not found.');
  const plan = num(req.body.plan, 0, 100, 'Planned % must be 0–100.');
  db.prepare('UPDATE areas SET plan=?, ps=?, pe=? WHERE id=?').run(plan, dateStr(req.body.ps), dateStr(req.body.pe), a.id);
  log(req.user, `Updated schedule for ${a.name}`);
  res.json({ ok: true });
}));

app.post('/api/wages/approve-all', MANAGER, wrap((req, res) => {
  const r = db.prepare("UPDATE wages SET status='approved', approved_by=? WHERE status='submitted'").run(req.user.id);
  if (r.changes) log(req.user, `Approved ${r.changes} wage record(s)`);
  res.json({ count: r.changes });
}));

app.post('/api/wages/:id/approve', MANAGER, wrap((req, res) => {
  const r = db.prepare("UPDATE wages SET status='approved', approved_by=? WHERE id=? AND status='submitted'").run(req.user.id, req.params.id);
  if (!r.changes) throw fail(404, 'No submitted wage record found.');
  log(req.user, `Approved wage record ${req.params.id}`);
  res.json({ ok: true });
}));

app.post('/api/resources/:id/stock', MANAGER, wrap((req, res) => {
  const qty = num(req.body.qty, 0.01, 1e9, 'Enter a quantity above 0.');
  const r = db.prepare('UPDATE resources SET available = available + ? WHERE id=?').run(qty, req.params.id);
  if (!r.changes) throw fail(404, 'Resource not found.');
  log(req.user, `Added ${qty} stock to resource ${req.params.id}`);
  res.json({ ok: true });
}));

app.post('/api/requests/:id/decide', MANAGER, wrap((req, res) => {
  const approve = req.body.approve === true;
  db.transaction(() => {
    const r = db.prepare("SELECT * FROM requests WHERE id=? AND status='pending'").get(req.params.id);
    if (!r) throw fail(404, 'No pending request found.');
    db.prepare('UPDATE requests SET status=? WHERE id=?').run(approve ? 'approved' : 'rejected', r.id);
    if (approve) db.prepare('UPDATE resources SET available = available + ? WHERE id=?').run(r.qty, r.resource_id);
    log(req.user, `Resource request ${r.id} ${approve ? 'approved' : 'rejected'}`);
  })();
  res.json({ ok: true });
}));

app.post('/api/expenses', MANAGER, wrap((req, res) => {
  const b = req.body;
  const amount = num(b.amount, 0.01, 1e12, 'Enter an amount above 0.');
  const category = oneOf(b.category, ['Material', 'Equipment', 'Other'], 'category');
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(String(b.projectId))) throw fail(404, 'Project not found.');
  db.prepare('INSERT INTO expenses (project_id,category,amount,note,exp_date) VALUES (?,?,?,?,?)')
    .run(String(b.projectId), category, amount, str(b.note, 300, 'Note', false), today());
  log(req.user, `Expense ${inr(amount)} recorded`);
  res.status(201).json({ ok: true });
}));

app.post('/api/issues/:id/resolve', MANAGER, wrap((req, res) => {
  const i = db.prepare("SELECT * FROM issues WHERE id=? AND status='open'").get(req.params.id);
  if (!i) throw fail(404, 'No open issue found.');
  db.prepare("UPDATE issues SET status='resolved' WHERE id=?").run(i.id);
  log(req.user, `Resolved issue ${i.type}`);
  res.json({ ok: true });
}));

/* ---------- supervisor actions ---------- */
app.post('/api/reports', SUPERVISOR, wrap((req, res) => {
  const b = req.body, u = req.user;
  const area = ownArea(u, b.areaId);
  const p = num(b.progress, 0, 100, 'Progress must be 0–100.');
  const note = str(b.note, 1000, 'Report note');
  const status = p >= 100 ? 'Completed' : p > 0 ? 'In progress' : area.status;
  db.transaction(() => {
    db.prepare('UPDATE areas SET prog=?, status=? WHERE id=?').run(Math.round(p), status, area.id);
    db.prepare('INSERT INTO reports (area_id,user_id,report_date,progress,note) VALUES (?,?,?,?,?)').run(area.id, u.id, today(), Math.round(p), note);
  })();
  res.status(201).json({ ok: true });
}));

app.post('/api/workers', SUPERVISOR, wrap((req, res) => {
  const b = req.body;
  const area = ownArea(req.user, b.areaId);
  const rate = num(b.rate, 1, 1e6, 'Enter a daily wage above 0.');
  db.prepare('INSERT INTO workers (id,name,trade,rate,area_id) VALUES (?,?,?,?,?)')
    .run(uid('W'), str(b.name, 80, 'Worker name'), str(b.trade, 40, 'Trade'), rate, area.id);
  res.status(201).json({ ok: true });
}));

app.put('/api/attendance', SUPERVISOR, wrap((req, res) => {
  const b = req.body, u = req.user;
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(String(b.workerId));
  if (!w) throw fail(404, 'Worker not found.');
  ownArea(u, w.area_id);
  const st = oneOf(b.attendance, ['Present', 'Half-day', 'Absent', 'Leave'], 'attendance');
  const ot = num(b.ot ?? 0, 0, 8, 'Overtime must be 0–8 hours.');
  const existing = db.prepare('SELECT * FROM wages WHERE worker_id=? AND work_date=?').get(w.id, today());
  if (existing && existing.status !== 'draft') throw fail(409, 'Record is locked after submission.');
  const total = pay(w.rate, st, ot);
  if (existing) {
    db.prepare('UPDATE wages SET attendance=?, ot_hours=?, total=? WHERE id=?').run(st, ot, total, existing.id);
  } else {
    db.prepare("INSERT INTO wages (id,worker_id,area_id,work_date,attendance,ot_hours,total,status) VALUES (?,?,?,?,?,?,?,'draft')")
      .run(uid('WR'), w.id, w.area_id, today(), st, ot, total);
  }
  res.json({ ok: true });
}));

app.post('/api/wages/submit', SUPERVISOR, wrap((req, res) => {
  const r = db.prepare("UPDATE wages SET status='submitted' WHERE status='draft' AND area_id IN (SELECT id FROM areas WHERE sup=?)").run(req.user.id);
  if (!r.changes) throw fail(400, 'Nothing to submit. Save attendance first.');
  log(req.user, `Submitted ${r.changes} wage record(s) for approval`);
  res.json({ count: r.changes });
}));

app.post('/api/resources/:id/use', SUPERVISOR, wrap((req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) throw fail(404, 'Resource not found.');
  ownArea(req.user, r.area_id);
  const qty = num(req.body.qty, 0.01, 1e9, 'Enter a quantity above 0.');
  const done = db.prepare('UPDATE resources SET available = available - ?, used = used + ? WHERE id=? AND available >= ?').run(qty, qty, r.id, qty);
  if (!done.changes) {
    const now = db.prepare('SELECT available FROM resources WHERE id=?').get(r.id).available;
    throw fail(400, `Only ${now} ${r.unit} available.`);
  }
  res.json({ ok: true });
}));

app.post('/api/requests', SUPERVISOR, wrap((req, res) => {
  const b = req.body;
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(String(b.resourceId));
  if (!r) throw fail(404, 'Resource not found.');
  ownArea(req.user, r.area_id);
  const qty = num(b.qty, 0.01, 1e9, 'Choose a resource and a quantity above 0.');
  const urgency = oneOf(b.urgency, ['Normal', 'Urgent', 'Critical'], 'urgency');
  db.prepare('INSERT INTO requests (id,user_id,resource_id,qty,urgency,reason,req_date) VALUES (?,?,?,?,?,?,?)')
    .run(uid('Q'), req.user.id, r.id, qty, urgency, str(b.reason, 300, 'Reason'), today());
  res.status(201).json({ ok: true });
}));

app.post('/api/issues', SUPERVISOR, wrap((req, res) => {
  const b = req.body;
  const area = ownArea(req.user, b.areaId);
  const type = oneOf(b.type, ['Material shortage', 'Equipment breakdown', 'Worker shortage', 'Schedule delay', 'Quality concern', 'Safety issue'], 'issue type');
  db.prepare('INSERT INTO issues (id,area_id,user_id,type,description,issue_date) VALUES (?,?,?,?,?,?)')
    .run(uid('I'), area.id, req.user.id, type, str(b.description, 500, 'Description'), today());
  res.status(201).json({ ok: true });
}));

/* ---------- misc ---------- */
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Server error.' : err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Terraplan running on http://localhost:${PORT}`));
}
module.exports = app;
