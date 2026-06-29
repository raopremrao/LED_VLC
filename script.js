// ==========================================
// VLC SECURE LINK - MASTER LOGIC SCRIPT
// (Updated for FreeRTOS Asynchronous Streaming)
// ==========================================

// --- BLE Service UUIDs (Nordic UART) ---
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Browser -> ESP32 Write
const UART_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // ESP32 -> Browser Notify

// --- Device State ---
let deviceTX = null, charTX_Write = null, charTX_Notify = null;
let deviceRX = null, charRX_Read = null, charRX_Write = null;

// --- Chat Buffers & Echo Cancellation ---
let chatIncomingBuffer = "";
let lastSentMessage = "";
let lastSentTime = 0;

// ==========================================
// FUZZY MATCHING (LEVENSHTEIN DISTANCE)
// ==========================================
function calculateSimilarity(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(matrix[i][j - 1] + 1, // insertion
                    matrix[i - 1][j] + 1) // deletion
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

// ==========================================
// ASYNC STREAMING SYSTEM (REPLACES CHUNKING)
// ==========================================
async function queueMessage(text) {
    if (!text || !charTX_Write) return false;
    
    // Append EOM token so the receiver knows when to draw the bubble
    let fullMsg = text + "[EOM]";
    let encoder = new TextEncoder();
    
    // We send in 100-character blocks to avoid crashing the browser's BLE MTU limit,
    // but we do NOT wait for hardware ACKs anymore. The ESP32 FreeRTOS handles the buffer.
    for (let i = 0; i < fullMsg.length; i += 100) {
        let chunk = fullMsg.slice(i, i + 100);
        
        try {
            await charTX_Write.writeValue(encoder.encode(chunk + '\n'));
            uiLog('TX', `Streamed to Hardware: [${chunk}]`, 'sys');
            
            // Tiny 50ms pause to ensure the ESP32's Core 0 has time to push to the queue
            await new Promise(r => setTimeout(r, 50)); 
        } catch (error) {
            uiLog('TX', `Send error: ${error}`, 'err');
        }
    }
    return true;
}

// ==========================================
// INCOMING DATA PARSER
// ==========================================
function handleIncomingData(event) {
    let text = new TextDecoder('utf-8').decode(event.target.value);
    const isChatPage = document.getElementById('chat-window') !== null;

    if (isChatPage) {
        if (text.startsWith("Sys:")) return; 
        
        chatIncomingBuffer += text;
        
        // Wait until we see the [EOM] token to draw the bubble
        if (chatIncomingBuffer.includes('[EOM]')) {
            
            let cleanMsg = chatIncomingBuffer.replace(/\[EOM\]/g, '').replace(/\n/g, '').trim();
            let sentMsgClean = lastSentMessage.replace(/\n/g, '').trim();
            
            let errorMargin = calculateSimilarity(cleanMsg, sentMsgClean);
            let allowedErrors = Math.max(5, Math.floor(sentMsgClean.length * 0.25)); 
            
            // Echo cancellation allows for dropped VLC bits, waits up to 60s
            if (errorMargin <= allowedErrors && (Date.now() - lastSentTime) < 60000) {
                uiLog('SYS', `Suppressed echo (Noise errors corrected: ${errorMargin})`, 'sys');
                lastSentMessage = ""; 
            } else if (cleanMsg.length > 0) {
                renderChatBubble(cleanMsg, 'rcvd');
            }
            
            chatIncomingBuffer = "";
        }
    } else {
        // Dashboard Console Output
        if (text.startsWith("Sys:")) uiLog('RX', text.trim(), 'sys');
        else uiLog('RX', text, 'rx');
    }
}

// ==========================================
// BLE CONNECTION MANAGEMENT
// ==========================================
async function connectBLE(role) {
    try {
        uiLog(role, `Requesting BLE Device for ${role}...`, 'sys');
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'VLC_' }], 
            optionalServices: [UART_SERVICE_UUID]
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(UART_SERVICE_UUID);

        if (role === 'TX') {
            deviceTX = device;
            charTX_Write = await service.getCharacteristic(UART_TX_CHAR_UUID);
            
            deviceTX.addEventListener('gattserverdisconnected', () => handleDisconnect('TX'));
            updateConnectionUI('TX', true, device.name);
            uiLog('TX', `Connected to ${device.name}`, 'sys');
        } 
        else if (role === 'RX') {
            deviceRX = device;
            charRX_Read = await service.getCharacteristic(UART_RX_CHAR_UUID);
            charRX_Write = await service.getCharacteristic(UART_TX_CHAR_UUID);
            
            await charRX_Read.startNotifications();
            charRX_Read.addEventListener('characteristicvaluechanged', handleIncomingData);
            deviceRX.addEventListener('gattserverdisconnected', () => handleDisconnect('RX'));

            updateConnectionUI('RX', true, device.name);
            uiLog('RX', `Connected to ${device.name}`, 'sys');
            
            if (document.getElementById('rx-mode-select')) changeRxMode(); 
        }
    } catch (error) {
        uiLog(role, `Connection failed: ${error}`, 'err');
    }
}

