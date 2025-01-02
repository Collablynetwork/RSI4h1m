import axios from 'axios';
import moment from 'moment';
import { sendTelegramMessage, editTelegramMessage } from './telegram.js';
import fs from 'fs';

// Define log file paths
const RSI_LOG_FILE = './rsi_data.csv'; // File to log RSI data
const BUY_SIGNAL_LOG_FILE = './buy_signals.csv'; // File to log buy signal details

// Global constants
const RSI_PERIOD = 14; // Period for RSI calculation
const RSI_THRESHOLD_15m = 10; // RSI threshold for 15-minute candles
const RSI_THRESHOLD_1m = 30; // RSI threshold for 1-minute candles

// Global trackers
const lastNotificationTimes = {}; // Track last notification time per symbol
const sellPrices = {}; // Store sell prices for active trades
const bottomPrices = {}; // Track the lowest prices observed
const entryPrices = {}; // To track all entry prices for a symbol
let lastBTCPrice = null; // Last BTC price for change calculation
const btcPriceHistory = []; // History of BTC prices for 30-minute change calculation

// Initialize log files
const initializeLogFiles = () => {
  if (!fs.existsSync(RSI_LOG_FILE)) {
    fs.writeFileSync(RSI_LOG_FILE, 'Timestamp,Symbol,RSI_15m,RSI_1m,Current Price\n'); // Initialize RSI log file with headers
  }
  if (!fs.existsSync(BUY_SIGNAL_LOG_FILE)) {
    fs.writeFileSync(
      BUY_SIGNAL_LOG_FILE,
      'Timestamp,Symbol,Entry Prices,Sell Price,Duration,Bottom Price,Percentage Drop,BTC Change,BTC 30m Change\n' // Initialize buy signal log file with headers
    );
  }
};
initializeLogFiles();

// Function to calculate RSI
const calculateRSI = (prices, period = RSI_PERIOD) => {
  if (prices.length < period) return null; // Ensure enough data points are available

  let gains = 0,
    losses = 0;
  for (let i = 1; i < period; i++) {
    const change = prices[i] - prices[i - 1]; // Calculate price changes
    if (change > 0) gains += change; // Accumulate gains
    else losses -= change; // Accumulate losses
  }

  const avgGain = gains / period; // Average gain
  const avgLoss = losses / period; // Average loss

  if (avgLoss === 0) return 100; // Return maximum RSI if no losses

  const rs = avgGain / avgLoss; // Relative strength
  return 100 - 100 / (1 + rs); // Final RSI calculation
};

// Fetch current BTC price and maintain history
const fetchBTCPrice = async () => {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price', {
      params: { symbol: 'BTCUSDT' } // Fetch BTC price from Binance API
    });
    const price = parseFloat(response.data.price);

    btcPriceHistory.push({
      price,
      timestamp: moment() // Store price with timestamp
    });

    const thirtyOneMinutesAgo = moment().subtract(31, 'minutes'); // Retain only the last 31 minutes of data
    while (btcPriceHistory.length > 0 && btcPriceHistory[0].timestamp.isBefore(thirtyOneMinutesAgo)) {
      btcPriceHistory.shift();
    }

    return price;
  } catch (error) {
    console.error('Error fetching BTC price:', error); // Handle errors gracefully
    return null;
  }
};

// Calculate BTC price changes over time
const calculateBTCChanges = async () => {
  const currentBTCPrice = await fetchBTCPrice();
  if (!currentBTCPrice) return { price: null, change: null, change30m: null }; // Return nulls if BTC price unavailable

  let priceChange = null;
  if (lastBTCPrice) {
    priceChange = ((currentBTCPrice - lastBTCPrice) / lastBTCPrice * 100).toFixed(2); // Calculate percentage change
  }

  let priceChange30m = null;
  if (btcPriceHistory.length > 0) {
    const thirtyMinutesAgo = moment().subtract(30, 'minutes');
    const oldPrice = btcPriceHistory.find(entry => entry.timestamp.isSameOrBefore(thirtyMinutesAgo));
    if (oldPrice) {
      priceChange30m = ((currentBTCPrice - oldPrice.price) / oldPrice.price * 100).toFixed(2); // Calculate 30-minute change
    }
  }

  lastBTCPrice = currentBTCPrice; // Update last BTC price
  return {
    price: currentBTCPrice,
    change: priceChange,
    change30m: priceChange30m
  };
};

// Fetch candlestick data for a specific symbol and interval
const fetchCandlestickData = async (symbol, interval) => {
  try {
    const url = `https://api.binance.com/api/v3/klines`;
    const params = {
      symbol, // Trading pair symbol
      interval, // Interval for candlestick data
      limit: RSI_PERIOD + 1, // Fetch enough data for RSI calculation
    };

    const response = await axios.get(url, { params });
    return response.data.map((candle) => parseFloat(candle[4])); // Extract closing prices
  } catch (error) {
    console.error(`Error fetching ${interval} data for ${symbol}:`, error); // Handle errors gracefully
    return null;
  }
};

// Log RSI and price data
const logRSIAndPrice = (symbol, rsi15m, rsi1m, currentPrice) => {
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss'); // Current timestamp
  const logData = `${timestamp},${symbol},${rsi15m},${rsi1m},${currentPrice}\n`; // Log format

  fs.appendFile(RSI_LOG_FILE, logData, (err) => {
    if (err) console.error('Error writing to RSI log file:', err); // Handle errors
    else console.log(`Logged RSI and price for ${symbol}`); // Confirm logging
  });
};

