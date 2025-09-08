const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';

// --- Mapowanie przycisków na API ---
const exchanges = [
  { key: 'mexc', label: 'MEXC Futures' },
  { key: 'bybit', label: 'Bybit Perpetual' },
  { key: 'binance', label: 'Binance USDT-M' },
  { key: 'kucoin', label: 'KuCoin Futures' }
];

const exchangeKeyboard = [ exchanges.map(e => ({ text: e.label, callback_data: e.key })) ];

const mexcIntervalMap = { '1 min': 'Min1','5 min': 'Min5','15 min': 'Min15','30 min': 'Min30','1 godz': 'Min60','4 godz': 'Hour4','1 dzień': 'Day1','1 tydzień': 'Week1','1 miesiąc': 'Month1' };
const bybitIntervalMap = { '1 min': '1', '5 min': '5', '15 min': '15', '30 min': '30', '1 godz': '60', '4 godz': '240', '1 dzień': 'D', '1 tydzień': 'W', '1 miesiąc': 'M' };
const binanceIntervalMap = { '1 min':'1m','5 min':'5m','15 min':'15m','30 min':'30m','1 godz':'1h','4 godz':'4h','1 dzień':'1d','1 tydzień':'1w','1 miesiąc':'1M' };
const kucoinIntervalMap = { '1 min':'1min','5 min':'5min','15 min':'15min','30 min':'30min','1 godz':'1hour','4 godz':'4hour','1 dzień':'1day','1 tydzień':'1week','1 miesiąc':'1month' };
const intervalKeyboard = [ ['1 min','5 min','15 min'],['30 min','1 godz','4 godz'],['1 dzień','1 tydzień','1 miesiąc'] ];

const rsiThresholds = [
  [{ text: '99/1', callback_data: 'rsi_99_1' }, { text: '95/5', callback_data: 'rsi_95_5' }],
  [{ text: '90/10', callback_data: 'rsi_90_10' }, { text: '80/20', callback_data: 'rsi_80_20' }],
  [{ text: '70/30', callback_data: 'rsi_70_30' }]
];

// --- FUNKCJE DANYCH
async function fetchMexcFuturesSymbols() {
  const res = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
  return res.data.data.filter(s => s.quoteCoin === 'USDT').map(s => s.symbol);
}
async function fetchBybitSymbols() {
  const url = 'https://api.bybit.com/v5/market/instruments-info?category=linear';
  const res = await axios.get(url);
  return res.data.result.list.filter(x=>x.status==='Trading' && x.symbol.endsWith('USDT')).map(x=>x.symbol);
}
async function fetchBinanceFuturesSymbols() {
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  const res = await axios.get(url);
  return res.data.symbols.filter(s=>s.status==='TRADING' && s.symbol.endsWith('USDT')).map(s=>s.symbol);
}
async function fetchKucoinFuturesSymbols() {
  const url = 'https://api-futures.kucoin.com/api/v1/contracts/active';
  const res = await axios.get(url);
  return res.data.data.filter(x => x.baseCurrency && x.quoteCurrency === 'USDT').map(x => x.symbol);
}

