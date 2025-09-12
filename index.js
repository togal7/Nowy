const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

process.on('unhandledRejection', err => { console.error('UNHANDLED REJECTION:', err); });
process.on('uncaughtException', err => { console.error('UNCAUGHT EXCEPTION:', err); });

const TOKEN = '8067663229:AAEb3__Kn-UhDopgTHkGCdvdfwaZXRzHmig';
const ADMIN_ID = 5157140630;
const MAX_SYMBOLS = 50; // dla pełnych giełd polecam 50-100+ (tyle ile pozwala Railway; zwiększ/zmniejsz w razie timeoutów)

const exchanges = [
  { key: 'bybit', label: 'Bybit Perpetual' },
  { key: 'binance', label: 'Binance USDT-M' },
  { key: 'mexc', label: 'MEXC Futures' },
  { key: 'all', label: 'Wszystkie' }
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

function checkAccess(ctx) {
  const id = ctx.from.id;
  if (!userDB[id]) {
    userDB[id] = { start: Date.now(), accessUntil: Date.now() + 7*24*3600*1000, blocked: false };
  }
  if (id === ADMIN_ID) return true;
  if (userDB[id].blocked) {
    ctx.reply(`Twój dostęp został zablokowany przez administratora. Skontaktuj się z nim (ID: ${ADMIN_ID}) w celu odblokowania.`);
    return false;
  }
  if (Date.now() > userDB[id].accessUntil) {
    ctx.reply(`Twój bezpłatny tydzień testowy wygasł. Skontaktuj się z adminem (ID: ${ADMIN_ID}), aby uzyskać dostęp.`);
    userDB[id].blocked = true;
    return false;
  }
  return true;
}

// PANEL ADMINA
bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Brak uprawnień!');
  ctx.reply('Panel administratora:\n/uzytkownicy\n/odblokuj <id>\n/blokuj <id>');
});
bot.command('uzytkownicy', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  let msg = 'Lista użytkowników:\n';
  Object.entries(userDB).forEach(([uid, obj]) => {
    msg += `ID: ${uid}, dostęp do: ${new Date(obj.accessUntil).toLocaleDateString()}, blokada: ${obj.blocked ? 'TAK' : 'NIE'}\n`;
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
  if (!checkAccess(ctx)) return;
  userConfig[ctx.chat.id] = {};
  showMenu(ctx);
});
function showMenu(ctx) {
  ctx.reply('Wybierz giełdę do skanowania RSI:', Markup.inlineKeyboard([
    exchanges.map(e => ({ text: e.label, callback_data: e.key }))
  ]));
}

bot.use((ctx, next) => {
  if (!checkAccess(ctx)) return;
  next();
});

bot.action(exchanges.map(e=>e.key), ctx => {
  userConfig[ctx.chat.id] = { exchange: ctx.match[0] };
  ctx.reply('Wybierz interwał:', Markup.keyboard(intervalKeyboard).oneTime().resize());
  ctx.answerCbQuery();
});
bot.hears(['1 min','5 min','15 min','30 min','1 godz','4 godz','1 dzień','1 tydzień','1 miesiąc'], ctx => {
  userConfig[ctx.chat.id] = userConfig[ctx.chat.id] || {};
  userConfig[ctx.chat.id].interval = ctx.message.text;
  ctx.reply('Wybierz próg RSI:', Markup.inlineKeyboard(rsiThresholds));
});

bot.action(/rsi_(\d+)_(\d+)/, async ctx => {
  const chatId = ctx.chat.id;
  userConfig[chatId] = userConfig[chatId] || {};
  userConfig[chatId].overbought = parseInt(ctx.match[1]);
  userConfig[chatId].oversold = parseInt(ctx.match[2]);
  const exchange = userConfig[chatId].exchange || 'mexc';
  const intervalLabel = userConfig[chatId].interval || '1 godz';
  ctx.reply(`Skanuję RSI (${exchange.toUpperCase()}) >${userConfig[chatId].overbought} / <${userConfig[chatId].oversold} (${intervalLabel})...`);
  let wyniki = [];
  if (exchange === 'all') {
    for (const giełda of exchanges.filter(e => e.key !== 'all')) {
      let results = await scanRSISignals(giełda.key, intervalLabel, { overbought: userConfig[chatId].overbought, oversold: userConfig[chatId].oversold });
      results.forEach(r => { r.exchange = giełda.key; });
      wyniki = wyniki.concat(results);
    }
  } else {
    let results = await scanRSISignals(exchange, intervalLabel, { overbought: userConfig[chatId].overbought, oversold: userConfig[chatId].oversold });
    results.forEach(r => { r.exchange = exchange; });
    wyniki = wyniki.concat(results);
  }
  if (!wyniki.length) {
    ctx.reply('Brak sygnałów!');
    showMenu(ctx);
    return ctx.answerCbQuery();
  }
  let keyboard = wyniki.map(syg => [{
    text: `${syg.type} ${syg.symbol} (${syg.exchange.toUpperCase()}), RSI: ${syg.rsi.toFixed(2)}`,
    callback_data: `detail_${syg.symbol}_${syg.exchange}_${intervalLabel}_${syg.type === "🟢 Wyprzedane:" ? "LONG" : "SHORT"}`
  }]);
  ctx.reply(`Kliknij sygnał, aby zobaczyć poziom TP:`, Markup.inlineKeyboard(keyboard));
  ctx.answerCbQuery();
});

bot.action(/detail_(.+)_(.+)_(.+)_(LONG|SHORT)/, async ctx => {
  const [symbol, exchange, intervalLabel, direction] = [ctx.match[1], ctx.match[2], ctx.match[3], ctx.match[4]];
  ctx.reply(`Analizuję ${symbol} (${exchange}) na interwale ${intervalLabel}...`);
  const closes = await downloadCloses(exchange, symbol, intervalLabel, 50);
  if (!closes || closes.length < 20) {
    ctx.reply("Brak świeżych danych do analizy.");
    return ctx.answerCbQuery();
  }
  const rsi = calculateRSI(closes);
  let tp = null;
  if (direction === "LONG") {
    const curr = closes[closes.length-1];
    tp = Math.max(...closes.slice(-30).filter(x=>x>curr));
  } else {
    const curr = closes[closes.length-1];
    tp = Math.min(...closes.slice(-30).filter(x=>x<curr));
  }
  let msg = `Sygnał: ${direction === "LONG" ? "RSI < próg — kupno (LONG)" : "RSI > próg — sprzedaż (SHORT)"}\n`;
  msg += `Symbol: ${symbol}, RSI: ${rsi.toFixed(2)}\n`;
  msg += `Aktualna cena: ${closes[closes.length-1]}\n`;
  msg += tp && isFinite(tp) ? `🎯 Take Profit sugerowany: ${tp}\n` : 'Brak wyraźnego poziomu TP.\n';
  msg += `\n[Zobacz wykres](${generateChartUrl(symbol)})`;
  ctx.replyWithMarkdown(msg,
    Markup.inlineKeyboard([
      [{ text: "⚡ Zaawansowana analiza", callback_data: `advanced_${symbol}_${exchange}_${intervalLabel}_${direction}` }]
    ]));
  ctx.answerCbQuery();
});

bot.action(/advanced_(.+)_(.+)_(.+)_(LONG|SHORT)/, async ctx => {
  const [symbol, exchange, intervalLabel, direction] = [ctx.match[1], ctx.match[2], ctx.match[3], ctx.match[4]];
  ctx.reply(`Zaawansowana analiza ${symbol} (${exchange}, ${intervalLabel})...`);
  const {closes, highs, lows, volumes} = await downloadCandles(exchange, symbol, intervalLabel, 100);
  if (!closes || closes.length < 30) {
    ctx.reply("Brak świeżych danych do analizy.");
    return ctx.answerCbQuery();
  }
  // Cała analiza techniczna z wielu wskaźników:
  const rsi = calculateRSI(closes);
  const sma20 = SMA(closes, 20);
  const sma50 = SMA(closes, 50);
  const ema20 = EMA(closes, 20);
  const macd = MACD(closes, 12, 26, 9);
  const bb = BollingerBands(closes, 20, 2);
  const levels = detectSupportResistance(closes);
  const vol = Math.round(volumes.slice(-5).reduce((a,b)=>a+b,0)/5);
  const trendInfo = trendSummary(closes, sma20, sma50, ema20, macd, bb);
  const lastClose = closes[closes.length-1];
  const tp = calculateTakeProfitAll(levels, bb, lastClose, direction);

  let msg = `📊 *Zaawansowany sygnał ${direction === "LONG" ? "Kup (LONG)" : "Sprzedaj (SHORT)"} dla* _${symbol}_\n\n`;
  msg += `*Cena*: ${lastClose}\n`;
  msg += `*RSI*: ${rsi ? rsi.toFixed(2) : "Brak"} | *Wolumen*: ${vol}\n`;
  msg += `*Trend*: ${trendInfo}\n`;
  msg += `*MACD*: ${macd.hist > 0 ? "➕" : "➖"} (${macd.hist.toFixed(3)})\n`;
  msg += `*SMA20/SMA50*: ${sma20.toFixed(2)} / ${sma50.toFixed(2)}\n`;
  msg += `*Bollinger Bands*: [${bb.lower.toFixed(2)} .. ${bb.upper.toFixed(2)}]\n`;
  msg += `Wsparcia: ${levels.support.map(Number).join(', ')}\n`;
  msg += `Opory: ${levels.resistance.map(Number).join(', ')}\n`;
  msg += tp.tpMsg + '\n';
  msg += levels.signal ? `Sygnał: ${levels.signal}\n` : '';
  msg += `\n[Zobacz wykres](${generateChartUrl(symbol, closes, levels)})`;
  ctx.replyWithMarkdown(msg);
  showMenu(ctx);
  ctx.answerCbQuery();
});

// SCAN DLA WSZYSTKICH PAR FUTURES DANEJ GIEŁDY
async function scanRSISignals(exchange, intervalLabel, thresholds) {
  let symbols = [];
  let results = [];
  function chunkArray(arr, size) { const res=[]; for(let i=0;i<arr.length;i+=size) res.push(arr.slice(i,i+size)); return res; }
  try {
    if (exchange === 'bybit') {
      const s = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear');
      symbols = s.data.result.list.filter(x =>
        x.status === 'Trading' && x.symbol.endsWith('USDT'))
        .map(x => x.symbol);
    } else if (exchange === 'binance') {
      const s = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
      symbols = s.data.symbols.filter(x =>
        x.status === 'TRADING' && x.symbol.endsWith('USDT'))
        .map(x => x.symbol);
    } else if (exchange === 'mexc') {
      const s = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
      symbols = s.data.data
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
    symbols = symbols.slice(0, MAX_SYMBOLS); // ogranicz jeśli Railway nie daje rady
    for (const batch of chunkArray(symbols, 10)) {
      const batchResults = await Promise.all(batch.map(async sym => {
        try {
          const closes = await downloadCloses(exchange, sym, intervalLabel, 50);
          if (!closes || closes.length < 20) return null;
          const rsi = calculateRSI(closes);
          if (rsi == null) return null;
          if (rsi < thresholds.oversold) return { symbol: sym, rsi, type: "🟢 Wyprzedane:" };
          if (rsi > thresholds.overbought) return { symbol: sym, rsi, type: "🔴 Wykupione:" };
        } catch(e) { return null; }
        return null;
      }));
      results = results.concat(batchResults.filter(x=>x));
      await new Promise(r=>setTimeout(r, 130));
    }
    return results;
  } catch (e) {
    console.log('Błąd globalny scanRSISignals:', e.message);
    return [];
  }
}

async function downloadCloses(exchange, symbol, intervalLabel, limit=50) {
  try {
    if (exchange === 'bybit') {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervalMap[intervalLabel]}&limit=${limit}`;
      const resp = await axios.get(url);
      if (!resp.data.result || !resp.data.result.list || resp.data.result.list.length < 10) return null;
      return resp.data.result.list.map(arr=>parseFloat(arr[4]));
    } else if (exchange === 'binance') {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${binanceIntervalMap[intervalLabel]}&limit=${limit}`;
      const resp = await axios.get(url);
      if (!Array.isArray(resp.data) || resp.data.length < 10) return null;
      return resp.data.map(x=>parseFloat(x[4]));
    } else if (exchange === 'mexc') {
      const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${mexcIntervalMap[intervalLabel]}&limit=${limit}`;
      const resp = await axios.get(url);
      if (Array.isArray(resp.data.data) && resp.data.data.length >= 10) {
        return resp.data.data.map(x=>parseFloat(x[4]));
      } else if (resp.data.data && Array.isArray(resp.data.data.close) && resp.data.data.close.length >= 10) {
        return resp.data.data.close.slice(-10).map(Number);
      }
    }
    return null;
  } catch {
    return null;
  }
}
async function downloadCandles(exchange, symbol, intervalLabel, limit=50) {
  try {
    if (exchange === 'bybit') {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervalMap[intervalLabel]}&limit=${limit}`;
      const resp = await axios.get(url);
      if (!resp.data.result || !resp.data.result.list || resp.data.result.list.length < 10) return {};
      const parsed = resp.data.result.list.map(arr=>({
        open:parseFloat(arr[1]),
        high:parseFloat(arr[2]),
        low:parseFloat(arr[3]),
        close:parseFloat(arr[4]),
        volume:parseFloat(arr[5])
      }));
      return {
        closes: parsed.map(x=>x.close),
        highs: parsed.map(x=>x.high),
        lows: parsed.map(x=>x.low),
        volumes: parsed.map(x=>x.volume)
      };
    } else if (exchange === 'binance') {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${binanceIntervalMap[intervalLabel]}&limit=${limit}`;
      const resp = await axios.get(url);
      if (!Array.isArray(resp.data) || resp.data.length < 10) return {};
      return {
        closes: resp.data.map(x=>parseFloat(x[4])),
        highs: resp.data.map(x=>parseFloat(x[2])),
        lows: resp.data.map(x=>parseFloat(x[3])),
        volumes: resp.data.map(x=>parseFloat(x[5]))
      };
    } else if (exchange === 'mexc') {
      const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${mexcIntervalMap[intervalLabel]}&limit=${limit}`;
      const resp = await axios.get(url);
      if (Array.isArray(resp.data.data) && resp.data.data.length >= 10) {
        return {
          closes: resp.data.data.map(x=>parseFloat(x[4])),
          highs: resp.data.data.map(x=>parseFloat(x[2])),
          lows: resp.data.data.map(x=>parseFloat(x[3])),
          volumes: resp.data.data.map(x=>parseFloat(x[5]))
        };
      } else if (resp.data.data && Array.isArray(resp.data.data.close) && resp.data.data.close.length >= 10) {
        return { closes: resp.data.data.close.slice(-10).map(Number), highs:[], lows:[], volumes:[] };
      }
    }
    return {};
  } catch { return {}; }
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
// ----- Zaawansowane wskaźniki -----
function SMA(arr, len) {
  if (arr.length < len) return NaN;
  return arr.slice(-len).reduce((a,b)=>a+b,0) / len;
}
function EMA(values, period) {
  let k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}
function MACD(values, fast=12, slow=26, signal=9) {
  if (values.length < slow+signal) return {macd:0, signal:0, hist:0};
  const emaFast = [];
  const emaSlow = [];
  let kFast = 2/(fast+1), kSlow = 2/(slow+1);
  emaFast[0]=values[0]; emaSlow[0]=values[0];
  for(let i=1; i<values.length; ++i){
    emaFast[i] = values[i]*kFast + emaFast[i-1]*(1-kFast);
    emaSlow[i] = values[i]*kSlow + emaSlow[i-1]*(1-kSlow);
  }
  const macdLine = emaFast.map((e,i)=>e-emaSlow[i]);
  let sig = macdLine.slice(0,signal).reduce((a,b)=>a+b,0)/signal;
  for(let i=signal;i<macdLine.length;i++) sig = macdLine[i]*kFast + sig*(1-kFast);
  return { macd: macdLine.at(-1), signal: sig, hist: macdLine.at(-1)-sig };
}
function BollingerBands(arr, length=20, mult=2) {
  if (arr.length < length) return {middle:NaN, upper:NaN, lower:NaN};
  let mean = arr.slice(-length).reduce((a,b)=>a+b,0)/length;
  let variance = arr.slice(-length).reduce((a,b)=>a+(b-mean)**2,0)/length;
  let std = Math.sqrt(variance);
  return {middle:mean, upper:mean + std*mult, lower: mean - std*mult, std:std};
}
function calculateTakeProfitAll(levels, bb, lastClose, direction) {
  let tpMsg = '';
  if (direction === "LONG") {
    const opors = levels.resistance.filter(r=>r>lastClose).sort((a,b)=>a-b);
    if (opors.length) {
      const tp = Math.min(opors[0], bb.upper);
      tpMsg = `🎯 TP: ${tp.toFixed(4)} (+${((tp/lastClose-1)*100).toFixed(2)}%), najbliższy opór/Bollinger.`;
    } else {
      const tp = Math.max(lastClose*1.02, bb.upper);
      tpMsg = `🎯 TP: ${tp.toFixed(4)} (BB upper lub +2%)`;
    }
  } else {
    const wsparc = levels.support.filter(s=>s<lastClose).sort((a,b)=>b-a);
    if (wsparc.length) {
      const tp = Math.max(wsparc[0], bb.lower);
      tpMsg = `🎯 TP: ${tp.toFixed(4)} (${((tp/lastClose-1)*100).toFixed(2)}%), najbliższe wsparcie/BB lower.`;
    } else {
      const tp = Math.min(lastClose*0.98, bb.lower);
      tpMsg = `🎯 TP: ${tp.toFixed(4)} (BB lower lub -2%)`;
    }
  }
  return { tpMsg };
}
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
  let signal = null;
  if (support.length > 0 && closes[closes.length-1] > support[support.length-1]) signal = "LONG/odbicie od wsparcia";
  if (resistance.length > 0 && closes[closes.length-1] < resistance[resistance.length-1]) signal = "SHORT/przebicie oporu";
  return { support: support.slice(-3), resistance: resistance.slice(-3), signal };
}
function trendSummary(closes, sma20, sma50, ema20, macd, bb) {
  const last = closes.at(-1);
  let t = [];
  if (last > sma20 && sma20 > sma50) t.push("silny wzrostowy");
  else if (last < sma20 && sma20 < sma50) t.push("silny spadkowy");
  else t.push("konsolidacja");
  if (last > ema20) t.push("momentum up");
  if (last < ema20) t.push("momentum down");
  if (macd.hist > 0) t.push("przewaga byków");
  if (macd.hist < 0) t.push("przewaga niedźwiedzi");
  if (last > bb.upper) t.push("skrajna wycena");
  if (last < bb.lower) t.push("wyprzedanie");
  return t.join(", ");
}
function generateChartUrl(symbol) {
  return `https://pl.tradingview.com/chart/?symbol=${symbol.replace('USDT','USDT.P')}`;
}

bot.launch();
