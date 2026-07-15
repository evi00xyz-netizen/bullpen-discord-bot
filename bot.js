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

function roundAmount(amount) {
  return Math.round(parseFloat(amount) * 100) / 100;
}

function fmtAmount(amount) {
  return roundAmount(amount).toFixed(2);
}

function fmtPrice(price) {
  return (Math.round(parseFloat(price) * 100) / 100).toFixed(2);
}

function fmtDisplay(value, decimals = 2) {
  const n = parseFloat(value);
  if (isNaN(n)) return String(value);
  return parseFloat(n.toFixed(decimals)).toString();
}

// --- THE FIX: round price UP (ceil) to 2 decimals for --max-price ---
// This ensures the actual fill price stays UNDER the max-price limit.
// Then find a clean USDC amount where shares = amount/price has ≤6 decimals.
//
// Math: price P (2 decimals) = p/100 where p is integer (e.g. 0.89 → p=89)
//       amount A (2 decimals) = a/100 where a is integer (e.g. $1.78 → a=178)
//       shares = A/P = (a/100)/(p/100) = a/p
//       For shares to have ≤6 decimals: (a * 1e6) mod p == 0
function computeCleanBuy(targetAmount, rawPrice) {
  const target = roundAmount(targetAmount);
  const targetCents = Math.round(target * 100);

  // Always ceil the price so fill price stays under max-price
  const ceilPrice = Math.ceil(parseFloat(rawPrice) * 100) / 100;

  console.log(`[computeCleanBuy] target=$${target.toFixed(2)}, rawPrice=${rawPrice}, ceilPrice=${ceilPrice}`);

  if (ceilPrice <= 0 || ceilPrice >= 1) {
    console.log(`[computeCleanBuy] invalid ceilPrice ${ceilPrice}, falling back`);
    return { amount: target, price: null, shares: null, adjusted: false };
  }

  const p = Math.round(ceilPrice * 100); // integer price in cents

  // Check if target itself is clean
  if ((targetCents * 1e6) % p === 0) {
    const shares = targetCents / p;
    console.log(`[computeCleanBuy] EXACT: price=${ceilPrice}, $${target.toFixed(2)} → ${shares} shares`);
    return { amount: target, price: ceilPrice, shares, adjusted: false };
  }

  // Search outward in 1-cent increments for a clean amount
  for (let delta = 1; delta <= 10000; delta++) {
    for (const sign of [1, -1]) {
      const testCents = targetCents + sign * delta;
      if (testCents <= 0) continue;
      if ((testCents * 1e6) % p === 0) {
        const testAmount = testCents / 100;
        const shares = testCents / p;
        console.log(`[computeCleanBuy] FOUND: price=${ceilPrice}, $${testAmount.toFixed(2)} → ${shares} shares (delta=${sign * delta}¢)`);
        return { amount: testAmount, price: ceilPrice, shares, adjusted: true };
      }
    }
  }

  console.log(`[computeCleanBuy] NO clean amount found, falling back to original`);
  return { amount: target, price: ceilPrice, shares: null, adjusted: false };
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

const pendingConfirms = new Map();

function extractSlugFromUrl(url) {
  let m = url.match(/polymarket\.com\/event\/([^\s?]+)/i);
  if (m) return { slug: m[1], type: 'event' };
  m = url.match(/polymarket\.com\/market\/([^\s?]+)/i);
  if (m) return { slug: m[1], type: 'market' };
  return null;
}

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

async function previewBuy(slug, outcome, amount, maxPrice) {
  const args = ['polymarket', 'buy', slug, outcome, fmtAmount(amount)];
  if (maxPrice) args.push('--max-price', fmtPrice(maxPrice));
  args.push('--preview', '--output', 'json');
  return runBullpen(args);
}

async function executeBuy(slug, outcome, amount, maxPrice) {
  const args = ['polymarket', 'buy', slug, outcome, fmtAmount(amount)];
  if (maxPrice) args.push('--max-price', fmtPrice(maxPrice));
  args.push('--yes', '--output', 'json');
  return runBullpen(args);
}

async function sellShares(slug, outcome, maxShares, preview) {
  const args = ['polymarket', 'sell', slug, outcome];
  if (maxShares === 'max') args.push('--max');
  else if (maxShares) args.push(fmtAmount(maxShares));
  if (preview) args.push('--preview');
  else args.push('--yes');
  args.push('--output', 'json');
  return runBullpen(args);
}

function parseBullpenResult(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

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

function isDecimalError(result) {
  const text = ((result.stderr || '') + ' ' + (result.stdout || '')