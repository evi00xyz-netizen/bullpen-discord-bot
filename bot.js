import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { config } from 'dotenv';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
config();

const {
  DISCORD_BOT_TOKEN,
  TRADE_CHANNEL_ID,
  BULLPEN_BIN = 'bullpen',
  BULLPEN_HOME,
  BULLPEN_ENV = 'production',
  BULLPEN_USE_WSL = 'false',
  DEFAULT_BUY_AMOUNT = '2',
  CONFIRM_TIMEOUT = '30',
} = process.env;

if (!DISCORD_BOT_TOKEN) { console.error('Missing DISCORD_BOT_TOKEN'); process.exit(1); }
if (!TRADE_CHANNEL_ID) { console.error('Missing TRADE_CHANNEL_ID'); process.exit(1); }

const useWsl = BULLPEN_USE_WSL.toLowerCase() === 'true';
const confirmTimeoutSec = parseInt(CONFIRM_TIMEOUT, 10) || 30;

// --- Round amount to 2 decimal places ---
function roundAmount(amount) {
  return Math.round(parseFloat(amount) * 100) / 100;
}

// --- Format amount as string with exactly 2 decimals ---
function fmtAmount(amount) {
  return roundAmount(amount).toFixed(2);
}

// --- Round price to 2 decimal places ---
function fmtPrice(price) {
  return (Math.round(parseFloat(price) * 100) / 100).toFixed(2);
}

// --- Round display value to max 2 decimals ---
function fmtDisplay(value, decimals = 2) {
  const n = parseFloat(value);
  if (isNaN(n)) return String(value);
  return parseFloat(n.toFixed(decimals)).toString();
}

// --- THE FIX: round price to 2 decimals, find clean USDC amount that produces integer shares ---
// CLOB requires: maker amount (USDC) max 2 decimals, taker amount (shares) max 6 decimals
// If price has >2 decimals (e.g. 0.8825), shares = USDC/price will have >6 decimals
// Solution: round price to 2 decimals via --max-price, then find USDC where shares is clean
//
// Math: price P (2 decimals) = p/100 where p is integer (e.g. 0.88 → p=88)
//       amount A (2 decimals) = a/100 where a is integer (e.g. $1.76 → a=176)
//       shares = A/P = (a/100)/(p/100) = a/p
//       For shares to have ≤6 decimals: a * 1e6 mod p == 0
function computeCleanBuyWithRoundedPrice(targetAmount, rawPrice) {
  const target = roundAmount(targetAmount);
  const targetCents = Math.round(target * 100); // integer cents

  // Try rounding price to 2 decimals in both directions (floor and ceil)
  const priceFloor = Math.floor(parseFloat(rawPrice) * 100) / 100;
  const priceCeil = Math.ceil(parseFloat(rawPrice) * 100) / 100;

  console.log(`[computeCleanBuy] target=$${target.toFixed(2)}, rawPrice=${rawPrice}, floor=${priceFloor}, ceil=${priceCeil}`);

  // Try both rounded prices, find the one with a clean amount closest to target
  const candidates = [];

  for (const roundedPrice of [priceFloor, priceCeil]) {
    if (roundedPrice <= 0 || roundedPrice >= 1) continue;

    const p = Math.round(roundedPrice * 100); // integer price in cents

    // Check if target itself is clean
    if ((targetCents * 1e6) % p === 0) {
      const shares = targetCents / p;
      console.log(`[computeCleanBuy] EXACT: price=${roundedPrice}, $${target.toFixed(2)} → ${shares} shares`);
      candidates.push({ amount: target, price: roundedPrice, shares, adjusted: false, distance: 0 });
      continue;
    }

    // Search outward in 1-cent increments for a clean amount
    for (let delta = 1; delta <= 10000; delta++) {
      for (const sign of [1, -1]) {
        const testCents = targetCents + sign * delta;
        if (testCents <= 0) continue;
        if ((testCents * 1e6) % p === 0) {
          const testAmount = testCents / 100;
          const shares = testCents / p;
          console.log(`[computeCleanBuy] FOUND: price=${roundedPrice}, $${testAmount.toFixed(2)} → ${shares} shares (delta=${sign * delta}¢)`);
          candidates.push({ amount: testAmount, price: roundedPrice, shares, adjusted: true, distance: delta });
          break;
        }
      }
      // If we found a candidate for this price, stop searching
      if (candidates.some(c => c.price === roundedPrice)) break;
    }
  }

  if (candidates.length === 0) {
    console.log(`[computeCleanBuy] NO clean amount found, falling back to original`);
    return { amount: target, price: null, shares: null, adjusted: false };
  }

  // Pick the candidate closest to the target amount
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  console.log(`[computeCleanBuy] BEST: price=${best.price}, $${best.amount.toFixed(2)} → ${best.shares} shares (distance=${best.distance}¢)`);

  return best;
}

