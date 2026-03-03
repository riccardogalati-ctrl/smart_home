const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'dbenergia.db');
const PORT = process.env.PORT || 3000;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '9bca8d0ea7286bf112e19f75625b0945';
const LAT = process.env.LAT || '45.46';
const LON = process.env.LON || '9.19';
const IMPIANTO_NOMINALE = Number(process.env.IMPIANTO_NOMINALE) || 3000; // Watt

const app = express();
app.use(express.json());
// Serve static frontend from ../public
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
  await run(`CREATE TABLE IF NOT EXISTS DeviceLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER,
    device_id INTEGER,
    current_watt INTEGER,
    FOREIGN KEY (log_id) REFERENCES PowerLogs(id),
    FOREIGN KEY (device_id) REFERENCES Devices(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS Devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nominal_consumption INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    status INTEGER,
    is_constant INTEGER,
    last_status_change DATETIME
  )`);

  await run(`CREATE TABLE IF NOT EXISTS PowerLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    production_w INTEGER NOT NULL,
    consumption_w INTEGER NOT NULL,
    grid_delta INTEGER NOT NULL,
    weather_id TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS Suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    device_id INTEGER,
    action TEXT NOT NULL,
    status TEXT DEFAULT 'Inviato',
    FOREIGN KEY (device_id) REFERENCES Devices(id)
  )`);
}

function calcolaConsumoReale(device) {
  // Robust handling: coerce numeric-like fields
  if (!device) return 0;
  const status = Number(device.status || 0);
  if (status === 0) return 0; // Spento = 0W

  const nominal = Number(device.nominal_consumption || 0);
  const isConstant = Number(device.is_constant || 0) === 1;

  // Se è un carico costante (es. Frigorifero), consuma sempre il suo nominale
  if (isConstant) return nominal;

  // Se non abbiamo info su quando è stato acceso, restituiamo il nominale
  if (!device.last_status_change) return nominal;

  // Calcoliamo da quanti minuti è acceso
  const oraInizio = new Date(device.last_status_change);
  const oraAttuale = new Date();
  const minutiTrascorsi = (oraAttuale - oraInizio) / (1000 * 60);

  // LOGICA DINAMICA
  if (device.name === 'Lavatrice' || device.name === 'Lavastoviglie') {
      if (minutiTrascorsi <= 20) return nominal; // Scalda l'acqua
      return 200; // Fase di lavaggio/cestello (consumo ridotto)
  }

  if (device.name === 'Forno Elettrico') {
      // Il forno "pulsa": acceso 5 min, spento 5 min per mantenere il calore
      return (Math.floor(minutiTrascorsi / 5) % 2 === 0) ? nominal : 0;
  }

  // Per gli altri, restituisci il nominale
  return nominal;
}

