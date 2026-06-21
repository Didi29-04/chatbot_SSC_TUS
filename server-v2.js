require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const multer = require('multer');

// Siapkan folder penampung file sementara
const upload = multer({ dest: 'uploads/' });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

let client = null;
let qrCodeData = null;
let isReady = false;
let isCleaning = false;
let isInitializing = false;
const handledMessageIds = new Set();

const chatHistories = new Map();

const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');

if (!fs.existsSync(knowledgeFile)) {
    fs.writeFileSync(knowledgeFile, JSON.stringify({ keywords: {}, responses: {} }, null, 2));
}

function loadKnowledge() {
    try {
        const data = fs.readFileSync(knowledgeFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading knowledge:', error);
        return { keywords: {}, responses: {} };
    }
}

function saveKnowledge(data) {
    try {
        fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
        ragEngine.clearCache();
        return true;
    } catch (error) {
        console.error('Error saving knowledge:', error);
        return false;
    }
}

function loadBehavior() {
    try {
        if (!fs.existsSync(behaviorFile)) return null;
        const content = fs.readFileSync(behaviorFile, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Error loading behavior config:', error.message);
        return null;
    }
}

function saveBehavior(obj) {
    try {
        fs.mkdirSync(path.dirname(behaviorFile), { recursive: true });
        fs.writeFileSync(behaviorFile, JSON.stringify(obj, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving behavior config:', error.message);
        return false;
    }
}

async function getAIResponse(message, contextItems = [], behavior = null, userId) {
    try {
        if (!behavior) {
            behavior = loadBehavior() || {
                system_instructions: 'Jawab berdasarkan konteks secara ramah.',
                fallback_response: 'Mohon maaf, informasi akademik tersebut tidak ditemukan di pedoman kampus saat ini.',
                max_sentences: 20,
                language: 'id'
            };
        }

        // PERBAIKAN: Menyaring file "Sistem_Bawaan" agar tidak dihitung sebagai dokumen
        const validContexts = contextItems.filter(item => item.source !== 'Sistem_Bawaan/Sistem');
        const systemParts = [];

        if (behavior.system_instructions) systemParts.push(behavior.system_instructions);

        systemParts.push(`\n=== DATA AKADEMIK KAMPUS TUS ===`);
        
        // JIKA DOKUMEN ADA
        if (validContexts.length > 0) {
            const contextBlock = ragEngine.buildContextBlock(validContexts);
            systemParts.push(contextBlock);
            systemParts.push(`\nPanduan Kritis Saat Menjawab:
1. PERAN: Kamu adalah asisten AI resmi untuk Layanan Akademik (Student Service Center) Telkom University Surabaya.
2. SUMBER DATA: Jawablah pertanyaan mahasiswa secara valid dan akurat HANYA berdasarkan data dokumen akademik di atas.
3. BORGOL ANTI-HALUSINASI: Jika pertanyaan mahasiswa TIDAK ADA jawabannya secara eksplisit di dokumen atas, DILARANG KERAS mengarang jawaban dari pengetahuan internetmu! Kamu WAJIB menjawab dengan persis kalimat ini: "${behavior.fallback_response}"
4. FORMAT: Gunakan bahasa yang ramah, profesional, dan gunakan poin-poin (bullet points) agar mudah dibaca.`);
        } 
        // JIKA DOKUMEN KOSONG (SUDAH DIHAPUS)
        else {
            systemParts.push(`[TIDAK ADA DATA! MEMORI DOKUMEN AKADEMIK KOSONG]`);
            systemParts.push(`\nPanduan Kritis: 
- PERINGATAN KERAS: Saat ini data akademik kampus TUS sedang KOSONG (telah dihapus oleh admin).
- JIKA mahasiswa menanyakan aturan, syarat, jurusan, atau jadwal akademik apa pun, KAMU DILARANG KERAS MENGARANG JAWABAN.
- Kamu WAJIB langsung membalas dengan kalimat ini: "${behavior.fallback_response}"
- Jika mahasiswa hanya menyapa (contoh: "Halo", "Pagi"), balas dengan ramah tanpa memberikan informasi akademik.`);
        }

        systemParts.push(`\n=== ATURAN FORMAT WHATSAPP ===`);
        systemParts.push(`1. BOLD: Gunakan SATU bintang (*Teks*), dilarang menggunakan dua bintang (**Teks**).`);
        systemParts.push(`2. LIST: Selalu gunakan tanda strip (-) untuk bullet points. Dilarang pakai simbol + atau *.`);
        systemParts.push(`\nCONTOH FORMAT YANG BENAR:\n*Cara Membuat KRS:*\n- Buka situs akademik.\n- Lakukan login.\n- Pilih mata kuliah.`);

        const systemMessage = systemParts.join('\n');

        let history = chatHistories.get(userId) || [];

        const messages = [
            { role: 'system', content: systemMessage },
            ...history,
            { role: 'user', content: message }
        ];

        const completion = await groq.chat.completions.create({
            messages: messages,
            model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
            max_tokens: Number(process.env.GROQ_MAX_TOKENS || 1024),
            temperature: 0.1 // AI lebih patuh pada aturan
        });

        let aiResponseText = completion.choices[0].message.content;

        // ====================================================================
        // KODE SAPU BERSIH: AUTO-FORMATTER REGEX KHUSUS WHATSAPP
        // ====================================================================
        
        // 1. Ubah **teks** menjadi *teks* (Format Bold Asli WhatsApp)
        aiResponseText = aiResponseText.replace(/\*\*(.*?)\*\*/g, '*$1*');
        
        // 2. Ubah bullet points aneh (spasi lalu +, atau spasi lalu *) menjadi strip (-)
        aiResponseText = aiResponseText.replace(/^\s*[\+\*]\s+/gm, '- ');
        
        // 3. Rapikan baris kosong yang berlebihan agar tidak boros layar HP
        aiResponseText = aiResponseText.replace(/\n{3,}/g, '\n\n');

        // ====================================================================

        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: aiResponseText });

        if (history.length > 8) {
            history = history.slice(history.length - 8);
        }

        chatHistories.set(userId, history);

        return aiResponseText;
    } catch (error) {
        console.error('Error getting AI response:', error.message);
        return null;
    }
}

async function startBot() {
    if (isReady || isInitializing) {
        return { success: false, message: 'Bot sudah berjalan atau sedang dimulai' };
    }
    if (isCleaning) {
        return { success: false, message: 'Bot sedang dihentikan, harap tunggu' };
    }

    isInitializing = true;

    try {
        const clientInstance = initializeClient();
        await clientInstance.initialize();
        isInitializing = false;
        return { success: true, message: 'Bot dimulai, silakan scan QR code' };
    } catch (error) {
        isInitializing = false;
        client = null;
        qrCodeData = null;
        isCleaning = false;
        throw error;
    }
}

function initializeClient() {
    if (client) return client;

    client = new Client({
        authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-resources',
                '--disable-sync',
                '--disable-translate',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-component-extensions-with-background-pages'
            ],
            timeout: 120000
        }
    });

    client.on('qr', (qr) => {
        console.log('\n📱 QR Code Generated');
        console.log('\n🔗 Scan QR Code di bawah untuk connect bot:\n');
        qrCodeData = qr;
        qrcode.generate(qr, { small: true });
        console.log('\n');
    });

    client.on('ready', () => {
        console.log('✅ Bot is ready!');
        isReady = true;
        isCleaning = false;
    });

    client.on('authenticated', () => {
        console.log('✅ Client authenticated');
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Client disconnected:', reason);
        isReady = false;
        client = null;
    });

    const handleIncomingMessage = async (msg, eventName) => {
        try {
            const messageId = msg && msg.id && msg.id._serialized ? msg.id._serialized : null;
            if (messageId) {
                if (handledMessageIds.has(messageId)) {
                    return;
                }
                handledMessageIds.add(messageId);
                setTimeout(() => handledMessageIds.delete(messageId), 5 * 60 * 1000);
            }

            if (msg.fromMe) return;

            const isPersonalChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
            const isNotStatus = !msg.from.endsWith('@status');

            if (!isPersonalChat || !isNotStatus) return;

            console.log(`📩 Pesan dari ${msg.from}: ${msg.body}`);

            try {
                await msg.getChat().then(chat => chat.sendStateTyping());
            } catch (e) { }

            const knowledge = loadKnowledge();
            const keyword = msg.body.toLowerCase().trim();

            if (knowledge.responses && knowledge.responses[keyword]) {
                await msg.reply(knowledge.responses[keyword]);
                console.log('↪️ Dibalas via FAQ (Keyword Match)');
            } else {
                const allDocuments = datasetManager.getAllDocuments();

                const contextItems = ragEngine.retrieveContext(
                    msg.body,
                    allDocuments,
                    Number(process.env.RAG_TOP_K || 15)
                );

                console.log(`🔍 AI Menarik ${contextItems.length} konteks yang relevan`);

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('AI response timeout')), 60000)
                );

                try {
                    const behavior = loadBehavior();

                    const aiResponse = await Promise.race([
                        getAIResponse(msg.body, contextItems, behavior, msg.from),
                        timeoutPromise
                    ]);

                    if (aiResponse) {
                        await msg.reply(aiResponse);
                        console.log(`✅ Berhasil dibalas oleh AI`);
                    } else {
                        await msg.reply('Maaf Kak, sistem SSC sedang sibuk memproses antrean. Silakan coba beberapa saat lagi ya 🙏');
                    }
                } catch (aiError) {
                    console.error('AI Error:', aiError.message);
                    await msg.reply('Maaf Kak, sistem SSC sedang ada perbaikan server. Silakan coba beberapa saat lagi 🙏');
                }
            }
        } catch (error) {
            console.error('Message handler error:', error.message);
        }
    };

    client.on('message', (msg) => handleIncomingMessage(msg, 'message'));

    return client;
}