// --- Auto-detect bullpen binary path ---
let resolvedBin = BULLPEN_BIN;
async function resolveBullpenPath() {
  try {
    await execFileAsync(BULLPEN_BIN, ['--version'], { timeout: 5000 });
    console.log(`Bullpen found: ${BULLPEN_BIN}`);
    return BULLPEN_BIN;
  } catch {}

  const commonPaths = [
    '/usr/local/bin/bullpen',
    '/usr/bin/bullpen',
    `${process.env.HOME}/.local/bin/bullpen`,
    `${process.env.HOME}/.bullpen/bin/bullpen`,
    `${process.env.HOME}/bin/bullpen`,
  ];

  for (const p of commonPaths) {
    try {
      await execFileAsync(p, ['--version'], { timeout: 5000 });
      console.log(`Bullpen found at: ${p}`);
      return p;
    } catch {}
  }

  try {
    const { stdout } = await execAsync('which bullpen 2>/dev/null || command -v bullpen 2>/dev/null', { timeout: 5000 });
    const path = stdout.trim();
    if (path) {
      console.log(`Bullpen found via which: ${path}`);
      return path;
    }
  } catch {}

  console.error('WARNING: Could not find bullpen binary. Tried:', BULLPEN_BIN, ...commonPaths);
  console.error('Set BULLPEN_BIN in .env to the full path of your bullpen install');
  return BULLPEN_BIN;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Track pending confirmations ---
const pendingConfirms = new Map();

// --- Extract slug from Polymarket URL ---
function extractSlugFromUrl(url) {
  let m = url.match(/polymarket\.com\/event\/([^\s?]+)/i);
  if (m) return { slug: m[1], type: 'event' };
  m = url.match(/polymarket\.com\/market\/([^\s?]+)/i);
  if (m) return { slug: m[1], type: 'market' };
  return null;
}

// --- Bullpen CLI helper ---
async function runBullpen(args) {
  const env = { ...process.env };
  if (BULLPEN_HOME) env.BULLPEN_HOME = BULLPEN_HOME;
  if (BULLPEN_ENV) env.BULLPEN_ENV = BULLPEN_ENV;
  env.BULLPEN_NON_INTERACTIVE = '1';

  const extraPaths = [
    '/usr/local/bin',
    '/usr/bin',
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.bullpen/bin`,
  ];
  env.PATH = `${extraPaths.join(':')}:${env.PATH || ''}`;

  let bin, binArgs;
  if (useWsl) {
    bin = 'wsl';
    binArgs = ['-e', resolvedBin, ...args];
  } else {
    bin = resolvedBin;
    binArgs = args;
  }

  console.log(`[runBullpen] ${bin} ${binArgs.join(' ')}`);

  try {
    const { stdout } = await execFileAsync(bin, binArgs, {
      env, timeout: 60000, maxBuffer: 1024 * 1024 * 5,
    });
    console.log(`[runBullpen] OK, stdout length: ${stdout.length}`);
    return { ok: true, stdout };
  } catch (err) {
    const realError = err.stderr || err.stdout || err.message;
    console.log(`[runBullpen] FAILED: ${String(realError).slice(0, 300)}`);
    return { ok: false, stdout: err.stdout || '', stderr: realError };
  }
}

// --- Search Polymarket ---
async function searchMarket(query) {
  const { ok, stdout, stderr } = await runBullpen([
    'polymarket', 'search', query, '--output', 'json', '--type', 'market', '--limit', '5',
  ]);
  if (!ok) return { ok: false, error: stderr || stdout };
  try {
    const data = JSON.parse(stdout);
    const events = data.events || data.results || data;
    if (Array.isArray(events) && events.length > 0) return { ok: true, markets: events };
    return { ok: false, error: 'No markets found' };
  } catch {
    return { ok: false, error: 'Failed to parse search results' };
  }
}

// --- Preview buy (no money moves) ---
async function previewBuy(slug, outcome, amount, maxPrice) {
  const args = ['polymarket', 'buy', slug, outcome, fmtAmount(amount)];
  if (maxPrice) args.push('--max-price', fmtPrice(maxPrice));
  args.push('--preview', '--output', 'json');
  return runBullpen(args);
}

// --- Execute buy (real trade) ---
async function executeBuy(slug, outcome, amount, maxPrice) {
  const args = ['polymarket', 'buy', slug, outcome, fmtAmount(amount)];
  if (maxPrice) args.push('--max-price', fmtPrice(maxPrice));
  args.push('--yes', '--output', 'json');
  return runBullpen(args);
}

// --- Sell shares ---
async function sellShares(slug, outcome, maxShares, preview) {
  const args = ['polymarket', 'sell', slug, outcome];
  if (maxShares === 'max') args.push('--max');
  else if (maxShares) args.push(fmtAmount(maxShares));
  if (preview) args.push('--preview');
  else args.push('--yes');
  args.push('--output', 'json');
  return runBullpen(args);
}

// --- Parse JSON output from bullpen ---
function parseBullpenResult(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// --- Extract price from bullpen output ---
function extractPrice(stdout) {
  const data = parseBullpenResult(stdout);
  if (data) {
    const candidates = [
      data.price, data.avg_price, data.fill_price, data.execution_price,
      data.best_price, data.order_price, data.match_price,
      data.preview?.price, data.preview?.avg_price,
      data.order?.price, data.order?.avg_price,
      data.result?.price, data.result?.avg_price,
      data.trade?.price, data.trade?.avg_price,
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null && !isNaN(parseFloat(c))) {
        console.log(`[extractPrice] found price in JSON: ${c}`);
        return parseFloat(c);
      }
    }
  }
  const text = stdout || '';
  const priceMatch = text.match(/Price:?\s*\$?([\d.]+)/i);
  if (priceMatch) {
    console.log(`[extractPrice] found price via regex: ${priceMatch[1]}`);
    return parseFloat(priceMatch[1]);
  }
  const atMatch = text.match(/(?:at|@)\s*([\d.]+)\s*¢/i);
  if (atMatch) {
    console.log(`[extractPrice] found price via 'at X¢': ${atMatch[1]}`);
    return parseFloat(atMatch[1]);
  }
  console.log(`[extractPrice] could not extract price from stdout`);
  return null;
}

// --- Extract shares from bullpen output ---
function extractShares(stdout) {
  const data = parseBullpenResult(stdout);
  if (data) {
    const candidates = [
      data.shares, data.fill_amount, data.filled, data.est_shares,
      data.estimated_shares, data.amount_bought, data.size,
      data.preview?.shares, data.preview?.est_shares,
      data.order?.shares, data.result?.shares,
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null && !isNaN(parseFloat(c))) {
        return parseFloat(c);
      }
    }
  }
  const text = stdout || '';
  const sharesMatch = text.match(/(?:Est\.?\s*)?shares:?\s*([\d.]+)/i);
  if (sharesMatch) return parseFloat(sharesMatch[1]);
  const filledMatch = text.match(/Filled:?\s*([\d.]+)/i);
  if (filledMatch) return parseFloat(filledMatch[1]);
  return null;
}

// --- Extract info from bullpen output (JSON or text) ---
function extractTradeInfo(stdout) {
  const data = parseBullpenResult(stdout);
  if (data) {
    return {
      price: data.price || data.avg_price || data.fill_price || data.execution_price || null,
      amount: data.amount || data.size || data.cost || data.usdc || data.spent || data.amount_usd || null,
      shares: data.shares || data.fill_amount || data.filled || data.est_shares || data.estimated_shares || data.amount_bought || null,
      potential: data.potential || data.potential_payout || data.payout || null,
      spread: data.spread || null,
      market: data.market || data.market_slug || data.slug || data.market_title || null,
      outcome: data.outcome || data.side || null,
      orderId: data.order_id || data.id || data.tx || data.tx_hash || null,
      status: data.status || null,
      raw: data,
    };
  }
  const text = stdout || '';
  const priceMatch = text.match(/Price:?\s*\$?([\d.]+)/i);
  const amountMatch = text.match(/Amount:?\s*\$?([\d.]+)/i);
  const sharesMatch = text.match(/(?:Est\.?\s*)?shares:?\s*([\d.]+)/i);
  const potentialMatch = text.match(/Potential:?\s*\$?([\d.]+)/i);
  const spreadMatch = text.match(/Spread:?\s*\$?([\d.]+)/i);
  const orderMatch = text.match(/Order submitted successfully.*?ID:?\s*(\S+)/i);
  const filledMatch = text.match(/Filled:?\s*([\d.]+)\s*@\s*\$?([\d.]+)/i);

  return {
    price: priceMatch ? priceMatch[1] : (filledMatch ? filledMatch[2] : null),
    amount: amountMatch ? amountMatch[1] : null,
    shares: sharesMatch ? sharesMatch[1] : (filledMatch ? filledMatch[1] : null),
    potential: potentialMatch ? potentialMatch[1] : null,
    spread: spreadMatch ? spreadMatch[1] : null,
    market: null,
    outcome: null,
    orderId: orderMatch ? orderMatch[1] : null,
    status: filledMatch ? 'filled' : (orderMatch ? 'submitted' : null),
    raw: null,
  };
}

// --- Build preview embed ---
function buildPreviewEmbed(cmd, result) {
  const embed = new EmbedBuilder().setTimestamp();
  const info = extractTradeInfo(result.stdout);

  if (!result.ok) {
    let errMsg = 'Unknown error';
    const data = parseBullpenResult(result.stdout);
    if (data && data.error) errMsg = data.error;
    else if (data && data.message) errMsg = data.message;
    else {
      const raw = (result.stderr || result.stdout || '').trim();
      const firstLine = raw.split('\n')[0];
      if (firstLine) errMsg = firstLine.slice(0, 200);
    }
    embed.setColor(0xff0000).setTitle('❌ Preview Failed');
    embed.addFields({ name: 'Error', value: `\`${errMsg}\``, inline: false });
    return embed;
  }

  embed.setColor(0x3498db).setTitle('📋 Trade Preview');

  const market = info.market || cmd.slug || cmd.market || 'N/A';
  const outcome = info.outcome || cmd.outcome || 'N/A';
  const amount = info.amount || cmd.amount || 'N/A';

  embed.addFields(
    { name: 'Market', value: `\`${String(market).slice(0, 100)}\``, inline: true },
    { name: 'Outcome', value: String(outcome), inline: true },
    { name: 'Amount', value: amount !== 'N/A' ? `$${fmtDisplay(amount, 2)}` : `$${fmtAmount(cmd.amount)}`, inline: true },
  );

  if (info.price) embed.addFields({ name: 'Price', value: `${fmtDisplay(info.price, 2)}¢`, inline: true });
  if (info.shares) embed.addFields({ name: 'Est. Shares', value: fmtDisplay(info.shares, 2), inline: true });
  if (info.potential) embed.addFields({ name: 'Potential', value: `$${fmtDisplay(info.potential, 2)}`, inline: true });
  if (info.spread) embed.addFields({ name: 'Spread', value: `${fmtDisplay(info.spread, 2)}¢`, inline: true });

  embed.setFooter({ text: `Type "y" to confirm — or anything else to cancel (${confirmTimeoutSec}s timeout)` });

  return embed;
}

