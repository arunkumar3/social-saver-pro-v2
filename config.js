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
  SYNC_HOUR: 0,        // Midnight (0-23)
  SYNC_MINUTE: 0,      // Minute (0-59)
  
  // Content capture
  MIN_TWEET_LENGTH: 30, // Ignore very short tweets
  MAX_SCROLL_TIME: 60000, // Max 60s for bookmark page scrolling
};

// Make available to both content script and service worker
if (typeof globalThis !== "undefined") {
  globalThis.SSP_CONFIG = SSP_CONFIG;
}
