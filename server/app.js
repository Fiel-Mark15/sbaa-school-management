import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { assertEnvironment, env } from './config/env.js';
import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import adminRoutes from './routes/admin.routes.js';
import usersRoutes from './routes/users.routes.js';
import academicRoutes from './routes/academic.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import attachmentsRoutes from './routes/attachments.routes.js';
import profilePhotoRoutes from './routes/profile-photo.routes.js';
import gradesRoutes from './routes/grades.routes.js';
import appointmentsRoutes from './routes/appointments.routes.js';
import firmsRoutes from './routes/firms.routes.js';
import aboutRoutes from './routes/about.routes.js';
import acquisitionsRoutes from './routes/acquisitions.routes.js';
import archiveRoutes from './routes/archive.routes.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { startClassReminderScheduler } from './services/class-reminders.js';
import { enforceRequestOrigin } from './middleware/auth.js';
import { pool } from './database/pool.js';
import { requirePagesProxy } from './middleware/pages-proxy.js';
import { assertPrivateStorageReady } from './utils/private-storage.js';

assertEnvironment();
const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(requirePagesProxy);
app.use(helmet()); app.use(cors({ origin: env.clientUrl, credentials: env.sessionTransport === 'cookie' }));
app.use(enforceRequestOrigin);
app.use(express.json({ limit: '100kb' }));
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { await pool.query('SELECT 1'); res.json({ success: true, data: { status: 'ok' } }); }
  catch { res.status(503).json({ success: false, data: { status: 'unavailable' } }); }
});
app.use('/api/admin', adminRoutes);
app.use('/api/account', usersRoutes);
app.use('/api/account/photo', profilePhotoRoutes);
app.use('/api/academic', academicRoutes);
app.use('/api/grades', gradesRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/firms', firmsRoutes);
app.use('/api/about', aboutRoutes);
app.use('/api/acquisitions', acquisitionsRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/schedule-attachments', attachmentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use(notFound); app.use(errorHandler);
let server;
let stopReminders;
try {
  await pool.query('SELECT 1');
  await assertPrivateStorageReady();
  server = app.listen(env.port, process.env.NODE_ENV === 'production' ? '0.0.0.0' : undefined, () => {
    console.log(`SBAA API listening on ${env.port}`);
    if (process.env.RUN_REMINDER_SCHEDULER === 'true' || (process.env.NODE_ENV !== 'production' && process.env.RUN_REMINDER_SCHEDULER !== 'false')) stopReminders = startClassReminderScheduler();
  });
  server.on('error', async error => {
    console.error(error.code === 'EADDRINUSE'
      ? `SBAA API cannot start: port ${env.port} is already in use. Stop the existing portal instance before running npm run dev again.`
      : `SBAA API cannot start: ${error.code || 'listen failed'}.`);
    await pool.end();
    process.exit(1);
  });
} catch (error) {
  console.error(`SBAA API cannot start: dependency check failed (${error.code || 'UNKNOWN'}).`);
  await pool.end();
  process.exitCode = 1;
}
async function shutdown() {
  stopReminders?.();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await pool.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
