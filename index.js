const { Telegraf } = require('telegraf');
const axios = require('axios');

// Twój token API bota z BotFather:
const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';

const bot = new Telegraf(TOKEN);

// Pobiera listę symboli z MEXC (USDT)
async function fetchSymbols() {
    const res = await axios.get('https://api.mexc.com/api/v3/exchangeInfo');
    return res.data.symbols
      .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
      .map(s => s.symbol);
}

// Pobiera kline i liczy RSI dla symbolu i interwału
async function fetchRSI(symbol, interval = '1d') {
    const limit = 15;
    const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const { data } = await axios.get(url);
    if (!data || data.length < 15) return null;
    const closes = data.map(k => parseFloat(k[4]));
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Przeszukuje RSI dla wszystkich symboli na zadanym interwale
async function scanRSI(interv = '1d', chatId) {
    try {
        const symbols = await fetchSymbols();
        let oversold = [];
        let overbought = [];
        for (const sym of symbols) {
            try {
                const rsi = await fetchRSI(sym, interv);
                if (!rsi) continue;
                if (rsi < 30) oversold.push({sym, rsi});
                if (rsi > 70) overbought.push({sym, rsi});
            } catch (e) {}
        }
        let msg = `📊 _Krypto: Skan RSI (${interv})_\n\n`;
        if (oversold.length) {
            msg += `🟢 Wyprzedane (RSI<30):\n`;
            oversold.slice(0,10).forEach(x => {
                msg += `• ${x.sym}: ${x.rsi.toFixed(2)}\n`;
            });
        }
        if (overbought.length) {
            msg += `🔴 Wykupione (RSI>70):\n`;
            overbought.slice(0,10).forEach(x => {
                msg += `• ${x.sym}: ${x.rsi.toFixed(2)}\n`;
            });
        }
        if (!oversold.length && !overbought.length)
            msg += "Brak sygnałów skrajnych RSI";
        await bot.telegram.sendMessage(chatId, msg, {parse_mode: 'Markdown'});
    } catch (err) { }
}

bot.start((ctx) => ctx.reply(
    "Witaj! Bot RSI działa.\n" +
    "Użyj: /rsi (domyślnie 1d) lub /rsi_interwal 1h/1m/4h/1w/1M by sprawdzić inne interwały."
));

bot.command('rsi', async (ctx) => {
    ctx.reply('Skanuję RSI dla wszystkich kryptowalut (1d)...');
    await scanRSI('1d', ctx.chat.id);
});

bot.command('rsi_interwal', async (ctx) => {
    const text = ctx.message.text.split(' ');
    const interval = (text[1]||'1d');
    ctx.reply(`Skanuję RSI (interwał: ${interval})...`);
    await scanRSI(interval, ctx.chat.id);
});

// Automatycznie wysyłaj sygnały RSI co 60 minut do czatu
setInterval(() => {
    // Jeśli chcesz automatyczne alerty do siebie, wpisz swoje chat_id tutaj:
    const myChatId = null; // Opcjonalnie: Twoje ID z botem! 
    if (myChatId) scanRSI('1d', myChatId);
}, 60 * 60 * 1000);

bot.launch();