async function getRealSolarProduction() {
  // Sun curve: sunrise 6:00, sunset 18:00 -> peak at 12:00
  const ora = new Date().getHours();
  let sunFactor = 0;
  if (ora >= 6 && ora <= 18) {
    sunFactor = Math.sin((ora - 6) * Math.PI / 12);
  }

  // Try OpenWeather for cloudiness and weather id; if unavailable fallback to deterministic local estimate
  try {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${OPENWEATHER_API_KEY}`);
    const data = await response.json();
    const clouds = (data && data.clouds && typeof data.clouds.all === 'number') ? data.clouds.all : null;
    const weatherId = (data && data.weather && data.weather[0] && data.weather[0].main) ? data.weather[0].main : null;
    if (clouds !== null) {
      const cloudFactor = 1 - (clouds / 100 * 0.7);
      const produzioneReale = IMPIANTO_NOMINALE * sunFactor * cloudFactor;
      return { production_w: Math.max(0, Math.floor(produzioneReale)), weather_id: weatherId };
    }
    if (weatherId) {
      // if we have weather but no cloud percentage, still return a production estimate
      const produzioneReale = IMPIANTO_NOMINALE * sunFactor * 0.6;
      return { production_w: Math.max(0, Math.floor(produzioneReale)), weather_id: weatherId };
    }
  } catch (e) {
    // ignore and use fallback
  }

  // Fallback: small deterministic variation based on minutes to avoid pure randomness
  const minute = new Date().getMinutes();
  const cloudPercFallback = 30 + (minute % 30); // 30-59% cloudiness
  const cloudFactorFallback = 1 - (cloudPercFallback / 100 * 0.7);
  const produzioneReale = IMPIANTO_NOMINALE * sunFactor * cloudFactorFallback;
  return { production_w: Math.max(0, Math.floor(produzioneReale)), weather_id: 'Fallback' };
}

// Simulation step: compute production, device consumptions and persist PowerLogs + DeviceLogs
async function simulateOnce() {
  try {
    const devices = await all('SELECT * FROM Devices');
    const devicesWithCurrent = devices.map(d => ({...d, current_w: calcolaConsumoReale(d)}));
    const consumptionTotal = devicesWithCurrent.reduce((s,d) => s + (Number(d.current_w)||0), 0);

    const prodObj = await getRealSolarProduction();
    const production = (prodObj && typeof prodObj.production_w === 'number') ? prodObj.production_w : Number(prodObj) || 0;
    const weather_id = (prodObj && prodObj.weather_id) ? prodObj.weather_id : null;

    const grid_delta = production - consumptionTotal;

    const r = await run('INSERT INTO PowerLogs (production_w, consumption_w, grid_delta, weather_id) VALUES (?,?,?,?)', [production, consumptionTotal, grid_delta, weather_id]);
    const logId = r.lastID;

    for (const d of devicesWithCurrent) {
      await run('INSERT INTO DeviceLogs (log_id, device_id, current_watt) VALUES (?,?,?)', [logId, d.id, d.current_w]);
    }
  } catch (e) {
    console.error('Simulate error', e.message);
  }
}

// API: init DB
app.get('/init-db', async (req,res)=>{
  try { await initDb(); res.json({ok:true, message:'DB inizializzato'}); }
  catch(e){ res.status(500).json({error: e.message}); }
});

// Devices endpoints
app.post('/devices', async (req,res)=>{
  const {name, nominal_consumption, priority=2, is_constant=0} = req.body;
  try {
    const r = await run('INSERT INTO Devices (name, nominal_consumption, priority, is_constant) VALUES (?,?,?,?)', [name, nominal_consumption, priority, is_constant]);
    res.json({id: r.lastID});
  } catch(e){ res.status(500).json({error: e.message}); }
});

app.get('/devices', async (req,res)=>{
  try { const rows = await all('SELECT * FROM Devices'); res.json(rows); }
  catch(e){ res.status(500).json({error: e.message}); }
});

app.post('/devices/:id/status', async (req,res)=>{
  const id = req.params.id; const {status} = req.body;
  try {
    const now = new Date().toISOString();
    await run('UPDATE Devices SET status=?, last_status_change=? WHERE id=?', [status, now, id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// Power log
app.post('/powerlog', async (req,res)=>{
  const {production_w, consumption_w, weather_id} = req.body;
  try {
    const grid_delta = production_w - consumption_w;
    const r = await run('INSERT INTO PowerLogs (production_w, consumption_w, grid_delta, weather_id) VALUES (?,?,?,?)', [production_w, consumption_w, grid_delta, weather_id]);
    res.json({id: r.lastID});
  } catch(e){ res.status(500).json({error: e.message}); }
});

app.get('/powerlog/latest', async (req,res)=>{
  try { const row = await get('SELECT * FROM PowerLogs ORDER BY timestamp DESC LIMIT 1'); res.json(row); }
  catch(e){ res.status(500).json({error: e.message}); }
});

// Realtime overview
app.get('/realtime', async (req,res)=>{
  try {
    const latest = await get('SELECT * FROM PowerLogs ORDER BY timestamp DESC LIMIT 1');
    const devices = await all('SELECT * FROM Devices');
    const devicesWithCurrent = devices.map(d=> ({...d, current_w: calcolaConsumoReale(d)}));
    const deviceConsumption = devicesWithCurrent.reduce((s,d)=> s + d.current_w, 0);
    res.json({powerlog: latest, devices: devicesWithCurrent, devices_total_w: deviceConsumption});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// PowerLogs history + current weather info
app.get('/powerlog/history', async (req,res)=>{
  try {
    const limit = Number(req.query.limit) || 60;
    const rows = await all('SELECT timestamp, production_w, consumption_w, grid_delta, weather_id FROM PowerLogs ORDER BY timestamp DESC LIMIT ?', [limit]);
    // return in chronological order
    const logs = rows.reverse();

    // Try to fetch current weather details for the UI (only if API key present and not a likely placeholder)
    let weather = null;
    const hasKey = OPENWEATHER_API_KEY && OPENWEATHER_API_KEY.length > 10 && OPENWEATHER_API_KEY !== '9bca8d0ea7286bf112e19f75625b0945';
    if (hasKey) {
      try {
        const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${OPENWEATHER_API_KEY}&units=metric`);
        const data = await response.json();
        if (data && !data.cod) {
          weather = {
            temp: data.main && typeof data.main.temp === 'number' ? data.main.temp : null,
            humidity: data.main && typeof data.main.humidity === 'number' ? data.main.humidity : null,
            city: data.name || null,
            description: data.weather && data.weather[0] && data.weather[0].description ? data.weather[0].description : null,
            icon: data.weather && data.weather[0] && data.weather[0].icon ? data.weather[0].icon : null,
            clouds: data.clouds && typeof data.clouds.all === 'number' ? data.clouds.all : null,
            wind_speed: data.wind && typeof data.wind.speed === 'number' ? data.wind.speed : null,
            source: 'openweather'
          };
        }
      } catch (e) {
        // ignore and fallback below
      }
    }

    // Fallback: if we couldn't fetch detailed weather, try to use latest PowerLogs.weather_id
    if (!weather) {
      try {
        const last = await get('SELECT weather_id, timestamp FROM PowerLogs WHERE weather_id IS NOT NULL ORDER BY timestamp DESC LIMIT 1');
        if (last && last.weather_id) {
          weather = {
            temp: null,
            city: null,
            description: last.weather_id,
            icon: null,
            clouds: null,
            source: 'powerlog'
          };
        }
      } catch (e) {
        // ignore
      }
    }

    // compute simple stats: irradiance estimate, efficiency, predicted 24h production
    const lastProduction = logs.length ? (logs[logs.length-1].production_w || 0) : 0;
    const avgProduction = rows.length ? Math.round(rows.reduce((s,r)=> s + (r.production_w||0),0) / rows.length) : 0;
    const irradiance_wm2 = IMPIANTO_NOMINALE > 0 ? Math.round((lastProduction / IMPIANTO_NOMINALE) * 1000) : null;
    const efficiency_percent = IMPIANTO_NOMINALE > 0 ? Math.round((lastProduction / IMPIANTO_NOMINALE) * 100) : null;
    const predicted24h_kwh = Math.round((avgProduction * 24) / 1000 * 10) / 10; // one decimal

    res.json({logs, weather, stats: { lastProduction, avgProduction, irradiance_wm2, efficiency_percent, predicted24h_kwh }});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Suggestion logic