// --- Build trade execution embed ---
function buildTradeEmbed(cmd, result) {
  const embed = new EmbedBuilder().setTimestamp();
  const info = extractTradeInfo(result.stdout);

  if (!result.ok) {
    let errMsg = 'Unknown error';
    const data = parseBullpenResult(result.stdout);
    if (data && data.error) errMsg = data.error;
    else if (data && data.message) errMsg = data.message;
    else {
      const raw = (result.stderr || result.stdout || '').trim();
      const firstLine = raw.split('\n')[0];
      if (firstLine) errMsg = firstLine.slice(0, 200);
    }
    embed.setColor(0xff0000).setTitle('❌ Trade Failed');
    embed.addFields({ name: 'Error', value: `\`${errMsg}\``, inline: false });
    return embed;
  }

  embed.setColor(0x00ff00).setTitle('✅ Trade Executed');

  const market = info.market || cmd.slug || cmd.market || 'N/A';
  const outcome = info.outcome || cmd.outcome || 'N/A';
  const amount = info.amount || cmd.amount || 'N/A';

  embed.addFields(
    { name: 'Market', value: `\`${String(market).slice(0, 100)}\``, inline: true },
    { name: 'Outcome', value: String(outcome), inline: true },
    { name: 'Spent', value: amount !== 'N/A' ? `$${fmtDisplay(amount, 2)}` : `$${fmtAmount(cmd.amount)}`, inline: true },
  );

  if (info.shares) embed.addFields({ name: 'Shares', value: fmtDisplay(info.shares, 2), inline: true });
  if (info.price) embed.addFields({ name: 'Fill Price', value: `${fmtDisplay(info.price, 2)}¢`, inline: true });
  if (info.potential) embed.addFields({ name: 'Potential', value: `$${fmtDisplay(info.potential, 2)}`, inline: true });
  if (info.orderId) embed.addFields({ name: 'Order ID', value: `\`${String(info.orderId).slice(0, 50)}\``, inline: true });

  return embed;
}

