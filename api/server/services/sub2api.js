const { createSub2API } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { getOrCreateSub2APIUser, updateUserKey, getUserKeyValues } = require('~/models');

module.exports = createSub2API({
  getAppConfig,
  identitySecret: process.env.SUB2API_IDENTITY_SECRET || process.env.JWT_REFRESH_SECRET || '',
  request: globalThis.fetch,
  getOrCreateSub2APIUser,
  updateUserKey,
  getUserKeyValues,
});
