const { logSafeError } = require('../utils/logger');

/**
 * Tangkap seluruh error sinkron/delegasi Express dan pastikan respons JSON aman
 * tanpa membocorkan stack trace, path file internal, maupun detail query SQL.
 */
function errorHandler(err, req, res, next) {
    if (!err) {
        return next();
    }
    if (res.headersSent) {
        return next(err);
    }

    const isJsonSyntaxError = err.type === 'entity.parse.failed'
        || (err instanceof SyntaxError && err.status === 400 && 'body' in err);
    if (isJsonSyntaxError) {
        return res.status(400).json({ message: 'Format JSON pada request body tidak valid.' });
    }

    if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
        return res.status(413).json({ message: 'Ukuran payload request melebihi batas yang diizinkan.' });
    }

    if (err.isCorsError === true || err.message === 'Origin tidak diizinkan oleh CORS.') {
        return res.status(403).json({ message: 'Origin tidak diizinkan oleh CORS.' });
    }

    const rawStatus = Number.isInteger(err.statusCode)
        ? err.statusCode
        : (Number.isInteger(err.status) ? err.status : 500);

    if (rawStatus >= 400 && rawStatus < 500) {
        return res.status(rawStatus).json({
            message: rawStatus === 400
                ? 'Permintaan tidak dapat diproses.'
                : 'Akses ditolak atau permintaan tidak valid.'
        });
    }

    const method = req && req.method ? req.method : 'UNKNOWN';
    const path = req && (req.originalUrl || req.url) ? String(req.originalUrl || req.url).split('?')[0] : '/';
    logSafeError(`[HTTP 500] ${method} ${path}:`, err);

    return res.status(500).json({ message: 'Terjadi kesalahan internal pada server.' });
}

module.exports = {
    errorHandler,
};
