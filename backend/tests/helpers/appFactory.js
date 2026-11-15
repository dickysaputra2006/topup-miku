process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.FOXY_API_KEY = process.env.FOXY_API_KEY || 'test-foxy-key';
process.env.FOXY_CALLBACK_SECRET = '';

const axios = require('axios');
const serverMod = require('../../server');
const cronUtils = require('../../utils/cronUtils');

const { pool, startServer } = serverMod;
const cronPool = cronUtils.pool;

/**
 * Create a lifecycle harness around the Express test server and shared mocks.
 */
function createServerHarness({ withAxios = false, withCronPool = false } = {}) {
    let server = null;
    let baseUrl = '';
    let origPoolQuery;
    let origPoolConnect;
    let origAxiosGet;
    let origAxiosPost;
    let origCronPoolQuery;
    let origCronPoolConnect;

    const start = () => {
        origPoolQuery = pool.query;
        origPoolConnect = pool.connect;
        if (withAxios) {
            origAxiosGet = axios.get;
            origAxiosPost = axios.post;
        }
        if (withCronPool) {
            origCronPoolQuery = cronPool.query;
            origCronPoolConnect = cronPool.connect;
        }
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        return {
            server,
            baseUrl,
            origPoolQuery,
            origPoolConnect,
            origAxiosGet,
            origAxiosPost,
            origCronPoolQuery,
            origCronPoolConnect
        };
    };

    const restorePool = () => {
        pool.query = origPoolQuery;
        pool.connect = origPoolConnect;
    };

    const restoreAxios = () => {
        if (withAxios) {
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    };

    const restoreCronPool = () => {
        if (withCronPool) {
            cronPool.query = origCronPoolQuery;
            cronPool.connect = origCronPoolConnect;
        }
    };

    const stop = async () => {
        restorePool();
        restoreAxios();
        restoreCronPool();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
            server = null;
        }
    };

    return {
        start,
        stop,
        restorePool,
        restoreAxios,
        restoreCronPool
    };
}

module.exports = {
    serverMod,
    pool,
    startServer,
    axios,
    cronUtils,
    cronPool,
    createServerHarness
};