// --- Build sell embed ---
function buildSellEmbed(cmd, result, isPreview) {
  const embed = new EmbedBuilder().setTimestamp();
  const info = extractTradeInfo(result.stdout);

  if (!result.ok) {
    let errMsg = 'Unknown error';
    const data = parseBullpenResult(result.stdout);
    if (data && data.error) errMsg = data.error;
    else {
      const raw = (result.stderr || result.stdout || '').trim();
      const firstLine = raw.split('\n')[0];
      if (firstLine) errMsg = firstLine.slice(0, 200);
    }
    embed.setColor(0xff0000).setTitle('❌ Sell Failed');
    embed.addFields({ name: 'Error', value: `\`${errMsg}\``, inline: false });
    return embed;
  }

  embed.setColor(isPreview ? 0x3498db : 0x00ff00).setTitle(isPreview ? '📋 Sell Preview' : '✅ Sell Executed');

  const market = info.market || cmd.slug || cmd.market || 'N/A';
  const outcome = info.outcome || cmd.outcome || 'N/A';

  embed.addFields(
    { name: 'Market', value: `\`${String(market).slice(0, 100)}\``, inline: true },
    { name: 'Outcome', value: String(outcome), inline: true },
    { name: 'Status', value: isPreview ? 'Preview' : 'Filled', inline: true },
  );

  if (info.shares) embed.addFields({ name: 'Shares', value: fmtDisplay(info.shares, 2), inline: true });
  if (info.price) embed.addFields({ name: 'Price', value: `${fmtDisplay(info.price, 2)}¢`, inline: true });
  if (info.amount) embed.addFields({ name: 'Received', value: `$${fmtDisplay(info.amount, 2)}`, inline: true });

  return embed;
}

// --- Format status as short summary ---
function formatStatusSummary(result) {
  const data = parseBullpenResult(result.stdout);

  if (!result.ok) {
    let errMsg = 'Unknown error';
    if (data && data.error) errMsg = data.error;
    else {
      const raw = (result.stderr || result.stdout || '').trim();
      const firstLine = raw.split('\n')[0];
      if (firstLine) errMsg = firstLine.slice(0, 200);
    }
    return { color: 0xff0000, title: '❌ Status Error', fields: [
      { name: 'Error', value: `\`${errMsg}\``, inline: false },
    ]};
  }

  const fields = [];
  const loggedIn = data?.logged_in ?? data?.authenticated ?? data?.status === 'ok';
  fields.push({ name: 'Logged In', value: loggedIn ? '✅ Yes' : '❌ No', inline: true });

  if (data?.wallet || data?.address) {
    fields.push({ name: 'Wallet', value: `\`${String(data.wallet || data.address).slice(0, 42)}\``, inline: true });
  }
  if (data?.balance !== undefined || data?.usdc_balance !== undefined) {
    const bal = data?.balance ?? data?.usdc_balance ?? 'N/A';
    fields.push({ name: 'USDC Balance', value: `$${fmtDisplay(bal, 2)}`, inline: true });
  }
  if (data?.network || data?.chain) {
    fields.push({ name: 'Network', value: String(data.network || data.chain), inline: true });
  }

  if (fields.length <= 1) {
    const short = result.stdout.trim().split('\n').slice(0, 3).join('\n').slice(0, 300);
    fields.push({ name: 'Details', value: `\`\`\`${short}\`\`\``, inline: false });
  }

  return { color: 0x00ff00, title: '📊 Bullpen Status', fields };
}

