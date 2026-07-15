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
} = process.env;

if (!DISCORD_BOT_TOKEN) { console.error('Missing DISCORD_BOT_TOKEN'); process.exit(1); }
if (!TRADE_CHANNEL_ID) { console.error('Missing TRADE_CHANNEL_ID'); process.exit(1); }

const useWsl = BULLPEN_USE_WSL.toLowerCase() === 'true';

// --- Auto-detect bullpen binary path ---
let resolvedBin = BULLPEN_BIN;
async function resolveBullpenPath() {
  // Try the configured bin first
  try {
    await execFileAsync(BULLPEN_BIN, ['--version'], { timeout: 5000 });
    console.log(`Bullpen found: ${BULLPEN_BIN}`);
    return BULLPEN_BIN;
  } catch {}

  // Try common install locations
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

  // Try `which bullpen` via shell
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

// --- Bullpen CLI helper ---
async function runBullpen(args) {
  const env = { ...process.env };
  if (BULLPEN_HOME) env.BULLPEN_HOME = BULLPEN_HOME;
  if (BULLPEN_ENV) env.BULLPEN_ENV = BULLPEN_ENV;
  env.BULLPEN_NON_INTERACTIVE = '1';

  // Make sure common bin dirs are in PATH
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
    // err.message is usually "Command failed: ..." — get the real error
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
async function buyShares(slug, outcome, amount) {
  return runBullpen(['trade', 'buy', slug, outcome, String(amount), '--yes', '--output', 'json']);
}

// --- Parse commands ---
function parseCommand(content) {
  const t = content.trim();
  if (!t.startsWith('!')) return null;

  let m = t.match(/^!buy\s+"([^"]+)"\s+(\w+)\s+([\d.]+)$/i);
  if (m) return { type: 'buy', market: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]) };

  m = t.match(/^!buy\s+(.+?)\s+(\w+)\s+([\d.]+)$/i);
  if (m) return { type: 'buy', market: m[1].trim(), outcome: m[2].toUpperCase(), amount: parseFloat(m[3]) };

  m = t.match(/^!buy-slug\s+(\S+)\s+(\w+)\s+([\d.]+)$/i);
  if (m) return { type: 'buy-slug', slug: m[1], outcome: m[2].toUpperCase(), amount: parseFloat(m[3]) };

  m = t.match(/^!trade\s+buy\s+\$([\d.]+)\s+of\s+(\w+)\s+on\s+"([^"]+)"$/i);
  if (m) return { type: 'buy', market: m[3], outcome: m[2].toUpperCase(), amount: parseFloat(m[1]) };

  m = t.match(/^!trade\s+buy\s+\$([\d.]+)\s+of\s+(\w+)\s+on\s+(.+)$/i);
  if (m) return { type: 'buy', market: m[3].trim(), outcome: m[2].toUpperCase(), amount: parseFloat(m[1]) };

  m = t.match(/^!search\s+(.+)$/i);
  if (m) return { type: 'search', query: m[1] };

  if (/^!status$/i.test(t)) return { type: 'status' };
  if (/^!positions$/i.test(t)) return { type: 'positions' };
  if (/^!debug$/i.test(t)) return { type: 'debug' };
  if (/^!help$/i.test(t)) return { type: 'help' };

  return null;
}

// --- Trade result embed ---
function buildTradeEmbed(cmd, result) {
  const embed = new EmbedBuilder().setTimestamp();
  if (result.ok) {
    let fillInfo = '';
    try {
      const data = JSON.parse(result.stdout);
      fillInfo = data.order || data.trade || data;
    } catch { fillInfo = result.stdout.slice(0, 500); }
    embed.setColor(0x00ff00).setTitle('Trade Executed').addFields(
      { name: 'Market', value: cmd.slug || cmd.market || 'N/A', inline: true },
      { name: 'Outcome', value: cmd.outcome, inline: true },
      { name: 'Amount', value: `$${cmd.amount}`, inline: true },
      { name: 'Result', value: '```' + (typeof fillInfo === 'string' ? fillInfo : JSON.stringify(fillInfo, null, 2)).slice(0, 1000) + '```' },
    );
  } else {
    embed.setColor(0xff0000).setTitle('Trade Failed').addFields(
      { name: 'Market', value: cmd.slug || cmd.market || 'N/A', inline: true },
      { name: 'Outcome', value: cmd.outcome, inline: true },
      { name: 'Amount', value: `$${cmd.amount}`, inline: true },
      { name: 'Error', value: '```' + (result.stderr || result.stdout || 'Unknown error').slice(0, 1000) + '```' },
    );
  }
  return embed;
}

// --- Message handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== TRADE_CHANNEL_ID) return;

  const cmd = parseCommand(msg.content);
  if (!cmd) return;

  try {
    switch (cmd.type) {
      case 'help': {
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Bullpen Discord Bot Commands').setDescription([
          '`!buy "Market Name" YES 10` — Buy $10 of YES on the named market',
          '`!buy-slug market-slug YES 10` — Buy by exact slug',
          '`!trade buy $10 of YES on "Market Name"` — Natural language buy',
          '`!search Trump election` — Search Polymarket markets',
          '`!status` — Check Bullpen CLI status',
          '`!positions` — View your Polymarket positions',
          '`!debug` — Show bot debug info (bullpen path, env, etc.)',
          '`!help` — Show this help',
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
          { name: 'PATH', value: '```' + (process.env.PATH || '').slice(0, 500) + '```' },
        );
        // Try running bullpen --version
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
        const embed = new EmbedBuilder().setTimestamp();
        if (result.ok) {
          embed.setColor(0x00ff00).setTitle('Bullpen Status').setDescription('```' + result.stdout.slice(0, 1500) + '```');
        } else {
          embed.setColor(0xff0000).setTitle('Bullpen Status Error').setDescription('```' + (result.stderr || result.stdout).slice(0, 1500) + '```');
        }
        await msg.reply({ embeds: [embed] });
        break;
      }

      case 'positions': {
        await msg.channel.sendTyping();
        const result = await runBullpen(['polymarket', 'positions', '--output', 'json']);
        const embed = new EmbedBuilder().setTimestamp();
        if (result.ok) {
          embed.setColor(0x00ff00).setTitle('Polymarket Positions').setDescription('```' + result.stdout.slice(0, 1500) + '```');
        } else {
          embed.setColor(0xff0000).setTitle('Positions Error').setDescription('```' + (result.stderr || result.stdout).slice(0, 1500) + '```');
        }
        await msg.reply({ embeds: [embed] });
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

      case 'buy-slug': {
        await msg.channel.sendTyping();
        await msg.reply(`Executing: buy ${cmd.outcome} on \`${cmd.slug}\` for $${cmd.amount}...`);
        const result = await buyShares(cmd.slug, cmd.outcome, cmd.amount);
        await msg.channel.send({ embeds: [buildTradeEmbed({ ...cmd, market: cmd.slug }, result)] });
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
        await msg.channel.send(`Found: **${title}** (slug: \`${slug}\`). Executing buy ${cmd.outcome} for $${cmd.amount}...`);
        const buyResult = await buyShares(slug, cmd.outcome, cmd.amount);
        await msg.channel.send({ embeds: [buildTradeEmbed({ ...cmd, slug }, buyResult)] });
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
  // Resolve bullpen path on startup
  resolvedBin = await resolveBullpenPath();
  console.log(`Using bullpen binary: ${resolvedBin}`);
});

client.login(DISCORD_BOT_TOKEN);
