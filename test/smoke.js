'use strict';
// End-to-end smoke test: starts the app on a temp database and exercises the main flows.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-')), 'test.db');
process.env.JWT_SECRET = 'test-secret';
const assert = require('assert');
const app = require('../server');

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const login = async (email) => (await call('POST', '/login', { email, password: 'demo123' })).body.token;
  let n = 0;
  const ok = (cond, label) => { assert(cond, label); n++; console.log('  ok -', label); };

  try {
    const bad = await call('POST', '/login', { email: 'ravi@terraplan.demo', password: 'wrong' });
    ok(bad.status === 401, 'wrong password rejected');
    ok((await call('GET', '/state')).status === 401, 'state requires login');

    const M = await login('manager@terraplan.demo');
    const R = await login('ravi@terraplan.demo');
    const A = await login('anita@terraplan.demo');

    const ms = (await call('GET', '/state', null, M)).body;
    const rs = (await call('GET', '/state', null, R)).body;
    ok(ms.projects[0].areas.length === 2, 'manager sees all areas');
    ok(rs.projects[0].areas.length === 1 && rs.projects[0].areas[0].id === 'A1', 'supervisor sees only own area');
    ok(!JSON.stringify(ms).includes('password'), 'no password data in state');

    // role + ownership checks
    ok((await call('POST', '/wages/approve-all', null, R)).status === 403, 'supervisor cannot approve wages');
    ok((await call('POST', '/reports', { areaId: 'A2', progress: 50, note: 'x' }, R)).status === 403, 'supervisor cannot report on another area');
    ok((await call('POST', '/expenses', { projectId: 'P-001', category: 'Other', amount: 5 }, R)).status === 403, 'supervisor cannot add expenses');

    // report -> progress
    ok((await call('POST', '/reports', { areaId: 'A1', progress: 65, note: 'Poured slab' }, R)).status === 201, 'daily report accepted');
    ok((await call('POST', '/reports', { areaId: 'A1', progress: 150, note: 'x' }, R)).status === 400, 'invalid progress rejected');
    ok((await call('GET', '/state', null, M)).body.projects[0].areas[0].prog === 65, 'progress updated for manager');

    // attendance -> wages (Present 700 + 2h OT = 700 + 2*700/8*1.5 = 962.5)
    ok((await call('PUT', '/attendance', { workerId: 'W1', attendance: 'Present', ot: 2 }, R)).status === 200, 'attendance saved');
    ok((await call('PUT', '/attendance', { workerId: 'W3', attendance: 'Present', ot: 0 }, R)).status === 403, "cannot mark another supervisor's worker");
    let w = (await call('GET', '/state', null, R)).body.wages[0];
    ok(Math.abs(w.t - 962.5) < 0.001, 'wage computed on the server (962.5)');
    ok(!(await call('GET', '/state', null, M)).body.wages.length, 'manager does not see draft wages');
    ok((await call('POST', '/wages/submit', null, R)).body.count === 1, 'wages submitted');
    ok((await call('PUT', '/attendance', { workerId: 'W1', attendance: 'Absent', ot: 0 }, R)).status === 409, 'submitted record is locked');
    ok((await call('POST', '/wages/submit', null, R)).status === 400, 'nothing left to submit');
    ok((await call('POST', `/wages/${w.id}/approve`, null, M)).status === 200, 'manager approves wage');
    ok((await call('GET', '/state', null, M)).body.wages[0].s === 'approved', 'wage is approved');

    // resources
    ok((await call('POST', '/resources/R1/use', { qty: 20 }, R)).status === 200, 'resource use recorded');
    ok((await call('POST', '/resources/R1/use', { qty: 99999 }, R)).status === 400, 'cannot use more than available');
    ok((await call('POST', '/resources/R3/use', { qty: 1 }, R)).status === 403, "cannot use another area's resource");
    const rq = await call('POST', '/requests', { resourceId: 'R1', qty: 100, urgency: 'Urgent', reason: 'Slab pour' }, R);
    ok(rq.status === 201, 'resource request created');
    const before = (await call('GET', '/state', null, M)).body;
    const req = before.reqs[0];
    ok((await call('POST', `/requests/${req.id}/decide`, { approve: true }, M)).status === 200, 'manager approves request');
    const after = (await call('GET', '/state', null, M)).body;
    ok(after.res.find((r) => r.id === 'R1').avail === before.res.find((r) => r.id === 'R1').avail + 100, 'approved quantity added to stock');
    ok((await call('POST', `/requests/${req.id}/decide`, { approve: true }, M)).status === 404, 'request cannot be decided twice');

    // issues, expenses, schedule, project
    ok((await call('POST', '/issues', { areaId: 'A1', type: 'Safety issue', description: 'Loose scaffold' }, R)).status === 201, 'issue reported');
    const iid = (await call('GET', '/state', null, M)).body.iss[0].id;
    ok((await call('POST', `/issues/${iid}/resolve`, null, M)).status === 200, 'manager resolves issue');
    ok((await call('POST', '/expenses', { projectId: 'P-001', category: 'Material', amount: 12000, note: 'Sand' }, M)).status === 201, 'expense recorded');
    ok((await call('PUT', '/areas/A1/schedule', { plan: 80, ps: '2026-10-01', pe: '2026-12-31' }, M)).status === 200, 'schedule saved');
    const np = await call('POST', '/projects', { name: 'Road Works', loc: 'Guwahati', client: 'PWD', budget: 900000, areas: [{ name: 'Earthwork', sup: 's3', budget: 100000 }] }, M);
    ok(np.status === 201 && np.body.id === 'P-002', 'project created (P-002)');
    ok((await call('GET', '/state', null, M)).body.audit.length > 0, 'audit trail recorded');

    // anita (other supervisor) cannot see Ravi's data
    const as = (await call('GET', '/state', null, A)).body;
    ok(as.workers.every((x) => x.area === 'A2') && as.reqs.length === 0, "supervisor data is isolated from other supervisors");

    console.log(`\nAll ${n} checks passed.`);
    server.close(); process.exit(0);
  } catch (e) {
    console.error('\nFAILED:', e.message); server.close(); process.exit(1);
  }
});
