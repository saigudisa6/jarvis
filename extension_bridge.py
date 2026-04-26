"""
Jarvis Extension Bridge Server
Bridges HTTP requests from browser extension to Jarvis restaurant agent.
Detects food-related Google searches, finds real nearby restaurants via
Google Places API, scores them against user preferences, and prints results.
"""

import json
import logging
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

import httpx
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY")
GOOGLE_PLACES_BASE_URL = "https://maps.googleapis.com/maps/api/place"
TEST_PREFERENCES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_preferences.json")

logging.basicConfig(
    level=logging.INFO,
    format='%(message)s'
)
logger = logging.getLogger('JarvisBridge')


# ============================================================================
# Preferences
# ============================================================================

def load_test_preferences() -> dict:
    with open(TEST_PREFERENCES_PATH, 'r') as f:
        return json.load(f)


# ============================================================================
# Location
# ============================================================================

def get_ip_location() -> tuple[float | None, float | None]:
    """Approximate location from IP as a fallback when browser doesn't share coords."""
    try:
        resp = httpx.get("https://ipinfo.io/json", timeout=5.0)
        data = resp.json()
        loc = data.get("loc", "").split(",")
        if len(loc) == 2:
            return float(loc[0]), float(loc[1])
    except Exception:
        pass
    return None, None


# ============================================================================
# Google Places API
# ============================================================================

def search_places_nearby(latitude: float, longitude: float, keyword: str, radius: int = 5000) -> dict:
    resp = httpx.get(
        f"{GOOGLE_PLACES_BASE_URL}/nearbysearch/json",
        params={
            "location": f"{latitude},{longitude}",
            "radius": radius,
            "type": "restaurant",
            "keyword": keyword,
            "key": GOOGLE_PLACES_API_KEY,
        },
        timeout=10.0
    )
    return resp.json()


def get_place_details(place_id: str) -> dict:
    resp = httpx.get(
        f"{GOOGLE_PLACES_BASE_URL}/details/json",
        params={
            "place_id": place_id,
            "fields": "name,formatted_address,formatted_phone_number,website,opening_hours,price_level,rating,user_ratings_total,types,geometry",
            "key": GOOGLE_PLACES_API_KEY,
        },
        timeout=10.0
    )
    return resp.json()


# ============================================================================
# Scoring
# ============================================================================

def score_restaurant(restaurant: dict, prefs: dict) -> tuple[float, list[str]]:
    """
    Score a restaurant dict against user preferences.
    Returns (0–1 score, list of reason strings).
    """
    score = 0.0
    reasons: list[str] = []

    name = restaurant.get("name", "").lower()
    types_str = " ".join(restaurant.get("types", [])).lower()
    combined = f"{name} {types_str}"

    rating = restaurant.get("rating", 0.0)
    price_level = restaurant.get("price_level")

    # Hard filter: cuisine aversions
    for aversion in prefs.get("cuisine_aversions", []):
        if aversion.lower() in combined:
            return 0.0, [f"Avoided cuisine: {aversion}"]

    # Cuisine match (35%)
    for cuisine in prefs.get("favorite_cuisines", []):
        if cuisine.lower() in combined:
            score += 0.35
            reasons.append(f"Matches favourite: {cuisine}")
            break

    # Google rating (25%) — normalised to 5★
    if rating > 0:
        score += (rating / 5.0) * 0.25
        if rating >= 4.5:
            reasons.append(f"Highly rated {rating}★")
        elif rating >= 4.0:
            reasons.append(f"Well rated {rating}★")

    # Price range match (25%)
    price_range = prefs.get("price_range", "moderate")
    if price_level is not None:
        if price_range == "budget" and price_level in [0, 1]:
            score += 0.25
            reasons.append("Budget-friendly")
        elif price_range == "moderate" and price_level in [1, 2]:
            score += 0.25
            reasons.append("Moderate pricing")
        elif price_range == "upscale" and price_level in [3, 4]:
            score += 0.25
            reasons.append("Upscale dining")
    else:
        score += 0.10  # neutral when price info missing

    # Favourite restaurant name match (15%)
    for fav in prefs.get("favorite_restaurants", []):
        if fav.lower() in name:
            score += 0.15
            reasons.append("One of your favourites!")
            break

    if not reasons:
        reasons.append("Matches search area")

    return min(score, 1.0), reasons


# ============================================================================
# HTTP Handler
# ============================================================================

