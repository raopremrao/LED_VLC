// ==========================================
// VLC SECURE LINK - MASTER LOGIC SCRIPT
// (Includes Async Streaming, Image Transfer & Full BLE Logic)
// ==========================================

// --- BLE Service UUIDs (Nordic UART) ---
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; 
const UART_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; 

// --- Device State ---
let deviceTX = null, charTX_Write = null, charTX_Notify = null;
let deviceRX = null, charRX_Read = null, charRX_Write = null;

// --- Chat Buffers & Echo Cancellation ---
let chatIncomingBuffer = "";
let lastSentMessage = "";
let lastSentTime = 0;
let isSendingImage = false;

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
                    matrix[i - 1][j - 1] + 1, 
                    Math.min(matrix[i][j - 1] + 1, 
                    matrix[i - 1][j] + 1) 
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

// ==========================================
// IMAGE PROCESSING & DOWNSCALING
// ==========================================
function sendImage() {
    const fileInput = document.getElementById('image-input');
    const file = fileInput.files[0];
    if (!file || !charTX_Write) return;

    uiLog('SYS', `Processing image...`, 'sys');

    const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            const MAX_SIZE = 64; 
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                }
            } else {
                if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
            }
            canvas.width = width;
            canvas.height = height;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.4); 
            let payload = "[IMG_START]" + dataUrl + "[IMG_END]";
            
            isSendingImage = true;
            lastSentTime = Date.now();
            
            uiLog('TX', `Image compressed. Streaming...`, 'tx');

            queueMessage(payload).then(() => {
                renderChatBubble(dataUrl, 'sent', true);
                fileInput.value = ""; 
            });
        }
        img.src = event.target.result;
    }
    reader.readAsDataURL(file);
}

// ==========================================
// ASYNC STREAMING SYSTEM 
// ==========================================
async function queueMessage(fullMsg) {
    if (!charTX_Write) return false;
    
    let encoder = new TextEncoder();
    
    for (let i = 0; i < fullMsg.length; i += 100) {
        let chunk = fullMsg.slice(i, i + 100);
        try {
            await charTX_Write.writeValue(encoder.encode(chunk + '\n'));
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
        
        // --- 1. HANDLE INCOMING TEXT ---
        if (chatIncomingBuffer.includes('[EOM]')) {
            let cleanMsg = chatIncomingBuffer.replace(/\[EOM\]/g, '').replace(/\n/g, '').trim();
            let sentMsgClean = lastSentMessage.replace(/\n/g, '').trim();
            
            let errorMargin = calculateSimilarity(cleanMsg, sentMsgClean);
            let allowedErrors = Math.max(5, Math.floor(sentMsgClean.length * 0.25)); 
            
            if (!isSendingImage && errorMargin <= allowedErrors && (Date.now() - lastSentTime) < 60000) {
                lastSentMessage = ""; 
            } else if (cleanMsg.length > 0) {
                renderChatBubble(cleanMsg, 'rcvd', false);
            }
            chatIncomingBuffer = "";
        }
        
        // --- 2. HANDLE INCOMING IMAGES ---
        else if (chatIncomingBuffer.includes('[IMG_END]')) {
            try {
                let startIndex = chatIncomingBuffer.indexOf('[IMG_START]') + 11;
                let endIndex = chatIncomingBuffer.indexOf('[IMG_END]');
                let base64Data = chatIncomingBuffer.substring(startIndex, endIndex).replace(/\n/g, '').trim();
                
                if (isSendingImage && (Date.now() - lastSentTime) < 120000) {
                    isSendingImage = false;
                } else if (base64Data.length > 0) {
                    renderChatBubble(base64Data, 'rcvd', true);
                }
            } catch (e) {
                uiLog('ERR', 'Failed to parse incoming image.', 'err');
            }
            chatIncomingBuffer = "";
        }

    } else {
        if (text.startsWith("Sys:")) uiLog('RX', text.trim(), 'sys');
        else uiLog('RX', text, 'rx');
    }
}

// ==========================================
// BLE CONNECTION MANAGEMENT
// ==========================================
async function connectBLE(role) {
    if (!navigator.bluetooth) {
        alert("ERROR: Your browser does not support Web Bluetooth. (iPhones block this feature entirely. Use Chrome/Edge on Android or PC).");
        return;
    }

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
        alert(`Connection Failed:\n${error.message}`);
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
    let payload = inputEl.value.trim() + "[EOM]";
    queueMessage(payload).then(() => {
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

    let payload = text + "[EOM]";
    queueMessage(payload).then(() => {
        lastSentMessage = text;
        lastSentTime = Date.now();
        isSendingImage = false;
        renderChatBubble(text, 'sent', false);
        inputEl.value = '';
    });
}

function renderChatBubble(content, type, isImage) {
    const windowEl = document.getElementById('chat-window');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const bubbleWrapper = document.createElement('div');
    bubbleWrapper.className = `wa-bubble-wrapper ${type}`;
    
    const bubble = document.createElement('div');
    bubble.className = `wa-bubble`;
    
    if (isImage) {
        bubble.innerHTML = `<img src="${content}" style="max-width: 150px; border-radius: 8px;" alt="VLC Image"/><span class="wa-msg-time">${time}</span>`;
    } else {
        bubble.innerHTML = `<span class="wa-msg-text">${content}</span><span class="wa-msg-time">${time}</span>`;
    }
    
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