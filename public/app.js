let powerChart = null;

async function fetchRealtime(){
  try{
    const res = await fetch('/realtime');
    const data = await res.json();
    const p = data.powerlog || {};
    // show production/consumption numbers
    document.getElementById('production').textContent = (p.production_w != null) ? `${p.production_w} W` : '—';
    document.getElementById('consumption').textContent = (data.devices_total_w != null) ? `${data.devices_total_w} W` : '—';
    document.getElementById('grid_delta').textContent = (p.grid_delta != null) ? `${p.grid_delta} W` : '—';

    // Active devices (left pane)
    const activeDiv = document.getElementById('activeDevices');
    activeDiv.innerHTML = '';
    const onDevices = (data.devices || []).filter(d => Number(d.status||0) === 1);
    if (onDevices.length === 0) activeDiv.textContent = 'Nessun dispositivo acceso';
    onDevices.forEach(d => {
      const el = document.createElement('div');
      el.className = 'flex items-center justify-between p-2 bg-blue-50 rounded text-sm';
      el.innerHTML = `<div><div class="font-medium">${d.name}</div><div class="text-xs text-gray-500">${d.current_w} W</div></div><div class="text-sm text-gray-700">${d.current_w} W</div>`;
      activeDiv.appendChild(el);
    });

    // Devices control (right pane)
    const ctrl = document.getElementById('devicesControl');
    ctrl.innerHTML = '';
    (data.devices || []).forEach(d => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-2 border rounded text-sm';
      const left = document.createElement('div');
      left.innerHTML = `<div class="font-medium">${d.name}</div><div class="text-xs text-gray-500">${d.is_constant==1? 'Costante' : 'Elettrodomestico'} • ${d.current_w} W</div>`;
      const right = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Number(d.status||0) === 1;
      input.className = 'toggle';
      input.onchange = async () => {
        const newStatus = input.checked ? 1 : 0;
        input.disabled = true;
        await fetch(`/devices/${d.id}/status`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status:newStatus})});
        await fetchRealtime();
        input.disabled = false;
      };
      right.appendChild(input);
      row.appendChild(left);
      row.appendChild(right);
      ctrl.appendChild(row);
    });

    // total label
    const totalLabel = document.getElementById('totalLabel');
    if (totalLabel) totalLabel.textContent = `${data.devices_total_w || 0} W`;
  }catch(e){ console.error('fetchRealtime', e); }
}

function initChart(labels, productionData, consumptionData){
  const ctx = document.getElementById('powerChart').getContext('2d');
  powerChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Produzione (kW)', data: productionData, borderColor: 'rgb(34,197,94)', backgroundColor: 'rgba(34,197,94,0.18)', tension: 0.2, fill: true },
        { label: 'Consumo (kW)', data: consumptionData, borderColor: 'rgb(249,115,22)', backgroundColor: 'rgba(249,115,22,0.18)', tension: 0.2, fill: true }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      stacked: false,
      scales: { x: { display: true }, y: { beginAtZero: true, title: { display: true, text: 'kW' } } }
    }
  });
}

async function fetchHistory(){
  try{
    const res = await fetch('/powerlog/history?limit=60');
    const data = await res.json();
    const logs = data.logs || [];
    const labels = logs.map(l => new Date(l.timestamp).toLocaleTimeString());
    // convert W -> kW for chart readability
    const prod = logs.map(l => parseFloat(((l.production_w||0)/1000).toFixed(2)));
    const cons = logs.map(l => parseFloat(((l.consumption_w||0)/1000).toFixed(2)));

    if (!powerChart) initChart(labels, prod, cons);
    else {
      powerChart.data.labels = labels;
      powerChart.data.datasets[0].data = prod;
      powerChart.data.datasets[1].data = cons;
      powerChart.update();
    }

    // update weather box and stats
    const weather = data.weather;
    const stats = data.stats || {};
    const wb = document.getElementById('weatherBox');
    if (weather || stats) {
      const iconUrl = weather && weather.icon ? `https://openweathermap.org/img/wn/${weather.icon}@2x.png` : '';
      const sourceLabel = weather && weather.source === 'openweather' ? ' (OpenWeather)' : weather && weather.source === 'powerlog' ? ' (last log)' : '';

      const humidity = weather && weather.humidity!=null ? `${weather.humidity}%` : '—';
      const wind = weather && weather.wind_speed!=null ? `${weather.wind_speed} m/s` : '—';
      // show cloud percentage only if available; do not duplicate description
      const clouds = (weather && typeof weather.clouds === 'number') ? `${weather.clouds}%` : '—';
      const description = weather && weather.description ? weather.description : '—';
      const irradiance = stats && stats.irradiance_wm2 != null ? `${stats.irradiance_wm2} W/m²` : '—';
      const efficiency = stats && stats.efficiency_percent != null ? `${stats.efficiency_percent}%` : '—';
      const predicted = stats && stats.predicted24h_kwh != null ? `${stats.predicted24h_kwh} kWh` : '—';

      wb.innerHTML = `
        <div class="flex items-start">
          <div class="mr-3">${iconUrl ? `<img src="${iconUrl}" alt="meteo" class="w-14 h-14"/>` : '<div class="w-14 h-14 bg-gray-100 rounded"></div>'}</div>
          <div class="flex-1">
            <div class="text-lg font-semibold">${weather && weather.temp!=null ? weather.temp+'°C' : '—'}</div>
            <div class="text-sm text-gray-600">${weather && weather.city ? weather.city + sourceLabel : '—'}</div>
            <div class="mt-2 text-sm text-gray-700">${description}</div>
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-600">
              <div><strong>Umidità:</strong> ${humidity}</div>
              <div><strong>Vento:</strong> ${wind}</div>
              <div><strong>Nuvolosità:</strong> ${clouds}</div>
              <div><strong>Irradianza:</strong> ${irradiance}</div>
            </div>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-1 gap-2">
          <div class="bg-green-50 p-2 rounded text-green-700 font-semibold">Efficienza: <span class="font-bold">${efficiency}</span></div>
          <div class="bg-blue-50 p-2 rounded text-blue-700 font-semibold">Previsto 24h: <span class="font-bold">${predicted}</span></div>
        </div>
      `;
    } else {
      wb.textContent = 'Meteo non disponibile';
    }
  }catch(e){ console.error('fetchHistory', e); }
}

