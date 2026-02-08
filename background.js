
import { SupabaseClient } from './lib/supabase-client.js';
import { CONFIG } from './config.js';

const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;

const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY = 'gemini_folders_data';
let isSyncing = false; // Prevent loops

// Listen for storage changes
chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
        // 1. Check if Folders Changed
        if (changes[STORAGE_KEY]) {
            // Avoid reacting to our own writes (if we pull from cloud)
            // For now, assume writes from Content Script need to go to Cloud.

            const newValue = changes[STORAGE_KEY].newValue;
            if (!newValue) return; // Deleted?

            await syncToCloud(newValue.folders);
        }

        // 2. Check if Session Changed (User logged in/out)
        if (changes['supabase_session']) {
            const session = changes['supabase_session'].newValue;
            if (session && session.access_token) {
                supabase.setSession(session.access_token);
                // Maybe trigger a pull on login?
            } else {
                supabase.setSession(null);
            }
        }
    }
});

async function syncToCloud(folders) {
    if (isSyncing) return;

    // Get current session from storage if not set
    if (!supabase.token) {
        const stored = await chrome.storage.local.get(['supabase_session']);
        if (stored.supabase_session && stored.supabase_session.access_token) {
            supabase.setSession(stored.supabase_session.access_token);
        } else {
            return; // No user logged in, cannot sync
        }
    }

    // Get User ID
    // Optimally we store user info or get it from token. 
    // Our popup saves 'user' object in session. Let's get it.
    const stored = await chrome.storage.local.get(['supabase_session']);
    const user = stored.supabase_session?.user;

    if (!user || !user.id) return;

    try {
        isSyncing = true;
        console.log('[Background] Pushing changes to Supabase...');
        await supabase.upsertFolders(user.id, { folders: folders });
        console.log('[Background] Sync Success');
    } catch (err) {
        console.error('[Background] Sync Failed', JSON.stringify(err, null, 2));
    } finally {
        isSyncing = false;
    }
}
