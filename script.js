// ==========================================
// VLC SECURE LINK - MASTER LOGIC SCRIPT
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
// CHUNKING & ROBUST QUEUE SYSTEM
// ==========================================
const CHUNK_SIZE = 10; // Safe size to prevent radio starvation
let txQueue = [];
let isWaitingForAck = false;
let ackTimeout = null; 

async function processTxQueue() {
    if (txQueue.length === 0 || isWaitingForAck || !charTX_Write) return;
    
    isWaitingForAck = true; 
    let chunk = txQueue.shift(); 
    
    try {
        let encoder = new TextEncoder();
        await charTX_Write.writeValue(encoder.encode(chunk + '\n'));
        uiLog('TX', `Sent Chunk: [${chunk}]`, 'sys');
        
        // FAILSAFE: Unlock the queue if ESP32 drops the packet
        ackTimeout = setTimeout(() => {
            uiLog('TX', `Hardware ACK Timeout! Auto-recovering queue...`, 'err');
            isWaitingForAck = false;
            processTxQueue();
        }, 4000);

    } catch (error) {
        uiLog('TX', `Send error: ${error}`, 'err');
        isWaitingForAck = false;
        setTimeout(processTxQueue, 1000); // Retry next chunk after a second
    }
}

function handleTxAck(event) {
    let text = new TextDecoder('utf-8').decode(event.target.value);
    if (text.includes("ACK")) {
        clearTimeout(ackTimeout); 
        
        // RACE CONDITION FIX: Give the ESP32 150ms to breathe
        setTimeout(() => {
            isWaitingForAck = false; 
            processTxQueue(); 
        }, 150);
    }
}

function queueMessage(text) {
    if (!text || !charTX_Write) return false;
    
    // Slice the message and inject the End of Message [EOM] token
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        let isLastChunk = (i + CHUNK_SIZE >= text.length);
        let chunk = text.slice(i, i + CHUNK_SIZE);
        
        if (isLastChunk) {
            chunk += "[EOM]";
        }
        
        txQueue.push(chunk);
    }
    
    processTxQueue();
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
            
            // Clean the token and stray newlines out of the final text
            let cleanMsg = chatIncomingBuffer.replace(/\[EOM\]/g, '').replace(/\n/g, '').trim();

            // Echo cancellation: Ignore if it perfectly matches what we just sent
            if (cleanMsg === lastSentMessage && (Date.now() - lastSentTime) < 60000) {
                lastSentMessage = ""; 
            } else if (cleanMsg.length > 0) {
                renderChatBubble(cleanMsg, 'rcvd');
            }
            
            // Flush buffer for the next message
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
            
            // Listen for ACKs
            charTX_Notify = await service.getCharacteristic(UART_RX_CHAR_UUID);
            await charTX_Notify.startNotifications();
            charTX_Notify.addEventListener('characteristicvaluechanged', handleTxAck);

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
        deviceTX = null; charTX_Write = null; charTX_Notify = null; 
        txQueue = []; isWaitingForAck = false; clearTimeout(ackTimeout);
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
    if (queueMessage(inputEl.value)) {
        uiLog('TX', `Queued: ${inputEl.value.trim()}`, 'tx');
        inputEl.value = ''; 
    }
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

    if (queueMessage(text)) {
        lastSentMessage = text;
        lastSentTime = Date.now();
        renderChatBubble(text, 'sent');
        inputEl.value = '';
    }
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