// --- Format positions as short summary ---
function formatPositionsSummary(result) {
  const data = parseBullpenResult(result.stdout);

  if (!result.ok) {
    let errMsg = 'Unknown error';
    if (data && data.error) errMsg = data.error;
    else {
      const raw = (result.stderr || result.stdout || '').trim();
      const firstLine = raw.split('\n')[0];
      if (firstLine) errMsg = firstLine.slice(0, 200);
    }
    return { color: 0xff0000, title: '❌ Positions Error', fields: [
      { name: 'Error', value: `\`${errMsg}\``, inline: false },
    ]};
  }

  const positions = data?.positions || data?.markets || (Array.isArray(data) ? data : null);

  if (!positions || positions.length === 0) {
    return { color: 0x3498db, title: '📊 Positions', fields: [
      { name: 'Result', value: 'No open positions', inline: false },
    ]};
  }

  const fields = [];
  positions.slice(0, 5).forEach((p, i) => {
    const market = p?.market || p?.market_slug || p?.question || p?.title || `Position ${i + 1}`;
    const outcome = p?.outcome || p?.side || 'N/A';
    const shares = p?.shares || p?.size || p?.amount || 'N/A';
    const value = p?.value || p?.current_value || p?.cost || 'N/A';
    const pnl = p?.pnl || p?.profit || p?.realized_pnl || null;

    let line = `**${market}**\n${outcome} | ${fmtDisplay(shares, 2)} shares`;
    if (value !== 'N/A') line += ` | $${fmtDisplay(value, 2)}`;
    if (pnl !== null) line += ` | PnL: $${fmtDisplay(pnl, 2)}`;

    fields.push({ name: `#${i + 1}`, value: line.slice(0, 200), inline: false });
  });

  if (positions.length > 5) {
    fields.push({ name: 'More', value: `...and ${positions.length - 5} more positions`, inline: false });
  }

  return { color: 0x00ff00, title: `📊 Positions (${positions.length})`, fields };
}

// --- Parse commands ---
function parseCommand(content) {
  const t = content.trim();

  // NATURAL LANGUAGE (no ! prefix needed)
  let m = t.match(/^Buy\s+"([^"]+)"\s+on\s+Polymarket:?\s+(https?:\/\/\S+)\s+for\s+\$([\d.]+)/i);
  if (m) return { type: 'buy-url', outcome: m[1], url: m[2], amount: parseFloat(m[3]), maxPrice: null, natural: true };

  m = t.match(/^Buy\s+\$([\d.]+)\s+of\s+"([^"]+)"\s+on\s+Polymarket:?\s+(https?:\/\/\S+)/i);
  if (m) return { type: 'buy-url', outcome: m[2], url: m[3], amount: parseFloat(m[1]), maxPrice: null, natural: true };

  m = t.match(/^Buy\s+"([^"]+)"\s+on\s+Polymarket:?\s+(https?:\/\/\S+)/i);
  if (m) return { type: 'buy-url', outcome: m[1], url: m[2], amount: parseFloat(DEFAULT_BUY_AMOUNT), maxPrice: null, natural: true };

  if (!t.startsWith('!')) return null;

  m = t.match(/^!buy-url\s+(https?:\/\/\S+)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy-url', url: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!buy\s+"([^"]+)"\s+(https?:\/\/\S+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy-url', outcome: m[1].toUpperCase(), url: m[2], amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!buy\s+"([^"]+)"\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy', market: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!buy\s+(.+?)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy', market: m[1].trim(), outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!buy-slug\s+(\S+)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy-slug', slug: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!preview\s+"([^"]+)"\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'preview', market: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!preview-slug\s+(\S+)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'preview-slug', slug: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  m = t.match(/^!sell\s+"([^"]+)"\s+(\w+)(?:\s+(max|[\d.]+))?(?:\s+--preview)?$/i);
  if (m) return { type: 'sell', market: m[1], outcome: m[2].toUpperCase(), sellAmount: m[3] || 'max', preview: /--preview/i.test(t) };

  m = t.match(/^!sell-slug\s+(\S+)\s+(\w+)(?:\s+(max|[\d.]+))?(?:\s+--preview)?$/i);
  if (m) return { type: 'sell-slug', slug: m[1], outcome: m[2].toUpperCase(), sellAmount: m[3] || 'max', preview: /--preview/i.test(t) };

  m = t.match(/^!search\s+(.+)$/i);
  if (m) return { type: 'search', query: m[1] };

  if (/^!status$/i.test(t)) return { type: 'status' };
  if (/^!positions$/i.test(t)) return { type: 'positions' };
  if (/^!debug$/i.test(t)) return { type: 'debug' };
  if (/^!help$/i.test(t)) return { type: 'help' };

  return null;
}

function buildEmbedFromSummary(summary) {
  const embed = new EmbedBuilder().setTimestamp();
  embed.setColor(summary.color).setTitle(summary.title);
  embed.addFields(...summary.fields);
  return embed;
}

// --- Check if error is the decimal precision error ---
function isDecimalError(result) {
  const text = ((result.stderr || '') + ' ' + (result.stdout || '')).toLowerCase();
  return text.includes('decimal') || text.includes('invalid amounts') || text.includes('max accuracy');
}

