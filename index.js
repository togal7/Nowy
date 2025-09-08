const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';
const bot = new Telegraf(TOKEN);

// Dostępne interwały do wyboru:
const intervals = [
  ['1 min', '5 min', '15 min'],
  ['30 min', '1 godz', '4 godz'],
  ['1 dzień', '1 tydzień', '1 miesiąc']
];

// Mapowanie nazwy na kod interwału MEXC
const intervalMap = {
  '1 min': '1m',
  '5 min': '5m',
  '15 min': '15m',
  '30 min': '30m',
  '1 godz': '1h',
  '4 godz': '4h',
  '1 dzień': '1d',
  '1 tydzień': '1w',
  '1 miesiąc': '1M'
};

async function fetchSymbols() {
  try {
    const res = await axios.get('https://api.mexc.com/api/v3/exchangeInfo');
    return res.data.symbols
      .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
      .map(s => s.symbol);
  } catch (err) { return []; }
}

function calculateRSI(closes) {
  if (closes.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchRSI(symbol, interval = '1d') {
  try {
    const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=15`;
    const { data } = await axios.get(url);
    const closes = data.map(c => parseFloat(c[4]));
    return calculateRSI(closes);
  } catch (e) { return null; }
}

async function scanRSI(interval = '1d', chatId) {
  const symbols = await fetchSymbols();
  let oversold = [], overbought = [];
  for (const sym of symbols) {
    const rsi = await fetchRSI(sym, interval);
    if (rsi === null) continue;
    if (rsi < 30) oversold.push({sym, rsi});
    if (rsi > 70) overbought.push({sym, rsi});
  }
  let msg = `📊 _Skan RSI (${interval})_\n\n`;
  if (oversold.length) {
    msg += "🟢 Wyprzedane (RSI<30):\n";
    oversold.slice(0,10).forEach(x => msg+=`• ${x.sym}: ${x.rsi.toFixed(2)}\n`);
  }
  if (overbought.length) {
    msg += "🔴 Wykupione (RSI>70):\n";
    overbought.slice(0,10).forEach(x => msg+=`• ${x.sym}: ${x.rsi.toFixed(2)}\n`);
  }
  if (!oversold.length && !overbought.length) msg += "Brak sygnałów skrajnych RSI.";
  await bot.telegram.sendMessage(chatId, msg, {parse_mode:'Markdown'});
}

// Główna komenda - wybór interwału z klawiatury
bot.start(ctx => {
  ctx.reply(
    "Witaj! Wybierz interwał skanowania RSI:\n(dzienny domyślnie)",
    Markup.keyboard(intervals).oneTime().resize()
  );
});

// Obsługa kliknięcia przycisku interwału
bot.hears(Object.keys(intervalMap), ctx => {
  const intervalText = ctx.message.text;
  const interval = intervalMap[intervalText] || '1d';
  ctx.reply(
    `Skanuję RSI (${intervalText}) dla wszystkich kryptowalut... (może potrwać do minuty, depending on MEXC)`
  );
  scanRSI(interval, ctx.chat.id);
});

// Dodatkowo /rsi i /rsi_interwal (dla kompatybilności)
bot.command('rsi', ctx => {
  ctx.reply('Skanuję RSI dla interwału dziennego (1d)...');
  scanRSI('1d', ctx.chat.id);
});
bot.command('rsi_interwal', ctx => {
  const text = ctx.message.text.split(' ');
  const interval = (text[1]||'1d');
  ctx.reply(`Skanuję RSI (interwał: ${interval})...`);
  scanRSI(interval, ctx.chat.id);
});

bot.launch();
