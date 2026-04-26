# 🍽️ JARVIS Restaurant Suggestion Feature - Setup Guide

## Overview
This feature allows JARVIS to detect when you search for restaurants on Google and automatically provide personalized recommendations based on your preferences.

## How It Works

1. **Browser Extension** detects food/restaurant searches on Google
2. **Content Script** captures the search query
3. **Background Worker** sends request to Bridge Server
4. **Bridge Server** (Python) processes the request and logs recommendations
5. **Recommendations** appear in the terminal

## Prerequisites

- Python 3.8+
- Dependencies installed: `pip install -r requirements.txt`
- Chrome/Chromium browser with extension loaded
- Ports available: 8000, 8001, 9000

## Setup Steps

### 1. Prepare .env File
```bash
cp .env.example .env
```

Add your API keys:
```
GOOGLE_PLACES_API_KEY=your_key_here
RESTAURANT_AGENT_ADDRESS=agent1qt93qwsne03pma6jp0m73fxy2pdkursm2hw6uecnjkq6knxrujn6jhkf0m5
```

### 2. Load Browser Extension in Chrome
1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Navigate to `/Users/jasonlukose/jarvis/extension/` and select it
5. Extension should now appear in your toolbar

### 3. Terminal 1 - Start Restaurant Agent
```bash
cd /Users/jasonlukose/jarvis
python restaurant_agent.py
```

Output will show:
```
INFO: [restaurant_suggestion_agent]: Starting agent with address: agent1qt93qwsne...
INFO: [restaurant_suggestion_agent]: Starting server on http://0.0.0.0:8001
```

### 4. Terminal 2 - Start Bridge Server
```bash
cd /Users/jasonlukose/jarvis
python extension_bridge.py
```

Output will show:
```
[2026-04-25 ...] INFO - 🌉 Jarvis Bridge Server starting on http://127.0.0.1:9000
[2026-04-25 ...] INFO - 📡 Listening for restaurant search requests from browser extension
[2026-04-25 ...] INFO - 🍽️ Endpoint: /restaurant-search
```

### 5. Test It!

#### Option A: Search on Google (Recommended)
1. Go to https://google.com
2. Search for: "restaurants near me" OR "best pizza" OR "sushi SF"
3. Check Terminal 2 for recommendations 🎉

#### Option B: Test with Curl
```bash
curl -X POST http://127.0.0.1:9000/restaurant-search \
  -H "Content-Type: application/json" \
  -d '{"query": "best thai restaurants", "user_id": "test_user"}'
```

## What Gets Detected

The extension detects searches containing these keywords:
- restaurant, food, eat, dining
- lunch, dinner, breakfast, brunch
- cafe, coffee, bakery
- pizza, sushi, burger, thai, italian, mexican, chinese, indian
- ramen, pho, BBQ, steak, vegan, vegetarian
- And more...

## Terminal Output Example

When you search for "best pizza near me":

```
🍽️ [JARVIS Restaurant Agent] Processing search: "best pizza near me"
📡 Connecting to Jarvis Bridge server...
✅ Found 5 restaurant recommendations:

  1. Artisan Pizza Co
     ⭐ Rating: 4.6★ | 💰 Price Level: 2/4 | 📊 Score: 0.65
     📍 San Francisco, CA
     🌐 https://example.com/Artisan-Pizza-Co

  2. Slice of Heaven
     ⭐ Rating: 4.5★ | 💰 Price Level: 1/4 | 📊 Score: 0.63
     📍 San Francisco, CA
     🌐 https://example.com/Slice-of-Heaven

[... more results ...]

Message: Found 5 recommended restaurants for 'best pizza near me'
```

## Customization

### Add Cuisine Keywords
Edit `extension/content_script.js` - `foodKeywords` array:
```javascript
const foodKeywords = [
  'restaurant', 'food', 'eat', 'dining',
  // Add more keywords here
];
```

### Change Location
Edit `extension_bridge.py` - `handleRestaurantSearch()` function:
```python
# Modify these coordinates (currently San Francisco)
latitude = 37.7749
longitude = -122.4194
```

### Load User Preferences
The bridge server automatically loads user preferences if a profile exists. Create one:
```bash
python -c "
from user_preferences import get_preferences_manager
manager = get_preferences_manager()
profile = manager.create_default_profile('test_user', 'Test User')
manager.update_restaurant_preferences(
    'test_user',
    cuisines=['Italian', 'Japanese'],
    price_range='moderate'
)
"
```

## Troubleshooting

### "Restaurant search error" in console
- Check Bridge Server is running: `python extension_bridge.py`
- Check it's on port 9000
- Check terminal for error messages

### Extension not detecting searches
- Make sure extension is enabled in chrome://extensions/
- Try reloading the extension (click reload icon)
- Open DevTools (F12) to see console messages

### No recommendations appearing
- Verify your .env file has required API keys
- Check that user preferences are loaded
- Try the curl test above

### Agent not responding
- Make sure Restaurant Agent is running on port 8001
- Check for error messages in that terminal

## Architecture

```
Browser Extension (content_script.js)
         ↓ (detects search)
Browser Background Worker (background.js)
         ↓ (sends HTTP request)
Bridge Server (extension_bridge.py) [Port 9000]
         ↓ (loads preferences & scores)
User Preferences (user_preferences.py)
         ↓
Restaurant Agent (restaurant_agent.py) [Port 8001]
         ↓
Terminal Output
```

## Next Steps

- Add Google Places API integration for real-time data
- Store recommendation history in user preferences
- Add click tracking to improve recommendations over time
- Create visual UI overlay in Chrome with recommendations
- Deploy agents to Agentverse for always-on functionality

## Support

Check logs in:
- Browser Console: F12 (on search results page)
- Terminal 1: Restaurant Agent logs
- Terminal 2: Bridge Server logs
