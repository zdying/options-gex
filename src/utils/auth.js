const datacenter = require('../datacenter');
const env = require('../env');
const { verifyJwt } = require('./jwt');
const logger = require('./logger')('auth');

let proPlusUsers = null;
let loadingUsers = null;
let proPlusUsersLoadedAt = 0;

const PRO_PLUS_USERS_CACHE_TTL_MS = 5 * 60 * 1000;

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function getProPlusUsers() {
  const hasCache = Array.isArray(proPlusUsers);
  const cacheExpired = !hasCache || Date.now() - proPlusUsersLoadedAt > PRO_PLUS_USERS_CACHE_TTL_MS;

  if (hasCache && !cacheExpired) {
    return proPlusUsers;
  }

  if (!loadingUsers) {
    loadingUsers = datacenter.fetchProPlusUsers()
      .then(users => {
        proPlusUsers = users;
        proPlusUsersLoadedAt = Date.now();
        logger.info(`[Auth] Loaded ${users.length} pro+ users. user list: ${JSON.stringify(users.map(u => ({ user_id: u.user_id, email: u.email })))}`);
        return proPlusUsers;
      })
      .catch(error => {
        logger.error(`[Auth] Failed to load pro+ users: ${error.message}`);
        if (hasCache) {
          logger.warn(`[Auth] Using stale pro+ users cache with ${proPlusUsers.length} users.`);
          return proPlusUsers;
        }
        throw error;
      })
      .finally(() => {
        loadingUsers = null;
      });
  }

  return loadingUsers;
}

function isUserInProPlusList(payload, users) {
  const userId = payload && (payload.sub || payload.user_id || payload.id);
  const email = payload && payload.email ? String(payload.email).toLowerCase() : '';

  return users.some(user => {
    if (userId && String(user.user_id) === String(userId)) {
      return true;
    }
    return email && String(user.email || '').toLowerCase() === email;
  });
}

async function isAuthorizedRequest(req) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      logger.warn(`[Auth] Missing bearer token for ${req.method} ${req.originalUrl || req.url}`);
      return { ok: false, payload: null };
    }

    if (!env.JWT_SECRET) {
      logger.error(`[Auth] JWT_SECRET is not configured.`);
      return { ok: false, payload: null };
    }

    const payload = await verifyJwt(token, env.JWT_SECRET);
    const users = await getProPlusUsers();
    const ok = isUserInProPlusList(payload, users);

    logger.info(`[Auth] Authorization check for ${req.method} ${req.originalUrl || req.url}: user_id=${payload.sub || payload.user_id || payload.id || ''}, email=${payload.email || ''}, ok=${ok}`);

    if (!ok) {
      logger.warn(`[Auth] User not in pro+ list: sub=${payload.sub || ''}, email=${payload.email || ''}`);
    }

    logger.info(`[Auth] Authorization check completed for ${req.method} ${req.originalUrl || req.url}: ok=${ok}`);
    return { ok, payload };
  } catch (error) {
    logger.warn(`[Auth] Authorization failed for ${req.method} ${req.originalUrl || req.url}: ${error.message}`);
    return { ok: false, payload: null };
  }
}

module.exports = {
  getBearerToken,
  getProPlusUsers,
  isUserInProPlusList,
  isAuthorizedRequest
};
