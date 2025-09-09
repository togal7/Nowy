const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const moment = require('moment'); // npm install moment

const TOKEN = 'TU_WSTAW_TOKEN_BOTA';

const exchanges = [
  { key: 'bingx', label: 'BingX USDT-M' },
  { key: 'okx', label: 'OKX USDT-M' },
  { key: 'bitget', label: 'Bitget Futures' },
  { key: 'bybit', label: 'Bybit Perpetual' },
  { key: 'binance', label: 'Binance USDT-M' },
  { key: 'kucoin', label: 'KuCoin Futures' },
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

const userDB = {}; // Testowa "baza" dostępu: chatId: { start, blocked, accessUntil }
const userConfig = {}; // chatId: { exchange, interval, overbought, oversold }

const mexcIntervalMap = { '1 min': 'Min1','5 min': 'Min5','15 min': 'Min15','30 min': 'Min30','1 godz': 'Min60','4 godz': 'Hour4','1 dzień': 'Day1','1 tydzień': 'Week1','1 miesiąc': 'Month1' };
const bybitIntervalMap = { '1 min': '1', '5 min': '5', '15 min': '15', '30 min': '30', '1 godz': '60', '4 godz': '240', '1 dzień': 'D', '1 tydzień': 'W', '1 miesiąc': 'M' };
const binanceIntervalMap = { '1 min':'1m','5 min':'5m','15 min':'15m','30 min':'30m','1 godz':'1h','4 godz':'4h','1 dzień':'1d','1 tydzień':'1w','1 miesiąc':'1M' };
const kucoinIntervalMap = { '1 min':'1min','5 min':'5min','15 min':'15min','30 min':'30min','1 godz':'1hour','4 godz':'4hour','1 dzień':'1day','1 tydzień':'1week','1 miesiąc':'1month' };
// Skeleton: doklej ewentualne dodatkowe interwały dla nowo dodanych giełd
const defaultInterval = '1h';

const bot = new Telegraf(TOKEN);

function getActiveMenu(chatId) {
  bot.telegram.sendMessage(chatId, 'Wybierz giełdę do skanowania RSI:', Markup.inlineKeyboard(exchangeKeyboard));
}

bot.on('message', ctx => {
  const chatId = ctx.chat.id;
  // Obsługa darmowego testu (1 tydzień) i blokady
  if (!userDB[chatId]) userDB[chatId] = { start: Date.now(), blocked: false, accessUntil: Date.now() + 7*24*3600*1000 };
  if (userDB[chatId].blocked || Date.now() > userDB[chatId].accessUntil) {
    ctx.reply("Twój dostęp wygasł. Skontaktuj się ze mną, aby odblokować dostęp.");
    return;
  }
  getActiveMenu(chatId);
});

bot.action(exchanges.map(e=>e.key), ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].exchange = ctx.match[0];
  ctx.reply('Wybierz interwał:', Markup.keyboard(intervalKeyboard).oneTime().resize());
});

bot.hears(['1 min','5 min','15 min','30 min','1 godz','4 godz','1 dzień','1 tydzień','1 miesiąc'], ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = ctx.message.text;
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const chatId = ctx.chat.id;
  const over = parseInt(ctx.match[1]), under = parseInt(ctx.match[2]);
  userConfig[chatId] = userConfig[chatId] || {};
  userConfig[chatId].overbought = over;
  userConfig[chatId].oversold = under;
  const exch = userConfig[chatId].exchange || 'mexc';
  const intervalLabel = userConfig[chatId].interval || defaultInterval;

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

// ================== Skeleton, przykładowa implementacja pobierania RSI dla Bybit/MEXC/Binance ===============
async function scanRSI(exchange, intervalLabel, thresholds, chatId) {
  let symbols = ['BTCUSDT']; // demo – dla pełnych giełd podstaw publiczne API
  if (exchange === 'bybit') {
    // Przykład: pobierz listę symboli
    try {
      const s = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear');
      symbols = s.data.result.list
        .filter(x => x.status === 'Trading' && x.symbol.endsWith('USDT'))
        .map(x => x.symbol)
        .slice(0, 10);
    } catch {}
  }
  if (exchange === 'mexc') {
    try {
      const s = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
      symbols = s.data.data
        .filter(x => x.quoteCoin === 'USDT')
        .map(x => x.symbol)
        .slice(0, 10);
    } catch {}
  }
  // Analogicznie dodać BingX, OKX, Bitget, Binance, KuCoin...
  // Demo skanowania
  let msg = `⭐ Wyniki (${exchange}, interwał ${intervalLabel})\n`;
  for (const sym of symbols) {
    // Dla demo: RSI = losowa liczba 1-100 (podmień na prawdziwe pobieranie świec)
    const rsi = Math.random()*100;
    if (rsi < thresholds.oversold)
      msg += `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
    if (rsi > thresholds.overbought)
      msg += `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
  }
  if (msg.trim() === `⭐ Wyniki (${exchange}, interwał ${intervalLabel})`) msg += 'Brak sygnałów!';
  await bot.telegram.sendMessage(chatId, msg);
}

// ================== Uzupełnij implementacje pobierania RSI dla nowych giełd – w razie pytań podam endpointy ==================

bot.launch();