app.get('/api/bot/status', (req, res) => {
    res.json({
        isReady,
        isCleaning,
        isInitializing,
        hasQRCode: qrCodeData ? true : false
    });
});

app.post('/api/upload-pedoman', upload.single('file_pdf'), async (req, res) => {
    try {
        if (!req.file) throw new Error('File PDF tidak dikirim oleh browser.');

        const dataBuffer = fs.readFileSync(req.file.path);
        const pdf = require('pdf-parse');
        
        if (typeof pdf !== 'function') {
            throw new Error("Modul pdf-parse rusak di komputer Kakak.");
        }

        let pdfData;
        try {
            pdfData = await pdf(dataBuffer);
        } catch (err) {
            throw new Error(`Gagal mengekstrak teks. File mungkin dikunci. Detail: ${err.message}`);
        }

        const rawText = pdfData.text;
        if (!rawText || rawText.trim() === '') {
            throw new Error('PDF kosong atau berisi Gambar/Scan kertas.');
        }

        const originalName = req.file.originalname.replace('.pdf', '');
        const cleanName = originalName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const csvFileName = `dokumen_${cleanName}_${Date.now()}.csv`;

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        const chunks = rawText.split(/\n\s*\n/).filter(chunk => chunk.trim().length > 50);
        if (chunks.length === 0) throw new Error('Format teks di dalam PDF tidak terstruktur dengan baik.');

        let csvContent = 'Topik,Informasi\n';
        chunks.forEach((chunk, index) => {
            const cleanText = chunk.replace(/"/g, '""').replace(/\n/g, ' ');
            csvContent += `"Potongan ${originalName} Bagian ${index + 1}","${cleanText}"\n`;
        });

        const targetPath = path.join(__dirname, 'data', csvFileName);
        fs.writeFileSync(targetPath, csvContent, 'utf8');

        // PERBAIKAN: Refresh Dataset DAN Refresh Cache RAG Engine
        if (typeof datasetManager.loadDatasets === 'function') {
            datasetManager.loadDatasets(); 
        }
        
        // PENTING: Tambahkan ini agar mesin RAG langsung menyerap data baru
        if (ragEngine && typeof ragEngine.clearCache === 'function') {
            ragEngine.clearCache();
        }

        res.json({ success: true, message: `Sukses! Bot kini mempelajari ${chunks.length} paragraf baru.` });

    } catch (error) {
        console.error('❌ ERROR UPLOAD:', error.message);
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/datasets/:name', (req, res) => {
    const docs = datasetManager.getDatasetDocuments(req.params.name);
    if (docs.length === 0) {
        return res.status(404).json({ message: 'Dataset tidak ditemukan' });
    }
    res.json({ documents: docs });
});

app.post('/api/datasets', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!name || !data) {
            return res.status(400).json({ message: 'name dan data harus diisi' });
        }
        const result = datasetManager.saveDataset(name, data);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message });
    }
});

