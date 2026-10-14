import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

export const pool = mysql.createPool({ ...env.db, waitForConnections: true, connectionLimit: env.dbPoolLimit, queueLimit: 100, connectTimeout: 10000, namedPlaceholders: true });
