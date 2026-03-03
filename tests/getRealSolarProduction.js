async function getRealSolarProduction() {
    const API_KEY = '9bca8d0ea7286bf112e19f75625b0945';
    const LAT = '45.46'; // Esempio: Milano
    const LON = '9.19';
    const impiantoNominale = 3000; // Il tuo impianto da 3kW

    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${API_KEY}`);
    const data = await response.json();

    const clouds = data.clouds.all; // 0 = sereno, 100 = coperto
    const ora = new Date().getHours();

    let sunFactor = 0;
    if (ora >= 6 && ora <= 20) {
        sunFactor = Math.sin((ora - 6) * Math.PI / 14); 
    }

    const cloudFactor = 1 - (clouds / 100 * 0.7);

    const produzioneReale = impiantoNominale * sunFactor * cloudFactor;

    return Math.floor(produzioneReale);
}

module.exports = { getRealSolarProduction };
