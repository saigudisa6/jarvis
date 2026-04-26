import os
import requests
import json
from uagents import Agent, Context, Model

# VERSION = "FAST_MODE_V3"

agent = Agent()

# ── Configuration (Add these as SECRETS in Agentverse) ──────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
GOOGLE_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")
GOOGLE_PLACES_BASE_URL = "https://maps.googleapis.com/maps/api/place"

# ── Models ──────────────────────────────────────────────────────────────────

class CloudRestaurantRequest(Model):
    user_uuid: str
    request_id: str
    search_query: str
    latitude: float
    longitude: float

class CloudRestaurantResponse(Model):
    request_id: str
    success: bool
    restaurants_json: str
    message: str

# ── Helpers (MUST BE DEFINED ABOVE THE HANDLER) ─────────────────────────────

def fetch_user_profile(user_uuid: str) -> dict:
    if not SUPABASE_URL: return {}
    url = f"{SUPABASE_URL}/rest/v1/user_profiles?user_uuid=eq.{user_uuid}&select=*"
    headers = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + str(SUPABASE_KEY)}
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        data = resp.json()
        return data[0] if (data and len(data) > 0) else {}
    except: return {}

def search_nearby(lat, lng, keyword):
    resp = requests.get(
        f"{GOOGLE_PLACES_BASE_URL}/nearbysearch/json",
        params={"location": f"{lat},{lng}", "radius": 4000, "type": "restaurant", "keyword": keyword, "key": GOOGLE_PLACES_API_KEY},
        timeout=10
    )
    return resp.json()

def score_restaurant(restaurant: dict, profile: dict) -> tuple:
    score = 0.0
    reasons = []
    prefs = profile.get("restaurant_prefs", {})
    combined = (restaurant.get("name", "") + " " + " ".join(restaurant.get("types", []))).lower()
    
    for cuisine in prefs.get("favorite_cuisines", []):
        if cuisine.lower() in combined:
            score += 0.5
            reasons.append(f"Fav: {cuisine}")
            break
            
    if restaurant.get("rating", 0) >= 4.0:
        score += 0.3
        reasons.append("High rating")
        
    return score, reasons

# ── Handler (Uses the functions above) ──────────────────────────────────────

@agent.on_message(model=CloudRestaurantRequest)
async def handle_search_request(ctx: Context, sender: str, msg: CloudRestaurantRequest):
    ctx.logger.info(f"Processing search: {msg.search_query}")
    
    # This line depends on the function defined above
    profile = fetch_user_profile(msg.user_uuid)
    
    try:
        nearby = search_nearby(msg.latitude, msg.longitude, msg.search_query)
        scored = []
        for place in nearby.get("results", [])[:10]:
            r = {"name": place.get("name"), "address": place.get("vicinity"), "rating": place.get("rating", 0.0), "types": place.get("types", [])}
            val, reasons = score_restaurant(r, profile)
            if val > 0:
                scored.append({**r, "score": val, "reasons": reasons})
        
        scored.sort(key=lambda x: x.get("score", 0), reverse=True)
        await ctx.send(sender, CloudRestaurantResponse(
            request_id=msg.request_id, success=True, 
            restaurants_json=json.dumps(scored[:5]), 
            message="JARVIS Intelligence Complete."
        ))
    except Exception as e:
        await ctx.send(sender, CloudRestaurantResponse(request_id=msg.request_id, success=False, restaurants_json="[]", message=str(e)))
