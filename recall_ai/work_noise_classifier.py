"""
Work/Noise classifier for Ember activities.

Classification rules from spec:
- Work: VS Code, Cursor, Terminal, Notion, Figma, Xcode (always surfaces)
- Neutral: Chrome, Safari (surfaces only if title suggests work)
- Noise: YouTube, Spotify, Reddit, Twitter, WhatsApp (never surfaces)
"""

from __future__ import annotations

import re
from typing import Literal


# App categories (normalized bundle identifiers and common names)
WORK_APPS = {
    "com.microsoft.VSCode",
    "com.microsoft.vscode",
    "Visual Studio Code",
    "VS Code",
    "Code",
    "Cursor",
    "com.twitter.cursor-ai",
    "Terminal",
    "com.apple.Terminal",
    "iTerm",
    "com.iterm2.iTerm2",
    "Notion",
    "com.notion.Notion",
    "Figma",
    "com.figma.Figma",
    "Xcode",
    "com.apple.dt.Xcode",
    "PyCharm",
    "com.jetbrains.pycharm",
    "IntelliJ",
    "com.jetbrains.intellij",
    "Slack",
    "com.tinyspeck.slackmacgap",
    "Discord",
    "com.hnc.Discord",
    "GitHub Desktop",
    "com.github.GitHubClient",
    "Postman",
    "com.postmanlabs.mac",
    "Insomnia",
    "com.insomnia.app",
}

NEUTRAL_APPS = {
    "Chrome",
    "com.google.Chrome",
    "Chromium",
    "org.chromium.Chromium",
    "Safari",
    "com.apple.Safari",
    "Firefox",
    "org.mozilla.firefox",
    "Edge",
    "com.microsoft.edgemac",
    "Brave",
    "com.brave.Browser",
}

NOISE_APPS = {
    "YouTube",
    "Spotify",
    "com.spotify.client",
    "Reddit",
    "Twitter",
    "com.twitter.Twitter",
    "X",
    "WhatsApp",
    "com.whatsapp.WhatsApp",
    "TikTok",
    "com.byte.tiktok",
    "Instagram",
    "com.instagram.Instagram",
    "Netflix",
    "com.netflix.Netflix",
    "Disney+",
    "Hulu",
    "com.hulu.Hulu",
}

# Keywords that indicate work-related content in neutral apps
WORK_KEYWORDS = {
    r"github",
    r"stackoverflow",
    r"stack overflow",
    r"localhost",
    r":3000",
    r":8000",
    r":8080",
    r"127\.0\.0\.1",
    r"docs\.google\.com",
    r"notion",
    r"figma",
    r"jira",
    r"linear",
    r"asana",
    r"trello",
    r"confluence",
    r"wiki",
    r"aws",
    r"azure",
    r"gcp",
    r"heroku",
    r"vercel",
    r"netlify",
    r"npm",
    r"pip",
    r"poetry",
    r"cargo",
    r"gradle",
    r"maven",
    r"pytest",
    r"jest",
    r"mocha",
    r"rspec",
    r"coding",
    r"development",
    r"api",
    r"database",
    r"server",
    r"debug",
    r"deploy",
    r"build",
}

NOISE_KEYWORDS = {
    r"youtube",
    r"youtu\.be",
    r"netflix",
    r"hulu",
    r"disneyplus",
    r"tiktok",
    r"instagram",
    r"facebook",
    r"reddit",
    r"twitter",
    r"spotify",
    r"music\.apple",
    r"pinterest",
    r"snapchat",
    r"twitch",
}


def normalize_app_name(app_name: str | None) -> str:
    """Normalize app name for comparison."""
    if not app_name:
        return ""
    return app_name.strip().lower()


def classify_activity(app_name: str | None, title: str | None = None) -> Literal["work", "neutral", "noise"]:
    """
    Classify an activity as work, neutral, or noise.
    
    Args:
        app_name: The application name or bundle identifier
        title: The window title (used for neutral app classification)
    
    Returns:
        "work" (always surfaces), "neutral" (conditional), or "noise" (never surfaces)
    """
    if not app_name:
        return "neutral"
    
    normalized_app = normalize_app_name(app_name)
    
    # Check noise apps FIRST (highest priority) - exact or bundle match
    for noise_app in NOISE_APPS:
        noise_app_lower = noise_app.lower()
        if normalized_app == noise_app_lower or (len(normalized_app) > 3 and noise_app_lower.endswith(normalized_app)):
            return "noise"
    
    # Check work apps (exact match, case-insensitive)
    for work_app in WORK_APPS:
        work_app_lower = work_app.lower()
        if normalized_app == work_app_lower or (len(normalized_app) > 3 and work_app_lower.endswith(normalized_app)):
            return "work"
    
    # Check neutral apps
    is_neutral = False
    for neutral_app in NEUTRAL_APPS:
        neutral_app_lower = neutral_app.lower()
        if normalized_app == neutral_app_lower or (len(normalized_app) > 3 and neutral_app_lower.endswith(normalized_app)):
            is_neutral = True
            break
    
    if not is_neutral:
        # If not in any category, default to neutral
        return "neutral"
    
    # For neutral apps, check title for work/noise indicators
    if title:
        title_lower = title.lower()
        
        # Check for noise keywords first (higher priority)
        for pattern in NOISE_KEYWORDS:
            if re.search(pattern, title_lower, re.IGNORECASE):
                return "noise"
        
        # Check for work keywords
        for pattern in WORK_KEYWORDS:
            if re.search(pattern, title_lower, re.IGNORECASE):
                return "work"
    
    # Default neutral apps to neutral if no indicators found
    return "neutral"


def should_surface_in_briefing(classification: str) -> bool:
    """
    Determine if an activity should surface in the morning briefing.
    
    Args:
        classification: "work", "neutral", or "noise"
    
    Returns:
        True if activity should appear in briefing, False otherwise
    """
    return classification in ("work",)  # Only work surfaces by default


def get_classification_for_session(app_name: str | None, title: str | None = None) -> dict:
    """
    Get detailed classification information for a session.
    
    Returns a dict with:
        - classification: "work" | "neutral" | "noise"
        - surfaces: bool (whether it should appear in briefings)
        - reason: str (explanation of classification)
    """
    classification = classify_activity(app_name, title)
    surfaces = should_surface_in_briefing(classification)
    
    # Generate explanation
    if classification == "work":
        reason = f"Work app: {app_name}"
    elif classification == "noise":
        reason = f"Noise app: {app_name}" + (f" ({title})" if title else "")
    else:  # neutral
        if title and any(re.search(p, title.lower(), re.IGNORECASE) for p in WORK_KEYWORDS):
            reason = f"Neutral app with work content: {app_name}"
        else:
            reason = f"Neutral app: {app_name}" + (f" - {title}" if title else "")
    
    return {
        "classification": classification,
        "surfaces": surfaces,
        "reason": reason,
    }