// Suggestions
// Automatic suggestions: fetch periodically and render minimal list
async function autoGenerateSuggestions(){
  try{
    const res = await fetch('/suggestions/generate');
    const data = await res.json();
    const box = document.getElementById('suggestions');
    if (!box) return;

    // Se in deficit
    if (data.inDeficit) {
      const deficit = Math.abs(data.delta);
      box.innerHTML = `
        <div class="bg-red-50 border-l-4 border-red-500 p-3 mb-3">
          <div class="flex items-center mb-2">
            <div class="w-2 h-2 bg-red-500 rounded-full animate-pulse mr-2"></div>
            <div class="font-bold text-red-700">⚠️ DEFICIT ENERGETICO</div>
          </div>
          <div class="text-sm text-red-600 mb-2">
            Stai consumando <strong>${deficit}W</strong> più di quello che produci
          </div>
          <div class="text-xs text-red-600">
            Produzione: <strong>${data.production}W</strong> | Consumo: <strong>${data.consumption}W</strong>
          </div>
        </div>
      `;

      // Mostra suggerimenti di spegnimento
      if (data.suggestions && data.suggestions.length) {
        const suggestionsHtml = data.suggestions.map(s => `
          <div class="bg-yellow-50 border border-yellow-200 p-2 mb-2 rounded">
            <div class="flex items-center justify-between mb-2">
              <div>
                <div class="font-semibold text-yellow-800">🔌 ${s.device}</div>
                <div class="text-xs text-yellow-700">Consumo: ${s.consumption_w}W</div>
              </div>
              <button onclick="applySuggestion(${s.id})" class="bg-yellow-600 hover:bg-yellow-700 text-white px-2 py-1 rounded text-xs font-medium transition">
                Spegni
              </button>
            </div>
          </div>
        `).join('');
        box.innerHTML += suggestionsHtml;
      } else {
        box.innerHTML += '<div class="text-xs text-gray-600 mt-2">Nessun dispositivo può essere spento.</div>';
      }
    } else if (data.delta > 500) {
      // Surplus energetico
      box.innerHTML = `
        <div class="bg-green-50 border-l-4 border-green-500 p-3 mb-3">
          <div class="flex items-center mb-2">
            <div class="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
            <div class="font-bold text-green-700">✓ SURPLUS ENERGETICO</div>
          </div>
          <div class="text-sm text-green-700">
            Hai un surplus di <strong>${data.delta}W</strong>
          </div>
        </div>
      `;

      if (data.suggestions && data.suggestions.length) {
        const suggestionsHtml = data.suggestions.map(s => `
          <div class="bg-blue-50 border border-blue-200 p-2 mb-2 rounded">
            <div class="flex items-center justify-between mb-2">
              <div>
                <div class="font-semibold text-blue-800">💡 ${s.device}</div>
                <div class="text-xs text-blue-700">Consumo: ${s.consumption_w}W</div>
              </div>
              <button onclick="applySuggestion(${s.id})" class="bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded text-xs font-medium transition">
                Accendi
              </button>
            </div>
          </div>
        `).join('');
        box.innerHTML += suggestionsHtml;
      } else {
        box.innerHTML += '<div class="text-xs text-gray-600 mt-2">Tutti i dispositivi prioritari sono accesi.</div>';
      }
    } else {
      // Tutto ok
      box.innerHTML = `
        <div class="bg-blue-50 border-l-4 border-blue-500 p-3">
          <div class="flex items-center">
            <div class="w-2 h-2 bg-blue-500 rounded-full mr-2"></div>
            <div class="font-semibold text-blue-700">Situazione equilibrata</div>
          </div>
          <div class="text-sm text-blue-600 mt-2">
            Produzione: <strong>${data.production}W</strong> | Consumo: <strong>${data.consumption}W</strong>
          </div>
        </div>
      `;
    }
  }catch(e){ console.error('autoGenerateSuggestions', e); }
}

// Applica un suggerimento: chiama l'API per eseguirlo
async function applySuggestion(suggestionId) {
  try {
    const res = await fetch(`/suggestions/${suggestionId}/apply`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    if (res.ok) {
      console.log('Suggerimento applicato:', suggestionId);
      // Aggiorna la visualizzazione
      await new Promise(r => setTimeout(r, 300));
      await fetchRealtime();
      await autoGenerateSuggestions();
    }
  } catch(e) {
    console.error('Errore applicando suggerimento', e);
  }
}

// Polling
fetchRealtime();
fetchHistory();
setInterval(fetchRealtime, 5000);
setInterval(fetchHistory, 10000);
// auto suggestions every 10s (più veloce)
autoGenerateSuggestions();
setInterval(autoGenerateSuggestions, 10000);
