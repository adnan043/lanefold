// Removes ALL load-test data: workspaces named "LT-%" created by a test account (their boards, lanes, cards,
// chats, messages go with them: ON DELETE CASCADE), then the test accounts (@loadtest.example.com).
//
//   node --env-file=.env tests/load/cleanup.mjs
//
// Local databases only, like seed.mjs.
import {rmSync} from 'node:fs';
import pg from 'pg';

const url = process.env.DATABASE_URL || '';
if (!/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Refusing: DATABASE_URL must be a local database.');

const db = new pg.Client({connectionString: url});
await db.connect();
await db.query('BEGIN');
const test = `SELECT id FROM users WHERE email LIKE '%@loadtest.example.com'`;
const ws = await db.query(`DELETE FROM workspaces WHERE name LIKE 'LT-%' AND created_by IN (${test})`);
const users = await db.query(`DELETE FROM users WHERE email LIKE '%@loadtest.example.com'`);
await db.query('COMMIT');
await db.end();
rmSync(new URL('./.fixtures.json', import.meta.url), {force: true});
console.log(`removed ${ws.rowCount} workspaces and ${users.rowCount} test accounts`);
