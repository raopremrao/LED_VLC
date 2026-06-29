// ==========================================
// VLC SECURE LINK - MASTER LOGIC SCRIPT
// (Includes Image Streaming & Base64 Downscaling)
// ==========================================

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; 
const UART_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; 

let deviceTX = null, charTX_Write = null, charTX_Notify = null;
let deviceRX = null, charRX_Read = null, charRX_Write = null;

let chatIncomingBuffer = "";
let lastSentMessage = "";
let lastSentTime = 0;
let isSendingImage = false; // Flag to help echo cancellation

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
            
            // CRITICAL: Max width/height of 64 pixels. 
            // Any larger and the VLC transfer will take over 5 minutes.
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

            // Compress to JPEG at 40% quality to save bytes
            const dataUrl = canvas.toDataURL('image/jpeg', 0.4); 
            
            // Wrap in tokens so the receiver knows it's an image
            let payload = "[IMG_START]" + dataUrl + "[IMG_END]";
            
            isSendingImage = true;
            lastSentTime = Date.now();
            
            uiLog('TX', `Image compressed to ${payload.length} bytes. Streaming...`, 'tx');

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
    
    // Stream in 100-character blocks
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
                
                // Echo Cancellation for Images: Images take a long time to send.
                // If we sent an image in the last 2 minutes, assume this massive block of text is our own echo.
                if (isSendingImage && (Date.now() - lastSentTime) < 120000) {
                    uiLog('SYS', `Suppressed image echo.`, 'sys');
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
        // Render an HTML image tag using the Base64 string
        bubble.innerHTML = `<img src="${content}" style="max-width: 150px; border-radius: 8px;" alt="VLC Image"/><span class="wa-msg-time">${time}</span>`;
    } else {
        bubble.innerHTML = `<span class="wa-msg-text">${content}</span><span class="wa-msg-time">${time}</span>`;
    }
    
    bubbleWrapper.appendChild(bubble);
    windowEl.appendChild(bubbleWrapper);
    windowEl.scrollTop = windowEl.scrollHeight;
}

// Standard BLE setup & UI functions remain the same below...
async function connectBLE(role) { /* ... unchanged ... */ }
function disconnectBLE(role) { /* ... unchanged ... */ }
function handleDisconnect(role) { /* ... unchanged ... */ }
function switchTab(tab) { /* ... unchanged ... */ }
function updateConnectionUI(role, isConnected, deviceName) { /* ... unchanged ... */ }
function uiLog(role, msg, type) { /* ... unchanged ... */ }
function clearConsole(consoleId) { document.getElementById(consoleId).innerHTML = ''; }
async function changeRxMode() { /* ... unchanged ... */ }
function dashboardSendMessage() { /* ... unchanged ... */ }

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