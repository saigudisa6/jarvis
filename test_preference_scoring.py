"""
Comprehensive test for restaurant preference-based recommendations
Demonstrates how Jarvis uses user preferences to score and rank restaurants
"""

import json
from restaurant_agent import calculate_restaurant_score, UserPreferences
from user_preferences import get_preferences_manager


def test_preference_based_scoring():
    """Test how restaurants are scored based on user preferences"""
    
    print("\n" + "=" * 80)
    print("RESTAURANT PREFERENCE SCORING TEST")
    print("=" * 80)
    
    # Create sample user preferences
    user_prefs = UserPreferences(
        user_id="test_user_001",
        favorite_cuisines=["Italian", "Japanese", "Thai"],
        dietary_restrictions=["gluten-free"],
        price_range="moderate",
        ambiance_preferences=["casual", "quiet"],
        favorite_restaurants=["My Favorite Italian Place"],
        cuisine_aversions=["Indian"]
    )
    
    print("\n📋 USER PREFERENCES:")
    print(f"  Favorite Cuisines: {user_prefs.favorite_cuisines}")
    print(f"  Dietary Restrictions: {user_prefs.dietary_restrictions}")
    print(f"  Price Range: {user_prefs.price_range}")
    print(f"  Favorite Restaurants: {user_prefs.favorite_restaurants}")
    print(f"  Cuisine Aversions: {user_prefs.cuisine_aversions}")
    
    # Sample restaurants to test
    test_restaurants = [
        {
            "name": "My Favorite Italian Place",
            "types": ["restaurant", "italian"],
            "rating": 4.7,
            "price_level": 2,  # moderate
        },
        {
            "name": "Tokyo Sushi Bar",
            "types": ["restaurant", "japanese", "sushi"],
            "rating": 4.5,
            "price_level": 2,  # moderate
        },
        {
            "name": "Thai Spice Express",
            "types": ["restaurant", "thai"],
            "rating": 4.2,
            "price_level": 1,  # budget
        },
        {
            "name": "Pasta Paradise",
            "types": ["restaurant", "italian", "pizza"],
            "rating": 4.8,
            "price_level": 2,  # moderate
        },
        {
            "name": "The Steakhouse",
            "types": ["restaurant", "steak"],
            "rating": 4.6,
            "price_level": 4,  # expensive
        },
        {
            "name": "Curry House",
            "types": ["restaurant", "indian", "curry"],
            "rating": 4.4,
            "price_level": 1,  # budget
        },
        {
            "name": "Thai Pizza Kitchen",
            "types": ["restaurant", "thai", "pizza"],
            "rating": 4.0,
            "price_level": 1,  # budget
        },
    ]
    
    # Score each restaurant
    print("\n" + "=" * 80)
    print("SCORING RESULTS")
    print("=" * 80)
    
    scored_restaurants = []
    
    for restaurant in test_restaurants:
        score, explanation = calculate_restaurant_score(
            restaurant,
            user_prefs,
            {}  # empty user history
        )
        scored_restaurants.append({
            "name": restaurant["name"],
            "score": score,
            "explanation": explanation,
            "rating": restaurant["rating"],
            "price_level": restaurant["price_level"],
            "types": restaurant["types"]
        })
    
    # Sort by score
    scored_restaurants.sort(key=lambda x: x["score"], reverse=True)
    
    # Display results
    print("\nRanked by Preference Match Score:\n")
    for i, rest in enumerate(scored_restaurants, 1):
        status = "✅" if rest["score"] > 0.5 else "⚠️" if rest["score"] > 0 else "❌"
        print(f"{i}. {status} {rest['name']}")
        print(f"   Score: {rest['score']:.2f} | Rating: {rest['rating']}★ | Price Level: {rest['price_level']}/4")
        print(f"   Why: {rest['explanation']}")
        print()


def test_dietary_restrictions():
    """Test how dietary restrictions filter restaurants"""
    
    print("\n" + "=" * 80)
    print("DIETARY RESTRICTIONS TEST")
    print("=" * 80)
    
    # Vegan user
    vegan_prefs = UserPreferences(
        user_id="vegan_user",
        favorite_cuisines=["Italian", "Thai", "Indian"],
        dietary_restrictions=["vegan"],
        price_range="moderate",
        ambiance_preferences=["casual"],
        favorite_restaurants=[],
        cuisine_aversions=[]
    )
    
    test_restaurants = [
        {"name": "Vegan Thai Restaurant", "types": ["thai"], "rating": 4.5, "price_level": 2},
        {"name": "The Steakhouse", "types": ["steak"], "rating": 4.7, "price_level": 4},
        {"name": "Vegan Italian Pasta", "types": ["italian"], "rating": 4.3, "price_level": 2},
        {"name": "Burger King", "types": ["burger"], "rating": 3.5, "price_level": 1},
    ]
    
    print("\n🥗 VEGAN USER PREFERENCES:")
    print(f"  Dietary Restriction: Vegan")
    print(f"  Favorite Cuisines: {vegan_prefs.favorite_cuisines}")
    
    print("\nResults:")
    for rest in test_restaurants:
        score, explanation = calculate_restaurant_score(rest, vegan_prefs, {})
        status = "✅ Compatible" if score > 0 else "❌ Excluded"
        print(f"  {status}: {rest['name']} - {explanation}")


