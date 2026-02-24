const { getRealSolarProduction } = require('./test');

function computeExpected(hour, clouds) {
    const impiantoNominale = 3000;
    let sunFactor = 0;
    if (hour >= 6 && hour <= 20) {
        sunFactor = Math.sin((hour - 6) * Math.PI / 14);
    }
    const cloudFactor = 1 - (clouds / 100 * 0.7);
    return Math.floor(impiantoNominale * sunFactor * cloudFactor);
}

async function runCase(name, hour, clouds) {
    const originalFetch = global.fetch;
    const originalGetHours = Date.prototype.getHours;
    let lastFetchUrl = null;
    global.fetch = async (url) => {
        lastFetchUrl = url;
        return { json: async () => ({ clouds: { all: clouds } }) };
    };
    Date.prototype.getHours = function () { return hour; };

    try {
        const result = await getRealSolarProduction();
        const expected = computeExpected(hour, clouds);
        const ok = result === expected;
        const fetchCalled = !!lastFetchUrl;
        const fetchUrlOk = fetchCalled &&
            lastFetchUrl.includes('openweathermap.org') &&
            lastFetchUrl.includes('lat=45.46') &&
            lastFetchUrl.includes('lon=9.19') &&
            lastFetchUrl.includes('appid=');
        console.log(`${name}: hour=${hour}, clouds=${clouds}% -> result=${result} expected=${expected} ${ok ? '✓' : '✗'} | fetchCalled=${fetchCalled} fetchUrlOk=${fetchUrlOk}`);
        return ok && fetchUrlOk;
    } catch (err) {
        console.error(`${name}: ERROR`, err);
        return false;
    } finally {
        global.fetch = originalFetch;
        Date.prototype.getHours = originalGetHours;
    }
}

async function runAll() {
    const cases = [
        ['Noon clear', 13, 0], // peak sun
        ['Noon half clouds', 13, 50],
        ['Night', 2, 0],
        ['Morning', 9, 30],
        ['Edge 6', 6, 0],
        ['Edge 20', 20, 0]
    ];

    let passed = 0;
    for (const [name, hour, clouds] of cases) {
        if (await runCase(name, hour, clouds)) passed++;
    }

    console.log(`\nPassed ${passed}/${cases.length} tests.`);
}

runAll().catch(err => console.error(err));
