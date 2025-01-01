import dotenv from 'dotenv';
import { trackedPairs } from './pairs.js';
import { EXCLUDED_PAIRS } from './excludedPairs.js';
import { handleRSI, checkTargetAchieved } from './strategy.js';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Function to monitor tokens
const monitorTokens = async () => {
  console.log('Monitoring started...');
  const usdtPairs = trackedPairs.filter(
    (pair) => !EXCLUDED_PAIRS.includes(pair) && pair.endsWith('USDT')
  );

  if (usdtPairs.length > 0) {
    console.log('Monitoring pairs:', usdtPairs.join(', '));
    const promises = usdtPairs.map((pair) =>
      handleRSI(pair, TELEGRAM_TOKEN, CHAT_ID)
    );
    await Promise.all(promises);
  } else {
    console.log('No valid USDT pairs found.');
  }

  console.log('Monitoring completed.');
};

// Main function
const main = async () => {
  await monitorTokens();
  setInterval(monitorTokens, 20000);
  setInterval(() => checkTargetAchieved(TELEGRAM_TOKEN, CHAT_ID), 20000);
};

// Start monitoring
main();