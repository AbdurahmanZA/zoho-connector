'use strict';
const { ZohoClient, ZohoError, SERVICES } = require('./client');
const { Books, contactEmail } = require('./books');
const { DEFAULT_SCOPES, authUrl, exchangeCode, revoke } = require('./oauth');
const { DATACENTERS, datacenter, dcForAccountsServer } = require('./datacenters');

module.exports = {
  ZohoClient, ZohoError, SERVICES, Books, contactEmail,
  DEFAULT_SCOPES, authUrl, exchangeCode, revoke,
  DATACENTERS, datacenter, dcForAccountsServer,
};
