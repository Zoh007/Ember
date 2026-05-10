"""
Test the work/noise classifier
"""

from recall_ai.work_noise_classifier import classify_activity, get_classification_for_session


def test_work_app_classification():
    """Test that work apps are always classified as work"""
    work_apps = ["VS Code", "Code", "Terminal", "Notion", "Figma", "Xcode", "Cursor"]
    for app in work_apps:
        result = classify_activity(app, "any title")
        assert result == "work", f"Expected {app} to be work, got {result}"
    print("✓ Work apps classified correctly")


def test_noise_app_classification():
    """Test that noise apps are classified as noise"""
    noise_apps = ["YouTube", "Spotify", "Reddit", "Twitter", "WhatsApp"]
    for app in noise_apps:
        result = classify_activity(app, "any title")
        assert result == "noise", f"Expected {app} to be noise, got {result}"
    print("✓ Noise apps classified correctly")


def test_neutral_app_work_content():
    """Test that neutral apps with work content are classified as work"""
    test_cases = [
        ("Chrome", "github.com - pull requests", "work"),
        ("Safari", "stackoverflow.com - python question", "work"),
        ("Chrome", "localhost:3000 - development", "work"),
        ("Safari", "AWS console - EC2", "work"),
        ("Firefox", "Notion - project planning", "work"),
    ]
    
    for app, title, expected in test_cases:
        result = classify_activity(app, title)
        assert result == expected, f"Expected {app} + '{title}' to be {expected}, got {result}"
    print("✓ Neutral apps with work content classified correctly")


def test_neutral_app_noise_content():
    """Test that neutral apps with noise content are classified as noise"""
    test_cases = [
        ("Chrome", "youtube - funny videos", "noise"),
        ("Safari", "netflix - watch movies", "noise"),
        ("Chrome", "reddit - r/aww", "noise"),
        ("Firefox", "twitter - home", "noise"),
    ]
    
    for app, title, expected in test_cases:
        result = classify_activity(app, title)
        assert result == expected, f"Expected {app} + '{title}' to be {expected}, got {result}"
    print("✓ Neutral apps with noise content classified correctly")


def test_neutral_app_no_indicators():
    """Test that neutral apps without work/noise indicators are neutral"""
    result = classify_activity("Chrome", "New Tab")
    assert result == "neutral", f"Expected neutral, got {result}"
    
    result = classify_activity("Safari", "Untitled Page")
    assert result == "neutral", f"Expected neutral, got {result}"
    print("✓ Neutral apps without indicators default to neutral")


def test_case_insensitivity():
    """Test that classification is case-insensitive"""
    test_cases = [
        ("vs code", "test.py", "work"),
        ("VS CODE", "README.md", "work"),
        ("chrome", "github.com/user/repo", "work"),
        ("YOUTUBE", "music", "noise"),
    ]
    
    for app, title, expected in test_cases:
        result = classify_activity(app, title)
        assert result == expected, f"Expected {app} + '{title}' to be {expected}, got {result}"
    print("✓ Case-insensitive classification works")


def test_get_classification_for_session():
    """Test the detailed classification info function"""
    info = get_classification_for_session("VS Code", "main.py")
    assert info["classification"] == "work"
    assert info["surfaces"] == True
    assert "Work app" in info["reason"]
    
    info = get_classification_for_session("YouTube", "funny videos")
    assert info["classification"] == "noise"
    assert info["surfaces"] == False
    
    info = get_classification_for_session("Chrome", "New Tab")
    assert info["classification"] == "neutral"
    assert info["surfaces"] == False  # Neutral doesn't surface by default
    print("✓ Detailed classification info works")


if __name__ == "__main__":
    test_work_app_classification()
    test_noise_app_classification()
    test_neutral_app_work_content()
    test_neutral_app_noise_content()
    test_neutral_app_no_indicators()
    test_case_insensitivity()
    test_get_classification_for_session()
    print("\n✅ All classifier tests passed!")
