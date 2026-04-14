const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const DEFAULT_STATE = { days: {} };

let dbGet, dbSet;

async function initDB() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY DEFAULT 1, data JSONB NOT NULL)');
    const row = await pool.query('SELECT id FROM app_state WHERE id = 1');
    if (row.rows.length === 0) await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [DEFAULT_STATE]);
    dbGet = async () => { const r = await pool.query('SELECT data FROM app_state WHERE id = 1'); return r.rows[0]?.data ?? JSON.parse(JSON.stringify(DEFAULT_STATE)); };
    dbSet = async (state) => { await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [state]); };
    console.log('🐘 Using PostgreSQL database');
  } else {
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'suivi.db'));
    db.exec('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    if (!db.prepare('SELECT id FROM app_state WHERE id = 1').get())
      db.prepare('INSERT INTO app_state (id, data) VALUES (1, ?)').run(JSON.stringify(DEFAULT_STATE));
    dbGet = async () => { const r = db.prepare('SELECT data FROM app_state WHERE id = 1').get(); return r ? JSON.parse(r.data) : JSON.parse(JSON.stringify(DEFAULT_STATE)); };
    dbSet = async (state) => { db.prepare('INSERT OR REPLACE INTO app_state (id, data) VALUES (1, ?)').run(JSON.stringify(state)); };
    console.log('🗄️  Using SQLite database (./data/suivi.db)');
  }
}

function ensureDay(state, date) {
  if (!state.days) state.days = {};
  if (!state.days[date]) state.days[date] = { calls: [], emails: [] };
  return state.days[date];
}

async function startServer() {
  await initDB();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/api/state', async (req, res) => { try { res.json(await dbGet()); } catch (e) { res.status(500).json({ error: e.message }); } });

  io.on('connection', async (socket) => {
    console.log(`🔌 Client connected   [${socket.id}]`);
    try { socket.emit('state', await dbGet()); } catch (e) { console.error('Error sending initial state:', e); }

    socket.on('add_entry', async ({ date, type, entry }) => {
      try {
        const state = await dbGet();
        const day = ensureDay(state, date);
        if (!day[type]) day[type] = [];
        day[type].push(entry);
        await dbSet(state);
        io.emit('state', state);
      } catch (e) { console.error('add_entry error:', e); }
    });

    socket.on('delete_entry', async ({ date, type, entryId }) => {
      try {
        const state = await dbGet();
        const day = ensureDay(state, date);
        if (day[type]) day[type] = day[type].filter(e => e.id !== entryId);
        await dbSet(state);
        io.emit('state', state);
      } catch (e) { console.error('delete_entry error:', e); }
    });

    socket.on('disconnect', () => { console.log(`🔌 Client disconnected [${socket.id}]`); });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => { console.log(`🚀 MIFA Suivi running → http://localhost:${PORT}`); });
}

startServer().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
