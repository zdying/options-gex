/**
 * @file env.js
 * @description 环境变量与敏感配置管理。
 */

module.exports = {
  PORT: process.env.PORT || 3080,
  BENZINGA_API_KEY: process.env.BENZINGA_API_KEY || '2RiuR92vjytxS8r93w3c8WTpGSd3y9Gk',
  BENZINGA_COOKIE: process.env.BENZINGA_COOKIE || 'benzinga_token=ut8v2gvljnpzk5krg0gw54kjgh7ohehy',
  PRO_PLUS_USERS_AUTHORIZATION: process.env.PRO_PLUS_USERS_AUTHORIZATION || 'Bearer ka_internal_M3MYTtJ60kQtKR45aJu8u6HoaVvbVjln',
  JWT_SECRET: process.env.JWT_SECRET || '4vLIrsJ16fMDL4CqM4BMn0xQcNEydF5gzQW2jePsQr7T7qmQc8RM3RqbDvKETKaY',
};
