/**
 * Social Saver Pro - Configuration
 * 
 * Fill in your Supabase credentials from:
 * Supabase Dashboard → Settings → API
 */

const SSP_CONFIG = {
  // Supabase
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  
  // Sync settings
  SYNC_HOUR: 9,        // 9 AM daily (0-23)
  SYNC_MINUTE: 0,      // Minute (0-59)

  // Content capture
  MIN_TWEET_LENGTH: 30,    // Ignore very short tweets
  MAX_SCROLL_TIME: 60000,  // Max 60s for bookmark page scrolling
  TAB_LOAD_WAIT: 2000,     // Wait after tab load for X rendering (ms)
  BETWEEN_TAB_DELAY: 1500, // Delay between processing individual bookmarks (ms)
};

// Make available to both content script and service worker
if (typeof globalThis !== "undefined") {
  globalThis.SSP_CONFIG = SSP_CONFIG;
}