def test_price_range_matching():
    """Test price range preferences"""
    
    print("\n" + "=" * 80)
    print("PRICE RANGE MATCHING TEST")
    print("=" * 80)
    
    price_ranges = ["budget", "moderate", "upscale"]
    
    test_restaurants = [
        {"name": "Food Truck", "types": ["casual"], "rating": 4.0, "price_level": 1},
        {"name": "Casual Diner", "types": ["diner"], "rating": 4.2, "price_level": 1},
        {"name": "Mid-Range Bistro", "types": ["bistro"], "rating": 4.5, "price_level": 2},
        {"name": "Nice Restaurant", "types": ["restaurant"], "rating": 4.6, "price_level": 2},
        {"name": "Fine Dining", "types": ["fine_dining"], "rating": 4.8, "price_level": 4},
        {"name": "Luxury Restaurant", "types": ["restaurant"], "rating": 4.9, "price_level": 4},
    ]
    
    for price_range in price_ranges:
        print(f"\n💰 {price_range.upper()} Budget User:")
        
        prefs = UserPreferences(
            user_id="test",
            favorite_cuisines=["Italian"],
            dietary_restrictions=[],
            price_range=price_range,
            ambiance_preferences=[],
            favorite_restaurants=[],
            cuisine_aversions=[]
        )
        
        results = []
        for rest in test_restaurants:
            score, _ = calculate_restaurant_score(rest, prefs, {})
            results.append((rest["name"], score, rest["price_level"]))
        
        results.sort(key=lambda x: x[1], reverse=True)
        
        for name, score, price in results[:3]:
            print(f"  {name} (Level {price}) - Score: {score:.2f}")


def test_favorite_restaurant_boost():
    """Test how favorite restaurants get boosted"""
    
    print("\n" + "=" * 80)
    print("FAVORITE RESTAURANT BOOST TEST")
    print("=" * 80)
    
    prefs_with_favorite = UserPreferences(
        user_id="test",
        favorite_cuisines=["Italian"],
        dietary_restrictions=[],
        price_range="moderate",
        ambiance_preferences=[],
        favorite_restaurants=["Mario's Italian Kitchen"],
        cuisine_aversions=[]
    )
    
    prefs_without_favorite = UserPreferences(
        user_id="test",
        favorite_cuisines=["Italian"],
        dietary_restrictions=[],
        price_range="moderate",
        ambiance_preferences=[],
        favorite_restaurants=[],
        cuisine_aversions=[]
    )
    
    restaurants = [
        {"name": "Mario's Italian Kitchen", "types": ["italian"], "rating": 4.0, "price_level": 2},
        {"name": "Giovanni's Italian Place", "types": ["italian"], "rating": 4.0, "price_level": 2},
    ]
    
    print("\nComparing two identical Italian restaurants:")
    print("One is in favorites, one is not\n")
    
    for rest in restaurants:
        score_with_fav, exp_with_fav = calculate_restaurant_score(rest, prefs_with_favorite, {})
        score_without_fav, exp_without_fav = calculate_restaurant_score(rest, prefs_without_favorite, {})
        
        print(f"{rest['name']}:")
        print(f"  Without being favorite: {score_without_fav:.2f} - {exp_without_fav}")
        print(f"  When marked as favorite: {score_with_fav:.2f} - {exp_with_fav}")
        print()


def run_all_tests():
    """Run all preference-based tests"""
    
    print("\n")
    print("╔" + "=" * 78 + "╗")
    print("║" + " " * 15 + "RESTAURANT PREFERENCE-BASED RECOMMENDATION TESTS" + " " * 15 + "║")
    print("╚" + "=" * 78 + "╝")
    
    try:
        test_preference_based_scoring()
        test_dietary_restrictions()
        test_price_range_matching()
        test_favorite_restaurant_boost()
        
        print("\n" + "=" * 80)
        print("✅ ALL TESTS COMPLETED SUCCESSFULLY")
        print("=" * 80)
        print("\nHow it works:")
        print("1. User preferences are loaded from personality quiz")
        print("2. When searching for restaurants, the agent gets results from Google Places")
        print("3. Each restaurant is scored based on:")
        print("   • Cuisine preference match (35% - highest weight)")
        print("   • Favorite restaurant status (25%)")
        print("   • Google rating (15%)")
        print("   • Price range alignment (20%)")
        print("   • User visit history (10%)")
        print("4. Results are ranked and returned with explanations")
        print("\n")
        
    except Exception as e:
        print(f"\n❌ Error during testing: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    run_all_tests()
