# Dyna-Nutrition WhatsApp Bot

A sophisticated WhatsApp chatbot for Dyna-Nutrition with AI-powered responses using DeepSeek API, featuring live website search, product lookup, price checking, store location services, and human agent handoff capabilities.

## Features

### Core Capabilities
- **AI-Powered Responses**: Intelligent conversation handling via DeepSeek API with context awareness
- **Live Website Search**: Real-time scraping of dyna-nutrition.com for up-to-date product information
- **Product Information Lookup**: Access to local knowledge base and product configurations
- **Price Checking API**: Integration with external price lookup service (Singapore phone numbers)
- **Store Locator**: Find nearby retail stores carrying Dyna-Nutrition products
- **Human Agent Handoff**: Seamless escalation to human representatives with working hours detection
- **Persistent Memory**: Conversation history and product tracking per user
- **Contact Caching**: Efficient phone number storage for returning users

### Smart Features
- **Working Hours Detection**: Automatically informs users outside business hours before escalation
- **Session Management**: Track and manage active human agent sessions
- **Message Chunking**: Automatic splitting of long messages for WhatsApp compatibility
- **Auto-Reconnect**: Exponential backoff retry logic for connection stability
- **Rate Limiting**: Built-in cooldown to prevent message flooding

## Project Structure

```
/workspace
├── index.js                 # Main entry point
├── bot/
│   └── whatsappBot.js       # WhatsApp client & message handling
├── config/
│   ├── botConfig.js         # Web scraping & response templates
│   ├── knowledgeBase.json   # Local knowledge base
│   ├── brochures/           # Brochure PDFs
│   └── products/            # Product configuration files
├── services/
│   ├── deepseek.js          # AI response generation
│   ├── intentManager.js     # User intent detection
│   ├── knowledgeLoader.js   # Load knowledge base
│   ├── priceApi.js          # Price lookup service
│   └── storeLocator.js      # Store finder service
├── utils/
│   ├── brochures.js         # Brochure handling
│   ├── contactCache.js      # Contact info caching
│   ├── humanHandoff.js      # Human escalation logic
│   ├── keepAlive.js         # Heartbeat utility
│   └── memory.js            # Conversation memory
└── .env.example             # Environment template
```

## Setup Instructions

### Prerequisites
- Node.js 16 or higher
- npm or yarn package manager
- WhatsApp account (for QR code authentication)
- DeepSeek API key ([get from platform.deepseek.com](https://platform.deepseek.com/))

### Installation

1. **Clone and install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```

3. **Edit `.env` and add your DeepSeek API key**
   ```env
   DEEPSEEK_API_KEY=your_api_key_here
   ```

4. **Start the bot**
   ```bash
   npm start
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

5. **Scan QR code** when prompted to link your WhatsApp account

## Commands

### User Commands
- `!bot` - Switch back to bot mode (exit human agent session)

### Admin Commands
- `!status` - View all active human agent sessions with details
- `!close <phone>` - Close a specific human session by phone number
- `!closeall` - Close all active human sessions

### Example Admin Workflow
```
Admin: !status
Bot: 📋 Active human sessions (3):
     📱 [1] 6591234567
        Agent: default
        Last: 5 min ago
        Command: !close 6591234567
     
     📱 [2] 60123456789
        Agent: escalation
        Last: 12 min ago
        Command: !close 60123456789
     
     Copy the command above to close a session.

Admin: !close 6591234567
Bot: ✅ Session closed for 6591234567. Bot active.
```

## Configuration

### Working Hours (Human Handoff)
The bot automatically detects working hours for escalations. Configure in `utils/humanHandoff.js`:
- Default: Monday-Friday, 9 AM - 6 PM (Singapore timezone)
- Outside hours: Users receive an informational message instead of escalation

### Knowledge Base
- **Local**: Edit `config/knowledgeBase.json` for static Q&A
- **Products**: Add JSON files to `config/products/` for product-specific data
- **Brochures**: Place PDF files in `config/brochures/`

### Web Scraping
The bot scrapes `dyna-nutrition.com` for:
- Product pages with linked internal content
- Search results for general queries
- Retry logic with exponential backoff (1s, 2s, 4s delays)

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| whatsapp-web.js | ^1.23.0 | WhatsApp Web API client |
| axios | ^1.6.0 | HTTP requests for web scraping |
| cheerio | ^1.0.0-rc.12 | HTML parsing for scraping |
| dotenv | ^16.3.1 | Environment variable management |
| qrcode-terminal | ^0.12.0 | QR code display for authentication |
| nodemon | ^3.0.1 | Development auto-reload (devDependencies) |

## Architecture Overview

### Message Flow
1. **Incoming Message** → Contact caching → Command check
2. **Mode Check** → Human mode (ignore) OR Bot mode (process)
3. **Intent Detection** → Escalation trigger? → Working hours check
4. **Response Generation** → DeepSeek API + Context + Live search
5. **Delivery** → Message chunking → Send to user

### Human Handoff States
- `bot` - Normal AI operation
- `escalation` - User requested human (within working hours)
- `human_complete` - Session ended by user
- `agent_closed` - Session closed by admin

### Memory System
- Per-user conversation history stored in `utils/memory.js`
- Product tracking to avoid duplicate recommendations
- Automatic cleanup of old entries

## Troubleshooting

### Common Issues

**QR Code not appearing**
- Ensure terminal supports ASCII rendering
- Check `puppeteer` installation: `npm install puppeteer`

**API Key Error**
```
❌ DEEPSEEK_API_KEY missing in .env
```
- Verify `.env` file exists in root directory
- Check for typos in variable name

**Connection Drops**
- Bot auto-reconnects with exponential backoff (max 5 attempts)
- Session data persisted in `./session-data/`

**Web Scraping Failures**
- Target website may be temporarily unavailable
- Retry logic handles transient errors (3 attempts)

### Debug Mode
Add console logging by modifying service files or run with:
```bash
DEBUG=* npm start
```

## Security Considerations

- **API Keys**: Never commit `.env` file to version control
- **Session Data**: Stored locally in `./session-data/` - secure this directory
- **Phone Numbers**: Cached in memory only (contactCache.js)
- **Rate Limiting**: Built-in 2-second cooldown between user messages

## License

Proprietary - Dyna-Nutrition

## Support

For technical issues or feature requests, contact the development team.