// Log buy signals to the buy signals log file
const logBuySignal = (symbol, entryPrices, sellPrice, duration, bottomPrice, percentageDrop, btcChange, btcChange30m) => {
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss'); // Current timestamp
  const logData = `${timestamp},${symbol},${entryPrices.join(';')},${sellPrice},${duration},${bottomPrice},${percentageDrop},${btcChange},${btcChange30m}\n`;

  fs.appendFile(BUY_SIGNAL_LOG_FILE, logData, (err) => {
    if (err) console.error('Error writing to buy_signals.csv:', err); // Handle write errors
    else console.log(`Logged Buy Signal for ${symbol}`); // Confirm successful logging
  });
};

// Handle RSI-based buy signal generation
export const handleRSI = async (symbol, token, chatId) => {
  const prices15m = await fetchCandlestickData(symbol, '15m'); // Fetch 15-minute candlestick data
  const prices1m = await fetchCandlestickData(symbol, '1m'); // Fetch 1-minute candlestick data
  const btcData = await calculateBTCChanges(); // Calculate BTC price changes

  if (!prices15m || !prices1m) return; // Exit if data is unavailable

  const rsi15m = calculateRSI(prices15m); // Calculate 15-minute RSI
  const rsi1m = calculateRSI(prices1m); // Calculate 1-minute RSI
  const currentPrice = prices1m[prices1m.length - 1]; // Get the latest price

  logRSIAndPrice(symbol, rsi15m, rsi1m, currentPrice); // Log RSI and price data

  const existingSignal = sellPrices[symbol];

  if (existingSignal) {
    // Update existing signal if sell price has not been achieved
    if (currentPrice < existingSignal.sellPrice && (entryPrices[symbol].length === 0 || currentPrice < entryPrices[symbol][0])) {
      entryPrices[symbol].unshift(currentPrice); // Add new entry price if lower
      const updatedMessage = `
📢 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Prices: ${entryPrices[symbol].join('-')}
💰 Sell Price: ${existingSignal.sellPrice}
🕒 Timeframe: 1m
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;
      await editTelegramMessage(token, chatId, existingSignal.messageId, updatedMessage); // Update Telegram message
    }
    return; // Do not generate a new signal
  }

  if (rsi15m < RSI_THRESHOLD_15m && rsi1m > RSI_THRESHOLD_1m) { // Check RSI thresholds
    const currentTime = moment();
    const lastNotificationTime = lastNotificationTimes[symbol];

    if (lastNotificationTime && currentTime.diff(lastNotificationTime, 'minutes') < 30) return; // Skip if notified recently

    lastNotificationTimes[symbol] = currentTime; // Update last notification time

    if (!entryPrices[symbol]) entryPrices[symbol] = []; // Initialize entry prices array if not present

    entryPrices[symbol].unshift(currentPrice); // Add the first entry price

    const sellPrice = (entryPrices[symbol][0] * 1.011).toFixed(8); // Calculate sell price based on first entry price
    const message = `
📢 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Prices: ${entryPrices[symbol].join('-')}
💰 Sell Price: ${sellPrice}
🕒 Timeframe: 1m
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;

    const messageId = await sendTelegramMessage(token, chatId, message); // Send Telegram message

    sellPrices[symbol] = { entryPrices: entryPrices[symbol], sellPrice, messageId, buyTime: currentTime }; // Track sell price
    bottomPrices[symbol] = currentPrice; // Update bottom price
  }
};

// Check if sell target is achieved
export const checkTargetAchieved = async (token, chatId) => {
  for (const symbol in sellPrices) {
    const { sellPrice, entryPrices, messageId, buyTime } = sellPrices[symbol];
    const prices = await fetchCandlestickData(symbol, '1m'); // Fetch latest prices

    if (!prices) continue; // Skip if prices unavailable

    const currentPrice = prices[prices.length - 1]; // Get the latest price
    if (currentPrice >= sellPrice) { // Check if sell price is reached
      const duration = moment.duration(moment().diff(buyTime));
      const period = `${duration.hours()}h ${duration.minutes()}m ${duration.seconds()}s`; // Calculate duration

      const bottomPrice = bottomPrices[symbol];
      const percentageDrop = (((entryPrices[0] - bottomPrice) / entryPrices[0]) * 100).toFixed(2); // Calculate percentage drop

      const newMessage = `
📢 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Prices: ${entryPrices.join('-')}
💰 Sell Price: ${sellPrice}
📉 Bottom Price: ${bottomPrice}
📉 Percentage Drop: ${percentageDrop}%
✅ Target Achieved
⏱️ Duration: ${period}
💹 Traded on: [Binance](https://www.binance.com/en/trade/${symbol})
`;

      await editTelegramMessage(token, chatId, messageId, newMessage); // Update Telegram message
      logBuySignal(symbol, entryPrices, sellPrice, period, bottomPrice, percentageDrop, null, null); // Log buy signal

      delete sellPrices[symbol]; // Cleanup after target achieved
      delete bottomPrices[symbol];
      delete entryPrices[symbol];
    }
  }
};