// --- Interactive buy: preview, wait for "y", then execute with clean amounts ---
async function doBuyWithConfirm(msg, slug, outcome, amount, maxPrice, marketLabel) {
  await msg.channel.sendTyping();
  const previewResult = await previewBuy(slug, outcome, amount, maxPrice);

  console.log(`[doBuyWithConfirm] preview ok=${previewResult.ok}`);
  console.log(`[doBuyWithConfirm] preview stdout (first 500): ${(previewResult.stdout || '').slice(0, 500)}`);

  const previewEmbed = buildPreviewEmbed({ slug, market: marketLabel, outcome, amount }, previewResult);
  await msg.channel.send({ embeds: [previewEmbed] });

  if (!previewResult.ok) {
    return;
  }

  // Extract price from preview
  const previewPrice = extractPrice(previewResult.stdout);
  const previewShares = extractShares(previewResult.stdout);

  console.log(`[doBuyWithConfirm] extracted price=${previewPrice}, shares=${previewShares}`);

  // THE FIX: round price to 2 decimals, find clean USDC amount
  let execAmount = amount;
  let execMaxPrice = maxPrice;

  if (previewPrice) {
    const clean = computeCleanBuyWithRoundedPrice(amount, previewPrice);
    execAmount = clean.amount;
    execMaxPrice = clean.price; // Always use rounded price as max-price

    if (clean.adjusted) {
      await msg.channel.send(`⚠️ Adjusted for CLOB precision: $${fmtAmount(clean.amount)} at ${fmtPrice(clean.price)} → ${fmtDisplay(clean.shares, 6)} shares (clean).`);
    } else if (clean.price && clean.price !== previewPrice) {
      await msg.channel.send(`⚠️ Using rounded price ${fmtPrice(clean.price)} (was ${previewPrice}) for CLOB precision.`);
    }
    console.log(`[doBuyWithConfirm] exec: amount=$${fmtAmount(execAmount)}, maxPrice=${execMaxPrice}`);
  } else {
    console.log(`[doBuyWithConfirm] could not extract price, using original amount and maxPrice`);
  }

  await msg.channel.send(`Type **y** to confirm this trade, or anything else to cancel (${confirmTimeoutSec}s timeout)...`);

  const confirmKey = msg.author.id;
  pendingConfirms.set(confirmKey, { slug, outcome, amount: execAmount, maxPrice: execMaxPrice, marketLabel, channelId: msg.channelId });

  try {
    const collected = await msg.channel.awaitMessages({
      filter: (m) => m.author.id === msg.author.id,
      max: 1,
      time: confirmTimeoutSec * 1000,
      errors: ['time'],
    });

    const response = collected.first();
    pendingConfirms.delete(confirmKey);

    if (response.content.trim().toLowerCase() === 'y' || response.content.trim().toLowerCase() === 'yes') {
      await msg.channel.send('⏳ Executing trade...');

      // Attempt 1: clean amount with rounded max-price
      console.log(`[doBuyWithConfirm] attempt 1: amount=$${fmtAmount(execAmount)}, maxPrice=${execMaxPrice}`);
      let execResult = await executeBuy(slug, outcome, execAmount, execMaxPrice);

      // Attempt 2: if decimal error, try without max-price
      if (!execResult.ok && isDecimalError(execResult)) {
        console.log(`[doBuyWithConfirm] attempt 1 failed with decimal error, retrying without --max-price`);
        await msg.channel.send('⚠️ Retrying without price limit...');
        execResult = await executeBuy(slug, outcome, execAmount, null);
      }

      // Attempt 3: try original amount with rounded max-price
      if (!execResult.ok && isDecimalError(execResult)) {
        console.log(`[doBuyWithConfirm] attempt 2 failed, trying original amount $${fmtAmount(amount)} with maxPrice=${execMaxPrice}`);
        await msg.channel.send('⚠️ Retrying with original amount...');
        execResult = await executeBuy(slug, outcome, amount, execMaxPrice);
      }

      // Attempt 4: try original amount without max-price
      if (!execResult.ok && isDecimalError(execResult)) {
        console.log(`[doBuyWithConfirm] attempt 3 failed, trying original amount without maxPrice`);
        execResult = await executeBuy(slug, outcome, amount, null);
      }

      // Attempt 5: try with ceil price instead of floor
      if (!execResult.ok && isDecimalError(execResult) && previewPrice) {
        const ceilPrice = Math.ceil(parseFloat(previewPrice) * 100) / 100;
        console.log(`[doBuyWithConfirm] attempt 4 failed, trying with ceil price ${ceilPrice}`);
        const clean2 = computeCleanBuyWithRoundedPrice(amount, ceilPrice);
        await msg.channel.send(`⚠️ Retrying with $${fmtAmount(clean2.amount)} at ${fmtPrice(clean2.price)}...`);
        execResult = await executeBuy(slug, outcome, clean2.amount, clean2.price);
      }

      const execEmbed = buildTradeEmbed({ slug, market: marketLabel, outcome, amount: execAmount }, execResult);
      await msg.channel.send({ embeds: [execEmbed] });
    } else {
      await msg.channel.send('❌ Trade cancelled.');
    }
  } catch (err) {
    pendingConfirms.delete(confirmKey);
    await msg.channel.send('⏰ Trade cancelled — confirmation timed out.');
  }
}

