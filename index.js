const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const moment = require('moment');

const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';

const exchanges = [
  { key: 'bybit', label: 'Bybit Perpetual' },
  { key: 'binance', label: 'Binance USDT-M' },
  { key: 'mexc', label: 'MEXC Futures' },
  { key: 'all', label: 'Wszystkie Giełdy' }
];

const exchangeKeyboard = [ exchanges.map(e => ({ text: e.label, callback_data: e.key })) ];
const intervalKeyboard = [
  ['1 min','5 min','15 min'],
  ['30 min','1 godz','4 godz'],
  ['1 dzień','1 tydzień','1 miesiąc']
];
const rsiThresholds = [
  [{ text: '99/1', callback_data: 'rsi_99_1' }, { text: '95/5', callback_data: 'rsi_95_5' }],
  [{ text: '90/10', callback_data: 'rsi_90_10' }, { text: '80/20', callback_data: 'rsi_80_20' }],
  [{ text: '70/30', callback_data: 'rsi_70_30' }]
];

const bybitIntervalMap = { '1 min': '1', '5 min': '5', '15 min': '15','30 min': '30','1 godz': '60','4 godz': '240','1 dzień': 'D','1 tydzień': 'W','1 miesiąc': 'M' };
const binanceIntervalMap = { '1 min':'1m','5 min':'5m','15 min':'15m','30 min':'30m','1 godz':'1h','4 godz':'4h','1 dzień':'1d','1 tydzień':'1w','1 miesiąc':'1M' };
const mexcIntervalMap = { '1 min': 'Min1','5 min': 'Min5','15 min': 'Min15','30 min': 'Min30','1 godz': 'Min60','4 godz': 'Hour4','1 dzień': 'Day1','1 tydzień': 'Week1','1 miesiąc': 'Month1' };

const userDB = {};
const userConfig = {};
const bot = new Telegraf(TOKEN);

// Menu giełd przy każdym wejściu
function getActiveMenu(chatId) {
  bot.telegram.sendMessage(chatId, 'Wybierz giełdę do skanowania RSI:', Markup.inlineKeyboard(exchangeKeyboard));
}

// Testowy tydzień dostępowy
bot.on('message', ctx => {
  const chatId = ctx.chat.id;
  if (!userDB[chatId]) userDB[chatId] = { start: Date.now(), blocked: false, accessUntil: Date.now() + 7*24*3600*1000 };
  if (userDB[chatId].blocked || Date.now() > userDB[chatId].accessUntil) {
    ctx.reply("Twój dostęp wygasł. Skontaktuj się ze mną, aby odblokować dostęp.");
    return;
  }
  getActiveMenu(chatId);
});

// Wybór giełdy
bot.action(exchanges.map(e=>e.key), ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].exchange = ctx.match[0];
  ctx.reply('Wybierz interwał:', Markup.keyboard(intervalKeyboard).oneTime().resize());
});

// Wybór interwału
bot.hears(Object.keys(bybitIntervalMap), ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = ctx.message.text;
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

// RSI liczony lokalnie
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

// Skanowanie RSI dla głównych giełd
async function scanRSI(exchange, intervalLabel, thresholds, chatId) {
  let symbols = [];
  let msg = `⭐ Wyniki (${exchange}, interwał ${intervalLabel})\n`;
  try {
    if (exchange === 'bybit') {
      const s = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear');
      symbols = s.data.result.list.filter(x => x.status === 'Trading' && x.symbol.endsWith('USDT')).map(x => x.symbol).slice(0, 15);
      for (const sym of symbols) {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${bybitIntervalMap[intervalLabel]}&limit=15`;
        const resp = await axios.get(url);
        if (!resp.data.result || !resp.data.result.list || resp.data.result.list.length < 15) continue;
        const closes = resp.data.result.list.map(k => parseFloat(k[4]));
        const rsi = calculateRSI(closes);
        if (rsi === null) continue;
        if (rsi < thresholds.oversold) msg += `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
        if (rsi > thresholds.overbought) msg += `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
      }
    } else if (exchange === 'binance') {
      const s = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
      symbols = s.data.symbols.filter(x => x.status === 'TRADING' && x.symbol.endsWith('USDT')).map(x => x.symbol).slice(0, 15);
      for (const sym of symbols) {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${binanceIntervalMap[intervalLabel]}&limit=15`;
        const resp = await axios.get(url);
        if (!Array.isArray(resp.data) || resp.data.length < 15) continue;
        const closes = resp.data.map(k => parseFloat(k[4]));
        const rsi = calculateRSI(closes);
        if (rsi === null) continue;
        if (rsi < thresholds.oversold) msg += `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
        if (rsi > thresholds.overbought) msg += `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
      }
    } else if (exchange === 'mexc') {
      const s = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
      symbols = s.data.data.filter(x => x.quoteCoin === 'USDT').map(x => x.symbol).slice(0, 15);
      for (const sym of symbols) {
        const url = `https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${mexcIntervalMap[intervalLabel]}&limit=15`;
        const resp = await axios.get(url);
        let closes = null;
        if (Array.isArray(resp.data.data) && resp.data.data.length >= 15) {
          closes = resp.data.data.map(k => parseFloat(k[4]));
        } else if (resp.data.data && Array.isArray(resp.data.data.close) && resp.data.data.close.length >= 15) {
          closes = resp.data.data.close.slice(-15).map(Number);
        }
        if (!closes) continue;
        const rsi = calculateRSI(closes);
        if (rsi === null) continue;
        if (rsi < thresholds.oversold) msg += `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
        if (rsi > thresholds.overbought) msg += `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
      }
    }
    // Inne giełdy — szkielet pod rozbudowę
  } catch (e) { msg += '\nBłąd podczas pobierania danych!'; }
  if (msg.trim() === `⭐ Wyniki (${exchange}, interwał ${intervalLabel})`) msg += 'Brak sygnałów!';
  await bot.telegram.sendMessage(chatId, msg);
}

// Obsługa progu RSI + skanowanie
bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const chatId = ctx.chat.id;
  const over = parseInt(ctx.match[1]), under = parseInt(ctx.match[2]);
  userConfig[chatId] = userConfig[chatId] || {};
  userConfig[chatId].overbought = over;
  userConfig[chatId].oversold = under;
  const exch = userConfig[chatId].exchange || 'mexc';
  const intervalLabel = userConfig[chatId].interval || '1 godz';
  ctx.reply(`Skanuję RSI (${exch.toUpperCase()}) >${over} / <${under} (${intervalLabel})...`);
  if (exch === 'all') {
    for (const giełda of exchanges.filter(e => e.key !== 'all')) {
      await scanRSI(giełda.key, intervalLabel, { overbought: over, oversold: under }, chatId);
    }
  } else {
    await scanRSI(exch, intervalLabel, { overbought: over, oversold: under }, chatId);
  }
  getActiveMenu(chatId);
});

bot.launch();