app.get('/suggestions/generate', async (req,res)=>{
  try {
    // previsione produzione semplice
    const productionPredictedObj = await getRealSolarProduction();
    const productionPredicted = (productionPredictedObj && typeof productionPredictedObj.production_w === 'number') ? productionPredictedObj.production_w : Number(productionPredictedObj) || 0;

    // consumo medio prossima ora (stima): media ultimi 12 logs
    const rows = await all('SELECT consumption_w FROM PowerLogs ORDER BY timestamp DESC LIMIT 12');
    const avgConsumption = rows.length ? Math.round(rows.reduce((s,r)=> s + r.consumption_w,0) / rows.length) : 800;

    // carichiamo dispositivi ordinati per priorità (1 = alta)
    const devices = await all('SELECT * FROM Devices ORDER BY priority ASC');
    const suggestions = [];

    // Evita duplicati: helper per verificare se esiste già suggerimento inviato
    async function hasPendingSuggestion(deviceId, action) {
      const s = await get('SELECT id FROM Suggestions WHERE device_id=? AND action=? AND status=? LIMIT 1', [deviceId, action, 'Inviato']);
      return !!s;
    }

    // Valutiamo scenario: se previsione superiore alla media -> proviamo ad accendere
    if (productionPredicted > avgConsumption) {
      let availableSurplus = productionPredicted - avgConsumption;
      for (const d of devices) {
        const isOn = Number(d.status || 0) === 1;
        const nominal = Number(d.nominal_consumption || 0);
        if (isOn) continue; // già acceso

        // Priorità 1 devices should be suggested when any surplus or explicitly high priority
        const recommendBecausePriority = Number(d.priority) === 1;
        const recommendBecauseFits = availableSurplus >= nominal;

        if ((recommendBecausePriority || recommendBecauseFits) && !(await hasPendingSuggestion(d.id, 'Accendi'))) {
          const r = await run('INSERT INTO Suggestions (device_id, action, status) VALUES (?,?,?)', [d.id, 'Accendi', 'Inviato']);
          suggestions.push({id: r.lastID, device: d.name, action: 'Accendi'});
          // If we used up surplus, decrement
          if (!recommendBecausePriority) availableSurplus -= nominal;
        }
      }
    } else if (productionPredicted < avgConsumption) {
      // Scarsità: suggeriamo di spegnere dispositivi a bassa priorità (3) o grandi carichi
      let deficit = avgConsumption - productionPredicted;
      // consider devices currently ON, order by priority DESC (low priority first) and by nominal desc
      const onDevices = devices.filter(d => Number(d.status||0) === 1).sort((a,b) => (Number(b.priority||0)-Number(a.priority||0)) || (Number(b.nominal_consumption||0)-Number(a.nominal_consumption||0)));
      for (const d of onDevices) {
        const nominal = Number(d.nominal_consumption||0);
        // prefer to suggest turning off priority 3 devices or very large loads
        if ((Number(d.priority) === 3 || nominal > 2000) && !(await hasPendingSuggestion(d.id, 'Spegni'))) {
          const r = await run('INSERT INTO Suggestions (device_id, action, status) VALUES (?,?,?)', [d.id, 'Spegni', 'Inviato']);
          suggestions.push({id: r.lastID, device: d.name, action: 'Spegni'});
          deficit -= nominal;
          if (deficit <= 0) break;
        }
      }
    }

    res.json({productionPredicted, avgConsumption, suggestions});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// List suggestions
app.get('/suggestions', async (req,res)=>{
  try {
    const rows = await all('SELECT s.*, d.name as device_name FROM Suggestions s LEFT JOIN Devices d ON d.id=s.device_id ORDER BY s.timestamp DESC LIMIT 100');
    res.json(rows);
  } catch(e){ res.status(500).json({error: e.message}); }
});

// Update suggestion status manually
app.post('/suggestions/:id/status', async (req,res)=>{
  const id = req.params.id; const {status} = req.body;
  try {
    await run('UPDATE Suggestions SET status=? WHERE id=?', [status, id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// Apply a suggestion: update device state and mark suggestion as Eseguito
app.post('/suggestions/:id/apply', async (req,res)=>{
  const id = req.params.id;
  try {
    const s = await get('SELECT * FROM Suggestions WHERE id=?', [id]);
    if (!s) return res.status(404).json({error:'Suggestion not found'});
    if (s.status !== 'Inviato') return res.status(400).json({error:'Suggestion not in Inviato state'});

    const device = await get('SELECT * FROM Devices WHERE id=?', [s.device_id]);
    if (!device) return res.status(404).json({error:'Device not found'});

    const now = new Date().toISOString();
    if (s.action === 'Accendi') {
      await run('UPDATE Devices SET status=1, last_status_change=? WHERE id=?', [now, device.id]);
    } else if (s.action === 'Spegni') {
      await run('UPDATE Devices SET status=0, last_status_change=? WHERE id=?', [now, device.id]);
    }

    await run('UPDATE Suggestions SET status=? WHERE id=?', ['Eseguito', id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// DeviceLogs endpoint
app.get('/devicelogs', async (req,res)=>{
  try {
    const rows = await all('SELECT dl.*, d.name as device_name, p.timestamp as log_timestamp FROM DeviceLogs dl LEFT JOIN Devices d ON d.id=dl.device_id LEFT JOIN PowerLogs p ON p.id=dl.log_id ORDER BY dl.id DESC LIMIT 200');
    res.json(rows);
  } catch(e){ res.status(500).json({error: e.message}); }
});

// POWERLOG: ottenere righe raw per un intervallo di tempo
app.get('/powerlog/range', async (req,res)=>{
  try {
    const { from, to, lastHours } = req.query;
    let start, end;
    const now = new Date();
    if (lastHours) {
      end = now.toISOString();
      start = new Date(now.getTime() - Number(lastHours) * 3600 * 1000).toISOString();
    } else if (from && to) {
      start = new Date(from).toISOString();
      end = new Date(to).toISOString();
    } else {
      end = now.toISOString();
      start = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    }

    const rows = await all('SELECT * FROM PowerLogs WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC', [start, end]);
    res.json({from: start, to: end, rows});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// POWERLOG: serie aggregata oraria per intervallo (avg production/consumption, sum grid_delta)
app.get('/powerlog/series', async (req,res)=>{
  try {
    const { from, to, lastHours } = req.query;
    let start, end;
    const now = new Date();
    if (lastHours) {
      end = now.toISOString();
      start = new Date(now.getTime() - Number(lastHours) * 3600 * 1000).toISOString();
    } else if (from && to) {
      start = new Date(from).toISOString();
      end = new Date(to).toISOString();
    } else {
      end = now.toISOString();
      start = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    }

    const sql = `SELECT strftime('%Y-%m-%d %H:00:00', timestamp) as bucket,
                        AVG(production_w) as production_avg,
                        AVG(consumption_w) as consumption_avg,
                        SUM(grid_delta) as grid_delta_sum
                 FROM PowerLogs
                 WHERE timestamp BETWEEN ? AND ?
                 GROUP BY bucket
                 ORDER BY bucket ASC`;

    const series = await all(sql, [start, end]);
    res.json({from: start, to: end, series});
  } catch(e){ res.status(500).json({error: e.message}); }
});

app.get('/', (req,res)=> res.sendFile(path.join(publicPath, 'index.html')));

(async ()=>{
  try { await initDb(); app.listen(PORT, ()=> console.log(`Server running on port ${PORT}`)); }
  catch(e){ console.error('Errore init DB', e); }
})();
// Start simulation loop
const SIM_INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS) || 15000; // default 15s
setInterval(() => { simulateOnce(); }, SIM_INTERVAL_MS);

module.exports = app;
