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
} = process.env;

if (!DISCORD_BOT_TOKEN) { console.error('Missing DISCORD_BOT_TOKEN'); process.exit(1); }
if (!TRADE_CHANNEL_ID) { console.error('Missing TRADE_CHANNEL_ID'); process.exit(1); }

const useWsl = BULLPEN_USE_WSL.toLowerCase() === 'true';

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

  try {
    const { stdout } = await execFileAsync(bin, binArgs, {
      env, timeout: 60000, maxBuffer: 1024 * 1024 * 5,
    });
    return { ok: true, stdout };
  } catch (err) {
    const realError = err.stderr || err.stdout || err.message;
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

// --- Buy shares ---
async function buyShares(slug, outcome, amount, maxPrice) {
  const args = ['trade', 'buy', slug, outcome, String(amount)];
  if (maxPrice) args.push('--max-price', String(maxPrice));
  args.push('--yes', '--output', 'json');
  return runBullpen(args);
}

// --- Preview buy ---
async function previewBuy(slug, outcome, amount, maxPrice) {
  const args = ['trade', 'buy', slug, outcome, String(amount)];
  if (maxPrice) args.push('--max-price', String(maxPrice));
  args.push('--preview', '--output', 'json');
  return runBullpen(args);
}

// --- Sell shares ---
async function sellShares(slug, outcome, maxShares, preview) {
  const args = ['trade', 'sell', slug, outcome];
  if (maxShares === 'max') args.push('--max');
  else if (maxShares) args.push(String(maxShares));
  if (preview) args.push('--preview');
  else args.push('--yes');
  args.push('--output', 'json');
  return runBullpen(args);
}

// --- Parse JSON output from bullpen and extract key fields ---
function parseBullpenResult(stdout) {
  try {
    const data = JSON.parse(stdout);
    return data;
  } catch {
    return null;
  }
}

// --- Format trade result as short human-readable summary ---
function formatTradeSummary(cmd, result, isPreview) {
  const data = parseBullpenResult(result.stdout);

  if (!result.ok) {
    // Error — try to extract a short message
    let errMsg = 'Unknown error';
    if (data && data.error) errMsg = data.error;
    else if (data && data.message) errMsg = data.message;
    else {
      // try to extract first line of stderr/stdout
      const raw = (result.stderr || result.stdout || '').trim();
      const firstLine = raw.split('\n')[0];
      if (firstLine) errMsg = firstLine.slice(0, 200);
    }
    return { color: 0xff0000, title: '❌ Trade Failed', fields: [
      { name: 'Error', value: `\`${errMsg}\``, inline: false },
    ]};
  }

  // Success — extract key fields from JSON
  const market = data?.market || data?.market_slug || data?.slug || cmd.slug || cmd.market || 'N/A';
  const outcome = data?.outcome || data?.side || cmd.outcome || 'N/A';
  const amount = data?.amount || data?.size || data?.cost || data?.usdc || cmd.amount || 'N/A';
  const shares = data?.shares || data?.fill_amount || data?.filled || data?.amount_bought || 'N/A';
  const price = data?.price || data?.avg_price || data?.fill_price || data?.execution_price || null;
  const orderId = data?.order_id || data?.id || data?.tx || data?.tx_hash || null;
  const status = data?.status || (isPreview ? 'preview' : 'filled');

  const fields = [];

  // Market line
  fields.push({ name: 'Market', value: `\`${String(market).slice(0, 100)}\``, inline: true });
  // Outcome
  fields.push({ name: 'Outcome', value: String(outcome), inline: true });
  // Amount spent
  fields.push({ name: 'Spent', value: amount !== 'N/A' ? `$${amount}` : 'N/A', inline: true });

  // Shares received
  if (shares !== 'N/A') {
    fields.push({ name: 'Shares', value: String(shares), inline: true });
  }
  // Price
  if (price !== null) {
    fields.push({ name: 'Price', value: `$${price}`, inline: true });
  }
  // Status
  fields.push({ name: 'Status', value: isPreview ? '📋 Preview' : '✅ Filled', inline: true });

  // Order ID (if present, short)
  if (orderId) {
    fields.push({ name: 'Order ID', value: `\`${String(orderId).slice(0, 50)}\``, inline: true });
  }

  const color = isPreview ? 0x3498db : 0x00ff00;
  const title = isPreview ? '📋 Trade Preview' : '✅ Trade Executed';

  return { color, title, fields };
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
    fields.push({ name: 'USDC Balance', value: `$${bal}`, inline: true });
  }
  if (data?.network || data?.chain) {
    fields.push({ name: 'Network', value: String(data.network || data.chain), inline: true });
  }

  // If we couldn't parse structured data, show a short text snippet
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

  // Try to extract positions array
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

    let line = `**${market}**\n${outcome} | ${shares} shares`;
    if (value !== 'N/A') line += ` | $${value}`;
    if (pnl !== null) line += ` | PnL: $${pnl}`;

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

  // ==========================================
  // NATURAL LANGUAGE (no ! prefix needed)
  // ==========================================

  // Buy "Rinderknech" on Polymarket: https://polymarket.com/event/... for $10
  let m = t.match(/^Buy\s+"([^"]+)"\s+on\s+Polymarket:?\s+(https?:\/\/\S+)\s+for\s+\$([\d.]+)/i);
  if (m) return { type: 'buy-url', outcome: m[1], url: m[2], amount: parseFloat(m[3]), maxPrice: null, natural: true };

  // Buy $10 of "Rinderknech" on Polymarket: https://polymarket.com/event/...
  m = t.match(/^Buy\s+\$([\d.]+)\s+of\s+"([^"]+)"\s+on\s+Polymarket:?\s+(https?:\/\/\S+)/i);
  if (m) return { type: 'buy-url', outcome: m[2], url: m[3], amount: parseFloat(m[1]), maxPrice: null, natural: true };

  // Buy "Rinderknech" on Polymarket: https://polymarket.com/event/...
  m = t.match(/^Buy\s+"([^"]+)"\s+on\s+Polymarket:?\s+(https?:\/\/\S+)/i);
  if (m) return { type: 'buy-url', outcome: m[1], url: m[2], amount: parseFloat(DEFAULT_BUY_AMOUNT), maxPrice: null, natural: true };

  // ==========================================
  // ! COMMANDS (require ! prefix)
  // ==========================================
  if (!t.startsWith('!')) return null;

  // !buy-url <url> <outcome> <amount> [--max-price 0.20]
  m = t.match(/^!buy-url\s+(https?:\/\/\S+)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy-url', url: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !buy "Rinderknech" https://polymarket.com/event/... 10 [--max-price 0.20]
  m = t.match(/^!buy\s+"([^"]+)"\s+(https?:\/\/\S+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy-url', outcome: m[1].toUpperCase(), url: m[2], amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !buy "Market Name" YES 10 [--max-price 0.20]
  m = t.match(/^!buy\s+"([^"]+)"\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy', market: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !buy Market Name YES 10 (no quotes)
  m = t.match(/^!buy\s+(.+?)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy', market: m[1].trim(), outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !buy-slug market-slug YES 10 [--max-price 0.20]
  m = t.match(/^!buy-slug\s+(\S+)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'buy-slug', slug: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !preview "Market Name" YES 10 [--max-price 0.20]
  m = t.match(/^!preview\s+"([^"]+)"\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'preview', market: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !preview-slug market-slug YES 10 [--max-price 0.20]
  m = t.match(/^!preview-slug\s+(\S+)\s+(\w+)\s+([\d.]+)(?:\s+--max-price\s+([\d.]+))?$/i);
  if (m) return { type: 'preview-slug', slug: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]), maxPrice: m[4] ? parseFloat(m[4]) : null };

  // !sell "Market Name" YES [max|amount] [--preview]
  m = t.match(/^!sell\s+"([^"]+)"\s+(\w+)(?:\s+(max|[\d.]+))?(?:\s+--preview)?$/i);
  if (m) return { type: 'sell', market: m[1], outcome: m[2].toUpperCase(), sellAmount: m[3] || 'max', preview: /--preview/i.test(t) };

  // !sell-slug market-slug YES [max|amount] [--preview]
  m = t.match(/^!sell-slug\s+(\S+)\s+(\w+)(?:\s+(max|[\d.]+))?(?:\s+--preview)?$/i);
  if (m) return { type: 'sell-slug', slug: m[1], outcome: m[2].toUpperCase(), sellAmount: m[3] || 'max', preview: /--preview/i.test(t) };

  // !search bitcoin
  m = t.match(/^!search\s+(.+)$/i);
  if (m) return { type: 'search', query: m[1] };

  if (/^!status$/i.test(t)) return { type: 'status' };
  if (/^!positions$/i.test(t)) return { type: 'positions' };
  if (/^!debug$/i.test(t)) return { type: 'debug' };
  if (/^!help$/i.test(t)) return { type: 'help' };

  return null;
}

