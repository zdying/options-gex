/**
 * @file env.js
 * @description 环境变量与敏感配置管理。
 */

const fs = require('fs');

function readToken() {
  try {
    const token = fs.readFileSync(__dirname + '/benzinga_token.txt', 'utf-8').trim();
    return token;
  } catch (error) {
    return process.env.BENZINGA_COOKIE || 'benzinga_token=0ja5hdazney8m6etjz8apdipoiduo801';
  }
}

module.exports = {
  PORT: process.env.PORT || 3080,
  BENZINGA_API_KEY: process.env.BENZINGA_API_KEY || '2RiuR92vjytxS8r93w3c8WTpGSd3y9Gk',
  BENZINGA_COOKIE: readToken(),
  PRO_PLUS_USERS_AUTHORIZATION: process.env.PRO_PLUS_USERS_AUTHORIZATION || 'Bearer ka_internal_M3MYTtJ60kQtKR45aJu8u6HoaVvbVjln',
  JWT_SECRET: process.env.JWT_SECRET || '4vLIrsJ16fMDL4CqM4BMn0xQcNEydF5gzQW2jePsQr7T7qmQc8RM3RqbDvKETKaY',
  KA_SERVER_HOST: process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:8787' : 'https://app.kairalert.pro'
};
