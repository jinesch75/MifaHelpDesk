const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

/* ══════════════════════════════════════════
   DEFAULT STATE
══════════════════════════════════════════ */
const DEFAULT_STATE = {
  customCats: { appels: [], emails: [] },   // shared across all workers
  workerData: {
    'Marc S.': { days: {} },
    'Marc P.': { days: {} }
  }
};

/* ══════════════════════════════════════════
   DATABASE  (PostgreSQL on Railway, SQLite locally)
══════════════════════════════════════════ */
let dbGet, dbSet;

async function initDB() {
  if (process.env.DATABASE_URL) {
    /* ── PostgreSQL (Railway) ── */
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id   INTEGER PRIMARY KEY DEFAULT 1,
        data JSONB   NOT NULL
      )
    `);

    const row = await pool.query('SELECT id FROM app_state WHERE id = 1');
    if (row.rows.length === 0) {
      await pool.query(
        'INSERT INTO app_state (id, data) VALUES (1, $1)',
        [DEFAULT_STATE]
      );
    }

    dbGet = async () => {
      const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
      return r.rows[0]?.data ?? JSON.parse(JSON.stringify(DEFAULT_STATE));
    };

    dbSet = async (state) => {
      await pool.query(
        'INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
        [state]
      );
    };

    console.log('🐘 Using PostgreSQL database');
  } else {
    /* ── SQLite (local dev) ── */
    const Database = require('better-sqlite3');
    const dataDir  = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const db = new Database(path.join(dataDir, 'suivi.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id   INTEGER PRIMARY KEY,
        data TEXT    NOT NULL
      )
    `);

    const existing = db.prepare('SELECT id FROM app_state WHERE id = 1').get();
    if (!existing) {
      db.prepare('INSERT INTO app_state (id, data) VALUES (1, ?)')
        .run(JSON.stringify(DEFAULT_STATE));
    }

    dbGet = async () => {
      const r = db.prepare('SELECT data FROM app_state WHERE id = 1').get();
      return r ? JSON.parse(r.data) : JSON.parse(JSON.stringify(DEFAULT_STATE));
    };

    dbSet = async (state) => {
      db.prepare('INSERT OR REPLACE INTO app_state (id, data) VALUES (1, ?)')
        .run(JSON.stringify(state));
    };

    console.log('🗄️  Using SQLite database (./data/suivi.db)');
  }
}

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */
function ensureDay(state, worker, date) {
  if (!state.workerData[worker])
    state.workerData[worker] = { days: {} };
  if (!state.workerData[worker].days[date])
    state.workerData[worker].days[date] = {
      appels: {}, emails: {},
      appels_custom: {}, emails_custom: {}
    };
  return state.workerData[worker].days[date];
}

/* ══════════════════════════════════════════
   START SERVER
══════════════════════════════════════════ */
async function startServer() {
  await initDB();

  /* ── Static files ── */
  app.use(express.static(path.join(__dirname, 'public')));

  /* ── REST: initial load (fallback for slow sockets) ── */
  app.get('/api/state', async (req, res) => {
    try { res.json(await dbGet()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ══════════════════════════════════════════
     SOCKET.IO  — real-time sync
  ══════════════════════════════════════════ */
  io.on('connection', async (socket) => {
    console.log(`🔌 Client connected   [${socket.id}]`);

    /* Send full state to newcomer */
    try {
      socket.emit('state', await dbGet());
    } catch (e) {
      console.error('Error sending initial state:', e);
    }

    /* ── Counter +/- ── */
    socket.on('update_counter', async ({ worker, date, type, catId, isCustom, delta }) => {
      try {
        const state = await dbGet();
        const day   = ensureDay(state, worker, date);
        const key   = isCustom ? type + '_custom' : type;
        if (!day[key]) day[key] = {};
        day[key][catId] = Math.max(0, (day[key][catId] || 0) + delta);
        await dbSet(state);
        io.emit('state', state);           // broadcast to ALL clients
      } catch (e) { console.error('update_counter error:', e); }
    });

    /* ── Add global custom category ── */
    socket.on('add_cat', async ({ type, name }) => {
      try {
        const state = await dbGet();
        if (!state.customCats[type]) state.customCats[type] = [];
        if (!state.customCats[type].includes(name)) {
          state.customCats[type].push(name);
          await dbSet(state);
          io.emit('state', state);
        }
      } catch (e) { console.error('add_cat error:', e); }
    });

    /* ── Delete global custom category ── */
    socket.on('delete_cat', async ({ type, name }) => {
      try {
        const state = await dbGet();
        state.customCats[type] = (state.customCats[type] || []).filter(c => c !== name);
        // Purge from all worker day data
        for (const wn of Object.keys(state.workerData || {})) {
          const w  = state.workerData[wn];
          const ck = type + '_custom';
          for (const d of Object.keys(w.days || {})) {
            if (w.days[d][ck]) delete w.days[d][ck][name];
          }
        }
        await dbSet(state);
        io.emit('state', state);
      } catch (e) { console.error('delete_cat error:', e); }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected [${socket.id}]`);
    });
  });

  /* ── Listen ── */
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 MIFA Suivi running → http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
