const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let sock = null;
let isConnected = false;

async function startBaileys() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;

        if (qr) {
            // Convert QR string to a data URL image and send to frontend
            const qrImage = await QRCode.toDataURL(qr);
            io.emit('qr', qrImage);
        }

        if (connection === 'open') {
            isConnected = true;
            io.emit('status', 'Client is ready! Connected to WhatsApp.');
        } else if (connection === 'close') {
            isConnected = false;
            io.emit('status', 'Connection closed. Reconnecting...');
            startBaileys();
        }
    });
}

io.on('connection', (socket) => {
    socket.emit('status', isConnected ? 'Client is ready! Connected to WhatsApp.' : 'Starting WhatsApp client...');
    
    // Listen for numbers from the frontend
    socket.on('check_numbers', async (numbers) => {
        if (!isConnected) {
            socket.emit('log', '⚠️ Error: WhatsApp client is not connected yet.');
            return;
        }

        socket.emit('log', `\nStarting batch check for ${numbers.length} numbers...`);
        
        for (let i = 0; i < numbers.length; i++) {
            let num = numbers[i];
            // Auto-add 91 if it's a 10-digit number
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

            // Delay between checks
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
