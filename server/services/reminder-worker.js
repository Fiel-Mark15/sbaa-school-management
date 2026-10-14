import { assertEnvironment } from '../config/env.js';
import { pool } from '../database/pool.js';
import { startClassReminderScheduler } from './class-reminders.js';

assertEnvironment();
const stop = startClassReminderScheduler({ keepAlive: true });
console.log('SBAA class reminder worker running.');
async function shutdown() {
  stop();
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
