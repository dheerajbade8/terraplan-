'use strict';
// Usage: node scripts/create-user.js "Full Name" email@example.com manager|supervisor "password" ["skills"]
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

const [name, email, role, password, skills = ''] = process.argv.slice(2);
if (!name || !email || !['manager', 'supervisor'].includes(role) || !password || password.length < 8) {
  console.error('Usage: node scripts/create-user.js "Full Name" email manager|supervisor "password(8+ chars)" ["skills"]');
  process.exit(1);
}
const id = (role === 'manager' ? 'm' : 's') + crypto.randomBytes(4).toString('hex');
try {
  db.prepare('INSERT INTO users (id,name,role,email,password_hash,skills) VALUES (?,?,?,?,?,?)')
    .run(id, name, role, email.trim().toLowerCase(), bcrypt.hashSync(password, 10), skills);
  console.log(`Created ${role} ${email} (${id})`);
} catch (e) {
  console.error(e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That email already exists.' : e.message);
  process.exit(1);
}
