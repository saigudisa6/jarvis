"""
Test utility for Jarvis Restaurant Suggestion Feature
Demonstrates how to use the user preferences and restaurant agent
"""

from user_preferences import get_preferences_manager, UserProfile
from restaurant_agent import UserPreferences, RestaurantSearchRequest
import json


def test_user_profile_creation():
    """Test creating and managing user profiles"""
    print("=" * 60)
    print("TEST 1: User Profile Creation and Management")
    print("=" * 60)
    
    manager = get_preferences_manager()
    
    # Create a new user profile
    profile = manager.create_default_profile("jason_001", "Jason Lukose")
    print(f"✓ Created profile for: {profile.name}")
    
    # Update restaurant preferences
    manager.update_restaurant_preferences(
        "jason_001",
        cuisines=["Italian", "Japanese", "Thai", "Mexican"],
        price_range="moderate",
        dietary_restrictions=["gluten-free"],
        favorite_restaurants=["Local Pizza Place", "Sushi Haven"]
    )
    print("✓ Updated restaurant preferences")
    
    # Update career info
    manager.update_career_info(
        "jason_001",
        goals="Become a Senior Software Engineer in AI/ML",
        role="Software Engineer",
        skills=["Python", "JavaScript", "Go", "Machine Learning"],
        skill_gaps=["Rust", "Cloud Architecture", "DevOps"]
    )
    print("✓ Updated career information")
    
    # Update personality traits
    manager.update_personality_traits(
        "jason_001",
        communication_style="collaborative",
        work_style="independent",
        risk_tolerance="moderate",
        introvert_extrovert="ambivert"
    )
    print("✓ Updated personality traits")
    
    # Update values and interests
    manager.update_values_and_interests(
        "jason_001",
        organizations=["Fetch.ai", "Tech Meetup Group"],
        hobbies=["Hiking", "Coding", "Reading"],
        values=["Innovation", "Growth", "Impact"],
        strengths=["Problem Solving", "Communication", "Learning"],
        weaknesses=["Perfectionism", "Time Management"]
    )
    print("✓ Updated values and interests")
    
    # Load and display profile
    loaded_profile = manager.load_profile("jason_001")
    print("\n📋 Loaded Profile:")
    print(json.dumps(loaded_profile.dict(), indent=2))
    
    return True


def test_user_preferences_conversion():
    """Test converting user profile to restaurant preferences"""
    print("\n" + "=" * 60)
    print("TEST 2: Converting Profile to Restaurant Preferences")
    print("=" * 60)
    
    manager = get_preferences_manager()
    
    # Load existing profile
    profile = manager.load_profile("jason_001")
    if not profile:
        print("❌ Profile not found. Run test_user_profile_creation first.")
        return False
    
    # Convert to restaurant preferences for agent
    restaurant_prefs = UserPreferences(
        favorite_cuisines=profile.favorite_cuisines,
        dietary_restrictions=profile.dietary_restrictions,
        price_range=profile.price_range,
        ambiance_preferences=profile.ambiance_preferences,
        favorite_restaurants=profile.favorite_restaurants,
        cuisine_aversions=profile.cuisine_aversions,
        user_id=profile.user_id
    )
    
    print("✓ Converted profile to restaurant preferences")
    print("\n🍽️ Restaurant Preferences:")
    print(f"  Favorite Cuisines: {restaurant_prefs.favorite_cuisines}")
    print(f"  Price Range: {restaurant_prefs.price_range}")
    print(f"  Dietary Restrictions: {restaurant_prefs.dietary_restrictions}")
    print(f"  Favorite Restaurants: {restaurant_prefs.favorite_restaurants}")
    print(f"  Ambiance Preferences: {restaurant_prefs.ambiance_preferences}")
    
    return True


def test_restaurant_search_request():
    """Test creating a restaurant search request"""
    print("\n" + "=" * 60)
    print("TEST 3: Creating Restaurant Search Request")
    print("=" * 60)
    
    manager = get_preferences_manager()
    profile = manager.load_profile("jason_001")
    
    if not profile:
        print("❌ Profile not found. Run test_user_profile_creation first.")
        return False
    
    # Create restaurant preferences
    prefs = UserPreferences(
        favorite_cuisines=profile.favorite_cuisines,
        dietary_restrictions=profile.dietary_restrictions,
        price_range=profile.price_range,
        ambiance_preferences=profile.ambiance_preferences,
        favorite_restaurants=profile.favorite_restaurants,
        cuisine_aversions=profile.cuisine_aversions,
        user_id=profile.user_id
    )
    
    # Create search request (example: searching in San Francisco)
    request = RestaurantSearchRequest(
        search_query="Japanese restaurant",
        latitude=37.7749,  # San Francisco
        longitude=-122.4194,
        radius=5000,
        user_preferences=prefs,
        occasion="casual",
        max_results=5
    )
    
    print("✓ Created restaurant search request")
    print("\n🔍 Search Request:")
    print(f"  Query: {request.search_query}")
    print(f"  Location: ({request.latitude}, {request.longitude})")
    print(f"  Radius: {request.radius}m")
    print(f"  Occasion: {request.occasion}")
    print(f"  Max Results: {request.max_results}")
    print(f"  User ID: {request.user_preferences.user_id}")
    
    return True


def test_multiple_user_profiles():
    """Test managing multiple user profiles"""
    print("\n" + "=" * 60)
    print("TEST 4: Managing Multiple User Profiles")
    print("=" * 60)
    
    manager = get_preferences_manager()
    
    # Create multiple user profiles
    users = [
        ("alice_001", "Alice Chen"),
        ("bob_001", "Bob Smith"),
        ("carol_001", "Carol Johnson")
    ]
    
    for user_id, name in users:
        profile = manager.create_default_profile(user_id, name)
        print(f"✓ Created profile for {name}")
    
    # List all profiles
    all_profiles = manager.list_all_profiles()
    print(f"\n✓ Total profiles in system: {len(all_profiles)}")
    print(f"  Profiles: {all_profiles}")
    
    return True


def run_all_tests():
    """Run all tests"""
    print("\n")
    print("╔" + "=" * 58 + "╗")
    print("║" + " " * 10 + "JARVIS RESTAURANT FEATURE TEST SUITE" + " " * 12 + "║")
    print("╚" + "=" * 58 + "╝")
    
    tests = [
        ("User Profile Creation", test_user_profile_creation),
        ("Profile to Preferences Conversion", test_user_preferences_conversion),
        ("Restaurant Search Request", test_restaurant_search_request),
        ("Multiple User Profiles", test_multiple_user_profiles),
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, "✓ PASSED" if result else "❌ FAILED"))
        except Exception as e:
            print(f"❌ Error: {e}")
            results.append((test_name, f"❌ FAILED: {str(e)}"))
    
    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    for test_name, result in results:
        print(f"{test_name}: {result}")
    
    passed = sum(1 for _, r in results if "PASSED" in r)
    total = len(results)
    print(f"\n{passed}/{total} tests passed")


if __name__ == "__main__":
    run_all_tests()