class RestaurantBridgeHandler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path != '/restaurant-search':
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            req = json.loads(body.decode('utf-8'))
            search_query: str = req.get('query', 'restaurants')
            latitude: float | None = req.get('latitude')
            longitude: float | None = req.get('longitude')

            prefs = load_test_preferences()

            logger.info("")
            logger.info("=" * 62)
            logger.info("  JARVIS — RESTAURANT SEARCH DETECTED")
            logger.info("=" * 62)
            logger.info(f"  Query   : \"{search_query}\"")
            logger.info(f"  User    : {prefs.get('name', 'Unknown')}")

            # Resolve location
            if latitude is None or longitude is None:
                logger.info("  Location: none from browser — falling back to IP geolocation…")
                latitude, longitude = get_ip_location()

            if latitude is None or longitude is None:
                raise ValueError("Could not determine location from browser or IP.")

            logger.info(f"  Location: {latitude:.5f}, {longitude:.5f}")
            logger.info(f"  Radius  : {prefs.get('search_radius_meters', 3000)} m")
            logger.info("")
            logger.info("  Querying Google Places API…")

            places_result = search_places_nearby(
                latitude, longitude,
                search_query,
                radius=prefs.get("search_radius_meters", 3000)
            )

            status = places_result.get("status")
            if status != "OK":
                raise ValueError(
                    f"Google Places API returned status '{status}': "
                    f"{places_result.get('error_message', 'no detail')}"
                )

            raw_places = places_result.get("results", [])
            logger.info(f"  {len(raw_places)} places returned — fetching details & scoring…")

            # Fetch details + score (cap at 15 candidates to stay fast)
            scored: list[dict] = []
            for place in raw_places[:15]:
                place_id = place.get("place_id")
                if not place_id:
                    continue

                detail_resp = get_place_details(place_id)
                result = detail_resp.get("result", {})
                if not result:
                    continue

                geo = result.get("geometry", {}).get("location", {})
                restaurant = {
                    "name": result.get("name", "Unknown"),
                    "address": result.get("formatted_address", ""),
                    "rating": result.get("rating", 0.0),
                    "user_ratings_total": result.get("user_ratings_total", 0),
                    "price_level": result.get("price_level"),
                    "types": result.get("types", []),
                    "website": result.get("website"),
                    "phone": result.get("formatted_phone_number"),
                    "open_now": result.get("opening_hours", {}).get("open_now"),
                    "lat": geo.get("lat", 0.0),
                    "lng": geo.get("lng", 0.0),
                }

                score_val, reasons = score_restaurant(restaurant, prefs)
                if score_val > 0:
                    scored.append({**restaurant, "score": score_val, "reasons": reasons})

            scored.sort(key=lambda x: x["score"], reverse=True)
            top = scored[:prefs.get("max_results", 5)]

            # ── Terminal output ──────────────────────────────────────────
            logger.info("")
            logger.info(f"  TOP {len(top)} RECOMMENDATIONS  (sorted by match score)")
            logger.info("=" * 62)

            for i, r in enumerate(top, 1):
                stars = "★" * int(r["rating"]) if r["rating"] else "No rating"
                price_str = "$" * r["price_level"] if r.get("price_level") else "$$?"
                if r.get("open_now") is True:
                    hours_str = "Open now"
                elif r.get("open_now") is False:
                    hours_str = "Currently closed"
                else:
                    hours_str = "Hours unknown"

                logger.info("")
                logger.info(f"  {i}. {r['name']}")
                logger.info(f"     {r['rating']}★  ({r['user_ratings_total']} reviews)  ·  {price_str}  ·  {hours_str}")
                logger.info(f"     {r['address']}")
                logger.info(f"     Match {r['score']:.0%}  —  {' | '.join(r['reasons'])}")
                if r.get("website"):
                    logger.info(f"     {r['website']}")
                if r.get("phone"):
                    logger.info(f"     {r['phone']}")

            logger.info("")
            logger.info("=" * 62)
            logger.info("")

            response = {
                "success": True,
                "query": search_query,
                "restaurants": top,
                "message": f"Found {len(top)} recommendations near you for \"{search_query}\""
            }

            self._json_response(200, response)

        except json.JSONDecodeError:
            logger.error("Bad request: invalid JSON body")
            self._json_response(400, {"error": "Invalid JSON"})
        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)
            self._json_response(500, {"error": str(e)})

    def do_GET(self):
        if self.path == '/health':
            self._json_response(200, {"status": "ok", "service": "jarvis-bridge"})
        else:
            self.send_response(404)
            self.end_headers()

    def _json_response(self, code: int, data: dict):
        payload = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass  # silence default access log; we use logger above


# ============================================================================
# Entry point
# ============================================================================

def run_bridge_server(port: int = 9000):
    if not GOOGLE_PLACES_API_KEY:
        logger.error("GOOGLE_PLACES_API_KEY is not set in .env — aborting.")
        sys.exit(1)

    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, RestaurantBridgeHandler)

    logger.info("=" * 62)
    logger.info("  JARVIS Bridge Server")
    logger.info("=" * 62)
    logger.info(f"  Listening : http://127.0.0.1:{port}")
    logger.info(f"  Endpoint  : POST /restaurant-search")
    logger.info(f"  Places key: {'set ✓' if GOOGLE_PLACES_API_KEY else 'MISSING ✗'}")
    logger.info(f"  Prefs file: {TEST_PREFERENCES_PATH}")
    logger.info("=" * 62)
    logger.info("")
    logger.info("  Waiting for restaurant searches from the browser extension…")
    logger.info("")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("\n  Shutting down…")
        httpd.shutdown()


if __name__ == '__main__':
    run_bridge_server(port=9000)
