# SpielerPlus Calendar Filter

Multi-user service that filters SpielerPlus.de calendar feeds with personalized attendance status emojis.

## Features

- 🎯 **Personal attendance status** - Shows your response with emojis (👍 attending, 👎 not attending, ❓ maybe, etc.)
- 🔒 **HTTP Basic Auth** - Secure authentication with your SpielerPlus credentials
- 🎛️ **Filtering options** - `showNotNominated` parameter to control visibility of events you're not nominated for
- 👥 **Multi-user support** - Each user gets their own filtered calendar
- ⚡ **Session caching** - Reuses authentication sessions for better performance

## Usage

### Basic URL Format
```
https://your-domain.com/calendar/ICAL_TOKEN?u=USER_ID&name=TEAM_NAME
```

### With Parameters
```
https://your-domain.com/calendar/ICAL_TOKEN?u=USER_ID&name=TEAM_NAME&showNotNominated=true
```

### Parameters

- `ICAL_TOKEN` - Your SpielerPlus iCal token
- `u` - Your user ID from SpielerPlus
- `name` - Team/calendar name (optional)
- `showNotNominated` - Show events you're not nominated for (default: false)

## Authentication

Uses HTTP Basic Authentication with your SpielerPlus credentials:
- **Username**: Your SpielerPlus email
- **Password**: Your SpielerPlus password

## Emojis

- 👍 **Attending** - You've confirmed attendance
- 👎 **Not Attending** - You've declined
- ❓ **Maybe** - You're unsure
- 🤷 **No Response** - You haven't responded yet
- ❌ **Not Nominated** - You're not nominated for this event
- 🔒 **Auth Failed** - Authentication issue

## Environment Variables

- `PORT` - Server port (default: 3000)
- `SPIELERPLUS_BASE_URL` - SpielerPlus base URL
- `SPIELERPLUS_TEST_USERNAME` - Test username
- `SPIELERPLUS_TEST_PASSWORD` - Test password

## Development

```bash
npm install
npm start
```

## License

MIT