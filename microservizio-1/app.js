// ============================================
// MICROSERVIZIO 1: Device Service
// Gestione dei dispositivi della casa (CRUD, accensione/spegnimento)
// Porta: 3001
// ============================================

const express = require('express');        // Framework HTTP
const sqlite3 = require('sqlite3').verbose(); // Database SQLite
const path = require('path');               // Manipolazione percorsi file

// Configurazione
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'dbenergia.db');
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json()); // Parser JSON per i body delle richieste

const db = new sqlite3.Database(DB_PATH);

// ============================================
// FUNZIONI HELPER PER QUERY DATABASE
// Trasformano il callback async di SQLite in Promise
// ============================================

// Esegue INSERT/UPDATE/DELETE e ritorna info sulla riga
function run(dbRun, params=[]) {
  return new Promise((res, rej) => db.run(dbRun, params, function(err){
    if (err) return rej(err); res(this); // 'this' contiene lastID
  }));
}

// Esegue SELECT e ritorna UNA riga (primo risultato)
function get(dbGet, params=[]) {
  return new Promise((res, rej) => db.get(dbGet, params, (err,row)=>{
    if (err) return rej(err); res(row);
  }));
}

// Esegue SELECT e ritorna TUTTE le righe matching
function all(dbAll, params=[]) {
  return new Promise((res, rej) => db.all(dbAll, params, (err,rows)=>{
    if (err) return rej(err); res(rows);
  }));
}

async function initDb() {
  // Crea la tabella Devices se non esiste già
  // Colonne:
  // - id: identificativo univoco
  // - name: nome dispositivo (es. "Lavatrice")
  // - nominal_consumption: consumo nominale in Watt (es. 2000)
  // - priority: priorità (1=alta, 2=media, 3=bassa) - utile per spegnere dispositivi meno importanti
  // - status: 0=spento, 1=acceso
  // - is_constant: 1=consumo costante (es. frigo), 0=consumo variabile (es. lavatrice)
  // - last_status_change: timestamp ultimo cambio di stato
  await run(`CREATE TABLE IF NOT EXISTS Devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nominal_consumption INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    status INTEGER,
    is_constant INTEGER,
    last_status_change DATETIME
  )`);
}

// ============================================
// FUNZIONE CHIAVE: Calcola il consumo REALE del dispositivo
// Non è sempre il consumo nominale - varia nel tempo a seconda del ciclo
// ============================================
function calcolaConsumoReale(device) {
  if (!device) return 0;
  const status = Number(device.status || 0);
  // Se spento, ritorna 0W
  if (status === 0) return 0;

  const nominal = Number(device.nominal_consumption || 0);
  const isConstant = Number(device.is_constant || 0) === 1;

  // Se è un carico costante (es. frigorifero), consuma sempre il nominale
  if (isConstant) return nominal;
  // Se non abbiamo info su quando è stato acceso, ritorna il nominale
  if (!device.last_status_change) return nominal;

  // Calcola quanti minuti sono passati dal primo accensione
  const oraInizio = new Date(device.last_status_change);
  const oraAttuale = new Date();
  const minutiTrascorsi = (oraAttuale - oraInizio) / (1000 * 60);

  // Logica speciale per Lavatrice/Lavastoviglie:
  // Primi 20 minuti = fase di riscaldamento (consumo alto)
  // Dopo 20 minuti = fase di centrifuga/scarico (consumo basso = 200W)
  if (device.name === 'Lavatrice' || device.name === 'Lavastoviglie') {
      if (minutiTrascorsi <= 20) return nominal;
      return 200;
  }

  // Logica per Forno Elettrico: "pulsa" (acceso/spento a intervalli)
  // Si accende per 5 minuti, si spegne per 5 minuti, per mantenere il calore
  if (device.name === 'Forno Elettrico') {
      return (Math.floor(minutiTrascorsi / 5) % 2 === 0) ? nominal : 0;
  }

  // Per altri dispositivi, ritorna il nominale
  return nominal;
}

// ============================================
// ENDPOINT 1: POST /devices
// Crea un nuovo dispositivo
// Body: { name, nominal_consumption, priority, is_constant }
// Response: { id: numero_dispositivo }
// ============================================
app.post('/devices', async (req,res)=>{
  const {name, nominal_consumption, priority=2, is_constant=0} = req.body;
  try {
    // Inserisce la riga nella tabella Devices
    const r = await run('INSERT INTO Devices (name, nominal_consumption, priority, is_constant) VALUES (?,?,?,?)', [name, nominal_consumption, priority, is_constant]);
    res.json({id: r.lastID}); // Ritorna l'ID generato
  } catch(e){ res.status(500).json({error: e.message}); }
});

// ============================================
// ENDPOINT 2: GET /devices
// Elenca TUTTI i dispositivi con il loro consumo REALE attuale
// Response: [ { id, name, status, current_w, ... }, ... ]
// ============================================
app.get('/devices', async (req,res)=>{
  try { 
    const rows = await all('SELECT * FROM Devices');
    // Aggiunge il campo 'current_w' a ogni dispositivo calcolando il consumo reale
    const withCurrent = rows.map(d => ({...d, current_w: calcolaConsumoReale(d)}));
    res.json(withCurrent); 
  }
  catch(e){ res.status(500).json({error: e.message}); }
});

// ============================================
// ENDPOINT 3: POST /devices/:id/status
// Accende o spegne un dispositivo
// Body: { status: 0 o 1 }
// Side-effect: registra il timestamp di cambio stato in 'last_status_change'
// Response: { ok: true }
// ============================================
app.post('/devices/:id/status', async (req,res)=>{
  const id = req.params.id;  // ID del dispositivo da ID_URL
  const {status} = req.body; // 0=spento, 1=acceso
  try {
    const now = new Date().toISOString(); // Timestamp ISO per la BD
    // Aggiorna lo stato del dispositivo E registra quando è stato cambiato
    await run('UPDATE Devices SET status=?, last_status_change=? WHERE id=?', [status, now, id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error: e.message}); }
});

// ============================================
// ENDPOINT HEALTH CHECK
// Verifica che il servizio sia attivo
// ============================================
app.get('/', (req, res) => res.json({service: 'Device Service', status: 'running'}));

// ============================================
// AVVIO DEL MICROSERVIZIO
// ============================================
(async ()=>{
  try { 
    await initDb();  // Inizializza il database (crea tabella Devices se non esiste)
    // Avvia il server su PORT (default 3001)
    app.listen(PORT, ()=> console.log(`Device Service running on port ${PORT}`)); 
  }
  catch(e){ console.error('Errore init', e); }
})();

module.exports = app;
