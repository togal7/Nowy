const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';
const ADMIN_ID = 5157140630;

const exchanges = [
  { key: 'bybit', label: 'Bybit Perpetual' },
  { key: 'binance', label: 'Binance USDT-M' },
  { key: 'mexc', label: 'MEXC Futures' },
];

const bybitIntervalMap = { '1 min': '1', '5 min': '5', '15 min': '15','30 min': '30','1 godz': '60','4 godz': '240','1 dzień': 'D','1 tydzień': 'W','1 miesiąc': 'M' };
const binanceIntervalMap = { '1 min':'1m','5 min':'5m','15 min':'15m','30 min':'30m','1 godz':'1h','4 godz':'4h','1 dzień':'1d','1 tydzień':'1w','1 miesiąc':'1M' };
const mexcIntervalMap = { '1 min': 'Min1','5 min': 'Min5','15 min': 'Min15','30 min': 'Min30','1 godz': 'Min60','4 godz': 'Hour4','1 dzień': 'Day1','1 tydzień': 'Week1','1 miesiąc': 'Month1' };

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

// PANEL ADMINA
bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Brak uprawnień!');
  ctx.reply('Panel administratora:\n/uzytkownicy\n/odblokuj <id>\n/blokuj <id>');
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
  const id = ctx.message.text.split(' ')[1];
  if (userDB[id]) {
    userDB[id].accessUntil = Date.now() + 30*24*3600*1000;
    userDB[id].blocked = false;
    ctx.reply(`Użytkownik ${id} odblokowany na 30 dni.`);
  } else ctx.reply('Nie znaleziono użytkownika.');
});
bot.command('blokuj', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.message.text.split(' ')[1];
  if (userDB[id]) {
    userDB[id].blocked = true;
    ctx.reply(`Użytkownik ${id} zablokowany.`);
  } else ctx.reply('Nie znaleziono użytkownika.');
});

bot.start(ctx => {
  userConfig[ctx.chat.id] = {};
  showMenu(ctx);
});
function showMenu(ctx) {
  ctx.reply('Wybierz giełdę do skanowania RSI:', Markup.inlineKeyboard([
    exchanges.map(e => ({ text: e.label, callback_data: e.key }))
  ]));
}

// WYBÓR GIEŁDY → INTERWAŁ
bot.action(exchanges.map(e=>e.key), ctx => {
  userConfig[ctx.chat.id] = { exchange: ctx.match[0] };
  ctx.reply('Wybierz interwał:', Markup.keyboard(intervalKeyboard).oneTime().resize());
  ctx.answerCbQuery();
});

// WYBÓR INTERWAŁU → PROG RSI
bot.hears(['1 min','5 min','15 min','30 min','1 godz','4 godz','1 dzień','1 tydzień','1 miesiąc'], ctx => {
  if (!userConfig[ctx.chat.id]) userConfig[ctx.chat.id] = {};
  userConfig[ctx.chat.id].interval = ctx.message.text;
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

// WYBÓR PROGU RSI → LISTA PAR
bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const chatId = ctx.chat.id;
  if (!userConfig[chatId]) userConfig[chatId] = {};
  userConfig[chatId].overbought = parseInt(ctx.match[1]);
  userConfig[chatId].oversold = parseInt(ctx.match[2]);
  const exchange = userConfig[chatId].exchange || 'mexc';
  const intervalLabel = userConfig[chatId].interval || '1 godz';
  // Pobierz listę par
  let pairs = await getAvailablePairs(exchange);
  // Prezentacja wyboru par w menu
  const keyboards = [];
  for (let i = 0; i < pairs.length; i += 3) {
    keyboards.push(pairs.slice(i, i+3).map(p => ({ text: p, callback_data: `pair_${p}` })));
  }
  ctx.reply(`Wybierz parę do analizy technicznej (${exchange.toUpperCase()}, ${intervalLabel}):`, Markup.inlineKeyboard(keyboards));
  ctx.answerCbQuery();
});

// ANALIZA TECHNICZNA PO WYBORZE PARY
bot.action(/pair_(.+)/, async ctx => {
  const chatId = ctx.chat.id;
  const pair = ctx.match[1];
  const exch = userConfig[chatId].exchange || 'mexc';
  const intervalLabel = userConfig[chatId].interval || '1 godz';
  ctx.reply(`Analizuję ${pair} (${exch}) na interwale ${intervalLabel} ...`);
  // Pobierz dane świec dla wybranej pary
  const closes = await downloadCloses(exch, pair, intervalLabel);
  if (!closes || closes.length < 15) {
    ctx.reply("Brak świeżych danych do analizy.");
    return;
  }
  // RSI
  const rsi = calculateRSI(closes);
  // Znajdź wsparcia/opory
  const levels = detectSupportResistance(closes);
  // News (przykładowo, demo)
  const news = await fetchLatestNews(pair);
  // Wygeneruj wykres (tu jako link)
  const chartUrl = generateChartUrl(pair, closes, levels);

  // Przygotuj raport
  let msg = `📊 Analiza techniczna ${pair} (${exch.toUpperCase()}, ${intervalLabel})\n`;
  msg += `RSI: ${rsi ? rsi.toFixed(2) : "Blad obliczeń"}\n`;
  msg += `Wsparcia: ${levels.support.map(Number).join(', ')}\n`;
  msg += `Opory: ${levels.resistance.map(Number).join(', ')}\n`;
  msg += levels.signal ? `Sygnał: ${levels.signal}\n` : '';
  if (news) msg += `\n📰 Najnowsze newsy:\n${news.join('\n')}\n`;
  msg += `\n[Zobacz wykres](${chartUrl})`;
  ctx.replyWithMarkdown(msg);
  showMenu(ctx);
  ctx.answerCbQuery();
});

