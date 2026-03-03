const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'dbenergia.db');
const PORT = process.env.PORT || 3003;
const DEVICE_SERVICE_URL = process.env.DEVICE_SERVICE_URL || 'http://localhost:3001';
const POWER_SERVICE_URL = process.env.POWER_SERVICE_URL || 'http://localhost:3002';

const app = express();
app.use(express.json());
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));

const db = new sqlite3.Database(DB_PATH);

function run(dbRun, params=[]) {
  return new Promise((res, rej) => db.run(dbRun, params, function(err){
    if (err) return rej(err); res(this);
  }));
}

function get(dbGet, params=[]) {
  return new Promise((res, rej) => db.get(dbGet, params, (err,row)=>{
    if (err) return rej(err); res(row);
  }));
}

function all(dbAll, params=[]) {
  return new Promise((res, rej) => db.all(dbAll, params, (err,rows)=>{
    if (err) return rej(err); res(rows);
  }));
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS Suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    device_id INTEGER,
    action TEXT NOT NULL,
    status TEXT DEFAULT 'Inviato',
    FOREIGN KEY (device_id) REFERENCES Devices(id)
  )`);
}

async function getRealtimeData() {
  try {
    const res = await fetch(`${POWER_SERVICE_URL}/realtime`);
    return await res.json();
  } catch (e) {
    console.error('Errore realtime:', e.message);
    return { powerlog: {}, devices: [], devices_total_w: 0 };
  }
}

async function applyDeviceStatus(deviceId, status) {
  try {
    const res = await fetch(`${DEVICE_SERVICE_URL}/devices/${deviceId}/status`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({status})
    });
    return await res.json();
  } catch (e) {
    console.error('Errore appliance device status:', e.message);
    return null;
  }
}

// Genera suggerimenti
app.get('/suggestions/generate', async (req,res)=>{
  try {
    const realtimeData = await getRealtimeData();
    const powerlog = realtimeData.powerlog || {};
    const devices = realtimeData.devices || [];
    
    const production = Number(powerlog.production_w || 0);
    const consumption = Number(realtimeData.devices_total_w || 0);
    const delta = production - consumption;
    const inDeficit = delta < 0;

    const suggestions = [];

    async function hasPendingSuggestion(deviceId, action) {
      const s = await get('SELECT id FROM Suggestions WHERE device_id=? AND action=? AND status NOT IN (?,?) LIMIT 1', [deviceId, action, 'Eseguito', 'Rifiutato']);
      return !!s;
    }

    if (inDeficit) {
      let deficitAmount = Math.abs(delta);
      const onDevices = devices
        .filter(d => Number(d.status||0) === 1 && Number(d.is_constant||0) === 0)
        .sort((a,b) => {
          const priorityDiff = Number(b.priority||0) - Number(a.priority||0);
          if (priorityDiff !== 0) return priorityDiff;
          return Number(b.current_w||0) - Number(a.current_w||0);
        });

      for (const d of onDevices) {
        const nominal = Number(d.current_w||0);
        if (!(await hasPendingSuggestion(d.id, 'Spegni'))) {
          const r = await run('INSERT INTO Suggestions (device_id, action, status) VALUES (?,?,?)', [d.id, 'Spegni', 'Inviato']);
          suggestions.push({
            id: r.lastID, 
            device: d.name, 
            action: 'Spegni',
            consumption_w: nominal,
            priority: d.priority
          });
          deficitAmount -= nominal;
          if (deficitAmount <= 0 || suggestions.length >= 3) break;
        }
      }
    }

    res.json({
      production,
      consumption,
      delta,
      inDeficit,
      suggestions
    });
  } catch(e){ res.status(500).json({error: e.message}); }
});

app.get('/suggestions', async (req,res)=>{
  try {
    const rows = await all('SELECT * FROM Suggestions ORDER BY timestamp DESC LIMIT 100');
    res.json(rows);
  } catch(e){ res.status(500).json({error: e.message}); }
});

app.post('/suggestions/:id/apply', async (req,res)=>{
  const id = req.params.id;
  try {
    const s = await get('SELECT * FROM Suggestions WHERE id=?', [id]);
    if (!s) return res.status(404).json({error:'Suggestion not found'});
    if (s.status !== 'Inviato') return res.status(400).json({error:'Suggestion not in Inviato state'});

    if (s.action === 'Spegni') {
      await applyDeviceStatus(s.device_id, 0);
    } else if (s.action === 'Accendi') {
      await applyDeviceStatus(s.device_id, 1);
    }

    await run('UPDATE Suggestions SET status=? WHERE id=?', ['Eseguito', id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error: e.message}); }
});

app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

(async ()=>{
  try { 
    await initDb(); 
    app.listen(PORT, ()=> console.log(`Suggestion Service running on port ${PORT}`)); 
  }
  catch(e){ console.error('Errore init', e); }
})();

module.exports = app;
