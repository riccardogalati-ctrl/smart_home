async function getRealSolarProduction() {
    const API_KEY = '9bca8d0ea7286bf112e19f75625b0945';
    const LAT = '45.46'; // Esempio: Milano
    const LON = '9.19';
    const impiantoNominale = 3000; // Il tuo impianto da 3kW

    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${API_KEY}`);
    const data = await response.json();

    const clouds = data.clouds.all; // 0 = sereno, 100 = coperto
    const ora = new Date().getHours();

    // 1. Calcoliamo la curva del sole (0 a 1) basata sull'ora (picco alle 13:00)
    // Se è notte (prima delle 6 o dopo le 20) la produzione è 0
    let sunFactor = 0;
    if (ora >= 6 && ora <= 20) {
        // Funzione a campana semplice
        sunFactor = Math.sin((ora - 6) * Math.PI / 14); 
    }

    // 2. Applichiamo l'effetto nuvole (le nuvole riducono la produzione fino al 70%)
    const cloudFactor = 1 - (clouds / 100 * 0.7);

    // 3. Risultato finale in Watt
    const produzioneReale = impiantoNominale * sunFactor * cloudFactor;

    return Math.floor(produzioneReale);
}

module.exports = { getRealSolarProduction };