// === NARZĘDZIA ALGORYTMICZNE ===

// Pobierz listę realnych par na danej giełdzie (krypto USDTPERP USDT-MEXC/Bybit/Binance)
async function getAvailablePairs(exchange) {
  try {
    if (exchange === 'bybit') {
      const s = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear');
      return s.data.result.list.filter(x =>
        x.status === 'Trading' && x.symbol.endsWith('USDT'))
        .map(x => x.symbol);
    } else if (exchange === 'binance') {
      const s = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
      return s.data.symbols.filter(x =>
        x.status === 'TRADING' && x.symbol.endsWith('USDT'))
        .map(x => x.symbol);
    } else if (exchange === 'mexc') {
      const s = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
      return s.data.data
        .filter(x =>
          x.quoteCoin === 'USDT' &&
          (
            !x.state || x.state === 'ENABLED' || x.state === '1' || x.state === '2'
          ) &&
          (
            !x.status || x.status === 'listed' || x.status === 'TRADING' || x.status === 'open'
          )
        )
        .map(x => x.symbol)
        .filter(sym =>
          !sym.includes('STOCK') &&
          !sym.includes('ETF') &&
          !sym.includes('INDEX') &&
          !sym.includes('LIVE') &&
          sym.endsWith('USDT') &&
          sym === sym.toUpperCase()
        );
    }
    return [];
  } catch {
    return [];
  }
}

// Pobierz dane zamknięcia dla wybranej pary i interwału
async function downloadCloses(exchange, symbol, intervalLabel) {
  try {
    if (exchange === 'bybit') {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervalMap[intervalLabel]}&limit=200`;
      const resp = await axios.get(url);
      if (!resp.data.result || !resp.data.result.list || resp.data.result.list.length < 15) return null;
      return resp.data.result.list.map(k => parseFloat(k[4]));
    } else if (exchange === 'binance') {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${binanceIntervalMap[intervalLabel]}&limit=200`;
      const resp = await axios.get(url);
      if (!Array.isArray(resp.data) || resp.data.length < 15) return null;
      return resp.data.map(k => parseFloat(k[4]));
    } else if (exchange === 'mexc') {
      const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${mexcIntervalMap[intervalLabel]}&limit=200`;
      const resp = await axios.get(url);
      if (Array.isArray(resp.data.data) && resp.data.data.length >= 15) {
        return resp.data.data.map(k => parseFloat(k[4]));
      } else if (resp.data.data && Array.isArray(resp.data.data.close) && resp.data.data.close.length >= 15) {
        return resp.data.data.close.slice(-15).map(Number);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// RSI
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

// AI/Algorytmiczne wsparcia/opory (prosty przykład)
function detectSupportResistance(closes) {
  let support = [], resistance = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] < closes[i - 1] && closes[i] < closes[i - 2] && closes[i] < closes[i + 1] && closes[i] < closes[i + 2]) {
      support.push(closes[i]);
    }
    if (closes[i] > closes[i - 1] && closes[i] > closes[i - 2] && closes[i] > closes[i + 1] && closes[i] > closes[i + 2]) {
      resistance.push(closes[i]);
    }
  }
  // Sygnał: bullish jeśli ostatni close > ostatni support, bearish jeśli < ostatni resistance
  let signal = null;
  if (support.length > 0 && closes[closes.length-1] > support[support.length-1]) signal = "LONG/odbicie od wsparcia";
  if (resistance.length > 0 && closes[closes.length-1] < resistance[resistance.length-1]) signal = "SHORT/przebicie oporu";
  return { support: support.slice(-3), resistance: resistance.slice(-3), signal };
}

// News/sentyment (mock-up/demo – tu pobiera tylko nagłówki, do rozbudowy pod AI i news-sentiment)
async function fetchLatestNews(symbol) {
  try {
    // Przykład: pobierz 3 newsy z Google News API (możesz zamienić na prawdziwy provider)
    const resp = await axios.get(`https://newsapi.org/v2/everything`, {
      params: { q: symbol.replace('USDT',''), pageSize: 3, apiKey: 'demo' } // demo key!
    });
    return resp.data.articles.slice(0, 3).map(news => `${news.title} (${news.source.name})`);
  } catch {
    // Demo fallback
    return [`Brak najnowszych newsów lub błąd API.`];
  }
}

// Wygeneruj wykres (mock – możesz użyć chart-js-image, TradingView snapshot, matplotlib, etc.)
function generateChartUrl(symbol, closes, levels) {
  // Link do TradingView (podstawowy, bez logowania)
  return `https://pl.tradingview.com/chart/?symbol=${symbol.replace('USDT','USDT.P')}`;
}

bot.launch();
