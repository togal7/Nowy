const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';
const ADMIN_ID = 5157140630; // Twój Telegram ID

const exchanges = [
  { key: 'bybit', label: 'Bybit Perpetual' },
  { key: 'binance', label: 'Binance USDT-M' },
  { key: 'mexc', label: 'MEXC Futures' },
  { key: 'all', label: 'Wszystkie Giełdy' }
];

const bybitIntervalMap = { '1 min': '1', '5 min': '5', '15 min': '15','30 min': '30','1 godz': '60','4 godz': '240','1 dzień': 'D','1 tydzień': 'W','1 miesiąc': 'M' };
const binanceIntervalMap = { '1 min':'1m','5 min':'5m','15 min':'15m','30 min':'30m','1 godz':'1h','4 godz':'4h','1 dzień':'1d','1 tydzień':'1w','1 miesiąc':'1M' };
const mexcIntervalMap = { '1 min': 'Min1','5 min': 'Min5','15 min': 'Min15','30 min': 'Min30','1 godz': 'Min60','4 godz': 'Hour4','1 dzień': 'Day1','1 tydzień': 'Week1','1 miesiąc': 'Month1' };

const exchangeKeyboard = [exchanges.map(e => ({ text: e.label, callback_data: e.key }))];
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

const userDB = {};
const userConfig = {};
const bot = new Telegraf(TOKEN);

// ======== PANEL ADMINA ===========

bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('Brak uprawnień!');
  }
  ctx.reply('Panel administratora aktywny!\nDostępne komendy:\n/uzytkownicy\n/odblokuj <id>\n/blokuj <id>');
});

bot.command('uzytkownicy', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  let msg = 'Lista użytkowników:\n';
  Object.entries(userDB).forEach(([uid, obj]) => {
    msg += `ID: ${uid}, dostęp do: ${new Date(obj.accessUntil).toLocaleDateString()}\n`;
  });
  ctx.reply(msg.length > 30 ? msg : 'Brak użytkowników.');
});

bot.command('odblokuj', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1];
  if (userDB[id]) {
    userDB[id].accessUntil = Date.now() + 30*24*3600*1000;
    userDB[id].blocked = false;
    ctx.reply(`Użytkownik ${id} odblokowany na 30 dni.`);
  } else {
    ctx.reply('Nie znaleziono użytkownika.');
  }
});

bot.command('blokuj', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1];
  if (userDB[id]) {
    userDB[id].blocked = true;
    ctx.reply(`Użytkownik ${id} zablokowany.`);
  } else {
    ctx.reply('Nie znaleziono użytkownika.');
  }
});

// ======== KONIEC PANELU ADMINA ===========

// Pokazuje menu giełdy (po każdym wejściu/menu)
function showMenu(ctx) {
  ctx.reply('Wybierz giełdę do skanowania RSI:', Markup.inlineKeyboard(exchangeKeyboard));
}

// Każda wiadomość od usera = menu (nie przesłania wyboru interwału ani admin-komend)
bot.on('message', ctx => {
  if (
    ctx.message.text &&
    (
      ctx.message.text.startsWith('/') || // komendy (np. /admin, /odblokuj)
      ['1 min','5 min','15 min','30 min','1 godz','4 godz','1 dzień','1 tydzień','1 miesiąc'].includes(ctx.message.text) // wybór interwału
    )
  ) return;
  // Inne wiadomości pokazują menu
  const chatId = ctx.chat.id;
  if (!userDB[chatId]) userDB[chatId] = { start: Date.now(), accessUntil: Date.now() + 7*24*3600*1000 };
  if (userDB[chatId].blocked || Date.now() > userDB[chatId].accessUntil) {
    ctx.reply("Twój dostęp wygasł. Skontaktuj się ze mną, aby odblokować dostęp.");
    return;
  }
  showMenu(ctx);
});

// Wybor giełdy
bot.action(exchanges.map(e=>e.key), ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].exchange = ctx.match[0];
  ctx.reply('Wybierz interwał:', Markup.keyboard(intervalKeyboard).oneTime().resize());
  ctx.answerCbQuery();
});

