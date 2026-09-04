const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs= require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let sock = null;
let isConnected = false;
let latestQr = null; // Store the QR code so new browser tabs can load it

async function startBaileys() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '14.0.0'] // Prevents formatting issues on some devices
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Generate and save the QR locally in server memory
            latestQr = await QRCode.toDataURL(qr);
            io.emit('qr', latestQr);
        }

        if (connection === 'open') {
            isConnected = true;
            latestQr = null; // Clear QR from memory once connected
            io.emit('status', { type: 'connected', msg: 'Client is ready! Connected to WhatsApp.' });
        } 
        else if (connection === 'close') {
            isConnected = false;
            latestQr = null;
            
            // Check if the user manually logged out via their phone or the dashboard
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                io.emit('status', { type: 'reconnecting', msg: 'Connection lost. Reconnecting...' });
                startBaileys();
            } else {
                io.emit('status', { type: 'disconnected', msg: 'Session logged out. Please link a new account.' });
                // If logged out, delete the old auth folder so a new QR can be generated
                if (fs.existsSync('./auth_info_baileys')) {
                    fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                }
                startBaileys(); // Restart to generate a fresh QR
            }
        }
    });
}

io.on('connection', (socket) => {
    // 1. Immediately sync a new browser tab with the server's current state
    if (isConnected) {
        socket.emit('status', { type: 'connected', msg: 'Client is ready! Connected to WhatsApp.' });
    } else if (latestQr) {
        socket.emit('status', { type: 'qr', msg: 'Scan the QR code to link your account.' });
        socket.emit('qr', latestQr);
    } else {
        socket.emit('status', { type: 'loading', msg: 'Starting WhatsApp client...' });
    }

    // 2. Allow user to manually force a logout/reset from the dashboard
    socket.on('reset_session', () => {
        socket.emit('log', '⚠️ Manually resetting session...');
        if (fs.existsSync('./auth_info_baileys')) {
            fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
        }
        process.exit(1); // PM2 or Render will automatically restart the server with a clean state
    });

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
