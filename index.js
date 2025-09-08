const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// Klucze do MEXC
const MEXC_API_KEY = 'mx0vgl8IDqxNwtPobJ';
const MEXC_API_SECRET = '20004e6ab5ba431d9f80850f54feff4d';
const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';
const bot = new Telegraf(TOKEN);

// Mapowanie krótkich nazw do endpointów i interwałów
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

// Dostępne progi RSI do wyboru
const rsiThresholds = [
  [{ text: '90/10', callback_data: 'rsi_90_10' }, { text: '80/20', callback_data: 'rsi_80_20' }],
  [{ text: '70/30', callback_data: 'rsi_70_30' }], // klasyczny
];

// Interwały jako keyboard
const intervalKeyboard = [
  ['1 min', '5 min', '15 min'],
  ['30 min', '1 godz', '4 godz'],
  ['1 dzień', '1 tydzień', '1 miesiąc']
];

// Pobierz symbole futures USDT
async function fetchFuturesSymbols() {
  const res = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
  // Bierzemy tylko USDT-M
  return res.data.data.filter(s => s.quoteCoin === 'USDT').map(s => s.symbol);
}

// RSI z klucza
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

// Pobiera świece (candlestick) z MEXC Futures
async function fetchFuturesRSI(symbol, interval = '1h') {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=15`;
  const { data } = await axios.get(url);
  if (!data.data || data.data.length < 15) return null;
  const closes = data.data.map(k => parseFloat(k[4])); // [open,high,low,close,volume,timestamp]
  return calculateRSI(closes);
}

// Główna funkcja skanowania z możliwością wyboru progu
async function scanFuturesRSI(interval = '1h', thresholds = { overbought: 70, oversold: 30 }, chatId) {
  const symbols = await fetchFuturesSymbols();
  let oversold = [], overbought = [];
  for (const sym of symbols) {
    const rsi = await fetchFuturesRSI(sym, interval);
    if (rsi === null) continue;
    if (rsi < thresholds.oversold) oversold.push({ sym, rsi });
    if (rsi > thresholds.overbought) overbought.push({ sym, rsi });
  }
  let msg = `📊 _Skan RSI Futures (${interval})_\nUstawienia: Wyprzedane <${thresholds.oversold}, wykupione >${thresholds.overbought}\n\n`;
  if (oversold.length) {
    msg += `🟢 Wyprzedane (RSI<${thresholds.oversold}):\n`;
    oversold.slice(0,10).forEach(x => msg+=`• ${x.sym}: ${x.rsi.toFixed(2)}\n`);
  }
  if (overbought.length) {
    msg += `🔴 Wykupione (RSI>${thresholds.overbought}):\n`;
    overbought.slice(0,10).forEach(x => msg+=`• ${x.sym}: ${x.rsi.toFixed(2)}\n`);
  }
  if (!oversold.length && !overbought.length) msg += "Brak sygnałów!";
  await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// Rozpocznij – wybierz interwał i próg!
bot.start(ctx => {
  ctx.reply(
    "Witaj! Wybierz interwał oraz próg RSI:",
    Markup.keyboard(intervalKeyboard).oneTime().resize()
  );
  ctx.reply(
    "Wybierz układ progów RSI:",
    Markup.inlineKeyboard(rsiThresholds)
  );
});

// Przechowuj ostatnią konfigurację użytkownika (pobierz do lepszej wersji – tutaj prosto)
let userConfig = {};
bot.hears(Object.keys(intervalMap), ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = intervalMap[ctx.message.text] || '1h';
  ctx.reply('Wybrano interwał: ' + ctx.message.text + '. Teraz wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

bot.action(/rsi_(\d+)_(\d+)/, ctx => {
  const over = parseInt(ctx.match[1]);
  const under = parseInt(ctx.match[2]);
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].overbought = over;
  userConfig[ctx.chat.id].oversold = under;
  const interval = userConfig[ctx.chat.id].interval || '1h';
  ctx.reply(`Skanuję Futures RSI dla progu >${over} / <${under}, interwał: ${interval}...`);
  scanFuturesRSI(interval, { overbought: over, oversold: under }, ctx.chat.id);
});

// Komenda tekstowa – zaawansowani
bot.command('futures', ctx => {
  // /futures 1h 90 10
  const p = ctx.message.text.split(' ');
  const interval = (p[1] || '1h');
  const over = parseInt(p[2]) || 70;
  const under = parseInt(p[3]) || 30;
  ctx.reply(`Skanuję Futures RSI >${over} / <${under} (${interval})...`);
  scanFuturesRSI(interval, { overbought: over, oversold: under }, ctx.chat.id);
});

bot.launch();
