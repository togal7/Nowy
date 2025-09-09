const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// Klucze do MEXC – NIE udostępniaj nikomu! Wpisz swoje tutaj:
const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';

// Mapowanie klawiatury na wartości z API MEXC FUTURES:
const futuresIntervalMap = {
  '1 min': 'Min1',
  '5 min': 'Min5',
  '15 min': 'Min15',
  '30 min': 'Min30',
  '1 godz': 'Min60',
  '4 godz': 'Hour4',
  '1 dzień': 'Day1',
  '1 tydzień': 'Week1',
  '1 miesiąc': 'Month1'
};

const intervalKeyboard = [
  ['1 min', '5 min', '15 min'],
  ['30 min', '1 godz', '4 godz'],
  ['1 dzień', '1 tydzień', '1 miesiąc']
];

// Dostępne progi RSI do wyboru
const rsiThresholds = [
  [{ text: '99/1', callback_data: 'rsi_99_1' }, { text: '95/5', callback_data: 'rsi_95_5' }],
  [{ text: '90/10', callback_data: 'rsi_90_10' }, { text: '80/20', callback_data: 'rsi_80_20' }],
  [{ text: '70/30', callback_data: 'rsi_70_30' }]
];

// ======== FUNKCJE POBIERAJĄCE DANE Z MEXC FUTURES ========

// Lista tylko USDT-M (perpetual) futures:
async function fetchFuturesSymbols() {
  const res = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
  return res.data.data.filter(s => s.quoteCoin === 'USDT').map(s => s.symbol);
}

// Liczenie RSI
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

// Pobierz świece dla futures
async function fetchFuturesRSI(symbol, interval = 'Min60') {
  try {
    const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=15`;
    const { data } = await axios.get(url);
    if (!data.data || data.data.length < 15) return null;
    const closes = data.data.map(k => parseFloat(k[4]));
    return calculateRSI(closes);
  } catch (err) {
    return null;
  }
}

// Główna funkcja do skanowania RSI na futures z konfigurowalnymi progami
async function scanFuturesRSI(interval = 'Min60', thresholds = { overbought: 70, oversold: 30 }, chatId) {
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

// ============= INTERFEJS TELEGRAM ===============

const bot = new Telegraf(TOKEN);

// Przechowuje wybory użytkownika (proste cache, na prostą wersję)
let userConfig = {};

/* Etap 1: start – wybierz interwał z keyboarda */
bot.start(ctx => {
  ctx.reply(
    "Witaj! Wybierz interwał RSI do skanowania na rynku futures.",
    Markup.keyboard(intervalKeyboard).oneTime().resize()
  );
  ctx.reply(
    "Wybierz próg RSI:",
    Markup.inlineKeyboard(rsiThresholds)
  );
});

/* Etap 2: wybór interwału przez keyboard */
bot.hears(Object.keys(futuresIntervalMap), ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = futuresIntervalMap[ctx.message.text] || 'Min60';
  ctx.reply('Wybrano interwał: ' + ctx.message.text + '. Teraz wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

/* Etap 3: wybór progu przez inline keyboard */
bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const over = parseInt(ctx.match[1]);
  const under = parseInt(ctx.match[2]);
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].overbought = over;
  userConfig[ctx.chat.id].oversold = under;
  const interval = userConfig[ctx.chat.id].interval || 'Min60';
  await ctx.reply(`Skanuję Futures RSI dla progu >${over} / <${under}, interwał: ${interval}...`);
  await scanFuturesRSI(interval, { overbought: over, oversold: under }, ctx.chat.id);
});

/* Zaawansowana komenda tekstowa! /futures [interwał] [górny próg] [dolny próg] */
bot.command('futures', ctx => {
  // np. /futures Min1 95 5
  const p = ctx.message.text.split(' ');
  const interval = p[1] || 'Min60';
  const over = parseInt(p[2]) || 70;
  const under = parseInt(p[3]) || 30;
  ctx.reply(`Skanuję Futures RSI >${over} / <${under} (${interval})...`);
  scanFuturesRSI(interval, { overbought: over, oversold: under }, ctx.chat.id);
});

bot.launch();