function disconnectBLE(role) {
    if (role === 'TX' && deviceTX) deviceTX.gatt.disconnect();
    else if (role === 'RX' && deviceRX) deviceRX.gatt.disconnect();
}

function handleDisconnect(role) {
    updateConnectionUI(role, false, "");
    uiLog(role, `Device disconnected.`, 'err');
    if (role === 'TX') { 
        deviceTX = null; charTX_Write = null; 
    } 
    else { deviceRX = null; charRX_Read = null; charRX_Write = null; }
}

// ==========================================
// UI HANDLING (DASHBOARD & CHAT)
// ==========================================
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    if(tab === 'tx') {
        document.getElementById('tab-tx').classList.add('active');
        document.getElementById('panel-tx').classList.add('active');
    } else {
        document.getElementById('tab-rx').classList.add('active');
        document.getElementById('panel-rx').classList.add('active');
    }
}

function updateConnectionUI(role, isConnected, deviceName) {
    const isChatPage = document.getElementById('chat-window') !== null;
    if (isChatPage) {
        const statusText = document.getElementById('wa-status-text');
        let txStatus = deviceTX ? '🟢' : '🔴';
        let rxStatus = deviceRX ? '🟢' : '🔴';
        statusText.innerText = `TX: ${txStatus} | RX: ${rxStatus}`;
    } else {
        document.getElementById(`status-${role.toLowerCase()}`).innerText = isConnected ? `Status: Connected to ${deviceName}` : `Status: Disconnected`;
        document.getElementById(`btn-conn-${role.toLowerCase()}`).style.display = isConnected ? 'none' : 'inline-block';
        document.getElementById(`btn-disc-${role.toLowerCase()}`).style.display = isConnected ? 'inline-block' : 'none';
        if (role === 'RX') document.getElementById('rx-mode-select').disabled = !isConnected;
    }
}

function uiLog(role, msg, type) {
    const consoleEl = document.getElementById(`console-${role.toLowerCase()}`);
    if (!consoleEl) return; 
    const time = new Date().toLocaleTimeString();
    let colorClass = 'sys';
    if (type === 'tx') colorClass = 'tx';
    if (type === 'rx') colorClass = 'rx';
    if (type === 'err') colorClass = 'err';
    consoleEl.innerHTML += `<div><span style="color:#555">[${time}]</span> <span class="${colorClass}">${msg}</span></div>`;
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole(consoleId) { document.getElementById(consoleId).innerHTML = ''; }

async function changeRxMode() {
    if (!charRX_Write) return;
    const modeCommand = document.getElementById('rx-mode-select').value + '\n';
    try {
        await charRX_Write.writeValue(new TextEncoder().encode(modeCommand));
        uiLog('RX', `Sending setting -> ${modeCommand.trim()}`, 'sys');
    } catch (e) { uiLog('RX', `Setting Error`, 'err'); }
}

function dashboardSendMessage() {
    const inputEl = document.getElementById('tx-input');
    queueMessage(inputEl.value).then(() => {
        uiLog('TX', `Queued: ${inputEl.value.trim()}`, 'tx');
        inputEl.value = ''; 
    });
}

// ==========================================
// CHAT UI RENDERING ENGINE
// ==========================================
function sendChatMessage() {
    const inputEl = document.getElementById('chat-input');
    const text = inputEl.value.trim();
    if (!text) return;

    if (!charTX_Write) {
        alert("Please connect your Transmitter (TX) using the top right icon!");
        return;
    }

    queueMessage(text).then(() => {
        lastSentMessage = text;
        lastSentTime = Date.now();
        renderChatBubble(text, 'sent');
        inputEl.value = '';
    });
}

function renderChatBubble(text, type) {
    const windowEl = document.getElementById('chat-window');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const bubbleWrapper = document.createElement('div');
    bubbleWrapper.className = `wa-bubble-wrapper ${type}`;
    
    const bubble = document.createElement('div');
    bubble.className = `wa-bubble`;
    bubble.innerHTML = `<span class="wa-msg-text">${text}</span><span class="wa-msg-time">${time}</span>`;
    
    bubbleWrapper.appendChild(bubble);
    windowEl.appendChild(bubbleWrapper);
    windowEl.scrollTop = windowEl.scrollHeight;
}

// Add event listener for Enter key in Chat Input
window.onload = () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener("keypress", function(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                sendChatMessage();
            }
        });
    }
};