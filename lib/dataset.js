const fs = require('fs');
const path = require('path');

class DatasetManager {
    constructor() {
        this.dataDir = path.join(__dirname, '..', 'data');
        this.ensureDataDir();
        this.datasets = new Map();
        
        // Mulai memuat data saat server pertama kali menyala
        this.loadDatasets();
    }

    parseCsvLine(line) {
        const values = [];
        let current = '';
        let insideQuotes = false;
        
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index];
            if (character === '"') {
                if (insideQuotes && line[index + 1] === '"') {
                    current += '"';
                    index += 1;
                } else {
                    insideQuotes = !insideQuotes;
                }
                continue;
            }
            if (character === ',' && !insideQuotes) {
                values.push(current.trim());
                current = '';
                continue;
            }
            current += character;
        }
        values.push(current.trim());
        return values;
    }

    buildTextFromCsvRow(headers, row) {
        const fields = [];
        headers.forEach((header, index) => {
            const value = row[index] ? row[index].trim() : '';
            if (!value) return;
            const normalizedHeader = header.toLowerCase();
            if (normalizedHeader.includes('href') || normalizedHeader.includes('src')) return;
            fields.push(`${header}: ${value}`);
        });
        return fields.join('\n');
    }

    extractCsvLabel(row) {
        for (const value of row) {
            const cleanValue = value ? value.trim() : '';
            if (!cleanValue) continue;
            if (/^https?:\/\//i.test(cleanValue)) continue;
            if (/^data:/i.test(cleanValue)) continue;
            if (/^[\d.,%+-]+$/.test(cleanValue)) continue;
            if (cleanValue.length < 4) continue;
            return cleanValue;
        }
        return 'baris';
    }

    loadCsvDataset(filePath, datasetName) {
        const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const lines = content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);
            
        if (lines.length < 2) {
            return {
                name: datasetName,
                file: filePath,
                data: { documents: [] },
                loadedAt: new Date().toISOString()
            };
        }
        
        const headers = this.parseCsvLine(lines[0]);
        const documents = [];
        
        for (let index = 1; index < lines.length; index += 1) {
            const row = this.parseCsvLine(lines[index]);
            const text = this.buildTextFromCsvRow(headers, row);
            if (!text) continue;
            const title = this.extractCsvLabel(row);
            documents.push({
                source: `${datasetName}/${title}`,
                text
            });
        }
        
        return {
            name: datasetName,
            file: filePath,
            data: {
                metadata: {
                    name: datasetName,
                    type: 'csv'
                },
                documents
            },
            loadedAt: new Date().toISOString()
        };
    }

    ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    // FUNGSI INI SUDAH DILENGKAPI ANTI-CRASH
    loadDatasets() {
        try {
            this.datasets.clear();
            const files = fs.readdirSync(this.dataDir);

            for (const file of files) {
                const filePath = path.join(this.dataDir, file);
                try {
                    if (file.endsWith('.json')) {
                        const datasetName = file.replace('.json', '');
                        const content = fs.readFileSync(filePath, 'utf8');
                        const data = JSON.parse(content);
                        this.datasets.set(datasetName, {
                            name: datasetName,
                            file: filePath,
                            data: data,
                            loadedAt: new Date().toISOString()
                        });
                    }
                    if (file.endsWith('.csv')) {
                        const datasetName = file.replace('.csv', '');
                        const dataset = this.loadCsvDataset(filePath, datasetName);
                        this.datasets.set(datasetName, dataset);
                    }
                } catch (error) {
                    console.error(`❌ Error loading dataset ${file}:`, error.message);
                }
            }

            // === SISTEM ANTI-CRASH JIKA DATA KOSONG ===
            if (this.datasets.size === 0) {
                console.log('⚠️ Folder data kosong! Mengaktifkan memori sistem cadangan agar AI tidak crash...');
                this.datasets.set('Sistem_Bawaan', {
                    name: 'Sistem_Bawaan',
                    file: 'internal',
                    data: {
                        metadata: { name: 'Sistem_Bawaan', type: 'system' },
                        documents: [{ 
                            source: 'Sistem', 
                            text: 'INFO: Saat ini belum ada dokumen pedoman akademik yang diupload oleh admin ke dalam sistem SSC.' 
                        }]
                    },
                    loadedAt: new Date().toISOString()
                });
            } else {
                console.log(`🚀 Sukses memuat total ${this.datasets.size} dokumen ke dalam memori AI.`);
            }
        } catch (error) {
            console.error('Error loading datasets:', error.message);
        }
    }

    getAllDocuments() {
        const allDocs = [];
        for (const [name, dataset] of this.datasets) {
            if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
                for (const doc of dataset.data.documents) {
                    allDocs.push({
                        source: `${name}/${doc.source || 'unknown'}`,
                        text: doc.text || ''
                    });
                }
            }
            if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
                for (const faq of dataset.data.faq) {
                    allDocs.push({
                        source: `${name}/FAQ: ${faq.question || 'unknown'}`,
                        text: `${faq.question}\n${faq.answer}`
                    });
                }
            }
        }
        return allDocs;
    }

    getDatasetDocuments(datasetName) {
        const dataset = this.datasets.get(datasetName);
        if (!dataset) return [];

        const docs = [];
        if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
            for (const doc of dataset.data.documents) {
                docs.push({
                    source: `${datasetName}/${doc.source || 'unknown'}`,
                    text: doc.text || ''
                });
            }
        }
        if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
            for (const faq of dataset.data.faq) {
                docs.push({
                    source: `${datasetName}/FAQ: ${faq.question || 'unknown'}`,
                    text: `${faq.question}\n${faq.answer}`
                });
            }
        }
        return docs;
    }

    saveDataset(datasetName, data) {
        try {
            const filePath = path.join(this.dataDir, `${datasetName}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

            this.datasets.set(datasetName, {
                name: datasetName,
                file: filePath,
                data: data,
                loadedAt: new Date().toISOString()
            });

            return { success: true, message: `Dataset ${datasetName} saved` };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // FUNGSI MENGHAPUS DOKUMEN YANG DIPERBARUI
    deleteDataset(datasetName) {
        try {
            const files = fs.readdirSync(this.dataDir);
            let found = false;

            files.forEach(file => {
                // Hapus file yang berawalan dengan nama dataset
                if (file.startsWith(datasetName)) {
                    fs.unlinkSync(path.join(this.dataDir, file));
                    found = true;
                }
            });

            if (found) {
                this.datasets.delete(datasetName);
                console.log(`🗑️ Berhasil menghapus dokumen: ${datasetName}`);
                return { success: true, message: `Dokumen berhasil dihapus.` };
            } else {
                return { success: false, message: `File tidak ditemukan di server.` };
            }
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    listDatasets() {
        return Array.from(this.datasets.values())
            // Sembunyikan memori cadangan dari tampilan web admin
            .filter(d => d.name !== 'Sistem_Bawaan') 
            .map(d => ({
                name: d.name,
                loadedAt: d.loadedAt,
                documentCount: this.getDatasetDocuments(d.name).length
            }));
    }

    reloadDatasets() {
        this.loadDatasets();
    }
}

module.exports = DatasetManager;