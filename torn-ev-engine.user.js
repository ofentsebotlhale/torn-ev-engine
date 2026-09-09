// ==UserScript==
// @name         Torn Bookie EV Engine
// @namespace    http://tampermonkey.net/
// @version      0.0.18
// @description  Sleek, minimal EV Engine for Torn Bookie with auto-stake placement and a compact HUD.
// @author       AI Studio
// @match        https://www.torn.com/bookie.php*
// @match        https://www.torn.com/loader.php?sid=bookie*
// @match        https://www.torn.com/page.php?sid=bookie*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.the-odds-api.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==============================================================================
    // CONFIGURATION & PERSISTENCE
    // ==============================================================================
    
    const getSafeValue = (key, def) => {
        try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : (window.localStorage.getItem(key) || def); } 
        catch (e) { return window.localStorage.getItem(key) || def; }
    };
    
    const setSafeValue = (key, val) => {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, val); else window.localStorage.setItem(key, val); }
        catch (e) { window.localStorage.setItem(key, val); }
    };
    
    let ODDS_API_KEY = getSafeValue('torn_ev_odds_api_key', '');
    let BANKROLL = parseFloat(getSafeValue('torn_ev_bankroll', '10000000'));

    const injectStyles = () => {
        if (document.getElementById('ev-engine-styles')) return;
        const style = document.createElement('style');
        style.id = 'ev-engine-styles';
        style.innerHTML = `
        /* Micro Pill Badges */
        .ev-pill {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 6px;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            font-weight: 700;
            font-size: 10px;
            letter-spacing: 0.02em;
            border-radius: 4px;
            margin-left: 6px;
            vertical-align: middle;
            transition: all 0.15s ease;
            box-shadow: 0 1px 2px rgba(0,0,0,0.4);
        }
        .ev-pill-pos { background: #10b981; color: #09090b; }
        .ev-pill-neg { background: #27272a; color: #71717a; border: 1px solid #3f3f46; }

        /* Quick Stake Action Button */
        .ev-stake-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: #18181b;
            color: #10b981;
            border: 1px solid #10b981;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            font-weight: 800;
            font-size: 10px;
            padding: 3px 8px;
            border-radius: 4px;
            margin-left: 6px;
            cursor: pointer;
            transition: all 0.15s ease;
            text-transform: uppercase;
        }
        .ev-stake-btn:hover {
            background: #10b981;
            color: #09090b;
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
        }

        /* Minimal Floating HUD */
        #ev-hud {
            position: fixed;
            bottom: 16px;
            left: 16px;
            width: 240px;
            background: #09090b;
            border: 1px solid #27272a;
            border-radius: 8px;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            z-index: 99999;
            box-shadow: 0 12px 24px rgba(0,0,0,0.6);
            overflow: hidden;
            backdrop-filter: blur(8px);
        }
        .ev-hud-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: #18181b;
            border-bottom: 1px solid #27272a;
            cursor: pointer;
        }
        .ev-hud-title {
            font-size: 11px;
            font-weight: 800;
            color: #f4f4f5;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .ev-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 6px #10b981;
        }
        .ev-hud-body {
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .ev-hud-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .ev-hud-label {
            font-size: 10px;
            color: #a1a1aa;
            text-transform: uppercase;
            font-weight: 600;
        }
        .ev-hud-input {
            background: #18181b;
            border: 1px solid #3f3f46;
            color: #f4f4f5;
            font-family: monospace;
            font-size: 11px;
            padding: 3px 6px;
            border-radius: 4px;
            width: 100px;
            text-align: right;
        }
        .ev-hud-input:focus {
            outline: none;
            border-color: #10b981;
        }
        .ev-hud-btn {
            background: #27272a;
            color: #f4f4f5;
            border: 1px solid #3f3f46;
            font-size: 10px;
            font-weight: 700;
            padding: 5px;
            border-radius: 4px;
            cursor: pointer;
            text-align: center;
            text-transform: uppercase;
            transition: background 0.15s ease;
        }
        .ev-hud-btn:hover { background: #3f3f46; }
    `;
        (document.head || document.documentElement).appendChild(style);
    };

    injectStyles();

    // ==============================================================================
    // MATH ENGINE
    // ==============================================================================

    function calculateImpliedProbability(decimalOdds) {
        if (!decimalOdds || decimalOdds <= 1) return 0;
        return 1 / decimalOdds;
    }

    function calculateEV(tornOdds, trueProbability) {
        const profit = tornOdds - 1;
        const lossProb = 1 - trueProbability;
        return ((trueProbability * profit) - lossProb) * 100;
    }

    function calculateKelly(tornOdds, trueProbability, fraction = 0.25) {
        const b = tornOdds - 1;
        const p = trueProbability;
        const q = 1 - p;
        const kellyFraction = (b * p - q) / b;
        return Math.max(0, Math.min(kellyFraction * fraction, 0.10));
    }

    // ==============================================================================
    // API FETCHING
    // ==============================================================================
    
    let oddsCache = null;
    let cacheTimestamp = 0;

    function makeGMRequest(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    headers: { "Accept": "application/json" },
                    onload: (res) => {
                        if (res.status === 401 || res.status === 403) {
                            setSafeValue('torn_ev_odds_api_key', '');
                            reject(new Error(`HTTP ${res.status}`));
                        } else if (res.status >= 200 && res.status < 300) {
                            try { resolve(JSON.parse(res.responseText)); } 
                            catch (e) { reject(e); }
                        } else {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    },
                    onerror: (err) => reject(err)
                });
            } else {
                fetch(url).then(r => r.json()).then(resolve).catch(reject);
            }
        });
    }

    async function fetchRealWorldProbability(matchName, selectionName, tornOdds) {
        if (!ODDS_API_KEY) return calculateImpliedProbability(tornOdds);

        try {
            if (!oddsCache || Date.now() - cacheTimestamp > 300000) {
                const url = `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h`;
                oddsCache = await makeGMRequest(url);
                cacheTimestamp = Date.now();
            }

            const matchLower = matchName.toLowerCase();
            const matchedEvent = oddsCache.find(event => 
                matchLower.includes(event.home_team.toLowerCase()) || 
                matchLower.includes(event.away_team.toLowerCase())
            );

            if (matchedEvent && matchedEvent.bookmakers.length > 0) {
                const market = matchedEvent.bookmakers[0].markets[0];
                const outcome = market.outcomes.find(o => 
                    selectionName.toLowerCase().includes(o.name.toLowerCase()) ||
                    o.name.toLowerCase().includes(selectionName.toLowerCase())
                );
                if (outcome && outcome.price > 1) return 1 / outcome.price;
            }
            return calculateImpliedProbability(tornOdds);
        } catch (e) {
            return calculateImpliedProbability(tornOdds);
        }
    }

    // ==============================================================================
    // UI INJECTION & STAKE AUTO-FILL
    // ==============================================================================

    async function injectEVUI(targetEl, matchData, selectionData) {
        if (targetEl.getAttribute('data-ev-injected') === 'true') return;
        targetEl.setAttribute('data-ev-injected', 'true');

        const tornOdds = selectionData.odds;
        const selectionName = selectionData.name;
        
        const trueProb = await fetchRealWorldProbability(matchData.title, selectionName, tornOdds);
        const evPercent = calculateEV(tornOdds, trueProb);
        
        // Render minimal badge
        const badge = document.createElement('span');
        badge.className = `ev-pill ${evPercent > 0 ? 'ev-pill-pos' : 'ev-pill-neg'}`;
        badge.textContent = `${evPercent > 0 ? '+' : ''}${evPercent.toFixed(1)}% EV`;
        targetEl.appendChild(badge);

        // If edge is positive, add 1-click Auto-Fill Stake button
        if (evPercent > 0) {
            const kellyFraction = calculateKelly(tornOdds, trueProb, 0.25);
            const recommendedStake = Math.round(BANKROLL * kellyFraction);

            if (recommendedStake > 0) {
                const stakeBtn = document.createElement('button');
                stakeBtn.className = 'ev-stake-btn';
                stakeBtn.textContent = `$${(recommendedStake / 1000000).toFixed(2)}M`;
                stakeBtn.title = `Click to auto-fill Kelly stake: $${recommendedStake.toLocaleString()}`;
                
                stakeBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    
                    // Locate associated input field on the page
                    const parentCard = targetEl.closest('li, div[class*="match"], div[class*="bet"]');
                    const input = parentCard ? parentCard.querySelector('input[type="text"], input[type="number"]') : document.querySelector('input[type="text"]');
                    
                    if (input) {
                        input.value = recommendedStake;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.focus();
                    } else {
                        // Fallback: copy recommended stake to clipboard
                        navigator.clipboard.writeText(recommendedStake.toString());
                        stakeBtn.textContent = 'COPIED!';
                        setTimeout(() => {
                            stakeBtn.textContent = `$${(recommendedStake / 1000000).toFixed(2)}M`;
                        }, 1200);
                    }
                };

                targetEl.appendChild(stakeBtn);
            }
        }
    }

    // ==============================================================================
    // DOM SCANNER
    // ==============================================================================

    function processBetCards() {
        const candidates = document.querySelectorAll('button, a, [role="button"], label, div[class*="option"]');

        candidates.forEach(el => {
            if (el.getAttribute('data-ev-injected') === 'true' || el.closest('#ev-hud')) return;

            const text = el.textContent.trim().replace(/\s+/g, ' ');
            const matches = text.match(/\b([1-9]\d*(?:\.\d{1,2})?)\b/g);
            if (!matches) return;

            const potentialOdds = parseFloat(matches[matches.length - 1]);

            if (!isNaN(potentialOdds) && potentialOdds > 1.01 && potentialOdds < 500) {
                if (el.tagName === 'INPUT' || el.querySelector('input')) return;

                const name = text.replace(potentialOdds.toString(), '').trim() || "Selection";
                const parentBlock = el.closest('li, div');
                const titleEl = parentBlock ? parentBlock.querySelector('h3, strong, span') : null;
                const matchTitle = titleEl ? titleEl.textContent.trim() : "Unknown Match";

                injectEVUI(el, { title: matchTitle }, { name: name, odds: potentialOdds });
            }
        });
    }

    // ==============================================================================
    // HUD CONTROL
    // ==============================================================================

    function injectHUD() {
        if (document.getElementById('ev-hud')) return;

        const hud = document.createElement('div');
        hud.id = 'ev-hud';
        hud.innerHTML = `
            <div class="ev-hud-header" id="ev-hud-toggle">
                <span class="ev-hud-title"><span class="ev-status-dot"></span> EV ENGINE</span>
                <span style="color:#a1a1aa; font-size:10px;" id="ev-hud-icon">▼</span>
            </div>
            <div class="ev-hud-body" id="ev-hud-body">
                <div class="ev-hud-row">
                    <span class="ev-hud-label">Bankroll ($)</span>
                    <input type="number" class="ev-hud-input" id="ev-bankroll-input" value="${BANKROLL}" />
                </div>
                <div class="ev-hud-row">
                    <span class="ev-hud-label">API Key</span>
                    <input type="password" class="ev-hud-input" id="ev-apikey-input" value="${ODDS_API_KEY}" placeholder="Paste key" />
                </div>
                <button class="ev-hud-btn" id="ev-rescan-btn">Rescan Odds</button>
            </div>
        `;

        document.body.appendChild(hud);

        // HUD Interactions
        const body = document.getElementById('ev-hud-body');
        const toggle = document.getElementById('ev-hud-toggle');
        const icon = document.getElementById('ev-hud-icon');
        let isCollapsed = false;

        toggle.onclick = () => {
            isCollapsed = !isCollapsed;
            body.style.display = isCollapsed ? 'none' : 'flex';
            icon.textContent = isCollapsed ? '▲' : '▼';
        };

        document.getElementById('ev-bankroll-input').onchange = (e) => {
            BANKROLL = parseFloat(e.target.value) || 10000000;
            setSafeValue('torn_ev_bankroll', BANKROLL);
            processBetCards();
        };

        document.getElementById('ev-apikey-input').onchange = (e) => {
            ODDS_API_KEY = e.target.value.trim();
            setSafeValue('torn_ev_odds_api_key', ODDS_API_KEY);
            oddsCache = null; // Clear cache
            processBetCards();
        };

        document.getElementById('ev-rescan-btn').onclick = () => {
            processBetCards();
        };
    }

    // Initialize Observer & HUD
    let timeoutId;
    const observer = new MutationObserver(() => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            processBetCards();
        }, 400);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    
    setTimeout(() => {
        injectHUD();
        processBetCards();
    }, 1000);

})();
