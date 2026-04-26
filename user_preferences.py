"""
User Preferences Manager
Handles loading and managing user personality quiz data for Jarvis
"""

import json
import os
from typing import Optional, Dict, Any
from pydantic import BaseModel


class UserProfile(BaseModel):
    """Complete user profile from personality quiz"""
    user_id: str
    name: str
    
    # Restaurant Preferences
    favorite_cuisines: list = []
    dietary_restrictions: list = []
    price_range: str = "moderate"  # budget, moderate, upscale
    ambiance_preferences: list = []  # quiet, social, casual, fine-dining
    favorite_restaurants: list = []
    cuisine_aversions: list = []
    
    # Career & Goals
    career_goals: str = ""
    current_role: str = ""
    skills: list = []
    skill_gaps: list = []
    
    # Personality Traits
    communication_style: str = ""  # direct, diplomatic, collaborative
    work_style: str = ""  # independent, collaborative, structured
    risk_tolerance: str = ""  # conservative, moderate, aggressive
    introvert_extrovert: str = ""  # introvert, ambivert, extrovert
    
    # Organizations & Background
    organizations: list = []  # Companies, clubs, groups
    hobbies: list = []
    values: list = []  # e.g., innovation, family, growth, impact
    background: str = ""
    strengths: list = []
    weaknesses: list = []
    
    # Preferences
    meeting_tolerance: int = 3  # max meetings per day before fatigue
    email_response_time: str = "same_day"  # immediate, within_2h, same_day, next_day
    decision_making_style: str = "collaborative"  # quick, data_driven, collaborative
    notification_preferences: dict = {
        "urgent_only": False,
        "digest": False,
        "real_time": True
    }


class PreferencesManager:
    """Manage user profile and preferences"""
    
    def __init__(self, data_dir: str = "./user_data"):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
    
    def get_profile_path(self, user_id: str) -> str:
        """Get file path for user profile"""
        return os.path.join(self.data_dir, f"{user_id}_profile.json")
    
    def load_profile(self, user_id: str) -> Optional[UserProfile]:
        """Load user profile from disk"""
        profile_path = self.get_profile_path(user_id)
        
        if not os.path.exists(profile_path):
            return None
        
        try:
            with open(profile_path, 'r') as f:
                data = json.load(f)
            return UserProfile(**data)
        except Exception as e:
            print(f"Error loading profile for {user_id}: {e}")
            return None
    
    def save_profile(self, profile: UserProfile) -> bool:
        """Save user profile to disk"""
        profile_path = self.get_profile_path(profile.user_id)
        
        try:
            with open(profile_path, 'w') as f:
                json.dump(profile.dict(), f, indent=2)
            return True
        except Exception as e:
            print(f"Error saving profile for {profile.user_id}: {e}")
            return False
    
    def create_default_profile(self, user_id: str, name: str) -> UserProfile:
        """Create a default profile for new user"""
        profile = UserProfile(user_id=user_id, name=name)
        self.save_profile(profile)
        return profile
    
    def update_restaurant_preferences(
        self,
        user_id: str,
        cuisines: Optional[list] = None,
        price_range: Optional[str] = None,
        dietary_restrictions: Optional[list] = None,
        favorite_restaurants: Optional[list] = None
    ) -> bool:
        """Update restaurant-specific preferences"""
        
        profile = self.load_profile(user_id)
        if not profile:
            return False
        
        if cuisines is not None:
            profile.favorite_cuisines = cuisines
        if price_range is not None:
            profile.price_range = price_range
        if dietary_restrictions is not None:
            profile.dietary_restrictions = dietary_restrictions
        if favorite_restaurants is not None:
            profile.favorite_restaurants = favorite_restaurants
        
        return self.save_profile(profile)
    
    def update_career_info(
        self,
        user_id: str,
        goals: Optional[str] = None,
        role: Optional[str] = None,
        skills: Optional[list] = None,
        skill_gaps: Optional[list] = None
    ) -> bool:
        """Update career-related information"""
        
        profile = self.load_profile(user_id)
        if not profile:
            return False
        
        if goals is not None:
            profile.career_goals = goals
        if role is not None:
            profile.current_role = role
        if skills is not None:
            profile.skills = skills
        if skill_gaps is not None:
            profile.skill_gaps = skill_gaps
        
        return self.save_profile(profile)
    
    def update_personality_traits(
        self,
        user_id: str,
        communication_style: Optional[str] = None,
        work_style: Optional[str] = None,
        risk_tolerance: Optional[str] = None,
        introvert_extrovert: Optional[str] = None
    ) -> bool:
        """Update personality traits"""
        
        profile = self.load_profile(user_id)
        if not profile:
            return False
        
        if communication_style is not None:
            profile.communication_style = communication_style
        if work_style is not None:
            profile.work_style = work_style
        if risk_tolerance is not None:
            profile.risk_tolerance = risk_tolerance
        if introvert_extrovert is not None:
            profile.introvert_extrovert = introvert_extrovert
        
        return self.save_profile(profile)
    
    def update_values_and_interests(
        self,
        user_id: str,
        organizations: Optional[list] = None,
        hobbies: Optional[list] = None,
        values: Optional[list] = None,
        strengths: Optional[list] = None,
        weaknesses: Optional[list] = None
    ) -> bool:
        """Update values, interests, strengths, and weaknesses"""
        
        profile = self.load_profile(user_id)
        if not profile:
            return False
        
        if organizations is not None:
            profile.organizations = organizations
        if hobbies is not None:
            profile.hobbies = hobbies
        if values is not None:
            profile.values = values
        if strengths is not None:
            profile.strengths = strengths
        if weaknesses is not None:
            profile.weaknesses = weaknesses
        
        return self.save_profile(profile)
    
    def get_restaurant_preferences(self, user_id: str) -> Dict[str, Any]:
        """Get restaurant-specific preferences"""
        profile = self.load_profile(user_id)
        if not profile:
            return {}
        
        return {
            "favorite_cuisines": profile.favorite_cuisines,
            "dietary_restrictions": profile.dietary_restrictions,
            "price_range": profile.price_range,
            "ambiance_preferences": profile.ambiance_preferences,
            "favorite_restaurants": profile.favorite_restaurants,
            "cuisine_aversions": profile.cuisine_aversions,
        }
    
    def list_all_profiles(self) -> list:
        """List all user profiles"""
        profiles = []
        for filename in os.listdir(self.data_dir):
            if filename.endswith("_profile.json"):
                user_id = filename.replace("_profile.json", "")
                profiles.append(user_id)
        return profiles


# Global instance
_manager = None


def get_preferences_manager(data_dir: str = "./user_data") -> PreferencesManager:
    """Get or create global preferences manager"""
    global _manager
    if _manager is None:
        _manager = PreferencesManager(data_dir)
    return _manager


if __name__ == "__main__":
    # Example usage
    manager = get_preferences_manager()
    
    # Create a new profile
    profile = manager.create_default_profile("user_001", "Jason Lukose")
    
    # Update restaurant preferences
    manager.update_restaurant_preferences(
        "user_001",
        cuisines=["Italian", "Japanese", "Thai"],
        price_range="moderate",
        dietary_restrictions=["gluten-free"]
    )
    
    # Update career info
    manager.update_career_info(
        "user_001",
        goals="Become a Senior Engineer",
        role="Software Engineer",
        skills=["Python", "JavaScript", "Go"],
        skill_gaps=["Rust", "Cloud Architecture"]
    )
    
    # Load and print profile
    loaded_profile = manager.load_profile("user_001")
    print(loaded_profile.json(indent=2))
