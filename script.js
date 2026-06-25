// ==========================================
// VLC SECURE LINK - MASTER LOGIC SCRIPT
// ==========================================

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; 
const UART_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; 

let deviceTX = null, charTX_Write = null, charTX_Notify = null;
let deviceRX = null, charRX_Read = null, charRX_Write = null;

let chatIncomingBuffer = "";
let rxBufferTimeout = null; 

// ==========================================
// CHUNKING & TIME-BASED BLINDING
// ==========================================
const CHUNK_SIZE = 15; // Reduced from 25 to leave safe headroom for [EOM] tag within BLE MTU
let txQueue = [];
let isWaitingForAck = false;
let ackTimeout = null; 

// SELF-HEALING MUTE: Tracks the exact millisecond of our last transmission
let lastTxTime = 0; 

async function processTxQueue() {
    if (txQueue.length === 0 || isWaitingForAck || !charTX_Write) return;
    
    isWaitingForAck = true; 
    let chunk = txQueue.shift(); 
    
    try {
        let encoder = new TextEncoder();
        await charTX_Write.writeValue(encoder.encode(chunk));
        
        lastTxTime = Date.now(); // Refresh the blinding timer
        uiLog('TX', `Sent Chunk: [${chunk}]`, 'sys');
        
        // Failsafe: If ESP32 drops the chunk, unlock after 4 seconds
        ackTimeout = setTimeout(() => {
            uiLog('TX', `Hardware ACK Timeout! Auto-recovering...`, 'err');
            isWaitingForAck = false;
            processTxQueue(); 
        }, 4000);

    } catch (error) {
        uiLog('TX', `Send error: ${error}`, 'err');
        isWaitingForAck = false;
        setTimeout(processTxQueue, 1000); 
    }
}

function handleTxAck(event) {
    let text = new TextDecoder('utf-8').decode(event.target.value);
    if (text.includes("ACK")) {
        clearTimeout(ackTimeout); 
        
        // Wait 150ms so the Receiver ESP32 recognizes the BLE gap
        setTimeout(() => {
            isWaitingForAck = false; 
            lastTxTime = Date.now(); // Extend the blinding timer on ACK
            processTxQueue(); 
        }, 150);
    }
}

function queueMessage(text) {
    if (!text || !charTX_Write) return false;
    
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        let isLastChunk = (i + CHUNK_SIZE >= text.length);
        let chunk = text.slice(i, i + CHUNK_SIZE);
        if (isLastChunk) chunk += "[EOM]";
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

    // SMART LOOPBACK BLIND: Suppress any echo that arrives within 1500ms of our
    // last transmission. The loopback echo (our own LED → our own photodiode) always
    // arrives within ~850ms. The other person's reply always takes longer (human typing).
    // TX ACKs come via charTX_Notify (handleTxAck), not here, so we never block those.
    if (Date.now() - lastTxTime < 1500) {
        chatIncomingBuffer = "";
        clearTimeout(rxBufferTimeout);
        return;
    }

    if (isChatPage) {
        if (text.startsWith("Sys:")) return; 
        
        chatIncomingBuffer += text;
        clearTimeout(rxBufferTimeout); 

        if (chatIncomingBuffer.includes('[EOM]')) {
            flushRxBuffer();
        } else {
            rxBufferTimeout = setTimeout(flushRxBuffer, 4000);
        }
    } else {
        if (text.startsWith("Sys:")) uiLog('RX', text.trim(), 'sys');
        else uiLog('RX', text, 'rx');
    }
}

