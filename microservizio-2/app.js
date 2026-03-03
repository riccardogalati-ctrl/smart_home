// ============================================
// MICROSERVIZIO 2: Power Service
// Calcola produzione solare, registra consumi e produce dati per grafici
// Porta: 3002
// ============================================

const express = require('express');        // Framework HTTP
const fetch = require('node-fetch');        // Fetch API HTTP (chiamate meteo)
const sqlite3 = require('sqlite3').verbose(); // Database SQLite
const path = require('path');               // Manipolazione percorsi file

// ============================================
// CONFIGURAZIONE
// ============================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'dbenergia.db');
const PORT = process.env.PORT || 3002;
// API Key OpenWeather per dati meteo reali (nuvole, temperatura)
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '9bca8d0ea7286bf112e19f75625b0945';
const LAT = process.env.LAT || '45.3593';  // Latitudine (Crema)
const LON = process.env.LON || '9.6779';   // Longitudine (Crema)
const IMPIANTO_NOMINALE = Number(process.env.IMPIANTO_NOMINALE) || 3000; // Potenza picco pannelli (Watt)
// URL del Microservizio 1 per leggere lo stato dei dispositivi
const DEVICE_SERVICE_URL = process.env.DEVICE_SERVICE_URL || 'http://localhost:3001';

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_PATH);

// ============================================
// FUNZIONI HELPER PER QUERY DATABASE
// ============================================
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

// ============================================
// INIZIALIZZAZIONE DATABASE
// Crea le tabelle PowerLogs e DeviceLogs
// ============================================
async function initDb() {
  // Tabella PowerLogs: registra i dati di produzione e consumo ogni N secondi
  // - id: identificativo univoco
  // - timestamp: quando è stato registrato
  // - production_w: Watt prodotti dal pannello solare
  // - consumption_w: Watt consumati da tutti i dispositivi
  // - grid_delta: differenza (positivo=surplus da mandare in rete, negativo=deficit dalla rete)
  // - weather_id: condizione meteo (es. "Clouds", "Clear")
  await run(`CREATE TABLE IF NOT EXISTS PowerLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    production_w INTEGER NOT NULL,
    consumption_w INTEGER NOT NULL,
    grid_delta INTEGER NOT NULL,
    weather_id TEXT
  )`);

  // Tabella DeviceLogs: dettaglio del consumo PER dispositivo in ogni PowerLog
  // Serve per capire quale dispositivo ha consumato quanto in quel momento
  // - id: identificativo univoco
  // - log_id: riferimento al PowerLog (riga di PowerLogs)
  // - device_id: quale dispositivo (riferimento a Devices)
  // - current_watt: consumo di quel dispositivo in quel momento
  await run(`CREATE TABLE IF NOT EXISTS DeviceLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER,
    device_id INTEGER,
    current_watt INTEGER,
    FOREIGN KEY (log_id) REFERENCES PowerLogs(id),
    FOREIGN KEY (device_id) REFERENCES Devices(id)
  )`);
}

