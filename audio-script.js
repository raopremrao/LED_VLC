// ==========================================
// VLC DUAL-ROLE AUDIO ENGINE
// ==========================================
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Mobile reads from here
const UART_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // Laptop writes here

let deviceBLE = null;
let txCharacteristic = null;
let rxCharacteristic = null;

// Audio Configuration
const SAMPLE_RATE = 8000; 
let pcmDataBuffer = null; 

// Playback Engine Variables
let audioCtx = null;
let nextPlayTime = 0;
const CHUNK_SIZE_BYTES = 1024; // Playback buffer threshold

function uiLog(role, msg, type) {
    const consoleEl = document.getElementById(`console-${role.toLowerCase()}`);
    if (!consoleEl) return;
    const time = new Date().toLocaleTimeString();
    let color = type === 'err' ? '#ef9a9a' : '#00a884';
    consoleEl.innerHTML += `<div><span style="color:#555">[${time}]</span> <span style="color:${color}">${msg}</span></div>`;
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    
    document.getElementById(`tab-${tab}`).classList.add('active');
    let panel = document.getElementById(`panel-${tab}`);
    panel.classList.remove('hidden');
    panel.classList.add('active');
}

// ==========================================
// TX: PROCESS & DOWN-SAMPLE AUDIO
// ==========================================
async function processAudioFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    uiLog('TX', `Loading ${file.name}...`, 'sys');
    
    const arrayBuffer = await file.arrayBuffer();
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    
    // Downsample to 8kHz Mono for the laser
    const offlineCtx = new OfflineAudioContext(1, audioBuffer.duration * SAMPLE_RATE, SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    
    const downsampledBuffer = await offlineCtx.startRendering();
    const float32Data = downsampledBuffer.getChannelData(0);
    
    // Convert Float32 to UInt8 (0-255)
    pcmDataBuffer = new Uint8Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
        let val = Math.floor((float32Data[i] + 1.0) * 127.5);
        pcmDataBuffer[i] = Math.max(0, Math.min(255, val));
    }

    uiLog('TX', `Audio ready: ${(pcmDataBuffer.length / 1024).toFixed(1)} KB`, 'sys');
    document.getElementById('btn-stream').disabled = false;
}

// ==========================================
// TX: STREAM OVER BLE -> LASER
// ==========================================
async function streamAudioBuffer() {
    if (!txCharacteristic || !pcmDataBuffer) return;

    uiLog('TX', `Firing laser...`, 'sys');
    const chunkSize = 64; 
    const delayMs = 8; // Tweak this based on ESP32 processing speed

    for (let i = 0; i < pcmDataBuffer.length; i += chunkSize) {
        let chunk = pcmDataBuffer.slice(i, i + chunkSize);
        try {
            // Use WriteWithoutResponse for faster, fire-and-forget streaming
            await txCharacteristic.writeValueWithoutResponse(chunk);
            
            if (i % (chunkSize * 10) === 0) {
                document.getElementById('stream-progress').innerText = `Progress: ${((i / pcmDataBuffer.length) * 100).toFixed(1)}%`;
            }
            await new Promise(r => setTimeout(r, delayMs));
        } catch (error) {
            // Print the actual system error so we aren't flying blind
            uiLog('TX', `Halted: ${error.message}`, 'err');
            console.error(error);
            break;
        }
    }
    document.getElementById('stream-progress').innerText = "Transmission Complete.";
}

// ==========================================
// RX: RECEIVE & PLAY AUDIO
// ==========================================
let receiveBuffer = [];

function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        uiLog('RX', 'Web Audio Context Initialized.', 'sys');
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function handleIncomingAudio(event) {
    const rawData = new Uint8Array(event.target.value.buffer);
    
    // Push bytes into our jitter buffer
    for (let i = 0; i < rawData.length; i++) {
        receiveBuffer.push(rawData[i]);
    }
    
    document.getElementById('rx-buffer-status').innerText = `Buffer: ${receiveBuffer.length} bytes`;

    // Once we have enough bytes, schedule a playback chunk
    if (receiveBuffer.length >= CHUNK_SIZE_BYTES) {
        playAudioChunk(receiveBuffer.splice(0, CHUNK_SIZE_BYTES));
    }
}

function playAudioChunk(uint8Array) {
    if (!audioCtx) return;

    const audioBuffer = audioCtx.createBuffer(1, uint8Array.length, SAMPLE_RATE);
    const channelData = audioBuffer.getChannelData(0);

    // Convert back from UInt8 (0-255) to Float32 (-1.0 to 1.0)
    for (let i = 0; i < uint8Array.length; i++) {
        channelData[i] = (uint8Array[i] - 127.5) / 127.5;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    // Continuous playback scheduling
    if (nextPlayTime < audioCtx.currentTime) {
        nextPlayTime = audioCtx.currentTime + 0.05; // 50ms buffer
    }
    
    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
}

// ==========================================
// BLE CONNECTION HANDLER
// ==========================================
async function connectBLE(role) {
    try {
        uiLog(role, `Scanning for ${role} device...`, 'sys');
        
        // Mobile browsers require user interaction to play audio. 
        // We use the connect button click to unlock the audio context.
        if (role === 'RX') initAudioContext();

        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'VLC_' }], 
            optionalServices: [UART_SERVICE_UUID]
        });
        
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(UART_SERVICE_UUID);
        
        deviceBLE = device;

        if (role === 'TX') {
            txCharacteristic = await service.getCharacteristic(UART_RX_CHAR_UUID);
        } else {
            rxCharacteristic = await service.getCharacteristic(UART_TX_CHAR_UUID);
            await rxCharacteristic.startNotifications();
            rxCharacteristic.addEventListener('characteristicvaluechanged', handleIncomingAudio);
        }
        
        document.getElementById(`status-${role.toLowerCase()}`).innerText = `Status: Connected to ${device.name}`;
        uiLog(role, `Successfully connected.`, 'sys');

    } catch (error) {
        uiLog(role, `Connection failed: ${error.message}`, 'err');
    }
}