app.get('/api/knowledge/keywords', (req, res) => {
    const knowledge = loadKnowledge();
    res.json(knowledge);
});

app.post('/api/knowledge/keyword', (req, res) => {
    try {
        const { keyword, response } = req.body;
        if (!keyword || !response) {
            return res.status(400).json({ message: 'Keyword dan response harus diisi', success: false });
        }
        const knowledge = loadKnowledge();
        knowledge.responses[keyword.toLowerCase().trim()] = response;
        if (saveKnowledge(knowledge)) {
            res.json({ message: 'Keyword berhasil disimpan', success: true });
        } else {
            res.status(500).json({ message: 'Error menyimpan keyword', success: false });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message, success: false });
    }
});

app.delete('/api/knowledge/keyword/:keyword', (req, res) => {
    try {
        const keyword = decodeURIComponent(req.params.keyword).toLowerCase();
        const knowledge = loadKnowledge();
        if (knowledge.responses[keyword]) {
            delete knowledge.responses[keyword];
            if (saveKnowledge(knowledge)) {
                res.json({ message: 'Keyword berhasil dihapus', success: true });
            } else {
                res.status(500).json({ message: 'Error menghapus keyword', success: false });
            }
        } else {
            res.status(404).json({ message: 'Keyword tidak ditemukan', success: false });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message, success: false });
    }
});

app.get('/api/datasets', (req, res) => {
    try {
        res.json({
            datasets: datasetManager.listDatasets(),
            totalDocuments: datasetManager.getAllDocuments().length
        });
    } catch (error) {
        console.error('🚨 ALARM ERROR DATASET:', error);
        res.status(500).json({ message: 'Internal Server Error: ' + error.message });
    }
});

app.delete('/api/datasets/:name', (req, res) => {
    try {
        const datasetName = decodeURIComponent(req.params.name);
        
        const result = datasetManager.deleteDataset(datasetName);
        
        if (result.success) {
            datasetManager.loadDatasets(); 
            
            if (ragEngine && typeof ragEngine.clearCache === 'function') {
                ragEngine.clearCache();
            }
            
            chatHistories.clear(); 
            
            res.json(result);
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('Error saat menghapus di server:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    console.log(`Admin Dashboard: http://localhost:${PORT}`);
    console.log(`Datasets loaded: ${datasetManager.listDatasets().length}`);

    if (process.env.AUTO_START_BOT !== 'false') {
        setTimeout(() => {
            startBot().catch(error => {
                console.error('Error auto-starting bot:', error.message);
            });
        }, 500);
    }
});