async function fetchMexcFuturesRSI(symbol, interval = 'Min60') {
  try {
    const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=15`;
    const { data } = await axios.get(url);
    if (!data.data || data.data.length < 15) return null;
    const closes = data.data.map(k => parseFloat(k[4]));
    return calculateRSI(closes);
  } catch { return null; }
}
async function fetchBybitRSI(symbol, interval = '60') {
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=15`;
    const res = await axios.get(url);
    if (!res.data.result || !res.data.result.list || res.data.result.list.length < 15) return null;
    const closes = res.data.result.list.map(k => parseFloat(k[4]));
    return calculateRSI(closes);
  } catch { return null; }
}
async function fetchBinanceFuturesRSI(symbol, interval='1h') {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=15`;
    const res = await axios.get(url);
    if (!Array.isArray(res.data) || res.data.length < 15) return null;
    const closes = res.data.map(k => parseFloat(k[4]));
    return calculateRSI(closes);
  } catch { return null; }
}
async function fetchKucoinFuturesRSI(symbol, interval='1hour') {
  try {
    const url = `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${symbol}&granularity=${intervalToGranularity(interval)}&from=${Math.floor(Date.now()/1000-60*60*36)}&to=${Math.floor(Date.now()/1000)}`;
    const res = await axios.get(url);
    if (!res.data.data.candles || res.data.data.candles.length < 15) return null;
    const closes = res.data.data.candles.slice(-15).map(k => parseFloat(k[2]));
    return calculateRSI(closes);
  } catch { return null; }
}
function intervalToGranularity(interval) {
  return {
    '1min': 1, '5min': 5, '15min': 15, '30min': 30,
    '1hour': 60, '4hour': 240, '1day': 1440,
    '1week': 10080, '1month': 43200
  }[interval] || 60;
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

// --- GŁÓWNA AGREGACJA ---

async function scanRSI(exchange, interval, thresholds, chatId) {
  let symbols = [],
      rsiGetter,
      intervalLabel = interval,
      intervalMap;
  if (exchange === 'bybit') {
    symbols = await fetchBybitSymbols();
    rsiGetter = (symbol) => fetchBybitRSI(symbol, interval);
    intervalMap = bybitIntervalMap;
  } else if (exchange === 'binance') {
    symbols = await fetchBinanceFuturesSymbols();
    rsiGetter = (symbol) => fetchBinanceFuturesRSI(symbol, interval);
    intervalMap = binanceIntervalMap;
  } else if (exchange === 'kucoin') {
    symbols = await fetchKucoinFuturesSymbols();
    rsiGetter = (symbol) => fetchKucoinFuturesRSI(symbol, interval);
    intervalMap = kucoinIntervalMap;
  } else {
    symbols = await fetchMexcFuturesSymbols();
    rsiGetter = (symbol) => fetchMexcFuturesRSI(symbol, interval);
    intervalMap = mexcIntervalMap;
  }
  let oversold = [], overbought = [];
  for (const sym of symbols) {
    const rsi = await rsiGetter(sym);
    if (rsi === null) continue;
    if (rsi < thresholds.oversold) oversold.push({ sym, rsi });
    if (rsi > thresholds.overbought) overbought.push({ sym, rsi });
  }
  let msg = `📊 _Skan RSI [${exchange.toUpperCase()}] (${Object.keys(intervalMap).find(key => intervalMap[key] === interval) || interval})_\nUstawienia: Wyprzedane <${thresholds.oversold}, wykupione >${thresholds.overbought}\n\n`;
  if (oversold.length) {
    msg += `🟢 Wyprzedane:\n${oversold.slice(0, 10).map(x => `• ${x.sym}: ${x.rsi.toFixed(2)}`).join('\n')}\n`;
  }
  if (overbought.length) {
    msg += `🔴 Wykupione:\n${overbought.slice(0, 10).map(x => `• ${x.sym}: ${x.rsi.toFixed(2)}`).join('\n')}\n`;
  }
  if (!oversold.length && !overbought.length) msg += 'Brak sygnałów!';
  await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// --- INTERFEJS TELEGRAM ---

const bot = new Telegraf(TOKEN);
let userConfig = {};

bot.start(ctx => {
  userConfig[ctx.chat.id] = {};
  ctx.reply(
    'Witaj! Wybierz giełdę do skanowania RSI:',
    Markup.inlineKeyboard(exchangeKeyboard)
  );
});

bot.action(['mexc', 'bybit', 'binance', 'kucoin'], ctx => {
  const exchange = ctx.match[0];
  userConfig[ctx.chat.id] = { exchange };
  ctx.reply(
    `Wybrano giełdę: ${exchange.toUpperCase()}. Wybierz interwał RSI:`,
    Markup.keyboard(intervalKeyboard).oneTime().resize()
  );
  ctx.answerCbQuery();
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

bot.hears(Object.keys(mexcIntervalMap), ctx => {
  let exchange = userConfig[ctx.chat.id]?.exchange || 'mexc';
  let interval;
  if (exchange === 'bybit') interval = bybitIntervalMap[ctx.message.text] || '60';
  else if (exchange === 'binance') interval = binanceIntervalMap[ctx.message.text] || '1h';
  else if (exchange === 'kucoin') interval = kucoinIntervalMap[ctx.message.text] || '1hour';
  else interval = mexcIntervalMap[ctx.message.text] || 'Min60';
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
  let interval = userConfig[ctx.chat.id].interval;
  if (!interval) {
    if (exchange === 'bybit') interval = '60';
    else if (exchange === 'binance') interval = '1h';
    else if (exchange === 'kucoin') interval = '1hour';
    else interval = 'Min60';
  }
  await ctx.reply(`Skanuję ${exchange.toUpperCase()} RSI >${over} / <${under} (${interval})...`);
  await scanRSI(exchange, interval, { overbought: over, oversold: under }, ctx.chat.id);
});

// Komenda zaawansowana: /scan giełda interwał over under
bot.command('scan', ctx => {
  const [cmd, exch, interval, over, under] = ctx.message.text.split(' ');
  const exchange = exch || 'mexc';
  const ov = parseInt(over) || 70;
  const un = parseInt(under) || 30;
  ctx.reply(`Skanuję ${exchange.toUpperCase()} RSI >${ov} / <${un} (${interval})...`);
  scanRSI(exchange, interval, { overbought: ov, oversold: un }, ctx.chat.id);
});

bot.launch();
