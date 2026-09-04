const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let sock = null;
let isConnected = false;
let latestQr = null; 

async function startBaileys() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        // Using a canonical browser config is MANDATORY for pairing codes to work
        browser: Browsers.macOS('Chrome') 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQr = await QRCode.toDataURL(qr);
            io.emit('qr', latestQr);
        }

        if (connection === 'open') {
            isConnected = true;
            latestQr = null;
            io.emit('status', { type: 'connected', msg: 'Client is ready! Connected to WhatsApp.' });
        } 
        else if (connection === 'close') {
            isConnected = false;
            latestQr = null;
            
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                io.emit('status', { type: 'reconnecting', msg: 'Connection lost. Reconnecting...' });
                setTimeout(startBaileys, 3000);
            } else {
                io.emit('status', { type: 'disconnected', msg: 'Session logged out. Please link a new account.' });
                resetSessionFiles();
                setTimeout(startBaileys, 3000);
            }
        }
    });
}

function resetSessionFiles() {
    if (fs.existsSync('./auth_info_baileys')) {
        fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    }
    isConnected = false;
    latestQr = null;
}

io.on('connection', (socket) => {
    // 1. Initial State Sync
    if (isConnected) {
        socket.emit('status', { type: 'connected', msg: 'Client is ready! Connected to WhatsApp.' });
    } else if (latestQr) {
        socket.emit('status', { type: 'qr', msg: 'Link your account via QR or Pairing Code.' });
        socket.emit('qr', latestQr);
    } else {
        socket.emit('status', { type: 'loading', msg: 'Starting WhatsApp client...' });
    }

    // 2. Generate Pairing Code
    socket.on('request_pairing_code', async (phoneNumber) => {
        try {
            if (sock && !sock.authState.creds.registered) {
                const cleanNumber = phoneNumber.replace(/\D/g, '');
                socket.emit('log', `⏳ Requesting pairing code for ${cleanNumber}...`);
                
                const code = await sock.requestPairingCode(cleanNumber);
                socket.emit('pairing_code', code);
                socket.emit('log', `✅ Code generated successfully! Enter it on your phone.`);
            } else {
                socket.emit('log', `⚠️ Client is already registered or not ready.`);
            }
        } catch (error) {
            socket.emit('log', `⚠️ Error requesting pairing code: ${error.message}`);
        }
    });

    // 3. Graceful Reset (fixes the crash)
    socket.on('reset_session', () => {
        socket.emit('log', '⚠️ Resetting session cleanly in memory...');
        if (sock) {
            sock.ev.removeAllListeners();
            sock.ws.close();
            sock = null;
        }
        resetSessionFiles();
        socket.emit('status', { type: 'reconnecting', msg: 'Generating new session...' });
        
        // Wait 2 seconds before booting back up so files clear cleanly
        setTimeout(startBaileys, 2000); 
    });

    // 4. Number Checking Logic
    socket.on('check_numbers', async (numbers) => {
        if (!isConnected || !sock) {
            socket.emit('log', '⚠️ Error: WhatsApp client is not connected yet.');
            return;
        }

        socket.emit('log', `\nStarting batch check for ${numbers.length} numbers...`);
        
        for (let i = 0; i < numbers.length; i++) {
            let num = numbers[i];
            if (num.length === 10) num = `91${num}`;

            try {
                const targetJid = `${num}@s.whatsapp.net`;
                const result = await sock.onWhatsApp(targetJid);
                
                if (result && result.length > 0 && result[0].exists) {
                    socket.emit('log', `✅ VALID: ${num}`);
                } else {
                    socket.emit('log', `❌ INVALID: ${num}`);
                }
            } catch (error) {
                socket.emit('log', `⚠️ ERROR on ${num}: ${error.message}`);
            }

            if (i < numbers.length - 1) {
                const delayMs = Math.floor(Math.random() * (8000 - 4000 + 1)) + 4000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        socket.emit('log', 'Batch complete!');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startBaileys();
});