// --- Message handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== TRADE_CHANNEL_ID) return;

  const pending = pendingConfirms.get(msg.author.id);
  if (pending) return;

  const cmd = parseCommand(msg.content);
  if (!cmd) return;

  console.log(`Parsed command: ${JSON.stringify(cmd)}`);

  try {
    switch (cmd.type) {
      case 'help': {
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Bullpen Discord Bot Commands').setDescription([
          '**Natural Language (just paste it, no ! needed):**',
          '`Buy "Rinderknech" on Polymarket: https://polymarket.com/event/...` — Preview then confirm to buy $' + DEFAULT_BUY_AMOUNT + ' (default)',
          '`Buy "Rinderknech" on Polymarket: https://polymarket.com/event/... for $10` — Preview then confirm to buy $10',
          '`Buy $10 of "Rinderknech" on Polymarket: https://polymarket.com/event/...` — Preview then confirm to buy $10',
          '',
          '**Buying (shows preview, type y to confirm):**',
          '`!buy "Market Name" YES 10` — Preview then confirm to buy $10 of YES',
          '`!buy "Market Name" YES 10 --max-price 0.20` — Buy with max price limit',
          '`!buy "Rinderknech" https://polymarket.com/event/... 10` — Buy by Polymarket URL',
          '`!buy-url https://polymarket.com/event/... YES 10` — Buy by URL (outcome first)',
          '`!buy-slug market-slug YES 10` — Buy by exact slug',
          '',
          '**Previewing only (no money moves, no confirmation):**',
          '`!preview "Market Name" YES 10` — Preview a buy only',
          '`!preview-slug market-slug YES 10` — Preview by slug',
          '',
          '**Selling:**',
          '`!sell "Market Name" YES` — Sell all YES shares',
          '`!sell "Market Name" YES 50` — Sell 50 shares',
          '`!sell "Market Name" YES --preview` — Preview a sell',
          '`!sell-slug market-slug YES` — Sell by slug',
          '',
          '**Other:**',
          '`!search Trump election` — Search Polymarket markets',
          '`!status` — Check Bullpen CLI status',
          '`!positions` — View your Polymarket positions',
          '`!debug` — Show bot debug info',
          '`!help` — Show this help',
          '',
          `Default buy amount: $${DEFAULT_BUY_AMOUNT} (set DEFAULT_BUY_AMOUNT in .env)`,
          `Confirmation timeout: ${confirmTimeoutSec}s (set CONFIRM_TIMEOUT in .env)`,
        ].join('\n'))] });
        break;
      }

      case 'debug': {
        await msg.channel.sendTyping();
        const embed = new EmbedBuilder().setTimestamp().setColor(0x3498db).setTitle('Debug Info');
        embed.addFields(
          { name: 'BULLPEN_BIN', value: BULLPEN_BIN, inline: true },
          { name: 'resolvedBin', value: resolvedBin, inline: true },
          { name: 'BULLPEN_USE_WSL', value: String(useWsl), inline: true },
          { name: 'BULLPEN_HOME', value: BULLPEN_HOME || '(not set)', inline: true },
          { name: 'DEFAULT_BUY_AMOUNT', value: DEFAULT_BUY_AMOUNT, inline: true },
          { name: 'CONFIRM_TIMEOUT', value: String(confirmTimeoutSec) + 's', inline: true },
        );
        const verResult = await runBullpen(['--version']);
        if (verResult.ok) {
          embed.addFields({ name: 'bullpen --version', value: '```' + verResult.stdout.slice(0, 200) + '```' });
        } else {
          embed.addFields({ name: 'bullpen --version', value: '```' + (verResult.stderr || verResult.stdout || 'failed').slice(0, 200) + '```' });
        }
        await msg.reply({ embeds: [embed] });
        break;
      }

      case 'status': {
        await msg.channel.sendTyping();
        const result = await runBullpen(['status', '--output', 'json']);
        const summary = formatStatusSummary(result);
        await msg.reply({ embeds: [buildEmbedFromSummary(summary)] });
        break;
      }

      case 'positions': {
        await msg.channel.sendTyping();
        const result = await runBullpen(['polymarket', 'positions', '--output', 'json']);
        const summary = formatPositionsSummary(result);
        await msg.reply({ embeds: [buildEmbedFromSummary(summary)] });
        break;
      }

      case 'search': {
        await msg.channel.sendTyping();
        const result = await searchMarket(cmd.query);
        const embed = new EmbedBuilder().setTimestamp();
        if (result.ok) {
          embed.setColor(0x00ff00).setTitle(`Search: "${cmd.query}"`);
          const lines = result.markets.slice(0, 5).map((m, i) => {
            const slug = m.slug || m.market_slug || m.id || 'N/A';
            const title = m.title || m.question || m.name || 'Unknown';
            return `**${i + 1}.** ${title}\n   slug: \`${slug}\``;
          });
          embed.setDescription(lines.join('\n\n') || 'No results');
        } else {
          embed.setColor(0xff0000).setTitle('Search Failed').setDescription(result.error || 'Unknown error');
        }
        await msg.reply({ embeds: [embed] });
        break;
      }

      case 'buy-url': {
        await msg.channel.sendTyping();
        const extracted = extractSlugFromUrl(cmd.url);
        if (!extracted) {
          await msg.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('Invalid URL').setDescription('Could not extract slug from Polymarket URL')] });
          break;
        }

        await msg.reply(`Found ${extracted.type} slug: \`${extracted.slug}\`. Previewing buy **${cmd.outcome}** for $${fmtAmount(cmd.amount)}${cmd.maxPrice ? ` (max price $${fmtPrice(cmd.maxPrice)})` : ''}...`);

        const previewResult = await previewBuy(extracted.slug, cmd.outcome, cmd.amount, cmd.maxPrice);

        if (previewResult.ok) {
          await doBuyWithConfirm(msg, extracted.slug, cmd.outcome, cmd.amount, cmd.maxPrice, extracted.slug);
        } else {
          await msg.channel.send('Direct slug failed, searching for specific market...');
          const searchResult = await searchMarket(extracted.slug);
          if (searchResult.ok && searchResult.markets.length > 0) {
            const matching = searchResult.markets.find(m => {
              const title = (m.title || m.question || m.name || '').toLowerCase();
              return title.includes(cmd.outcome.toLowerCase());
            }) || searchResult.markets[0];
            const slug = matching.slug || matching.market_slug || matching.id;
            const title = matching.title || matching.question || matching.name || slug;
            await msg.channel.send(`Found market: **${title}** (slug: \`${slug}\`)`);
            await doBuyWithConfirm(msg, slug, cmd.outcome, cmd.amount, cmd.maxPrice, title);
          } else {
            await msg.channel.send('Search failed too. Attempting direct preview...');
            await doBuyWithConfirm(msg, extracted.slug, cmd.outcome, cmd.amount, cmd.maxPrice, extracted.slug);
          }
        }
        break;
      }

      case 'buy-slug': {
        await doBuyWithConfirm(msg, cmd.slug, cmd.outcome, cmd.amount, cmd.maxPrice, cmd.slug);
        break;
      }

      case 'buy': {
        await msg.channel.sendTyping();
        await msg.reply(`Searching for "${cmd.market}"...`);
        const searchResult = await searchMarket(cmd.market);
        if (!searchResult.ok) {
          await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('Market Not Found').setDescription(searchResult.error || 'No markets matched')] });
          break;
        }
        const first = searchResult.markets[0];
        const slug = first.slug || first.market_slug || first.id;
        if (!slug) {
          await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('No Slug Found').setDescription('Use `!buy-slug <slug> <outcome> <amount>` instead.')] });
          break;
        }
        const title = first.title || first.question || first.name || slug;
        await msg.channel.send(`Found: **${title}** (slug: \`${slug}\`)`);
        await doBuyWithConfirm(msg, slug, cmd.outcome, cmd.amount, cmd.maxPrice, title);
        break;
      }

      case 'preview-slug': {
        await msg.channel.sendTyping();
        await msg.reply(`Previewing: buy ${cmd.outcome} on \`${cmd.slug}\` for $${fmtAmount(cmd.amount)}${cmd.maxPrice ? ` (max price $${fmtPrice(cmd.maxPrice)})` : ''}...`);
        const result = await previewBuy(cmd.slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        const embed = buildPreviewEmbed({ ...cmd, market: cmd.slug }, result);
        await msg.channel.send({ embeds: [embed] });
        break;
      }

      case 'preview': {
        await msg.channel.sendTyping();
        await msg.reply(`Searching for "${cmd.market}"...`);
        const searchResult = await searchMarket(cmd.market);
        if (!searchResult.ok) {
          await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('Market Not Found').setDescription(searchResult.error || 'No markets matched')] });
          break;
        }
        const first = searchResult.markets[0];
        const slug = first.slug || first.market_slug || first.id;
        if (!slug) {
          await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('No Slug Found').setDescription('Use `!preview-slug <slug> <outcome> <amount>` instead.')] });
          break;
        }
        const title = first.title || first.question || first.name || slug;
        await msg.channel.send(`Found: **${title}** (slug: \`${slug}\`). Previewing buy ${cmd.outcome} for $${fmtAmount(cmd.amount)}...`);
        const result = await previewBuy(slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        const embed = buildPreviewEmbed({ ...cmd, slug, market: title }, result);
        await msg.channel.send({ embeds: [embed] });
        break;
      }

      case 'sell-slug': {
        await msg.channel.sendTyping();
        const sellStr = cmd.sellAmount === 'max' ? 'all' : `${cmd.sellAmount} shares`;
        await msg.reply(`Executing: sell ${sellStr} of ${cmd.outcome} on \`${cmd.slug}\`${cmd.preview ? ' (preview)' : ''}...`);
        const result = await sellShares(cmd.slug, cmd.outcome, cmd.sellAmount, cmd.preview);
        const embed = buildSellEmbed({ ...cmd, market: cmd.slug, outcome: cmd.outcome, amount: cmd.sellAmount }, result, cmd.preview);
        await msg.channel.send({ embeds: [embed] });
        break;
      }

      case 'sell': {
        await msg.channel.sendTyping();
        await msg.reply(`Searching for "${cmd.market}"...`);
        const searchResult = await searchMarket(cmd.market);
        if (!searchResult.ok) {
          await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('Market Not Found').setDescription(searchResult.error || 'No markets matched')] });
          break;
        }
        const first = searchResult.markets[0];
        const slug = first.slug || first.market_slug || first.id;
        if (!slug) {
          await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('No Slug Found').setDescription('Use `!sell-slug <slug> <outcome>` instead.')] });
          break;
        }
        const title = first.title || first.question || first.name || slug;
        const sellStr = cmd.sellAmount === 'max' ? 'all' : `${cmd.sellAmount} shares`;
        await msg.channel.send(`Found: **${title}** (slug: \`${slug}\`). Selling ${sellStr} of ${cmd.outcome}${cmd.preview ? ' (preview)' : ''}...`);
        const sellResult = await sellShares(slug, cmd.outcome, cmd.sellAmount, cmd.preview);
        const embed = buildSellEmbed({ ...cmd, slug, market: title, outcome: cmd.outcome, amount: cmd.sellAmount }, sellResult, cmd.preview);
        await msg.channel.send({ embeds: [embed] });
        break;
      }
    }
  } catch (err) {
    console.error('Handler error:', err);
    await msg.reply(`Error: ${err.message}`).catch(() => {});
  }
});

client.once('ready', async () => {
  console.log(`Bullpen Discord bot online — listening in channel ${TRADE_CHANNEL_ID}`);
  if (useWsl) console.log('WSL2 mode: bullpen commands routed through `wsl -e bullpen`');
  resolvedBin = await resolveBullpenPath();
  console.log(`Using bullpen binary: ${resolvedBin}`);
  console.log(`Default buy amount: $${DEFAULT_BUY_AMOUNT}`);
  console.log(`Confirmation timeout: ${confirmTimeoutSec}s`);
});

client.login(DISCORD_BOT_TOKEN);
