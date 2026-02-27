import { SupabaseClient } from './lib/supabase-client.js';
import { CONFIG } from './config.js';

const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;

const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY = 'gemini_folders_data';
let isSyncing = false; // Prevent loops

// Listen for messages from Popups or Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'saveSession') {
        const session = request.session;

        // Fetch real user object using the token to complete the session
        supabase.setSession(session.access_token);
        supabase.getUser(session.access_token).then(user => {
            session.user = user;
            chrome.storage.local.set({ 'supabase_session': session }, () => {
                sendResponse({ success: true });
            });
        }).catch(err => {
            console.error('[Background] Failed to fetch user details for intercepted token:', err);
            sendResponse({ success: false, error: err });
        });

        return true; // Keep message channel open for async response
    }
});

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
    const stored = await chrome.storage.local.get(['supabase_session']);
    let session = stored.supabase_session;

    if (session && session.access_token) {
        if (supabase.isTokenExpired(session.access_token) && session.refresh_token) {
            console.log('[Background] Token expired, attempting proactive refresh...');
            try {
                const data = await supabase.refreshToken(session.refresh_token);
                if (data.access_token) {
                    console.log('[Background] Token refreshed successfully');
                    session = {
                        access_token: data.access_token,
                        refresh_token: data.refresh_token || session.refresh_token,
                        user: data.user || session.user
                    };
                    await chrome.storage.local.set({ 'supabase_session': session });
                }
            } catch (e) {
                console.error('[Background] Proactive token refresh failed:', e);
                await chrome.storage.local.remove('supabase_session');
                isSyncing = false;
                return; // abort sync
            }
        }
        supabase.setSession(session.access_token);
    } else {
        isSyncing = false;
        return; // No user logged in, cannot sync
    }

    // Get User ID
    const user = session.user;
    if (!user || !user.id) {
        isSyncing = false;
        return;
    }

    try {
        isSyncing = true;
        console.log('[Background] Pushing changes to Supabase...');
        await supabase.upsertFolders(user.id, { folders: folders });
        console.log('[Background] Sync Success');
    } catch (err) {
        // Handle Token Expiry (401)
        if (err.status === 401 && session.refresh_token) {
            console.log('[Background] Token expired, attempting refresh...');
            try {
                const data = await supabase.refreshToken(session.refresh_token);
                if (data.access_token) {
                    console.log('[Background] Token refreshed successfully');

                    // Update Storage with new session
                    const newSession = {
                        access_token: data.access_token,
                        refresh_token: data.refresh_token || session.refresh_token,
                        user: data.user || session.user
                    };
                    await chrome.storage.local.set({ 'supabase_session': newSession });

                    // Retry Sync
                    supabase.setSession(data.access_token);
                    await supabase.upsertFolders(user.id, { folders: folders });
                    console.log('[Background] Retry Sync Success');
                    return;
                }
            } catch (refreshErr) {
                console.error('[Background] Token refresh failed:', refreshErr);
                // IF refresh definitively fails after a 401, remove session
                await chrome.storage.local.remove('supabase_session');
            }
        }
        console.error('[Background] Sync Failed', JSON.stringify(err, null, 2));
    } finally {
        isSyncing = false;
    }
}