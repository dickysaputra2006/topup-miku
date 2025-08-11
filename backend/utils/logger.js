const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

// Menentukan lokasi folder untuk menyimpan file log
// Ini akan membuat folder 'logs' di dalam direktori 'backend' Anda
const logDirectory = path.join(__dirname, '../logs');

// Konfigurasi untuk membuat file log baru setiap hari (untuk semua level log)
const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDirectory, 'app-%DATE%.log'), // Pola nama file, misal: app-2025-08-11.log
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true, // Arsipkan log lama dalam bentuk .gz untuk menghemat ruang
  maxSize: '20m',      // Ukuran maksimal file sebelum membuat file baru
  maxFiles: '14d'      // Simpan log selama 14 hari
});

// Konfigurasi untuk file log yang HANYA berisi error
const errorTransport = new winston.transports.DailyRotateFile({
  level: 'error', // Hanya catat log dengan level 'error'
  filename: path.join(logDirectory, 'error-%DATE%.log'), // misal: error-2025-08-11.log
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d' // Simpan log error lebih lama, selama 30 hari
});

const logger = winston.createLogger({
  // Level logging: 'info' berarti semua log dari level info, warn, dan error akan dicatat
  level: 'info',
  // Format log agar mudah dibaca dan dianalisis
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }), // Tampilkan detail error jika ada
    winston.format.splat(),
    winston.format.json() // Simpan log dalam format JSON yang terstruktur
  ),
  // Default transport (jika tidak ada yang spesifik)
  transports: [
    dailyRotateFileTransport, // Catat semua log ke file app-....log
    errorTransport         // Catat HANYA error ke file error-....log
  ]
});

// Jika kita tidak di lingkungan produksi (misalnya di komputer lokal),
// tampilkan juga log di konsol agar mudah dibaca saat development.
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(), // Beri warna pada log di konsol
      winston.format.simple()
    )
  }));
}

module.exports = logger;