// ============================================
// FUNZIONE CHIAVE: Calcola la produzione REALE del pannello solare
// Combina: curva solare (ora del giorno) + dati meteo (nuvolosità)
// ============================================
async function getRealSolarProduction() {
  // Curva solare: il sole sale dalle 6:00, picco a 12:00, tramonto 18:00
  // Utilizziamo una curva sinusoidale per simulare questo
  const ora = new Date().getHours();
  let sunFactor = 0; // 0 = notte, ~1 = mezzogiorno
  if (ora >= 6 && ora <= 18) {
    sunFactor = Math.sin((ora - 6) * Math.PI / 12); // Onda seno da 6 a 18
  }

  try {
    // Chiama OpenWeather API per avere dati reali su nuvolosità e condizioni
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${OPENWEATHER_API_KEY}`);
    const data = await response.json();
    const clouds = (data && data.clouds && typeof data.clouds.all === 'number') ? data.clouds.all : null;
    const weatherId = (data && data.weather && data.weather[0] && data.weather[0].main) ? data.weather[0].main : null;
    
    if (clouds !== null) {
      // Calcola il fattore di riduzione dovuto alle nuvole (0-100%)
      // 70% di riduzione max: con 100% nuvolosità -> 30% della produzione
      const cloudFactor = 1 - (clouds / 100 * 0.7);
      // Produzione = potenza picco * fattore sole * fattore nuvole
      const produzioneReale = IMPIANTO_NOMINALE * sunFactor * cloudFactor;
      return { production_w: Math.max(0, Math.floor(produzioneReale)), weather_id: weatherId };
    }
  } catch (e) {
    // Se l'API meteo fallisce, usiamo un fallback deterministico
  }

  // FALLBACK: API meteo non disponibile
  // Usa variazione deterministica basata sui minuti per evitare randomness puro
  const minute = new Date().getMinutes();
  const cloudPercFallback = 30 + (minute % 30); // 30-59% nuvole simulate
  const cloudFactorFallback = 1 - (cloudPercFallback / 100 * 0.7);
  const produzioneReale = IMPIANTO_NOMINALE * sunFactor * cloudFactorFallback;
  return { production_w: Math.max(0, Math.floor(produzioneReale)), weather_id: 'Fallback' };
}

// ============================================
// Legge lo stato dei dispositivi dal Microservizio 1
// ============================================
async function getDevices() {
  try {
    // Chiama GET /devices su Device Service (Microservizio 1)
    const res = await fetch(`${DEVICE_SERVICE_URL}/devices`);
    return await res.json(); // Ritorna array di dispositivi con current_w calcolato
  } catch (e) {
    console.error('Errore fetchDevices:', e.message);
    return []; // Se fallisce, ritorna lista vuota
  }
}

// ============================================
// LOOP DI SIMULAZIONE: Eseguito ogni N secondi
// Raccoglie dati di produzione e consumo e li salva in PowerLogs
// ============================================
async function simulateOnce() {
  try {
    // 1. Legge lo stato dei dispositivi dal Device Service
    const devices = await getDevices();
    // 2. Somma il consumo totale di tutti i dispositivi (W)
    const consumptionTotal = devices.reduce((s,d) => s + (Number(d.current_w)||0), 0);

    // 3. Calcola la produzione solare attuale
    const prodObj = await getRealSolarProduction();
    const production = (prodObj && typeof prodObj.production_w === 'number') ? prodObj.production_w : 0;
    const weather_id = (prodObj && prodObj.weather_id) ? prodObj.weather_id : null;

    // 4. Calcola il delta (differenza tra produzione e consumo)
    // Positivo = surplus da mandare in rete
    // Negativo = deficit dalla rete
    const grid_delta = production - consumptionTotal;

    // 5. Salva i dati aggregati in PowerLogs
    const r = await run('INSERT INTO PowerLogs (production_w, consumption_w, grid_delta, weather_id) VALUES (?,?,?,?)', [production, consumptionTotal, grid_delta, weather_id]);
    const logId = r.lastID;

    // 6. Salva il dettaglio per ogni dispositivo in DeviceLogs
    for (const d of devices) {
      await run('INSERT INTO DeviceLogs (log_id, device_id, current_watt) VALUES (?,?,?)', [logId, d.id, d.current_w]);
    }
  } catch (e) {
    console.error('Simulate error', e.message);
  }
}

// ============================================
// ENDPOINT 1: GET /realtime
// Ritorna lo stato attuale: produzione, consumo, lista dispositivi
// ============================================
app.get('/realtime', async (req,res)=>{
  try {
    // Legge l'ultimo PowerLog registrato
    const latest = await get('SELECT * FROM PowerLogs ORDER BY timestamp DESC LIMIT 1');
    // Legge lo stato attuale dei dispositivi
    const devices = await getDevices();
    // Calcola il consumo totale
    const deviceConsumption = devices.reduce((s,d)=> s + (Number(d.current_w)||0), 0);
    // Ritorna una vista "istantanea" per il frontend
    res.json({powerlog: latest, devices, devices_total_w: deviceConsumption});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// ============================================
// ENDPOINT 2: GET /powerlog/latest
// Ritorna l'ultima riga di PowerLogs registrata
// Utile per grafici e statistiche
// ============================================
app.get('/powerlog/latest', async (req,res)=>{
  try { 
    const row = await get('SELECT * FROM PowerLogs ORDER BY timestamp DESC LIMIT 1'); 
    res.json(row); 
  }
  catch(e){ res.status(500).json({error: e.message}); }
});

// ============================================
// ENDPOINT 3: GET /powerlog/history
// Ritorna la serie storica di PowerLogs
// Query param: ?limit=N (default 60)
// Usato per tracciare il grafico di produzione vs consumo
// ============================================
app.get('/powerlog/history', async (req,res)=>{
  try {
    // Legge gli ultimi N PowerLog (default ultimi 60)
    const limit = Number(req.query.limit) || 60;
    const rows = await all('SELECT timestamp, production_w, consumption_w, grid_delta, weather_id FROM PowerLogs ORDER BY timestamp DESC LIMIT ?', [limit]);
    // Inverte l'ordine per ottenere cronologico (dal più vecchio al più nuovo)
    const logs = rows.reverse();
    res.json({logs});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// ============================================
// ENDPOINT HEALTH CHECK
// Verifica che il servizio sia attivo
// ============================================
app.get('/', (req, res) => res.json({service: 'Power Service', status: 'running'}));

// ============================================
// AVVIO DEL MICROSERVIZIO
// ============================================
(async ()=>{
  try { 
    await initDb();  // Inizializza il database (crea tabelle se non esistono)
    // Avvia il server su PORT (default 3002)
    app.listen(PORT, ()=> console.log(`Power Service running on port ${PORT}`)); 
  }
  catch(e){ console.error('Errore init', e); }
})();

// ============================================
// LOOP DI SIMULAZIONE
// Esegue simulateOnce() ogni N millisecondi (default 15 secondi)
// Questo popola PowerLogs e DeviceLogs periodicamente
// ============================================
const SIM_INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS) || 15000;
setInterval(() => { simulateOnce(); }, SIM_INTERVAL_MS);

module.exports = app;