// --- Build embed from summary ---
function buildEmbedFromSummary(summary) {
  const embed = new EmbedBuilder().setTimestamp();
  embed.setColor(summary.color).setTitle(summary.title);
  embed.addFields(...summary.fields);
  return embed;
}

// --- Message handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== TRADE_CHANNEL_ID) return;

  const cmd = parseCommand(msg.content);
  if (!cmd) return;

  console.log(`Parsed command: ${JSON.stringify(cmd)}`);

  try {
    switch (cmd.type) {
      case 'help': {
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Bullpen Discord Bot Commands').setDescription([
          '**Natural Language (just paste it, no ! needed):**',
          '`Buy "Rinderknech" on Polymarket: https://polymarket.com/event/...` — Buy $' + DEFAULT_BUY_AMOUNT + ' (default)',
          '`Buy "Rinderknech" on Polymarket: https://polymarket.com/event/... for $10` — Buy $10',
          '`Buy $10 of "Rinderknech" on Polymarket: https://polymarket.com/event/...` — Buy $10',
          '',
          '**Buying:**',
          '`!buy "Market Name" YES 10` — Buy $10 of YES (auto-searches)',
          '`!buy "Market Name" YES 10 --max-price 0.20` — Buy with max price limit',
          '`!buy "Rinderknech" https://polymarket.com/event/... 10` — Buy by Polymarket URL',
          '`!buy-url https://polymarket.com/event/... YES 10` — Buy by URL (outcome first)',
          '`!buy-slug market-slug YES 10` — Buy by exact slug',
          '',
          '**Previewing (no money moves):**',
          '`!preview "Market Name" YES 10` — Preview a buy',
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

        await msg.reply(`Found ${extracted.type} slug: \`${extracted.slug}\`. Buying **${cmd.outcome}** for $${cmd.amount}${cmd.maxPrice ? ` (max price $${cmd.maxPrice})` : ''}...`);

        const buyResult = await buyShares(extracted.slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        if (buyResult.ok) {
          const summary = formatTradeSummary({ ...cmd, slug: extracted.slug }, buyResult);
          await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
        } else {
          // If direct slug fails, try searching for the market
          await msg.channel.send('Direct slug failed, searching for specific market...');
          const searchResult = await searchMarket(extracted.slug);
          if (searchResult.ok && searchResult.markets.length > 0) {
            const matching = searchResult.markets.find(m => {
              const title = (m.title || m.question || m.name || '').toLowerCase();
              return title.includes(cmd.outcome.toLowerCase());
            }) || searchResult.markets[0];
            const slug = matching.slug || matching.market_slug || matching.id;
            const title = matching.title || matching.question || matching.name || slug;
            await msg.channel.send(`Found market: **${title}** (slug: \`${slug}\`). Executing buy ${cmd.outcome} for $${cmd.amount}...`);
            const retryResult = await buyShares(slug, cmd.outcome, cmd.amount, cmd.maxPrice);
            const summary = formatTradeSummary({ ...cmd, slug }, retryResult);
            await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
          } else {
            await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTimestamp().setTitle('Market Not Found').setDescription(`Could not find a market for \`${extracted.slug}\`. Try \`!buy-slug ${extracted.slug} ${cmd.outcome} ${cmd.amount}\` manually.`)] });
          }
        }
        break;
      }

      case 'buy-slug': {
        await msg.channel.sendTyping();
        await msg.reply(`Executing: buy ${cmd.outcome} on \`${cmd.slug}\` for $${cmd.amount}${cmd.maxPrice ? ` (max price $${cmd.maxPrice})` : ''}...`);
        const result = await buyShares(cmd.slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        const summary = formatTradeSummary({ ...cmd, market: cmd.slug }, result);
        await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
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
        await msg.channel.send(`Found: **${title}** (slug: \`${slug}\`). Executing buy ${cmd.outcome} for $${cmd.amount}${cmd.maxPrice ? ` (max price $${cmd.maxPrice})` : ''}...`);
        const buyResult = await buyShares(slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        const summary = formatTradeSummary({ ...cmd, slug }, buyResult);
        await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
        break;
      }

      case 'preview-slug': {
        await msg.channel.sendTyping();
        await msg.reply(`Previewing: buy ${cmd.outcome} on \`${cmd.slug}\` for $${cmd.amount}${cmd.maxPrice ? ` (max price $${cmd.maxPrice})` : ''}...`);
        const result = await previewBuy(cmd.slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        const summary = formatTradeSummary({ ...cmd, market: cmd.slug }, result, true);
        await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
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
        await msg.channel.send(`Found: **${title}** (slug: \`${slug}\`). Previewing buy ${cmd.outcome} for $${cmd.amount}...`);
        const previewResult = await previewBuy(slug, cmd.outcome, cmd.amount, cmd.maxPrice);
        const summary = formatTradeSummary({ ...cmd, slug }, previewResult, true);
        await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
        break;
      }

      case 'sell-slug': {
        await msg.channel.sendTyping();
        const sellStr = cmd.sellAmount === 'max' ? 'all' : `${cmd.sellAmount} shares`;
        await msg.reply(`Executing: sell ${sellStr} of ${cmd.outcome} on \`${cmd.slug}\`${cmd.preview ? ' (preview)' : ''}...`);
        const result = await sellShares(cmd.slug, cmd.outcome, cmd.sellAmount, cmd.preview);
        const summary = formatTradeSummary({ ...cmd, market: cmd.slug, outcome: cmd.outcome, amount: cmd.sellAmount }, result, cmd.preview);
        await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
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
        const summary = formatTradeSummary({ ...cmd, slug, market: cmd.market, outcome: cmd.outcome, amount: cmd.sellAmount }, sellResult, cmd.preview);
        await msg.channel.send({ embeds: [buildEmbedFromSummary(summary)] });
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
});

client.login(DISCORD_BOT_TOKEN);