// Wybor interwału – pojawia się klawiatura RSI
bot.hears(['1 min','5 min','15 min','30 min','1 godz','4 godz','1 dzień','1 tydzień','1 miesiąc'], ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = ctx.message.text;
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

// Obliczanie RSI
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

function chunkArray(array, size) {
  const chunks = [];
  for (let i=0; i<array.length; i+=size) {
    chunks.push(array.slice(i,i+size));
  }
  return chunks;
}

// Skanowanie RSI
async function scanRSI(exchange, intervalLabel, thresholds, chatId) {
  let symbols = [];
  let msgHead = `⭐ Wyniki (${exchange}, interwał ${intervalLabel})\n`;
  let msg = '';
  try {
    if (exchange === 'bybit') {
      const s = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear');
      symbols = s.data.result.list.filter(x => x.status === 'Trading' && x.symbol.endsWith('USDT')).map(x => x.symbol);
      for (const chunk of chunkArray(symbols, 8)) {
        const results = await Promise.all(chunk.map(async (sym) => {
          try {
            const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${bybitIntervalMap[intervalLabel]}&limit=15`;
            const resp = await axios.get(url);
            if (!resp.data.result || !resp.data.result.list || resp.data.result.list.length < 15) return null;
            const closes = resp.data.result.list.map(k => parseFloat(k[4]));
            const rsi = calculateRSI(closes);
            if (rsi === null) return null;
            if (rsi < thresholds.oversold)
              return `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
            if (rsi > thresholds.overbought)
              return `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
            return null;
          } catch { return null; }
        }));
        msg += results.filter(x => x).join('');
      }
    } else if (exchange === 'binance') {
      const s = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
      symbols = s.data.symbols.filter(x => x.status === 'TRADING' && x.symbol.endsWith('USDT')).map(x => x.symbol);
      for (const chunk of chunkArray(symbols, 8)) {
        const results = await Promise.all(chunk.map(async (sym) => {
          try {
            const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${binanceIntervalMap[intervalLabel]}&limit=15`;
            const resp = await axios.get(url);
            if (!Array.isArray(resp.data) || resp.data.length < 15) return null;
            const closes = resp.data.map(k => parseFloat(k[4]));
            const rsi = calculateRSI(closes);
            if (rsi === null) return null;
            if (rsi < thresholds.oversold)
              return `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
            if (rsi > thresholds.overbought)
              return `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
            return null;
          } catch { return null; }
        }));
        msg += results.filter(x => x).join('');
      }
    } else if (exchange === 'mexc') {
      const s = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
      symbols = s.data.data.filter(x => x.quoteCoin === 'USDT').map(x => x.symbol);
      for (const chunk of chunkArray(symbols, 8)) {
        const results = await Promise.all(chunk.map(async (sym) => {
          try {
            const url = `https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${mexcIntervalMap[intervalLabel]}&limit=15`;
            const resp = await axios.get(url);
            let closes = null;
            if (Array.isArray(resp.data.data) && resp.data.data.length >= 15) {
              closes = resp.data.data.map(k => parseFloat(k[4]));
            } else if (resp.data.data && Array.isArray(resp.data.data.close) && resp.data.data.close.length >= 15) {
              closes = resp.data.data.close.slice(-15).map(Number);
            }
            if (!closes) return null;
            const rsi = calculateRSI(closes);
            if (rsi === null) return null;
            if (rsi < thresholds.oversold)
              return `🟢 Wyprzedane: ${sym}: RSI ${rsi.toFixed(2)}\n`;
            if (rsi > thresholds.overbought)
              return `🔴 Wykupione: ${sym}: RSI ${rsi.toFixed(2)}\n`;
            return null;
          } catch { return null; }
        }));
        msg += results.filter(x => x).join('');
      }
    } else {
      msg += 'Obsługa tej giełdy została wyłączona.';
    }
  } catch (e) {
    msg += '\nBłąd pobierania danych!\n' + (e.message||'');
  }
  if (msg.trim() === '') msg = 'Brak sygnałów!';
  await bot.telegram.sendMessage(chatId, msgHead + msg);
}

// Wybor progu RSI – skanowanie i powrót do menu
bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const chatId = ctx.chat.id;
  const over = parseInt(ctx.match[1]), under = parseInt(ctx.match[2]);
  userConfig[chatId] = userConfig[chatId] || {};
  userConfig[chatId].overbought = over;
  userConfig[chatId].oversold = under;
  const exch = userConfig[chatId].exchange || 'mexc';
  const intervalLabel = userConfig[chatId].interval || '1 godz';
  await ctx.reply(`Skanuję RSI (${exch.toUpperCase()}) >${over} / <${under} (${intervalLabel})...`);
  if (exch === 'all') {
    for (const giełda of exchanges.filter(e => e.key !== 'all')) {
      await scanRSI(giełda.key, intervalLabel, { overbought: over, oversold: under }, chatId);
    }
  } else {
    await scanRSI(exch, intervalLabel, { overbought: over, oversold: under }, chatId);
  }
  showMenu(ctx);
  ctx.answerCbQuery();
});

bot.launch();
