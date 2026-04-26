"""
Restaurant Suggestion Agent for Jarvis
Integrates with Google Places API to find restaurants based on user preferences
"""

import os
import httpx
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel
from uagents import Agent, Context, Model

# ============================================================================
# Message Models for Agent Communication
# ============================================================================

class UserPreferences(BaseModel):
    """User's restaurant preferences from personality quiz"""
    favorite_cuisines: List[str]  # e.g., ["Italian", "Japanese", "Mexican"]
    dietary_restrictions: List[str]  # e.g., ["vegan", "gluten-free"]
    price_range: str  # "budget", "moderate", "upscale"
    ambiance_preferences: List[str]  # e.g., ["quiet", "casual", "fine-dining"]
    favorite_restaurants: List[str]  # Specific loved restaurants
    cuisine_aversions: List[str]  # Cuisines to avoid
    user_id: str  # To track individual preferences


class RestaurantSearchRequest(BaseModel):
    """Request from orchestrator to find restaurants"""
    search_query: str
    latitude: float
    longitude: float
    radius: int = 5000  # meters
    user_preferences: UserPreferences
    occasion: str = "casual"  # "quick_lunch", "client_dinner", "date_night"
    max_results: int = 5


class Restaurant(BaseModel):
    """Individual restaurant result"""
    name: str
    address: str
    rating: float
    user_ratings_total: int
    phone: Optional[str]
    website: Optional[str]
    lat: float
    lng: float
    types: List[str]
    opening_hours: Optional[dict]
    price_level: Optional[int]  # 1-4 scale
    photos: List[str] = []


class RestaurantSearchResult(BaseModel):
    """Response with ranked restaurant suggestions"""
    success: bool
    restaurants: List[Restaurant]
    rankings_explanation: str
    error: Optional[str] = None


class UserVisitFeedback(BaseModel):
    """Track user visits and ratings to improve future suggestions"""
    user_id: str
    restaurant_name: str
    rating: int  # 1-5
    date_visited: str
    notes: Optional[str]


# ============================================================================
# Restaurant Suggestion Agent
# ============================================================================

agent = Agent(
    name="restaurant_suggestion_agent",
    seed="jarvis_restaurant_2026",
    port=8001,
    endpoint=["http://localhost:8001/submit"],
)

# API Configuration
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY")
GOOGLE_PLACES_BASE_URL = "https://maps.googleapis.com/maps/api/place"

# In-memory user visit history (in production, use database)
USER_VISIT_HISTORY = {}
USER_PREFERENCES_CACHE = {}


# ============================================================================
# Helper Functions
# ============================================================================

async def search_places_nearby(latitude: float, longitude: float, search_query: str, radius: int) -> dict:
    """Query Google Places API for nearby restaurants"""
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{GOOGLE_PLACES_BASE_URL}/nearbysearch/json",
            params={
                "location": f"{latitude},{longitude}",
                "radius": radius,
                "keyword": search_query,
                "type": "restaurant",
                "key": GOOGLE_PLACES_API_KEY
            }
        )
        
        return response.json()


async def get_place_details(place_id: str) -> dict:
    """Get detailed information about a specific place"""
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{GOOGLE_PLACES_BASE_URL}/details/json",
            params={
                "place_id": place_id,
                "fields": "name,formatted_address,formatted_phone_number,website,opening_hours,price_level,rating,user_ratings_total,type,photo",
                "key": GOOGLE_PLACES_API_KEY
            }
        )
        
        return response.json()


