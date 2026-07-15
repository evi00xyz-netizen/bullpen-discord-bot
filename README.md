# Bullpen Discord Bot

A Discord bot that reads trade commands from chat and executes them on Polymarket via the [Bullpen CLI](https://bullpen.fi/).

## How it works

1. You text a trade command in your Discord channel
2. The bot searches Polymarket via the Bullpen CLI
3. It extracts the market slug
4. It executes `bullpen trade buy <slug> <outcome> <amount> --yes --output json`
5. It posts the fill result back to Discord as an embed

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Bullpen CLI](https://bullpen.fi/) installed and logged in
- A Discord bot with Message Content Intent enabled

## Setup

### 1. Install Bullpen CLI

```bash
curl -fsSL https://raw.githubusercontent.com/BullpenFi/bullpen-cli-releases/main/install.sh | bash
bullpen login
bullpen status
```

### 2. Create a Discord bot

1. Go to https://discord.com/developers/applications
2. Create a new application
3. Go to the "Bot" tab and create a bot
4. Enable **Message Content Intent** under "Privileged Gateway Intents"
5. Copy the bot token
6. Go to "OAuth2 > URL Generator", select `bot` scope and "Send Messages" + "Read Message History" permissions
7. Open the generated URL to invite the bot to your server
8. Copy the channel ID of the channel where you want the bot to listen (enable Developer Mode in Discord settings, right-click the channel, "Copy Channel ID")

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:
- `DISCORD_BOT_TOKEN` — your Discord bot token
- `TRADE_CHANNEL_ID` — the channel ID where the bot listens
- `BULLPEN_HOME` — path to your Bullpen config directory (usually `~/.bullpen`)

### 4. Install and run

```bash
npm install
npm start
```

### Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
```

Note: You need to run `bullpen login` inside the container first to authenticate:
```bash
docker compose exec bullpen-bot bullpen login
```

### PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Commands

| Command | Description |
|---------|-------------|
| `!buy "Market Name" YES 10` | Buy $10 of YES on the named market (auto-searches) |
| `!buy-slug market-slug YES 10` | Buy by exact Polymarket slug |
| `!trade buy $10 of YES on "Market Name"` | Natural language buy |
| `!search bitcoin` | Search Polymarket markets |
| `!status` | Check Bullpen CLI login status |
| `!positions` | View your Polymarket positions |
| `!help` | Show all commands |

## Examples

```
!buy "Will Trump win 2024" YES 10
!buy-slug will-trump-win-2024 YES 10
!trade buy $50 of NO on "Bitcoin above 100k"
!search ethereum
!status
!positions
```

## Security

- Never commit `.env` — it's in `.gitignore`
- The bot only listens in the channel specified by `TRADE_CHANNEL_ID`
- Bullpen login session is stored in `BULLPEN_HOME` directory

## License

MIT
