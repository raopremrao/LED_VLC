// --- BLE Service UUIDs ---
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Browser -> ESP32 Write
const UART_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // ESP32 -> Browser Notify

let deviceTX = null, charTX_Write = null;
let deviceRX = null, charRX_Read = null, charRX_Write = null;

// Chat buffer to combine characters before rendering a bubble
let chatIncomingBuffer = "";

// --- Shared BLE Connection Logic ---
async function connectBLE(role) {
    try {
        uiLog(role, `Requesting BLE Device for ${role}...`, 'sys');
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'VLC_' }], 
            optionalServices: [UART_SERVICE_UUID]
        });

        uiLog(role, `Connecting to GATT Server...`, 'sys');
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
            
            // If on dashboard, sync print mode
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
    if (role === 'TX') { deviceTX = null; charTX_Write = null; } 
    else { deviceRX = null; charRX_Read = null; charRX_Write = null; }
}

// --- Data Transmission ---
async function sendMessage(text) {
    if (!text || !charTX_Write) return false;
    try {
        let encoder = new TextEncoder();
        await charTX_Write.writeValue(encoder.encode(text + '\n'));
        return true;
    } catch (error) {
        uiLog('TX', `Send error: ${error}`, 'err');
        return false;
    }
}

// --- Incoming Data Router ---
function handleIncomingData(event) {
    let text = new TextDecoder('utf-8').decode(event.target.value);
    
    // Check which page we are on
    const isChatPage = document.getElementById('chat-window') !== null;

    if (isChatPage) {
        // CHAT MODE: Buffer characters and wait for Newline to create a bubble
        if (text.startsWith("Sys:")) return; // Ignore system settings messages in chat
        
        chatIncomingBuffer += text;
        if (chatIncomingBuffer.includes('\n')) {
            renderChatBubble(chatIncomingBuffer.trim(), 'rcvd');
            chatIncomingBuffer = "";
        }
    } else {
        // DASHBOARD MODE: Print raw to console
        if (text.startsWith("Sys:")) uiLog('RX', text.trim(), 'sys');
        else uiLog('RX', text, 'rx');
    }
}


// ==========================================
// UI HANDLING FUNCTIONS
// ==========================================

// Dashboard Tab Switcher
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

// Universal UI Updater (Works for both Dashboard and Chat pages)
function updateConnectionUI(role, isConnected, deviceName) {
    const isChatPage = document.getElementById('chat-window') !== null;

    if (isChatPage) {
        // Update Chat UI Badges
        const badge = document.getElementById(`badge-${role.toLowerCase()}`);
        if (isConnected) {
            badge.classList.add('connected');
            badge.innerText = `${role} Connected`;
        } else {
            badge.classList.remove('connected');
            badge.innerText = `${role} Disconnected`;
        }
    } else {
        // Update Dashboard UI Buttons
        document.getElementById(`status-${role.toLowerCase()}`).innerText = isConnected ? `Status: Connected to ${deviceName}` : `Status: Disconnected`;
        document.getElementById(`btn-conn-${role.toLowerCase()}`).style.display = isConnected ? 'none' : 'inline-block';
        document.getElementById(`btn-disc-${role.toLowerCase()}`).style.display = isConnected ? 'inline-block' : 'none';
        
        if (role === 'RX') document.getElementById('rx-mode-select').disabled = !isConnected;
    }
}

// Universal Logger (Routes to correct console if it exists)
function uiLog(role, msg, type) {
    const consoleEl = document.getElementById(`console-${role.toLowerCase()}`);
    if (!consoleEl) return; // Ignores if on Chat page
    
    const time = new Date().toLocaleTimeString();
    let colorClass = 'sys';
    if (type === 'tx') colorClass = 'tx';
    if (type === 'rx') colorClass = 'rx';
    if (type === 'err') colorClass = 'err';

    consoleEl.innerHTML += `<div><span style="color:#555">[${time}]</span> <span class="${colorClass}">${msg}</span></div>`;
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole(consoleId) {
    document.getElementById(consoleId).innerHTML = '';
}

// Dashboard Specific: Send Settings
async function changeRxMode() {
    if (!charRX_Write) return;
    const modeCommand = document.getElementById('rx-mode-select').value + '\n';
    try {
        await charRX_Write.writeValue(new TextEncoder().encode(modeCommand));
        uiLog('RX', `Sending setting -> ${modeCommand.trim()}`, 'sys');
    } catch (e) { uiLog('RX', `Setting Error`, 'err'); }
}

// Dashboard Specific: Send TX Message
async function dashboardSendMessage() {
    const inputEl = document.getElementById('tx-input');
    if (await sendMessage(inputEl.value)) {
        uiLog('TX', `Sent: ${inputEl.value.trim()}`, 'tx');
        inputEl.value = ''; 
    }
}

// --- CHAT UI FUNCTIONS ---
async function sendChatMessage() {
    const inputEl = document.getElementById('chat-input');
    const text = inputEl.value.trim();
    if (!text) return;

    if (!charTX_Write) {
        alert("Please connect to your Transmitter (TX) first!");
        return;
    }

    if (await sendMessage(text)) {
        renderChatBubble(text, 'sent');
        inputEl.value = '';
    }
}

function renderChatBubble(text, type) {
    const windowEl = document.getElementById('chat-window');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${type}`;
    bubble.innerHTML = `${text} <span class="msg-time">${time}</span>`;
    
    windowEl.appendChild(bubble);
    windowEl.scrollTop = windowEl.scrollHeight;
}

// Setup Event Listeners on Page Load
window.onload = () => {
    // Detect Enter key in Chat
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