def calculate_restaurant_score(
    restaurant: dict,
    user_preferences: UserPreferences,
    user_history: dict
) -> tuple[float, str]:
    """
    Calculate a score for restaurant based on user preferences and history
    Returns: (score, explanation)
    """
    
    score = 0.0
    explanation_parts = []
    
    restaurant_name = restaurant.get("name", "Unknown")
    restaurant_types = restaurant.get("types", [])
    rating = restaurant.get("rating", 0)
    price_level = restaurant.get("price_level", 0)
    
    # Check dietary restrictions first - exclude if not compatible
    restaurant_types_lower = str(restaurant_types).lower()
    restaurant_name_lower = restaurant_name.lower()
    
    # DIETARY RESTRICTIONS CHECK
    excluded_keywords = {
        "vegan": ["steak", "bbq", "meat", "carnivore", "burger", "hot dog"],
        "vegetarian": ["steakhouse", "bbq", "carnivore"],
        "gluten-free": ["pizza", "pasta", "noodle"],  # These cuisines make it hard
    }
    
    for restriction in user_preferences.dietary_restrictions:
        if restriction.lower() in excluded_keywords:
            for keyword in excluded_keywords[restriction.lower()]:
                if keyword in restaurant_types_lower or keyword in restaurant_name_lower:
                    return 0.0, f"Incompatible with dietary restriction: {restriction}"
    
    # 1. Cuisine match (35% - increased weight)
    cuisine_score = 0
    matched_cuisine = None
    
    # Check if restaurant matches any favorite cuisines
    for cuisine in user_preferences.favorite_cuisines:
        cuisine_lower = cuisine.lower()
        if (cuisine_lower in restaurant_types_lower or 
            cuisine_lower in restaurant_name_lower or
            restaurant_name_lower.endswith(cuisine_lower)):
            cuisine_score = 0.35
            matched_cuisine = cuisine
            explanation_parts.append(f"✓ Matches favorite: {cuisine}")
            break
    
    # Penalize aversions
    for aversion in user_preferences.cuisine_aversions:
        if aversion.lower() in restaurant_types_lower or aversion.lower() in restaurant_name_lower:
            cuisine_score = 0
            explanation_parts.append(f"✗ Matches cuisine aversion: {aversion}")
            break
    
    score += cuisine_score
    
    # 2. Favorite restaurant (25%)
    if restaurant_name in user_preferences.favorite_restaurants:
        score += 0.25
        explanation_parts.append("Your favorite restaurant!")
    
    # 3. Google rating (15%)
    rating_normalized = min(rating / 5.0, 1.0) * 0.15
    score += rating_normalized
    if rating >= 4.5:
        explanation_parts.append(f"Highly rated: {rating}★")
    
    # 4. Price range match (20%)
    if user_preferences.price_range == "budget" and price_level in [0, 1]:
        score += 0.15
        explanation_parts.append("Within budget")
    elif user_preferences.price_range == "moderate" and price_level in [1, 2]:
        score += 0.15
        explanation_parts.append("Moderate pricing")
    elif user_preferences.price_range == "upscale" and price_level in [3, 4]:
        score += 0.15
        explanation_parts.append("Upscale dining")
    
    # 5. User visit history boost (10%)
    if restaurant_name in user_history:
        visit_info = user_history[restaurant_name]
        if visit_info.get("average_rating", 0) >= 4:
            score += 0.10
            explanation_parts.append(f"You previously rated it {visit_info.get('average_rating')}/5")
    
    explanation = " | ".join(explanation_parts) if explanation_parts else "Matches search criteria"
    
    return min(score, 1.0), explanation


def extract_restaurant_data(place_data: dict) -> Restaurant:
    """Convert Google Places API data to Restaurant model"""
    
    result = place_data.get("result", {})
    geometry = place_data.get("geometry", {})
    location = geometry.get("location", {})
    
    return Restaurant(
        name=result.get("name", "Unknown"),
        address=result.get("formatted_address", "Address not available"),
        rating=result.get("rating", 0.0),
        user_ratings_total=result.get("user_ratings_total", 0),
        phone=result.get("formatted_phone_number"),
        website=result.get("website"),
        lat=location.get("lat", 0),
        lng=location.get("lng", 0),
        types=result.get("types", []),
        opening_hours=result.get("opening_hours"),
        price_level=result.get("price_level")
    )


# ============================================================================
# Agent Event Handlers
# ============================================================================

