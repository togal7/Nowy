const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// Twój token Telegram
const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';

// Mapowanie: przyciski na telegramie → API giełdy
const exchangeKeyboard = [
  [{ text: 'MEXC Futures', callback_data: 'mexc' }, { text: 'Bybit Perpetual', callback_data: 'bybit' }]
];

// Interwały (Telegram → API MEXC/Bybit)
const mexcIntervalMap = {
  '1 min': 'Min1',    '5 min': 'Min5',  '15 min': 'Min15',
  '30 min': 'Min30',  '1 godz': 'Min60','4 godz': 'Hour4',
  '1 dzień': 'Day1',  '1 tydzień': 'Week1','1 miesiąc': 'Month1'
};
const bybitIntervalMap = {
  '1 min': '1',     '5 min': '5',   '15 min': '15',
  '30 min': '30',   '1 godz': '60', '4 godz': '240',
  '1 dzień': 'D',   '1 tydzień': 'W','1 miesiąc': 'M'
};
const intervalKeyboard = [
  ['1 min', '5 min', '15 min'],
  ['30 min', '1 godz', '4 godz'],
  ['1 dzień', '1 tydzień', '1 miesiąc']
];

// Progi RSI do wyboru
const rsiThresholds = [
  [{ text: '99/1', callback_data: 'rsi_99_1' }, { text: '95/5', callback_data: 'rsi_95_5' }],
  [{ text: '90/10', callback_data: 'rsi_90_10' }, { text: '80/20', callback_data: 'rsi_80_20' }],
  [{ text: '70/30', callback_data: 'rsi_70_30' }]
];

// ---------- FUNKCJE API -------------

// MEXC SYMBOLS
async function fetchMexcFuturesSymbols() {
  const res = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
  return res.data.data.filter(s => s.quoteCoin === 'USDT').map(s => s.symbol);
}

// BYBIT SYMBOLS
async function fetchBybitSymbols() {
  const url = 'https://api.bybit.com/v5/market/instruments-info?category=linear';
  const res = await axios.get(url);
  return res.data.result.list
    .filter(x => x.status === 'Trading' && x.symbol.endsWith('USDT'))
    .map(x => x.symbol);
}

// KLINE MEXC
async function fetchMexcFuturesRSI(symbol, interval = 'Min60') {
  try {
    const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=15`;
    const { data } = await axios.get(url);
    if (!data.data || data.data.length < 15) return null;
    const closes = data.data.map(k => parseFloat(k[4]));
    return calculateRSI(closes);
  } catch { return null; }
}

// KLINE BYBIT
async function fetchBybitRSI(symbol, interval = '60') {
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=15`;
    const res = await axios.get(url);
    if (!res.data.result || !res.data.result.list || res.data.result.list.length < 15) return null;
    const closes = res.data.result.list.map(k => parseFloat(k[4]));
    return calculateRSI(closes);
  } catch { return null; }
}

// RSI algorytm
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

// ----- Wspólna funkcja wykrywająca
async function scanRSI(exchange = 'mexc', interval, thresholds, chatId) {
  let symbols, rsiGetter, intervalLabel;
  if (exchange === 'bybit') {
    symbols = await fetchBybitSymbols();
    rsiGetter = (symbol) => fetchBybitRSI(symbol, interval);
    intervalLabel = Object.keys(bybitIntervalMap).find(key => bybitIntervalMap[key] === interval) || interval;
  } else {
    symbols = await fetchMexcFuturesSymbols();
    rsiGetter = (symbol) => fetchMexcFuturesRSI(symbol, interval);
    intervalLabel = Object.keys(mexcIntervalMap).find(key => mexcIntervalMap[key] === interval) || interval;
  }
  let oversold = [], overbought = [];
  for (const sym of symbols) {
    const rsi = await rsiGetter(sym);
    if (rsi === null) continue;
    if (rsi < thresholds.oversold) oversold.push({ sym, rsi });
    if (rsi > thresholds.overbought) overbought.push({ sym, rsi });
  }
  let msg = `📊 _Skan RSI [${exchange.toUpperCase()}] (${intervalLabel})_\nUstawienia: Wyprzedane <${thresholds.oversold}, wykupione >${thresholds.overbought}\n\n`;
  if (oversold.length) {
    msg += `🟢 Wyprzedane (RSI<${thresholds.oversold}):\n`;
    oversold.slice(0, 10).forEach(x => msg += `• ${x.sym}: ${x.rsi.toFixed(2)}\n`);
  }
  if (overbought.length) {
    msg += `🔴 Wykupione (RSI>${thresholds.overbought}):\n`;
    overbought.slice(0, 10).forEach(x => msg += `• ${x.sym}: ${x.rsi.toFixed(2)}\n`);
  }
  if (!oversold.length && !overbought.length) msg += 'Brak sygnałów!';
  await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// ------- INTERFEJS TELEGRAM ---------

const bot = new Telegraf(TOKEN);
let userConfig = {}; // chat.id: { exchange, interval, overbought, oversold }

bot.start(ctx => {
  userConfig[ctx.chat.id] = {};
  ctx.reply(
    'Witaj!\nWybierz giełdę do skanowania RSI:',
    Markup.inlineKeyboard(exchangeKeyboard)
  );
});

bot.action(['mexc', 'bybit'], ctx => {
  const exchange = ctx.match[0];
  userConfig[ctx.chat.id] = { exchange };
  ctx.reply(
    `Wybrano giełdę: ${exchange.toUpperCase()}.\nTeraz wybierz interwał RSI:`,
    Markup.keyboard(intervalKeyboard).oneTime().resize()
  );
  ctx.answerCbQuery();
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

bot.hears(Object.keys(mexcIntervalMap), ctx => {
  // Ustal który exchange, bo interwały się różnią!
  let interval;
  if (userConfig[ctx.chat.id] && userConfig[ctx.chat.id].exchange === 'bybit')
    interval = bybitIntervalMap[ctx.message.text] || '60';
  else
    interval = mexcIntervalMap[ctx.message.text] || 'Min60';
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = interval;
  ctx.reply('Wybrano interwał: ' + ctx.message.text + '. Teraz wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const over = parseInt(ctx.match[1]);
  const under = parseInt(ctx.match[2]);
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].overbought = over;
  userConfig[ctx.chat.id].oversold = under;
  const exchange = userConfig[ctx.chat.id].exchange || 'mexc';
  const interval = userConfig[ctx.chat.id].interval || (exchange === 'bybit' ? '60' : 'Min60');
  await ctx.reply(`Skanuję ${exchange.toUpperCase()} RSI dla progu >${over} / <${under}, interwał: ${interval}...`);
  await scanRSI(exchange, interval, { overbought: over, oversold: under }, ctx.chat.id);
});

// Komenda tekstowa uniwersalna:
/*
  /scan giełda interwał over under
  /scan bybit 60 99 1
  /scan mexc Min5 80 20
*/
bot.command('scan', ctx => {
  const [cmd, exch, interval, over, under] = ctx.message.text.split(' ');
  const exchange = exch || 'mexc';
  const ov = parseInt(over) || 70;
  const un = parseInt(under) || 30;
  ctx.reply(`Skanuję ${exchange.toUpperCase()} RSI >${ov} / <${un} (${interval})...`);
  scanRSI(exchange, interval, { overbought: ov, oversold: un }, ctx.chat.id);
});

bot.launch();