function flushRxBuffer() {
    if (!chatIncomingBuffer) return;
    
    let cleanMsg = chatIncomingBuffer.replace(/\[EOM\]/g, '').replace(/\n/g, '').trim();
    
    if (cleanMsg.length > 0) {
        renderChatBubble(cleanMsg, 'rcvd');
    }
    
    chatIncomingBuffer = ""; 
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
            charTX_Notify = await service.getCharacteristic(UART_RX_CHAR_UUID);
            await charTX_Notify.startNotifications();
            charTX_Notify.addEventListener('characteristicvaluechanged', handleTxAck);

            deviceTX.addEventListener('gattserverdisconnected', () => handleDisconnect('TX'));
            updateConnectionUI('TX', true, device.name);
        } 
        else if (role === 'RX') {
            deviceRX = device;
            charRX_Read = await service.getCharacteristic(UART_RX_CHAR_UUID);
            charRX_Write = await service.getCharacteristic(UART_TX_CHAR_UUID);
            await charRX_Read.startNotifications();
            charRX_Read.addEventListener('characteristicvaluechanged', handleIncomingData);
            deviceRX.addEventListener('gattserverdisconnected', () => handleDisconnect('RX'));

            updateConnectionUI('RX', true, device.name);
            if (document.getElementById('rx-mode-select')) changeRxMode(); 
        }
    } catch (e) { uiLog(role, `Connection failed: ${e}`, 'err'); }
}

function disconnectBLE(role) {
    if (role === 'TX' && deviceTX) deviceTX.gatt.disconnect();
    else if (role === 'RX' && deviceRX) deviceRX.gatt.disconnect();
}

function handleDisconnect(role) {
    updateConnectionUI(role, false, "");
    if (role === 'TX') { 
        deviceTX = null; charTX_Write = null; charTX_Notify = null; 
        txQueue = []; isWaitingForAck = false; clearTimeout(ackTimeout);
    } else { deviceRX = null; charRX_Read = null; charRX_Write = null; }
}

// ==========================================
// UI HANDLING
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
        document.getElementById('wa-status-text').innerText = `TX: ${deviceTX ? '🟢' : '🔴'} | RX: ${deviceRX ? '🟢' : '🔴'}`;
    } else {
        document.getElementById(`status-${role.toLowerCase()}`).innerText = isConnected ? `Status: Connected` : `Status: Disconnected`;
        document.getElementById(`btn-conn-${role.toLowerCase()}`).style.display = isConnected ? 'none' : 'inline-block';
        document.getElementById(`btn-disc-${role.toLowerCase()}`).style.display = isConnected ? 'inline-block' : 'none';
        if (role === 'RX') document.getElementById('rx-mode-select').disabled = !isConnected;
    }
}

function uiLog(role, msg, type) {
    const consoleEl = document.getElementById(`console-${role.toLowerCase()}`);
    if (!consoleEl) return; 
    let colorClass = type === 'tx' ? 'tx' : (type === 'rx' ? 'rx' : (type === 'err' ? 'err' : 'sys'));
    consoleEl.innerHTML += `<div><span style="color:#555">[${new Date().toLocaleTimeString()}]</span> <span class="${colorClass}">${msg}</span></div>`;
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole(consoleId) { document.getElementById(consoleId).innerHTML = ''; }

async function changeRxMode() {
    if (!charRX_Write) return;
    const modeCommand = document.getElementById('rx-mode-select').value + '\n';
    try {
        await charRX_Write.writeValue(new TextEncoder().encode(modeCommand));
    } catch (e) {}
}

function dashboardSendMessage() {
    const inputEl = document.getElementById('tx-input');
    if (queueMessage(inputEl.value)) inputEl.value = ''; 
}

function sendChatMessage() {
    const inputEl = document.getElementById('chat-input');
    const text = inputEl.value.trim();
    if (!text) return;

    // Hard block: TX is required to send anything
    if (!charTX_Write) {
        alert("TX not connected!\n\nTap the TX button and select your VLC_TX device first.");
        return;
    }

    // Soft warning: RX is required to receive replies
    if (!charRX_Read) {
        const proceed = confirm("RX not connected — you won't see replies from the other side.\n\nConnect RX after sending, or tap Cancel to connect now.");
        if (!proceed) return;
    }

    if (queueMessage(text)) {
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

window.onload = () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") { e.preventDefault(); sendChatMessage(); }
        });
    }

    // Remind user to connect both devices on chat page
    const statusEl = document.getElementById('wa-status-text');
    if (statusEl) {
        statusEl.title = "Connect TX first (your transmitter), then RX (your receiver)";
    }
};