@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"Restaurant Suggestion Agent started")
    ctx.logger.info(f"Agent Address: {agent.address}")
    ctx.logger.info(f"Ready to receive restaurant search requests")


@agent.on_message(model=RestaurantSearchRequest)
async def handle_restaurant_search(ctx: Context, sender: str, msg: RestaurantSearchRequest):
    """Main handler for restaurant search requests"""
    
    ctx.logger.info(f"Received restaurant search request from {sender}")
    ctx.logger.info(f"Query: {msg.search_query} | Location: {msg.latitude}, {msg.longitude}")
    
    try:
        # Search for nearby restaurants
        ctx.logger.info("Querying Google Places API...")
        places_result = await search_places_nearby(
            msg.latitude,
            msg.longitude,
            msg.search_query,
            msg.radius
        )
        
        if places_result.get("status") != "OK":
            await ctx.send(sender, RestaurantSearchResult(
                success=False,
                restaurants=[],
                rankings_explanation="",
                error=f"Google Places API error: {places_result.get('status')}"
            ))
            return
        
        # Get detailed information and score each restaurant
        restaurants_with_scores = []
        
        for place in places_result.get("results", [])[:msg.max_results * 2]:  # Get more to filter
            place_id = place.get("place_id")
            
            # Get detailed info
            details_result = await get_place_details(place_id)
            
            if details_result.get("status") == "OK":
                restaurant = extract_restaurant_data(details_result)
                
                # Load user history if available
                user_history = USER_VISIT_HISTORY.get(msg.user_preferences.user_id, {})
                
                # Calculate score
                score, explanation = calculate_restaurant_score(
                    {
                        "name": restaurant.name,
                        "types": restaurant.types,
                        "rating": restaurant.rating,
                        "price_level": restaurant.price_level
                    },
                    msg.user_preferences,
                    user_history
                )
                
                restaurants_with_scores.append((restaurant, score, explanation))
        
        # Sort by score descending
        restaurants_with_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Prepare results
        top_restaurants = [r[0] for r in restaurants_with_scores[:msg.max_results]]
        rankings_explanation = "\n".join([
            f"{i+1}. {r[0].name} (Score: {r[1]:.2f}) - {r[2]}"
            for i, r in enumerate(restaurants_with_scores[:msg.max_results])
        ])
        
        ctx.logger.info(f"Found and ranked {len(top_restaurants)} restaurants")
        
        # Send response
        await ctx.send(sender, RestaurantSearchResult(
            success=True,
            restaurants=top_restaurants,
            rankings_explanation=rankings_explanation
        ))
        
    except Exception as e:
        ctx.logger.error(f"Error processing restaurant search: {str(e)}")
        await ctx.send(sender, RestaurantSearchResult(
            success=False,
            restaurants=[],
            rankings_explanation="",
            error=f"Error: {str(e)}"
        ))


@agent.on_message(model=UserVisitFeedback)
async def handle_visit_feedback(ctx: Context, sender: str, msg: UserVisitFeedback):
    """Track user visits and ratings to improve suggestions"""
    
    user_id = msg.user_id
    restaurant_name = msg.restaurant_name
    
    if user_id not in USER_VISIT_HISTORY:
        USER_VISIT_HISTORY[user_id] = {}
    
    if restaurant_name not in USER_VISIT_HISTORY[user_id]:
        USER_VISIT_HISTORY[user_id][restaurant_name] = {
            "visits": [],
            "average_rating": 0
        }
    
    history = USER_VISIT_HISTORY[user_id][restaurant_name]
    history["visits"].append({
        "date": msg.date_visited,
        "rating": msg.rating,
        "notes": msg.notes
    })
    
    # Calculate average rating
    ratings = [v["rating"] for v in history["visits"]]
    history["average_rating"] = sum(ratings) / len(ratings)
    
    ctx.logger.info(f"Feedback recorded for {restaurant_name}: {msg.rating}/5 stars")


if __name__ == "__main__":
    agent.run()
